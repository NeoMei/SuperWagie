import { connectHost, HostRequestError, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import {
  CONTENT_LIMIT,
  EMPTY_ANSWERS,
  KIND_HINT,
  KIND_LABEL,
  KINDS,
  briefMarkdown,
  defaultTitle,
  sanitizeTitle,
  todayISO,
  workPathLabel,
  type Answers,
  type Kind,
} from './wizard.ts';
import { FLOW_STAGES, INTAKE, canStart, type IntakeField, type IntakeFieldID } from './flows.ts';
import {
  confirmMessage,
  readWorkView,
  workFilePaths,
  type Gate,
  type WorkFiles,
  type WorkView,
} from './readers.ts';
import { el, installStyles, notice } from './styles.ts';

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('缺少根节点');
const hostNotice = notice();

type Phase = 'wizard' | 'work';

type State = {
  ready: HostReadyContext | null;
  phase: Phase;
  kind: Kind | null;
  answers: Answers;
  title: string;
  busy: boolean;
  /** The work exists and the panel is waiting for the directory switch to land. */
  opening: boolean;
  sentDecision: string | null;
  view: WorkView | null;
  /** 再做一份 was chosen: stay in the wizard until a new directory lands. */
  fresh: boolean;
  /** Opened from a sidebar entry: start a new work even if this project has one. */
  forceNew: boolean;
};

const state: State = {
  ready: null,
  phase: 'wizard',
  kind: null,
  answers: { ...EMPTY_ANSWERS },
  title: '',
  busy: false,
  opening: false,
  sentDecision: null,
  view: null,
  fresh: false,
  forceNew: false,
};

const renderHead = (title: string): HTMLElement => {
  const head = el('div', 'cr-head');
  head.append(el('h2', '', title));
  if (state.phase === 'wizard' && state.kind) {
    const restart = el('button', 'cr-btn', '重来');
    restart.addEventListener('click', () => {
      // A start still in flight would keep creating its folder: stay put.
      if (state.busy || state.opening) return;
      state.kind = null;
      state.answers = { ...EMPTY_ANSWERS };
      state.title = '';
      state.forceNew = false;
      hostNotice.clear();
      render();
    });
    head.append(restart);
  }
  if (state.phase === 'work') {
    const another = el('button', 'cr-btn', '新作品');
    another.addEventListener('click', restartWork);
    head.append(another);
  }
  const exit = el('button', 'cr-btn', '退出');
  exit.type = 'button';
  exit.addEventListener('click', () => {
    if (state.busy || state.opening) return;
    void host.close().catch(() => {
      hostNotice.show('退出失败，重新打开一个会话即可离开创作页。', 'error');
    });
  });
  head.append(exit);
  return head;
};

const renderKinds = (): HTMLElement => {
  const wrap = el('div');
  wrap.append(el('p', 'cr-sub', '想做点什么？四种都从这里开始。'));
  const list = el('div', 'cr-kind');
  for (const kind of KINDS) {
    const card = el('button', 'cr-card');
    card.type = 'button';
    card.append(el('b', '', KIND_LABEL[kind]), el('span', '', KIND_HINT[kind]));
    card.addEventListener('click', () => {
      state.kind = kind;
      state.answers = { ...EMPTY_ANSWERS };
      state.title = '';
      render();
    });
    list.append(card);
  }
  wrap.append(list);
  return wrap;
};

let gate: HTMLButtonElement | null = null;

const syncGate = (): void => {
  if (gate && state.kind) gate.disabled = state.busy || state.opening || !canStart(state.kind, state.answers);
};

const setAnswer = (id: IntakeFieldID, value: string): void => {
  state.answers[id] = value;
  syncGate();
};

const renderIntakeField = (def: IntakeField): HTMLElement => {
  const box = el('div', 'cr-field');
  box.append(el('label', '', def.optional ? `${def.label}（可留空）` : def.label));
  if (def.kind === 'choice') {
    const row = el('div', 'cr-chips');
    for (const value of def.options ?? []) {
      const chip = el('button', 'cr-chip', value);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(state.answers[def.id] === value));
      chip.addEventListener('click', () => {
        state.answers[def.id] = value;
        render();
      });
      row.append(chip);
    }
    box.append(row);
  } else {
    const input = def.kind === 'long' ? el('textarea') : el('input');
    input.value = state.answers[def.id];
    if (def.id === 'content') input.maxLength = CONTENT_LIMIT;
    input.addEventListener('input', () => setAnswer(def.id, input.value));
    box.append(input);
  }
  if (def.hint) box.append(el('p', 'cr-meta', def.hint));
  return box;
};

const startDefaults = (kind: Kind): string => {
  if (kind === 'doc') return '加载 SuperWriter · 交付 DOCX 和 PDF';
  if (kind === 'deck') return '加载 SuperPPT · 16:9 · 风格稍后选';
  if (kind === 'video') return '加载 SuperVideo · 百炼旁白 · 横屏 · 先不加音乐';
  return '加载 SuperWeb · 先选方向 · 样页确认后整页';
};

const renderFlow = (kind: Kind, current: number): HTMLElement => {
  const stages = FLOW_STAGES[kind];
  const wrap = el('div', 'cr-progress');
  const track = el('div', 'cr-progress-track');
  const fill = el('div', 'cr-progress-fill');
  fill.style.width = `${((current + 1) / stages.length) * 100}%`;
  track.append(fill);
  wrap.append(track);
  const list = el('ol', 'cr-progress-steps');
  stages.forEach((label, step) => {
    const item = el('li');
    item.append(el('b', '', String(step + 1)), el('span', '', label));
    item.dataset.state = step < current ? 'done' : step === current ? 'now' : 'next';
    list.append(item);
  });
  wrap.append(list);
  return wrap;
};

const renderWizard = (): HTMLElement => {
  const kind = state.kind;
  if (!kind) return renderKinds();
  const wrap = el('div', 'cr-wizard');
  wrap.append(renderFlow(kind, 0));
  wrap.append(el('p', 'cr-sub', `${KIND_LABEL[kind]} · 第 1 步 / 共 ${FLOW_STAGES[kind].length} 步 · 把需求说清楚，后面的每一步都在这个页面里继续。`));

  for (const def of INTAKE[kind]) wrap.append(renderIntakeField(def));

  const nameBox = el('div', 'cr-field');
  nameBox.append(el('label', '', '名字，会变成文件夹'));
  const nameInput = el('input');
  nameInput.value = sanitizeTitle(state.title || defaultTitle(kind, state.answers));
  const pathLine = el('div', 'cr-meta', workPathLabel(kind, nameInput.value, todayISO()));
  nameInput.addEventListener('input', () => {
    nameInput.dataset.edited = '1';
    state.title = nameInput.value;
    pathLine.textContent = workPathLabel(kind, sanitizeTitle(nameInput.value), todayISO());
  });
  nameBox.append(nameInput);
  wrap.append(nameBox, pathLine);
  wrap.append(el('p', 'cr-sub', startDefaults(kind)));

  // The name follows the first line of what the user wrote until they edit it.
  wrap.addEventListener('input', () => {
    if (nameInput.dataset.edited === '1' || state.title) return;
    nameInput.value = defaultTitle(kind, state.answers);
    pathLine.textContent = workPathLabel(kind, sanitizeTitle(nameInput.value), todayISO());
  });

  const row = el('div', 'cr-row cr-wizard-actions');
  const swap = el('button', 'cr-btn', '换一种');
  swap.addEventListener('click', () => {
    if (state.busy || state.opening) return;
    state.kind = null;
    state.answers = { ...EMPTY_ANSWERS };
    state.title = '';
    hostNotice.clear();
    render();
  });
  row.append(swap);
  const start = el('button', 'cr-primary', state.opening ? '正在打开…' : state.busy ? '正在建…' : '确认并开始');
  start.disabled = state.busy || state.opening || !canStart(kind, state.answers);
  start.addEventListener('click', () => void startWork());
  gate = start;
  row.append(start);
  wrap.append(row);
  return wrap;
};

const readText = async (path: string): Promise<string | null> => {
  try {
    return (await host.readFile(path)).content;
  } catch {
    return null;
  }
};

const kindFromBrief = (brief: string | null): Kind | null => {
  const match = brief?.match(/^- 类型：(doc|deck|video|page)$/m);
  return match ? KINDS.find((kind) => kind === match[1]) ?? null : null;
};

const STATE_FILE = {
  doc: '协作状态.json',
  deck: 'superppt.json',
  video: 'project.json',
  page: 'superweb.json',
} satisfies Record<Kind, string>;

const collectFiles = async (kind: Kind, stateRaw: string): Promise<WorkFiles> => {
  const request = workFilePaths(kind, stateRaw);
  const [plan, prompts, directions, artifact, result] = await Promise.all([
    request.plan ? readText(request.plan) : Promise.resolve(null),
    request.prompts ? readText(request.prompts) : Promise.resolve(null),
    request.directions ? readText(request.directions) : Promise.resolve(null),
    request.artifact ? readText(request.artifact) : Promise.resolve(null),
    request.result ? readText(request.result) : Promise.resolve(null),
  ]);
  return { state: stateRaw, plan, prompts, directions, artifact, result };
};

// Session and directory events can start a read while an older one is still
// in flight. Only the newest read is allowed to paint.
let reloadSeq = 0;

// A new gate means the confirming decision is settled or replaced: drop the
// sent lock so the next decision can be sent. A failed send's error notice stays.
const syncSentDecision = (view: WorkView | null): void => {
  if ((view?.gate?.decisionId ?? null) === state.sentDecision) return;
  state.sentDecision = null;
  if (hostNotice.element.dataset.tone !== 'error') hostNotice.clear();
};

// Landing on the work phase ends the start flow: the start button stops
// showing 正在打开… and the info notice goes with it. An error notice stays.
const landWork = (): void => {
  if (!state.opening) return;
  clearOpening();
  state.opening = false;
  if (hostNotice.element.dataset.tone !== 'error') hostNotice.clear();
};

// A directory switch that never lands must not strand the panel on
// 正在打开…: after ten seconds the work is reported as created and the
// confirm screen stays usable.
const OPENING_TIMEOUT_MS = 10_000;
let openingTimer: ReturnType<typeof setTimeout> | null = null;

const clearOpening = (): void => {
  if (openingTimer === null) return;
  clearTimeout(openingTimer);
  openingTimer = null;
};

const armOpening = (): void => {
  clearOpening();
  state.opening = true;
  openingTimer = setTimeout(() => {
    openingTimer = null;
    state.opening = false;
    hostNotice.show('项目建好了，打开项目列表就能进去。');
    render();
  }, OPENING_TIMEOUT_MS);
};

// True when this read painted the work phase; false on an early or stale return.
const reload = async (): Promise<boolean> => {
  // 再做一份 keeps the wizard on screen: the old work still sits in the folder
  // until the next creation switches directories. A sidebar entry does the
  // same for a project that already holds a work.
  if (state.fresh || state.forceNew) return false;
  const seq = ++reloadSeq;
  const brief = await readText('需求.md');
  const kind = kindFromBrief(brief);
  if (seq !== reloadSeq) return false;
  if (!kind) {
    // No work here: stay in the wizard, whatever the session events say.
    if (state.phase === 'work') {
      state.phase = 'wizard';
      state.kind = null;
      state.answers = { ...EMPTY_ANSWERS };
      state.title = '';
      state.view = null;
      render();
    }
    return false;
  }
  const stateRaw = await readText(STATE_FILE[kind]);
  if (seq !== reloadSeq) return false;
  const view = stateRaw ? await collectFiles(kind, stateRaw) : null;
  if (seq !== reloadSeq) return false;
  state.phase = 'work';
  state.kind = kind;
  state.view = view ? readWorkView(kind, view) : null;
  syncSentDecision(state.view);
  landWork();
  render();
  return true;
};

const firstMessage = (kind: Kind): string => {
  if (kind === 'doc') return '请先调用 skill 工具加载 superwriter 技能，再读取本项目的 需求.md，按 SuperWriter 的流程开始。';
  if (kind === 'deck') return '请先调用 skill 工具加载 superppt 技能，再读取本项目的 需求.md，按 SuperPPT 的流程开始。';
  if (kind === 'video') return '请先调用 skill 工具加载 supervideo 技能，再读取本项目的 需求.md，按 SuperVideo 的流程开始。';
  return '请先调用 skill 工具加载 superweb 技能，再读取本项目的 需求.md。项目里已经有 需求.md，请用 superweb start --dir . --adopt-brief 初始化，按 SuperWeb 的流程开始；不要覆盖需求文件。若 superweb 不在 PATH，使用 node ~/.config/opencode/skills/superweb/bin/superweb.mjs。';
};

const readError = (body: string | null): string => {
  try {
    const parsed: { error?: string } = JSON.parse(body ?? '');
    return parsed.error ?? '建项目失败';
  } catch {
    return '建项目失败';
  }
};

// Copy this panel throws itself; anything else carries an English
// HostRequestError, SyntaxError or extension message and never reaches the user.
const OWN_ERRORS: ReadonlySet<string> = new Set(['建项目失败', '服务没有返回项目编号', '会话没有建起来']);

const startCode = (code: string): string => {
  switch (code) {
    case 'SESSION_BUSY': return '这个会话正在忙';
    case 'NO_SESSION': return '还没有打开会话';
    case 'HOST_TIMEOUT': return '服务没有回应';
    case 'DISABLED': return '这个扩展在设置里被停用了';
    default: return '连接出了点问题';
  }
};

const startFailText = (reason: string): string => `没能开始：${reason}。可以直接在对话里开始。`;

const startWork = async (): Promise<void> => {
  if (!state.kind || state.busy || state.opening) return;
  const kind = state.kind;
  const title = sanitizeTitle(state.title || defaultTitle(kind, state.answers));
  state.busy = true;
  hostNotice.show('正在建项目和会话…');
  render();
  let projectId: string | null = null;
  try {
    const response = await host.request({
      method: 'POST',
      path: '/api/creation/projects',
      body: JSON.stringify({ kind, title, brief: briefMarkdown(kind, state.answers, state.title) }),
    });
    if (response.status >= 400) {
      const code = readError(response.body);
      if (response.status === 404 || code === 'NO_DIRECTORY') {
        hostNotice.show('创建面板没有拿到权限，先重启应用再试。', 'error');
        return;
      }
      if (response.status === 400 && (code === 'unknown-kind' || code === 'brief-required')) {
        hostNotice.show('这次没有建起来，返回上一步改一下再试。', 'error');
        return;
      }
      throw new Error('建项目失败');
    }
    const created: { projectId?: string } = JSON.parse(response.body);
    if (!created.projectId) throw new Error('服务没有返回项目编号');
    projectId = created.projectId;
    const session = await host.startSession({
      providerId: 'creation',
      id: '作品',
      title,
      url: `https://superwagie.local/work/${kind}`,
      text: firstMessage(kind),
      projectId,
      navigation: 'open',
    });
    if (!session.sessionId) throw new Error('会话没有建起来');
    // The folder exists now: keep the button disabled until the panel actually
    // lands on the new work, so a slow directory switch cannot be clicked twice.
    armOpening();
    if (session.sent !== 'sent') {
      hostNotice.show('会话开好了，但第一句没发出去。打开对话把需求发一遍。', 'error');
    } else {
      hostNotice.show('项目建好了，正在打开…');
    }
    state.forceNew = false;
    await reload();
  } catch (error) {
    if (projectId) {
      hostNotice.show('项目建好了，但会话没开起来。打开项目列表就能进去。', 'error');
    } else if (error instanceof HostRequestError && error.code === 'NO_DIRECTORY') {
      hostNotice.show('创建面板没有拿到权限，先重启应用再试。', 'error');
    } else if (error instanceof HostRequestError) {
      hostNotice.show(startFailText(startCode(error.code)), 'error');
    } else if (error instanceof Error && OWN_ERRORS.has(error.message)) {
      hostNotice.show(startFailText(error.message), 'error');
    } else {
      hostNotice.show(startFailText('连接出了点问题'), 'error');
    }
  } finally {
    state.busy = false;
    render();
  }
};

const render = (): void => {
  gate = null;
  root.replaceChildren();
  installStyles();
  const page = el('main', 'cr');
  page.append(renderHead(state.kind ? KIND_LABEL[state.kind] : '创作'));
  page.append(state.phase === 'work' ? renderWork() : renderWizard());
  page.append(hostNotice.element);
  root.append(page);
};

const renderWork = (): HTMLElement => {
  const wrap = el('div');
  if (!state.kind) return wrap;
  if (!state.view) {
    wrap.append(el(
      'p',
      'cr-sub',
      state.ready?.session ? '已开始，进度以对话为准。' : '项目已建好，会话还没开。打开对话可以手动开始。',
    ));
    const open = el('button', 'cr-btn', '打开对话');
    open.addEventListener('click', () => void openChat());
    wrap.append(open);
    return wrap;
  }
  wrap.append(renderStrip(state.view));
  wrap.append(state.view.deliveredPath ? renderDelivered(state.view.deliveredPath) : renderGate(state.view));
  return wrap;
};

const continueWork = async (): Promise<void> => {
  try {
    await host.compose({ text: '我想改这份作品：', mode: 'replace' });
    await host.openSurface('chat');
  } catch {
    hostNotice.show('对话打不开，回到左侧会话列表试试。', 'error');
  }
};

const restartWork = (): void => {
  if (state.busy || state.opening) return;
  state.fresh = true;
  state.phase = 'wizard';
  state.kind = null;
  state.answers = { ...EMPTY_ANSWERS };
  state.title = '';
  state.view = null;
  hostNotice.clear();
  render();
};

const renderDelivered = (path: string): HTMLElement => {
  const card = el('section', 'cr-gate');
  card.append(el('h3', '', '已交付'), el('p', 'cr-meta', path));
  const row = el('div', 'cr-row');
  if (state.view?.deliveredMedia) {
    const media = state.view.deliveredMedia;
    const preview = el('button', 'cr-btn', `看${media.label}`);
    preview.addEventListener('click', () => void previewFile(media.path, media.label));
    row.append(preview);
  }
  const edit = el('button', 'cr-primary', '继续改');
  edit.addEventListener('click', () => void continueWork());
  const talk = el('button', 'cr-btn', '打开对话');
  talk.addEventListener('click', () => void openChat());
  const again = el('button', 'cr-btn', '再做一份');
  again.addEventListener('click', restartWork);
  row.append(edit, talk, again);
  card.append(row);
  return card;
};

// The reader's steps start after intake for deck and video; the guide always
// shows the whole skill, so intake is prepended once here.
const renderStrip = (view: WorkView): HTMLElement => {
  const current = view.steps.findIndex((step) => step.state === 'now');
  const offset = view.kind === 'doc' || view.kind === 'page' ? 0 : 1;
  return renderFlow(view.kind, Math.max(0, current + offset));
};

const deckPick = { styleId: '', level: 1, paletteId: '' };
type WebPick = { directionId: string; action: 'accept' | 'rework' };
const webPick: WebPick = { directionId: '', action: 'accept' };

const pickDeck = (gate: Gate): typeof deckPick => {
  const first = gate.choices?.[0];
  const known = gate.choices?.some((style) => style.styleId === deckPick.styleId);
  if (!known && first) {
    deckPick.styleId = first.styleId;
    deckPick.level = first.levels[0];
    deckPick.paletteId = first.palettes[1]?.id ?? first.palettes[0].id;
  }
  return deckPick;
};

// The host reads the project file itself; the guide only names it.
const previewFile = async (path: string, label: string): Promise<void> => {
  try {
    await host.previewFile(path);
  } catch {
    hostNotice.show(`《${label}》打不开，去左侧文件列表里看。`, 'error');
  }
};

const renderGate = (view: WorkView): HTMLElement => {
  const card = el('section', 'cr-gate');
  const current = view.gate;
  if (!current) {
    card.append(el('p', 'cr-sub', '进度以对话为准。'));
    return card;
  }
  card.append(el('h3', '', current.title), el('div', 'cr-meta', current.version));
  if (current.sections && current.sections.length > 0) {
    const list = el('div', 'cr-sections');
    for (const section of current.sections) {
      const item = el('div', 'cr-section');
      item.append(el('b', '', section.title), el('p', 'cr-section-text', section.text));
      list.append(item);
    }
    card.append(list);
  } else if (current.body) {
    card.append(el('div', 'cr-article', current.body));
  } else {
    card.append(el('p', 'cr-excerpt', current.excerpt));
  }
  if (current.openHint) card.append(el('p', 'cr-sub', current.openHint));
  if (current.media && current.media.length > 0) {
    const row = el('div', 'cr-row');
    for (const media of current.media) {
      const button = el('button', 'cr-btn', `看${media.label}`);
      button.type = 'button';
      button.addEventListener('click', () => void previewFile(media.path, media.label));
      row.append(button);
    }
    card.append(row);
  }
  if (current.key === 'deck-style') {
    const choice = pickDeck(current);
    for (const style of current.choices ?? []) {
      const row = el('div', 'cr-row');
      const chip = el('button', 'cr-chip', style.styleName);
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(choice.styleId === style.styleId));
      chip.addEventListener('click', () => {
        choice.styleId = style.styleId;
        choice.level = style.levels[0];
        choice.paletteId = style.palettes[1]?.id ?? style.palettes[0].id;
        render();
      });
      row.append(chip);
      card.append(row);
    }
    const selected = current.choices?.find((style) => style.styleId === choice.styleId);
    if (selected) {
      const levels = el('div', 'cr-row');
      for (const level of selected.levels) {
        const chip = el('button', 'cr-chip', `${level} 档`);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', String(choice.level === level));
        chip.addEventListener('click', () => {
          choice.level = level;
          render();
        });
        levels.append(chip);
      }
      card.append(levels);
      const palettes = el('div', 'cr-row');
      for (const palette of selected.palettes) {
        const chip = el('button', 'cr-chip', palette.name);
        chip.type = 'button';
        chip.setAttribute('aria-pressed', String(choice.paletteId === palette.id));
        chip.addEventListener('click', () => {
          choice.paletteId = palette.id;
          render();
        });
        palettes.append(chip);
      }
      card.append(palettes);
    }
    const prompt = current.prompts?.[`${choice.styleId}/${choice.level}/${choice.paletteId}`];
    if (prompt) {
      const details = el('details', 'cr-details');
      details.append(el('summary', '', '将发送的提示词'), el('pre', '', prompt));
      card.append(details);
    } else {
      card.append(el('p', 'cr-sub', '该组合还没有发布提示词，请在对话里确认。'));
    }
  }
  if (current.key === 'web-direction') {
    const options = current.options ?? [];
    if (!options.some((option) => option.id === webPick.directionId)) {
      webPick.directionId = options[0]?.id ?? '';
    }
    const row = el('div', 'cr-row');
    for (const option of options) {
      const chip = el('button', 'cr-chip', option.name);
      chip.type = 'button';
      chip.title = option.detail ?? option.name;
      chip.setAttribute('aria-pressed', String(webPick.directionId === option.id));
      chip.addEventListener('click', () => {
        webPick.directionId = option.id;
        render();
      });
      row.append(chip);
    }
    if (options.length === 0) card.append(el('p', 'cr-sub', '方向文件还没准备好，先在对话里生成方向。'));
    else card.append(row);
    const selected = options.find((option) => option.id === webPick.directionId);
    if (selected?.detail) card.append(el('p', 'cr-sub', selected.detail));
  }
  if (current.key === 'web-acceptance') {
    const row = el('div', 'cr-row');
    for (const action of ['accept', 'rework'] as const) {
      const chip = el('button', 'cr-chip', action === 'accept' ? '接受并交付' : '返工');
      chip.type = 'button';
      chip.setAttribute('aria-pressed', String(webPick.action === action));
      chip.addEventListener('click', () => {
        webPick.action = action;
        render();
      });
      row.append(chip);
    }
    card.append(row);
  }

  const revise = el('details', 'cr-details');
  revise.append(el('summary', '', '我想改这一步'));
  const reviseInput = el('textarea');
  reviseInput.placeholder = '写清楚要改什么，例如：这一章太书面，改成给客户看的语气。';
  const reviseButton = el('button', 'cr-btn', '提交修改');
  reviseButton.addEventListener('click', async () => {
    const value = reviseInput.value.trim();
    if (!value || state.busy) return;
    state.busy = true;
    render();
    try {
      const result = await host.prompt({ text: `关于${current.title}，我想改：${value}`, send: true });
      if (result.sent !== 'sent') {
        hostNotice.show(failText(result.sent === 'no-model' ? '没有可用的模型' : '消息被退回了'), 'error');
      } else {
        reviseInput.value = '';
        hostNotice.show('已发出，等 AI 改完这一步。');
      }
    } catch (error) {
      hostNotice.show(failText(failReason(error instanceof Error ? error : null)), 'error');
    } finally {
      state.busy = false;
      render();
    }
  });
  const reviseRow = el('div', 'cr-row');
  reviseRow.append(reviseButton);
  revise.append(reviseInput, reviseRow);
  card.append(revise);

  const message = confirmMessage(
    view.kind,
    current,
    current.key === 'web-direction'
      ? { directionId: webPick.directionId }
      : current.key === 'web-acceptance'
        ? { action: webPick.action }
        : current.choices ? pickDeck(current) : undefined,
  );
  // A gate whose exact confirmation cannot be composed has no button to press:
  // the skill's state machine only accepts the precise tuple.
  if (!message) {
    // The style card already says the selection has no published prompt.
    if (current.key !== 'deck-style' && current.key !== 'web-full') card.append(el('p', 'cr-sub', '请在对话里确认。'));
    return card;
  }
  const sessionBusy = state.ready?.session?.busy === true;
  // The line stays in place while idle so the buttons do not jump when the agent starts.
  card.append(el('p', 'cr-meta', sessionBusy ? 'AI 正在处理，等它停下来。' : ''));
  const row = el('div', 'cr-row');
  const canSend = Boolean(state.ready?.session);
  const label = current.key === 'deck-style'
    ? '生成样页'
    : current.key === 'deck-sample'
      ? '确认样页，做整套'
      : current.key === 'deck-deliver'
        ? '确认交付'
        : current.key === 'web-direction'
          ? '确认方向'
          : current.key === 'web-sample'
            ? '确认样页，做整页'
            : current.key === 'web-acceptance'
              ? webPick.action === 'rework' ? '提交返工' : '确认验收，交付'
              : `确认${current.object?.label ?? '这一步'}`;
  const decisionId = current.decisionId ?? null;
  const sent = decisionId !== null && state.sentDecision === decisionId;
  const confirm = el('button', 'cr-primary', sent ? '已发出，等 AI 处理。' : canSend ? label : '在对话里确认');
  confirm.disabled = state.busy || sent || sessionBusy;
  confirm.addEventListener('click', () => {
    if (!canSend) {
      hostNotice.show('先打开这个作品的会话。');
      void openChat();
      return;
    }
    void sendConfirm(message, decisionId);
  });
  row.append(confirm);
  const talk = el('button', 'cr-btn', '打开对话');
  talk.addEventListener('click', () => void openChat());
  row.append(talk);
  card.append(row);
  return card;
};

const failText = (reason: string): string => `没能发出去：${reason}。可以直接在对话里确认。`;

const failReason = (error: Error | null): string => {
  const code = error instanceof HostRequestError ? error.code : undefined;
  switch (code) {
    case 'SESSION_BUSY': return '这个会话正在忙，稍等一下再发';
    case 'NO_SESSION': return '这个作品还没有打开会话';
    case 'HOST_TIMEOUT': return '发送超时了';
    case 'NOT_GRANTED': return '面板没有发送权限';
    default: return '连接出了点问题';
  }
};

const sendConfirm = async (message: string | null, decisionId: string | null): Promise<void> => {
  if (!message || state.busy) return;
  state.busy = true;
  hostNotice.show('已发出，等 AI 处理。');
  render();
  try {
    const result = await host.prompt({ text: message, send: true });
    if (result.sent !== 'sent') {
      hostNotice.show(failText(result.sent === 'no-model' ? '没有可用的模型' : '消息被退回了'), 'error');
      return;
    }
    state.sentDecision = decisionId;
  } catch (error) {
    hostNotice.show(failText(failReason(error instanceof Error ? error : null)), 'error');
  } finally {
    state.busy = false;
    render();
  }
};

// The guide is a full page; revealing the chat means leaving it. The work
// stays in the sidebar, so the page can be reopened from there.
const openChat = async (): Promise<void> => {
  try {
    await host.close();
  } catch {
    hostNotice.show('切不到对话，回到左侧会话列表试试。', 'error');
  }
};

host.onSessionLifecycle((event) => {
  if (event.phase === 'completed' || event.phase === 'failure') void reload();
});
host.onSession((session) => {
  if (state.ready) state.ready = { ...state.ready, session };
  void reload();
});
host.onDirectory(() => {
  state.fresh = false;
  void reload();
});

host.onReady((ready) => {
  state.ready = ready;
  document.documentElement.dataset.surface = ready.surface;
  applyHostReady(ready, document.documentElement);
  hostNotice.clear();
  render();
  void reload();
});

const intentFromHash = (): Kind | null => {
  const value = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('intent');
  return value === 'doc' || value === 'deck' || value === 'video' || value === 'page' ? value : null;
};

// A sidebar entry opens the page with the type already chosen. The hash, not a
// host call, carries it, so a page reopened from the workbench has no intent
// and shows the four cards.
const applyIntent = (kind: Kind): void => {
  state.phase = 'wizard';
  state.kind = kind;
  state.answers = { ...EMPTY_ANSWERS };
  state.title = '';
  state.view = null;
  state.forceNew = true;
  hostNotice.clear();
  render();
};

const openedIntent = intentFromHash();
if (openedIntent) applyIntent(openedIntent);
window.addEventListener('hashchange', () => {
  const kind = intentFromHash();
  if (kind) applyIntent(kind);
});

render();
