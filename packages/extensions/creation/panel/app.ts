import { connectHost, HostRequestError, type HostReadyContext, type SessionSnapshot, type SessionLifecycleEvent } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import {
  CONTENT_LIMIT,
  EMPTY_ANSWERS,
  KINDS,
  briefMarkdown,
  defaultTitle,
  sanitizeTitle,
  todayISO,
  workPathLabel,
  type Answers,
  type Kind,
} from './wizard.ts';
import { flowStages, intakeFields, canStart, type IntakeField, type IntakeFieldID } from './flows.ts';
import {
  confirmMessage,
  readWorkView,
  workFilePaths,
  type Gate,
  type WorkFiles,
  type WorkView,
} from './readers.ts';
import { el, installStyles, notice } from './styles.ts';
import { creationLocale, creationText, type CreationMessageKey } from './i18n.ts';

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
  workFiles: WorkFiles | null;
  revisedText: string;
  touchedAnswers: Set<IntakeFieldID>;
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
  workFiles: null,
  revisedText: '',
  touchedAnswers: new Set(),
  fresh: false,
  forceNew: false,
};

const t = (key: CreationMessageKey, params?: { [name: string]: string | number }): string =>
  creationText(state.ready?.locale, key, params);

const kindLabel = (kind: Kind): string => t(`kind.${kind}`);

const renderHead = (title: string): HTMLElement => {
  const head = el('div', 'cr-head');
  head.append(el('h2', '', title));
  if (state.phase === 'wizard' && state.kind) {
    const restart = el('button', 'cr-btn', t('restart'));
    restart.addEventListener('click', () => {
      // A start still in flight would keep creating its folder: stay put.
      if (state.busy || state.opening) return;
      state.kind = null;
      state.answers = { ...EMPTY_ANSWERS };
      state.touchedAnswers.clear();
      state.title = '';
      state.forceNew = false;
      hostNotice.clear();
      render();
    });
    head.append(restart);
  }
  if (state.phase === 'work') {
    const another = el('button', 'cr-btn', t('newWork'));
    another.addEventListener('click', restartWork);
    head.append(another);
  }
  const exit = el('button', 'cr-btn', t('exit'));
  exit.type = 'button';
  exit.addEventListener('click', () => {
    if (state.busy || state.opening) return;
    void host.close().catch(() => {
      hostNotice.show(() => t('exitFailed'), 'error');
    });
  });
  head.append(exit);
  return head;
};

const renderKinds = (): HTMLElement => {
  const wrap = el('div');
  wrap.append(el('p', 'cr-sub', t('chooseKind')));
  const list = el('div', 'cr-kind');
  for (const kind of KINDS) {
    const card = el('button', 'cr-card');
    card.type = 'button';
    card.append(el('b', '', kindLabel(kind)), el('span', '', t(`hint.${kind}`)));
    card.addEventListener('click', () => {
      state.kind = kind;
      state.answers = { ...EMPTY_ANSWERS };
      state.touchedAnswers.clear();
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
  state.touchedAnswers.add(id);
  syncGate();
};

const renderIntakeField = (def: IntakeField): HTMLElement => {
  const box = el('div', 'cr-field');
  box.append(el('label', '', def.optional ? t('optional', { label: def.label }) : def.label));
  if (def.kind === 'choice') {
    const row = el('div', 'cr-chips');
    for (const { value, label } of def.options ?? []) {
      const chip = el('button', 'cr-chip', label);
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
    input.dataset.control = def.id;
    input.value = !state.touchedAnswers.has(def.id) && creationLocale(state.ready?.locale) === 'en'
      ? def.id === 'length' ? t('default.length') : def.id === 'pages' ? t('default.pages') : state.answers[def.id]
      : state.answers[def.id];
    if (def.id === 'content') input.maxLength = CONTENT_LIMIT;
    input.addEventListener('input', () => setAnswer(def.id, input.value));
    box.append(input);
  }
  if (def.hint) box.append(el('p', 'cr-meta', def.hint));
  return box;
};

const startDefaults = (kind: Kind): string => t(`defaults.${kind}`);

const renderFlow = (kind: Kind, current: number): HTMLElement => {
  const stages = flowStages(kind, state.ready?.locale);
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
  wrap.append(el('p', 'cr-sub', t('wizardProgress', { kind: kindLabel(kind), count: flowStages(kind, state.ready?.locale).length })));

  for (const def of intakeFields(kind, state.ready?.locale)) wrap.append(renderIntakeField(def));

  const nameBox = el('div', 'cr-field');
  nameBox.append(el('label', '', t('folderName')));
  const nameInput = el('input');
  nameInput.dataset.control = 'title';
  nameInput.value = sanitizeTitle(state.title || defaultTitle(kind, state.answers, state.ready?.locale));
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
    nameInput.value = defaultTitle(kind, state.answers, state.ready?.locale);
    pathLine.textContent = workPathLabel(kind, sanitizeTitle(nameInput.value), todayISO());
  });

  const row = el('div', 'cr-row cr-wizard-actions');
  const swap = el('button', 'cr-btn', t('changeKind'));
  swap.addEventListener('click', () => {
    if (state.busy || state.opening) return;
    state.kind = null;
    state.answers = { ...EMPTY_ANSWERS };
    state.touchedAnswers.clear();
    state.title = '';
    hostNotice.clear();
    render();
  });
  row.append(swap);
  const start = el('button', 'cr-primary', state.opening ? t('opening') : state.busy ? t('creating') : t('start'));
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
  const match = brief?.match(/^- (?:类型：|Type:\s*)(doc|deck|video|page)$/m);
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
  state.revisedText = '';
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
    hostNotice.show(() => t('projectCreated'));
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
  if (seq !== reloadSeq || state.fresh || state.forceNew) return false;
  if (!kind) {
    // No work here: stay in the wizard, whatever the session events say.
    if (state.phase === 'work') {
      state.phase = 'wizard';
      state.kind = null;
      state.answers = { ...EMPTY_ANSWERS };
      state.touchedAnswers.clear();
      state.title = '';
      state.view = null;
      state.workFiles = null;
      render();
    }
    return false;
  }
  const stateRaw = await readText(STATE_FILE[kind]);
  if (seq !== reloadSeq || state.fresh || state.forceNew) return false;
  const view = stateRaw ? await collectFiles(kind, stateRaw) : null;
  if (seq !== reloadSeq || state.fresh || state.forceNew) return false;
  state.phase = 'work';
  state.kind = kind;
  state.workFiles = view;
  state.view = view ? readWorkView(kind, view, state.ready?.locale) : null;
  syncSentDecision(state.view);
  landWork();
  render();
  return true;
};

const firstMessage = (kind: Kind): string => {
  if (kind === 'page') return t('prompt.startWeb');
  const skill = { doc: 'superwriter', deck: 'superppt', video: 'supervideo' }[kind];
  return t('prompt.start', { skill });
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

const ownErrorText = (reason: string): string => {
  if (reason === '建项目失败') return t('reason.projectFailed');
  if (reason === '服务没有返回项目编号') return t('reason.projectIdMissing');
  return t('reason.sessionFailed');
};

const startCode = (code: string): string => {
  switch (code) {
    case 'SESSION_BUSY': return t('reason.sessionBusy');
    case 'NO_SESSION': return t('reason.noSession');
    case 'HOST_TIMEOUT': return t('reason.noResponse');
    case 'DISABLED': return t('reason.disabled');
    default: return t('reason.connection');
  }
};

const startFailText = (reason: string): string => t('startFailed', { reason });

const startWork = async (): Promise<void> => {
  if (!state.kind || state.busy || state.opening) return;
  const kind = state.kind;
  const title = sanitizeTitle(state.title || defaultTitle(kind, state.answers, state.ready?.locale));
  state.busy = true;
  hostNotice.show(() => t('creatingProject'));
  render();
  let projectId: string | null = null;
  try {
    const response = await host.request({
      method: 'POST',
      path: '/api/creation/projects',
      body: JSON.stringify({ kind, title, brief: briefMarkdown(kind, {
        ...state.answers,
        length: state.touchedAnswers.has('length') ? state.answers.length : t('default.length'),
        pages: state.touchedAnswers.has('pages') ? state.answers.pages : t('default.pages'),
      }, state.title, todayISO(), state.ready?.locale) }),
    });
    if (response.status >= 400) {
      const code = readError(response.body);
      if (response.status === 404 || code === 'NO_DIRECTORY') {
        hostNotice.show(() => t('permissionMissing'), 'error');
        return;
      }
      if (response.status === 400 && (code === 'unknown-kind' || code === 'brief-required')) {
        hostNotice.show(() => t('invalidBrief'), 'error');
        return;
      }
      throw new Error('建项目失败');
    }
    const created: { projectId?: string } = JSON.parse(response.body);
    if (!created.projectId) throw new Error('服务没有返回项目编号');
    projectId = created.projectId;
    const session = await host.startSession({
      providerId: 'creation',
      id: t('workLabel'),
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
      hostNotice.show(() => t('firstMessageFailed'), 'error');
    } else {
      hostNotice.show(() => t('projectOpening'));
    }
    state.forceNew = false;
    await reload();
  } catch (error) {
    if (projectId) {
      hostNotice.show(() => t('sessionFailed'), 'error');
    } else if (error instanceof HostRequestError && error.code === 'NO_DIRECTORY') {
      hostNotice.show(() => t('permissionMissing'), 'error');
    } else if (error instanceof HostRequestError) {
      hostNotice.show(() => startFailText(startCode(error.code)), 'error');
    } else if (error instanceof Error && OWN_ERRORS.has(error.message)) {
      hostNotice.show(() => startFailText(ownErrorText(error.message)), 'error');
    } else {
      hostNotice.show(() => startFailText(t('reason.connection')), 'error');
    }
  } finally {
    state.busy = false;
    render();
  }
};

const render = (): void => {
  const focused = document.activeElement;
  const editing = focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement ? focused : null;
  const control = editing?.dataset.control;
  const selection = editing ? [editing.selectionStart, editing.selectionEnd] : null;
  const openDetails = [...root.querySelectorAll('details')].map((details) => details.open);
  const scroll = document.documentElement.scrollTop;
  gate = null;
  root.replaceChildren();
  installStyles();
  const page = el('main', 'cr');
  page.append(renderHead(state.kind ? kindLabel(state.kind) : t('title')));
  page.append(state.phase === 'work' ? renderWork() : renderWizard());
  page.append(hostNotice.element);
  root.append(page);
  root.querySelectorAll('details').forEach((details, index) => { details.open = openDetails[index] ?? false; });
  if (control && selection) {
    const next = root.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-control="${control}"]`);
    next?.focus({ preventScroll: true });
    if (next && selection[0] !== null && selection[1] !== null) next.setSelectionRange(selection[0], selection[1]);
  }
  document.documentElement.scrollTop = scroll;
};

const renderWork = (): HTMLElement => {
  const wrap = el('div');
  if (!state.kind) return wrap;
  if (!state.view) {
    wrap.append(el(
      'p',
      'cr-sub',
      state.ready?.session ? t('started') : t('projectNoSession'),
    ));
    const open = el('button', 'cr-btn', t('openChat'));
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
    await host.compose({ text: t('editWork'), mode: 'replace' });
    await host.openSurface('chat');
  } catch {
    hostNotice.show(() => t('chatUnavailable'), 'error');
  }
};

const restartWork = (): void => {
  if (state.busy || state.opening) return;
  state.fresh = true;
  state.phase = 'wizard';
  state.kind = null;
  state.answers = { ...EMPTY_ANSWERS };
  state.touchedAnswers.clear();
  state.title = '';
  state.view = null;
  state.workFiles = null;
  hostNotice.clear();
  render();
};

const renderDelivered = (path: string): HTMLElement => {
  const card = el('section', 'cr-gate');
  card.append(el('h3', '', t('delivered')), el('p', 'cr-meta', path));
  const row = el('div', 'cr-row');
  if (state.view?.deliveredMedia) {
    const media = state.view.deliveredMedia;
    const preview = el('button', 'cr-btn', t('preview', { label: media.label }));
    preview.addEventListener('click', () => void previewFile(media.path, media.label));
    row.append(preview);
  }
  const edit = el('button', 'cr-primary', t('continueEditing'));
  edit.addEventListener('click', () => void continueWork());
  const talk = el('button', 'cr-btn', t('openChat'));
  talk.addEventListener('click', () => void openChat());
  const again = el('button', 'cr-btn', t('createAnother'));
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
    hostNotice.show(() => t('previewFailed', { label }), 'error');
  }
};

const renderGate = (view: WorkView): HTMLElement => {
  const card = el('section', 'cr-gate');
  const current = view.gate;
  if (!current) {
    card.append(el('p', 'cr-sub', t('followChat')));
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
      const button = el('button', 'cr-btn', t('preview', { label: media.label }));
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
        const chip = el('button', 'cr-chip', t('tier', { level }));
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
      details.append(el('summary', '', t('promptPreview')), el('pre', '', prompt));
      card.append(details);
    } else {
      card.append(el('p', 'cr-sub', t('noStylePrompt')));
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
    if (options.length === 0) card.append(el('p', 'cr-sub', t('noDirections')));
    else card.append(row);
    const selected = options.find((option) => option.id === webPick.directionId);
    if (selected?.detail) card.append(el('p', 'cr-sub', selected.detail));
  }
  if (current.key === 'web-acceptance') {
    const row = el('div', 'cr-row');
    for (const action of ['accept', 'rework'] as const) {
      const chip = el('button', 'cr-chip', action === 'accept' ? t('acceptDeliver') : t('rework'));
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
  revise.append(el('summary', '', t('reviseStep')));
  const reviseInput = el('textarea');
  reviseInput.dataset.control = 'revision';
  reviseInput.value = state.revisedText;
  reviseInput.addEventListener('input', () => { state.revisedText = reviseInput.value; });
  reviseInput.placeholder = t('revisePlaceholder');
  const reviseButton = el('button', 'cr-btn', t('submitRevision'));
  reviseButton.addEventListener('click', async () => {
    const value = reviseInput.value.trim();
    if (!value || state.busy) return;
    state.busy = true;
    render();
    try {
      const result = await host.prompt({ text: t('revisionPrompt', { title: current.title, value }), send: true });
      if (result.sent !== 'sent') {
        hostNotice.show(() => failText(result.sent === 'no-model' ? t('reason.noModel') : t('reason.rejected')), 'error');
      } else {
        state.revisedText = '';
        reviseInput.value = '';
        hostNotice.show(() => t('revisionSent'));
      }
    } catch (error) {
      hostNotice.show(() => failText(failReason(error instanceof Error ? error : null)), 'error');
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
    state.ready?.locale,
  );
  // A gate whose exact confirmation cannot be composed has no button to press:
  // the skill's state machine only accepts the precise tuple.
  if (!message) {
    // The style card already says the selection has no published prompt.
    if (current.key !== 'deck-style' && current.key !== 'web-full') card.append(el('p', 'cr-sub', t('confirmInChat')));
    return card;
  }
  const sessionBusy = state.ready?.session?.busy === true;
  // The line stays in place while idle so the buttons do not jump when the agent starts.
  card.append(el('p', 'cr-meta', sessionBusy ? t('aiBusy') : ''));
  const row = el('div', 'cr-row');
  const canSend = Boolean(state.ready?.session);
  const label = current.key === 'deck-style'
    ? t('generateSample')
    : current.key === 'deck-sample'
      ? t('approveSampleDeck')
      : current.key === 'deck-deliver'
        ? t('confirmDelivery')
        : current.key === 'web-direction'
          ? t('confirmDirection')
          : current.key === 'web-sample'
            ? t('approveSamplePage')
            : current.key === 'web-acceptance'
              ? webPick.action === 'rework' ? t('submitRework') : t('approveAcceptance')
              : t('confirmObject', { label: current.object?.label ?? t('thisStep') });
  const decisionId = current.decisionId ?? null;
  const sent = decisionId !== null && state.sentDecision === decisionId;
  const confirm = el('button', 'cr-primary', sent ? t('sent') : canSend ? label : t('confirmViaChat'));
  confirm.disabled = state.busy || sent || sessionBusy;
  confirm.addEventListener('click', () => {
    if (!canSend) {
      hostNotice.show(() => t('openSessionFirst'));
      void openChat();
      return;
    }
    void sendConfirm(message, decisionId);
  });
  row.append(confirm);
  const talk = el('button', 'cr-btn', t('openChat'));
  talk.addEventListener('click', () => void openChat());
  row.append(talk);
  card.append(row);
  return card;
};

const failText = (reason: string): string => t('sendFailed', { reason });

const failReason = (error: Error | null): string => {
  const code = error instanceof HostRequestError ? error.code : undefined;
  switch (code) {
    case 'SESSION_BUSY': return t('reason.busy');
    case 'NO_SESSION': return t('reason.noWorkSession');
    case 'HOST_TIMEOUT': return t('reason.timeout');
    case 'NOT_GRANTED': return t('reason.noPermission');
    default: return t('reason.connection');
  }
};

const sendConfirm = async (message: string | null, decisionId: string | null): Promise<void> => {
  if (!message || state.busy) return;
  state.busy = true;
  hostNotice.show(() => t('sent'));
  render();
  try {
    const result = await host.prompt({ text: message, send: true });
    if (result.sent !== 'sent') {
      hostNotice.show(() => failText(result.sent === 'no-model' ? t('reason.noModel') : t('reason.rejected')), 'error');
      return;
    }
    state.sentDecision = decisionId;
  } catch (error) {
    hostNotice.show(() => failText(failReason(error instanceof Error ? error : null)), 'error');
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
    hostNotice.show(() => t('closeFailed'), 'error');
  }
};

let lastSession: SessionSnapshot | null | undefined;
let lastLifecycle: SessionLifecycleEvent | null = null;
host.onSessionLifecycle((event) => {
  if (event.sessionId === lastLifecycle?.sessionId && event.phase === lastLifecycle.phase) return;
  lastLifecycle = event;
  if (event.phase === 'completed' || event.phase === 'failure') void reload();
});
host.onSession((session) => {
  const changed = lastSession === undefined || lastSession?.id !== session?.id || lastSession?.busy !== session?.busy;
  lastSession = session;
  if (state.ready) state.ready = { ...state.ready, session };
  if (!changed) return;
  lastLifecycle = null;
  void reload();
});
let lastDirectory: string | null | undefined;
host.onDirectory((directory) => {
  if (directory === lastDirectory) return;
  lastDirectory = directory;
  if (state.ready) state.ready = { ...state.ready, directory };
  state.fresh = false;
  void reload();
});

host.onReady((ready) => {
  const previous = state.ready;
  state.ready = ready;
  if (state.kind && state.workFiles) state.view = readWorkView(state.kind, state.workFiles, ready.locale);
  document.documentElement.lang = creationLocale(ready.locale);
  document.title = t('title');
  document.documentElement.dataset.surface = ready.surface;
  applyHostReady(ready, document.documentElement);
  if (!previous || previous.directory !== ready.directory) hostNotice.clear();
  else hostNotice.refresh();
  render();
  if (!previous || previous.directory !== ready.directory) void reload();
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
  state.touchedAnswers.clear();
  state.title = '';
  state.view = null;
  state.workFiles = null;
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
