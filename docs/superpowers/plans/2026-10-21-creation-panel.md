# Creation Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A 创作 rail panel that creates one project per work, runs a three-question intake, starts the right bundled skill, and mirrors that skill's own stage and approval gate beside the chat.

**Architecture:** A new first-party built-in extension owns one rail panel. It reads the three skills' own state files in the work project and renders a per-mode view model. Creation goes through one allowlisted internal request that builds the directory and writes `需求.md` server-side, then the panel starts a session in the new project. The panel never writes skill state; every confirmation is a chat message naming the object and version the user saw.

**Tech Stack:** TypeScript panel bundled as an IIFE (`@openchamber/sdk`, `@openchamber/sdk/ui`), plain DOM with host theme tokens, Bun tests, Express server route on the guest request channel, Vitest for server modules.

**Spec:** `docs/specs/2026-10-21-creation-panel.md`

**Corrections found during implementation:** SuperPPT's `pendingDecision.kind` carries the stage (`plan-review`, `sample-review`, `deck-review`), not the decision action named in the original draft of Task 2; the reader keys on the stage and the fixture uses a real stage. The first session after creation needs one settings resync in `startGuestSession` before the newly created project id resolves, because the client project store has not seen the server-side activation yet. Both corrections are in the code and its tests.

## Global Constraints

- Work root is `~/Documents/SuperWagie`, categories are `文档`, `PPT`, `视频`, `网页`, work folders are `<title> <YYYY-MM-DD>` under a category.
- Titles replace `/ \ : * ? " < > |` with `-`, collapse whitespace, drop leading dots, truncate at 40 characters.
- One work is one project. The category folder is never a project.
- The panel reads `协作状态.json`, `superppt.json` and `project.json` as they are. It never writes them, never invents a percentage, and shows 以对话为准 when a file is missing, truncated or from an unknown schema.
- Confirmations are chat messages carrying the object id, version and revision shown to the user. No version means no confirm button.
- All four types are equal. No type is recommended, hidden or ordered by importance.
- Panel copy is Chinese, matches the workbench's tone, and fits 320px. Decks, videos and HTML review pages open in chat, never inside the panel.
- No dependencies are added to `packages/extensions/creation`.
- Do not run git or GitHub commands in this repository unless the maintainer asks. The pre-commit gate is `bun run check:changed`.
- The working tree already contains an uncommitted change in `packages/web/server/lib/guests/routes.js` that moves the `!guest.integration` refusal after the local allowlist branches. Preserve it; the creation request depends on it.

---

### Task 1: Panel package, shell and intake wizard

**Files:**
- Create: `packages/extensions/creation/package.json`
- Create: `packages/extensions/creation/panel/index.html`
- Create: `packages/extensions/creation/panel/styles.ts`
- Create: `packages/extensions/creation/panel/wizard.ts`
- Create: `packages/extensions/creation/panel/wizard.test.ts`
- Create: `packages/extensions/creation/panel/app.ts`
- Modify: `packages/extensions/registry.json`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `Kind`, `Answers`, `EMPTY_ANSWERS`, `AUDIENCES`, `SCREENS`, `canAdvance(kind, screen, answers)`, `sanitizeTitle(value)`, `defaultTitle(kind, answers)`, `todayISO(date?)`, `workFolder(title, date?)`, `workPathLabel(kind, title, date?)`, `briefMarkdown(kind, answers, date?)` from `panel/wizard.ts`; `installStyles()`, `el(tag, className?, text?)`, `notice()` from `panel/styles.ts`.

- [ ] **Step 1: Write the failing wizard tests**

`packages/extensions/creation/panel/wizard.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';

import {
  EMPTY_ANSWERS,
  briefMarkdown,
  canAdvance,
  defaultTitle,
  sanitizeTitle,
  todayISO,
  workFolder,
  workPathLabel,
  type Answers,
} from './wizard.ts';

const answers = (overrides: Partial<Answers> = {}): Answers => ({ ...EMPTY_ANSWERS, ...overrides });

describe('sanitizeTitle', () => {
  test('replaces path and shell punctuation', () => {
    expect(sanitizeTitle('2026/季度:汇报*草稿?')).toBe('2026-季度-汇报-草稿-');
  });
  test('collapses whitespace and trims', () => {
    expect(sanitizeTitle('  季度   汇报  ')).toBe('季度 汇报');
  });
  test('drops leading dots and caps at 40 characters', () => {
    expect(sanitizeTitle('..hidden')).toBe('hidden');
    expect(sanitizeTitle('长'.repeat(60))).toHaveLength(40);
  });
  test('falls back to a placeholder instead of an empty name', () => {
    expect(sanitizeTitle('   ')).toBe('未命名');
  });
});

describe('workFolder', () => {
  test('puts the date after the title', () => {
    expect(workFolder('季度汇报', '2026-10-21')).toBe('季度汇报 2026-10-21');
  });
  test('labels the folder under its category', () => {
    expect(workPathLabel('deck', '季度汇报', '2026-10-21')).toBe('文稿/SuperWagie/PPT/季度汇报 2026-10-21');
  });
});

describe('todayISO', () => {
  test('pads month and day', () => {
    expect(todayISO(new Date(2026, 0, 5))).toBe('2026-01-05');
  });
});

describe('defaultTitle', () => {
  test('uses the first line of the content', () => {
    expect(defaultTitle('doc', answers({ content: '关于接口开放的技术方案\n第二行' }))).toBe('关于接口开放的技术方案');
  });
  test('falls back per kind', () => {
    expect(defaultTitle('video', answers())).toBe('新视频');
  });
});

describe('canAdvance', () => {
  test('needs content and an audience', () => {
    expect(canAdvance('doc', 'content', answers())).toBe(false);
    expect(canAdvance('doc', 'content', answers({ content: '技术方案' }))).toBe(true);
    expect(canAdvance('doc', 'audience', answers({ content: '技术方案' }))).toBe(false);
    expect(canAdvance('doc', 'audience', answers({ content: '技术方案', audience: '客户' }))).toBe(true);
  });
  test('asks a different third question per kind', () => {
    const base = answers({ content: '季度汇报', audience: '同事' });
    expect(canAdvance('doc', 'shape', base)).toBe(true);
    expect(canAdvance('deck', 'shape', base)).toBe(false);
    expect(canAdvance('deck', 'shape', { ...base, occasion: '季度评审' })).toBe(true);
    expect(canAdvance('video', 'shape', { ...base, outcome: '看懂三个卖点' })).toBe(true);
    expect(canAdvance('page', 'shape', { ...base, webGoal: '预约试用' })).toBe(true);
  });
});

describe('briefMarkdown', () => {
  test('records the kind in a line the panel can read back', () => {
    const brief = briefMarkdown('deck', answers({ content: '季度汇报', audience: '客户', occasion: '季度评审', pages: '12 页' }), '2026-10-21');
    expect(brief.startsWith('# 季度汇报\n')).toBe(true);
    expect(brief).toContain('- 类型：deck');
    expect(brief).toContain('- 给谁看：客户');
    expect(brief).toContain('- 场合：季度评审');
    expect(brief).toContain('- 创建时间：2026-10-21');
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test packages/extensions/creation/panel/wizard.test.ts`
Expected: FAIL with `Cannot find module './wizard.ts'`.

- [ ] **Step 3: Write `wizard.ts`**

```ts
export const KINDS = ['doc', 'deck', 'video', 'page'] as const;
export type Kind = (typeof KINDS)[number];

export const KIND_LABEL: Record<Kind, string> = {
  doc: '写文档',
  deck: '做 PPT',
  video: '做视频',
  page: '做网页',
};

export const KIND_HINT: Record<Kind, string> = {
  doc: '标书、方案、报告、白皮书',
  deck: '汇报、路演、培训',
  video: '讲解片、绘本、教程',
  page: '落地页、作品集、小工具',
};

export const CATEGORY: Record<Kind, string> = { doc: '文档', deck: 'PPT', video: '视频', page: '网页' };

export type Answers = {
  content: string;
  audience: string;
  docType: string;
  length: string;
  occasion: string;
  pages: string;
  outcome: string;
  webGoal: string;
};

export const EMPTY_ANSWERS: Answers = {
  content: '',
  audience: '',
  docType: '方案',
  length: '中等，6 到 10 页',
  occasion: '',
  pages: '10 页左右',
  outcome: '',
  webGoal: '',
};

export const AUDIENCES = ['自己', '同事', '客户', '学生', '其他'] as const;
export const DOC_TYPES = ['标书', '方案', '报告', '白皮书', '其他'] as const;

export type ScreenID = 'content' | 'audience' | 'shape' | 'confirm';
export const SCREENS: readonly ScreenID[] = ['content', 'audience', 'shape', 'confirm'];

export const canAdvance = (kind: Kind, screen: ScreenID, answers: Answers): boolean => {
  if (screen === 'content') return answers.content.trim().length >= 2;
  if (screen === 'audience') return answers.audience.trim().length > 0;
  if (screen === 'shape') {
    if (kind === 'doc') return Boolean(answers.docType);
    if (kind === 'deck') return Boolean(answers.occasion.trim());
    if (kind === 'video') return Boolean(answers.outcome.trim());
    return Boolean(answers.webGoal.trim());
  }
  return true;
};

export const sanitizeTitle = (value: string): string => {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 40)
    .trim();
  return cleaned || '未命名';
};

export const todayISO = (date = new Date()): string => {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

export const defaultTitle = (kind: Kind, answers: Answers): string => {
  const first = answers.content.trim().split('\n')[0] ?? '';
  const subject = first.replace(/^#+\s*/, '').slice(0, 24).trim();
  if (subject) return subject;
  return ({ doc: '新文档', deck: '新 PPT', video: '新视频', page: '新网页' } as const)[kind];
};

export const workFolder = (title: string, date = todayISO()): string => `${sanitizeTitle(title)} ${date}`;

export const workPathLabel = (kind: Kind, title: string, date = todayISO()): string =>
  `文稿/SuperWagie/${CATEGORY[kind]}/${workFolder(title, date)}`;

const shapeLines = (kind: Kind, answers: Answers): string[] => {
  if (kind === 'doc') return [`- 文档类型：${answers.docType}`, `- 篇幅：${answers.length}`];
  if (kind === 'deck') return [`- 场合：${answers.occasion}`, `- 页数：${answers.pages}`];
  if (kind === 'video') return [`- 看完能做到：${answers.outcome}`];
  return [`- 访客要完成：${answers.webGoal}`];
};

export const briefMarkdown = (kind: Kind, answers: Answers, date = todayISO()): string => {
  const title = sanitizeTitle(defaultTitle(kind, answers));
  return [
    `# ${title}`,
    '',
    `- 类型：${kind}`,
    `- 给谁看：${answers.audience}`,
    ...shapeLines(kind, answers),
    `- 创建时间：${date}`,
    '',
    '## 用户原话',
    '',
    answers.content.trim(),
    '',
  ].join('\n');
};
```

- [ ] **Step 4: Run the tests again**

Run: `bun test packages/extensions/creation/panel/wizard.test.ts`
Expected: PASS. If `sanitizeTitle('2026/季度:汇报*草稿?')` differs, adjust only the expected string, not the rules.

- [ ] **Step 5: Write the presentation helpers**

`packages/extensions/creation/panel/styles.ts` follows the workbench's `shared.ts` shape: an `installStyles()` that injects one `<style id="creation-style">`, an `el()` helper, and a `notice()` with a reserved line.

```ts
const css = `
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--oc-bg);color:var(--oc-fg);font-family:var(--oc-font);font-size:14px;line-height:1.5}
body{overflow-wrap:anywhere}
button,input,textarea{font:inherit;color:inherit}
:root{
  --cr-panel:color-mix(in srgb,var(--oc-fg) 4%,var(--oc-bg));
  --cr-border:color-mix(in srgb,var(--oc-fg) 13%,transparent);
  --cr-rule:color-mix(in srgb,var(--oc-fg) 8%,transparent);
  --cr-muted:color-mix(in srgb,var(--oc-fg) 62%,var(--oc-bg));
  --cr-faint:color-mix(in srgb,var(--oc-fg) 42%,var(--oc-bg));
  --cr-accent:var(--oc-primary,#146b63);
  --cr-radius:16px;
}
:root[data-oc-theme="dark"]{--cr-border:color-mix(in srgb,var(--oc-fg) 16%,transparent)}
.cr{padding:14px 12px 20px;display:flex;flex-direction:column;gap:12px;min-height:100%}
.cr h2{font-family:"Songti SC","Noto Serif SC",Georgia,serif;font-size:17px;font-weight:600;margin:0;letter-spacing:-.01em}
.cr-sub{color:var(--cr-muted);font-size:12px;margin:0}
.cr-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px}
.cr-kind{display:flex;flex-direction:column;gap:8px}
.cr-card{background:var(--cr-panel);border:0;border-radius:var(--cr-radius);padding:12px 14px;text-align:left;cursor:pointer;display:flex;flex-direction:column;gap:2px}
.cr-card:hover{background:color-mix(in srgb,var(--oc-fg) 7%,var(--oc-bg))}
.cr-card b{font-size:14px;font-weight:600}
.cr-card span{font-size:12px;color:var(--cr-muted)}
.cr-steps{display:flex;flex-wrap:wrap;gap:4px;list-style:none;padding:0;margin:0;font-size:11px;color:var(--cr-faint)}
.cr-steps li{padding:2px 6px;border-radius:6px}
.cr-steps li[data-state="done"]{color:var(--cr-muted)}
.cr-steps li[data-state="done"]::before{content:"✓ "}
.cr-steps li[data-state="now"]{background:var(--cr-accent);color:var(--oc-primary-fg,var(--oc-bg));font-weight:600}
.cr-gate{background:var(--cr-panel);border-radius:var(--cr-radius);padding:14px;display:flex;flex-direction:column;gap:10px}
.cr-gate h3{margin:0;font-size:14px;font-weight:600}
.cr-excerpt{font-size:12px;color:var(--cr-muted);margin:0;white-space:pre-wrap;max-height:9.5em;overflow:auto}
.cr-row{display:flex;gap:6px;flex-wrap:wrap}
.cr-primary{background:var(--cr-accent);color:var(--oc-primary-fg,var(--oc-bg));border:0;border-radius:9px;padding:7px 12px;font-size:12px;font-weight:600;cursor:pointer}
.cr-primary:disabled{opacity:.5;cursor:default}
.cr-btn{background:transparent;border:1px solid var(--cr-border);border-radius:9px;padding:6px 10px;font-size:12px;cursor:pointer}
.cr-field{display:flex;flex-direction:column;gap:6px}
.cr-field label{font-size:11px;color:var(--cr-muted)}
.cr-field textarea,.cr-field input{width:100%;border:1px solid var(--cr-border);border-radius:9px;padding:7px 9px;background:var(--oc-bg);outline:none}
.cr-field textarea{min-height:96px;resize:vertical}
.cr-field input:focus,.cr-field textarea:focus{border-color:var(--cr-accent)}
.cr-chips{display:flex;gap:6px;flex-wrap:wrap}
.cr-chip{border:1px solid var(--cr-border);background:transparent;border-radius:999px;padding:5px 10px;font-size:12px;color:var(--cr-muted);cursor:pointer}
.cr-chip[aria-pressed="true"]{border-color:var(--cr-accent);color:var(--oc-fg)}
.cr-meta{font-family:var(--oc-mono);font-size:11px;color:var(--cr-muted);word-break:break-all}
.cr-note{font-size:12px;color:var(--cr-muted);padding:8px 10px;border-radius:9px;background:var(--cr-panel);min-height:34px}
.cr-note[data-tone="error"]{background:color-mix(in srgb,#a5342b 12%,transparent);color:#a5342b}
.cr-details summary{font-size:12px;color:var(--cr-muted);cursor:pointer}
.cr-details pre{font-family:var(--oc-mono);font-size:11px;white-space:pre-wrap;max-height:12em;overflow:auto;background:var(--oc-bg);padding:8px;border-radius:8px}
@media(max-width:360px){.cr{padding:10px 8px 16px}}
`;

export const installStyles = (): void => {
  if (document.getElementById('creation-style')) return;
  const style = document.createElement('style');
  style.id = 'creation-style';
  style.textContent = css;
  document.head.append(style);
};

export const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className = '', text = ''): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
};

export interface Notice {
  show: (text: string, tone?: 'info' | 'error') => void;
  clear: () => void;
  element: HTMLElement;
}

export const notice = (): Notice => {
  const node = el('div', 'cr-note');
  return {
    element: node,
    show: (text, tone = 'info') => {
      node.hidden = false;
      node.textContent = text;
      node.dataset.tone = tone;
    },
    clear: () => {
      node.hidden = true;
      node.textContent = '';
      delete node.dataset.tone;
    },
  };
};
```

- [ ] **Step 6: Write the panel HTML and manifest**

`packages/extensions/creation/panel/index.html`:

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <title>创作</title>
    <style>html, body { margin: 0; height: 100%; } #root { height: 100%; }</style>
  </head>
  <body><div id="root"></div><script src="index.js"></script></body>
</html>
```

`packages/extensions/creation/package.json`:

```json
{
  "name": "@openchamber/builtin-creation",
  "version": "1.0.0",
  "private": true,
  "description": "Guided creation of documents, decks, videos and pages.",
  "openchamber": {
    "apiVersion": 1,
    "engines": {
      "openchamber": ">=2.5.0"
    },
    "contributes": {
      "panel": {
        "id": "openchamber-builtin-creation",
        "name": "创作",
        "icon": "quill-pen",
        "entry": "panel/index.html"
      },
      "capabilities": ["files", "prompt", "sessions"]
    }
  }
}
```

- [ ] **Step 7: Write the first `app.ts` with the type cards and the wizard**

The file is deliberately split so later tasks add the running view without rewriting the wizard. Write the whole file now; the running view arrives in Task 2.

```ts
import { connectHost, type HostReadyContext } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';

import {
  AUDIENCES,
  DOC_TYPES,
  EMPTY_ANSWERS,
  KIND_HINT,
  KIND_LABEL,
  KINDS,
  SCREENS,
  briefMarkdown,
  canAdvance,
  defaultTitle,
  sanitizeTitle,
  todayISO,
  workPathLabel,
  type Answers,
  type Kind,
  type ScreenID,
} from './wizard.ts';
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
  screen: ScreenID;
  answers: Answers;
  title: string;
  busy: boolean;
};

const state: State = {
  ready: null,
  phase: 'wizard',
  kind: null,
  screen: 'content',
  answers: { ...EMPTY_ANSWERS },
  title: '',
  busy: false,
};

const renderHead = (title: string): HTMLElement => {
  const head = el('div', 'cr-head');
  head.append(el('h2', '', title));
  if (state.phase === 'wizard' && state.kind) {
    const restart = el('button', 'cr-btn', '重来');
    restart.addEventListener('click', () => {
      state.kind = null;
      state.screen = 'content';
      state.answers = { ...EMPTY_ANSWERS };
      state.title = '';
      hostNotice.clear();
      render();
    });
    head.append(restart);
  }
  return head;
};

const render = (): void => {
  root.replaceChildren();
  installStyles();
  const page = el('main', 'cr');
  page.append(renderHead(state.kind ? KIND_LABEL[state.kind] : '创作'));
  page.append(renderWizard());
  page.append(hostNotice.element);
  root.append(page);
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
      state.screen = 'content';
      state.answers = { ...EMPTY_ANSWERS };
      state.title = '';
      render();
    });
    list.append(card);
  }
  wrap.append(list);
  return wrap;
};

const field = (label: string, value: string, onChange: (next: string) => void, multiline = false): HTMLElement => {
  const box = el('div', 'cr-field');
  box.append(el('label', '', label));
  const input = multiline ? el('textarea') : el('input');
  input.value = value;
  input.addEventListener('input', () => onChange(input.value));
  box.append(input);
  return box;
};

const chipRow = (values: readonly string[], selected: string, onPick: (next: string) => void): HTMLElement => {
  const row = el('div', 'cr-chips');
  for (const value of values) {
    const chip = el('button', 'cr-chip', value);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', String(value === selected));
    chip.addEventListener('click', () => onPick(value));
    row.append(chip);
  }
  return row;
};

const renderShape = (kind: Kind): HTMLElement => {
  const wrap = el('div');
  if (kind === 'doc') {
    wrap.append(el('p', 'cr-sub', '这份文件要按什么规矩写？'));
    wrap.append(chipRow(DOC_TYPES, state.answers.docType, (value) => {
      state.answers.docType = value;
      render();
    }));
    wrap.append(field('大概篇幅', state.answers.length, (value) => {
      state.answers.length = value;
    }));
  } else if (kind === 'deck') {
    wrap.append(el('p', 'cr-sub', '用在哪里？大概几页？'));
    wrap.append(field('场合，例如季度评审、客户路演', state.answers.occasion, (value) => {
      state.answers.occasion = value;
    }));
    wrap.append(field('大概页数', state.answers.pages, (value) => {
      state.answers.pages = value;
    }));
  } else if (kind === 'video') {
    wrap.append(el('p', 'cr-sub', '看完之后，观众应该能做什么或说出什么？'));
    wrap.append(field('看完能做到', state.answers.outcome, (value) => {
      state.answers.outcome = value;
    }, true));
  } else {
    wrap.append(el('p', 'cr-sub', '访客在页面上要完成什么？'));
    wrap.append(field('访客要完成', state.answers.webGoal, (value) => {
      state.answers.webGoal = value;
    }, true));
  }
  return wrap;
};

const renderWizard = (): HTMLElement => {
  if (!state.kind) return renderKinds();
  const wrap = el('div');
  const index = SCREENS.indexOf(state.screen);
  wrap.append(el('p', 'cr-sub', `${KIND_LABEL[state.kind]} · 第 ${index + 1} 步，共 4 步`));

  if (state.screen === 'content') {
    wrap.append(field('要做什么？可以贴原文、给一个文件路径，或只写一句主题', state.answers.content, (value) => {
      state.answers.content = value;
    }, true));
  } else if (state.screen === 'audience') {
    wrap.append(el('p', 'cr-sub', '给谁看？'));
    wrap.append(chipRow(AUDIENCES, state.answers.audience, (value) => {
      state.answers.audience = value;
      render();
    }));
  } else if (state.screen === 'shape') {
    wrap.append(renderShape(state.kind));
  } else {
    wrap.append(renderConfirm());
  }

  const row = el('div', 'cr-row');
  if (index > 0) {
    const back = el('button', 'cr-btn', '上一步');
    back.addEventListener('click', () => {
      state.screen = SCREENS[index - 1];
      render();
    });
    row.append(back);
  }
  if (state.screen !== 'confirm') {
    const next = el('button', 'cr-primary', '下一步');
    next.disabled = !canAdvance(state.kind, state.screen, state.answers);
    next.addEventListener('click', () => {
      state.screen = SCREENS[index + 1];
      if (state.screen === 'confirm') state.title = defaultTitle(state.kind!, state.answers);
      render();
    });
    row.append(next);
  } else {
    const start = el('button', 'cr-primary', state.busy ? '正在建…' : '开始');
    start.disabled = state.busy;
    start.addEventListener('click', () => void startWork());
    row.append(start);
  }
  wrap.append(row);
  return wrap;
};
```

`renderConfirm` (the start button calls `startWork`, which is a stub in this task and is completed in Task 5):

```ts
const renderConfirm = (): HTMLElement => {
  if (!state.kind) return el('div');
  const kind = state.kind;
  const wrap = el('div');
  wrap.append(el('p', 'cr-sub', '看一眼，然后开始。'));
  const nameBox = el('div', 'cr-field');
  nameBox.append(el('label', '', '名字，会变成文件夹'));
  const nameInput = el('input');
  nameInput.value = sanitizeTitle(state.title);
  const pathLine = el('div', 'cr-meta', workPathLabel(kind, nameInput.value, todayISO()));
  nameInput.addEventListener('input', () => {
    state.title = nameInput.value;
    pathLine.textContent = workPathLabel(kind, sanitizeTitle(nameInput.value), todayISO());
  });
  nameBox.append(nameInput);
  wrap.append(nameBox, pathLine);
  const defaults = state.kind === 'doc'
    ? '加载 SuperWriter · 交付 DOCX 和 PDF'
    : state.kind === 'deck'
      ? '加载 SuperPPT · 16:9 · 风格稍后选'
      : state.kind === 'video'
        ? '加载 SuperVideo · 百炼旁白 · 横屏 · 先不加音乐'
        : '直接开始 · 不加载创作技能';
  wrap.append(el('p', 'cr-sub', defaults));
  return wrap;
};
```

`startWork` is a stub in this task:

```ts
const startWork = async (): Promise<void> => {
  hostNotice.show('下一步：建项目和开会话，将在接入服务后可用。', 'error');
};
```

- [ ] **Step 8: Wire the host**

```ts
host.onReady((ready) => {
  state.ready = ready;
  applyHostReady(ready, document.documentElement);
  hostNotice.clear();
  render();
});
```

The panel must still render before `ready` so it never shows a blank frame:

```ts
render();
```

- [ ] **Step 9: Register the package and build it**

`packages/extensions/registry.json` gains:

```json
{
  "id": "openchamber-builtin-creation",
  "directory": "creation",
  "files": ["panel/index.html"],
  "build": [
    { "entry": "panel/app.ts", "out": "panel/index.js", "target": "browser" }
  ]
}
```

Run: `bun run extensions:build`
Expected: exits 0; `packages/web/server/built-in-extensions/creation/panel/index.js` exists.

- [ ] **Step 10: Check the panel in the app**

Run: `bun run dev` and open the 创作 rail icon. Expected: the four cards; each opens the four-screen wizard; Back keeps answers; the confirm screen shows the folder under `文稿/SuperWagie/<category>/`.

---

### Task 2: Deck view model

**Files:**
- Create: `packages/extensions/creation/panel/readers.ts`
- Create: `packages/extensions/creation/panel/readers.test.ts`
- Create: `packages/extensions/creation/panel/fixtures/superppt.json`
- Create: `packages/extensions/creation/panel/fixtures/plan.json`
- Create: `packages/extensions/creation/panel/fixtures/sample-prompts.json`

**Interfaces:**
- Consumes: `Kind` from `./wizard.ts`.
- Produces: `WorkView`, `Gate`, `GateChoice`, `Step`, `FileRequest`, `readWorkView(kind, files)`, `workFilePaths(kind, stateRaw)`, `confirmMessage(kind, gate, choice?)` from `./readers.ts`.

The fixture `superppt.json` is a real `superppt.json` trimmed to the fields the panel reads:

```json
{
  "schemaVersion": "superppt-task-vnext",
  "projectId": "11111111-1111-4111-8111-111111111111",
  "title": "季度汇报",
  "contentRevision": "22222222-2222-4222-8222-222222222222",
  "stage": "plan-review",
  "sourcePath": "source.json",
  "planPath": "planning/22222222-2222-4222-8222-222222222222/plan.json",
  "styleLockPath": null,
  "activeJobId": null,
  "currentDeck": null,
  "pendingDecision": { "id": "33333333-3333-4333-8333-333333333333", "kind": "select-style-and-generate-sample" },
  "editSessionPath": null,
  "delivery": null,
  "work": null,
  "lastResult": null,
  "lastDecision": null,
  "dependenciesPath": null
}
```

`plan.json` (trimmed PlanBundle):

```json
{
  "brief": { "title": "季度汇报", "audience": "客户" },
  "outline": { "narrative": "三个卖点" },
  "slides": [
    { "slideId": "s1", "title": "封面", "coreMessage": "开场" },
    { "slideId": "s2", "title": "三个卖点", "coreMessage": "结论" }
  ],
  "styles": [
    {
      "id": "glass", "name": "玻璃",
      "tiers": [{ "level": 1 }, { "level": 2 }, { "level": 3 }],
      "palettes": [{ "id": "cool", "name": "偏冷" }, { "id": "mid", "name": "基准" }, { "id": "warm", "name": "偏暖" }]
    },
    {
      "id": "ink", "name": "水墨",
      "tiers": [{ "level": 1 }, { "level": 2 }, { "level": 3 }],
      "palettes": [{ "id": "cool", "name": "偏冷" }, { "id": "mid", "name": "基准" }, { "id": "warm", "name": "偏暖" }]
    }
  ],
  "representativeSlideId": "s2"
}
```

`sample-prompts.json`:

```json
{ "glass/2/cool": "完整提示词：玻璃，2 档，偏冷。" }
```

- [ ] **Step 1: Write the failing deck tests**

```ts
import { describe, expect, test } from 'bun:test';

import { confirmMessage, readWorkView, workFilePaths } from './readers.ts';

import plan from './fixtures/plan.json';
import prompts from './fixtures/sample-prompts.json';
import state from './fixtures/superppt.json';

const deck = () => {
  const view = readWorkView('deck', { state: JSON.stringify(state), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts) });
  if (!view) throw new Error('expected a deck view');
  return view;
};

describe('deck view', () => {
  test('maps plan-review to the selection gate', () => {
    const view = deck();
    expect(view.steps.map((step) => [step.label, step.state])).toEqual([
      ['方案', 'done'], ['选款', 'now'], ['样页', 'next'], ['整套', 'next'], ['交付', 'next'],
    ]);
    expect(view.gate?.key).toBe('deck-style');
    expect(view.gate?.title).toBe('选风格');
    expect(view.gate?.choices).toHaveLength(2);
    expect(view.gate?.choices?.[0]).toMatchObject({ styleId: 'glass', styleName: '玻璃', levels: [1, 2, 3] });
  });

  test('builds the exact tuple message from the selection', () => {
    const view = deck();
    const gate = view.gate;
    if (!gate) throw new Error('expected a gate');
    expect(confirmMessage('deck', gate, { styleId: 'glass', level: 2, paletteId: 'cool' })).toBe(
      `方案版本：${state.contentRevision}；决定编号：${state.pendingDecision.id}；选择玻璃，2 档，偏冷（glass/2/cool）；授权新增生图调用：1 次。`,
    );
  });

  test('refuses a selection whose prompt was not published', () => {
    const view = deck();
    const gate = view.gate;
    if (!gate) throw new Error('expected a gate');
    expect(confirmMessage('deck', gate, { styleId: 'glass', level: 3, paletteId: 'warm' })).toBeNull();
  });

  test('names the files it needs', () => {
    expect(workFilePaths('deck', JSON.stringify(state))).toEqual({
      plan: 'planning/22222222-2222-4222-8222-222222222222/plan.json',
      prompts: 'planning/22222222-2222-4222-8222-222222222222/sample-prompts.json',
    });
  });

  test('reports delivered with the current file', () => {
    const delivered = { ...state, stage: 'delivered', pendingDecision: null, delivery: { revisionId: 'r', relativePath: '交付/季度汇报.pptx', sha256: 'a'.repeat(64) } };
    const view = readWorkView('deck', { state: JSON.stringify(delivered), plan: JSON.stringify(plan), prompts: JSON.stringify(prompts) });
    expect(view?.deliveredPath).toBe('交付/季度汇报.pptx');
    expect(view?.steps.at(-1)?.state).toBe('now');
  });

  test('returns null for unknown or broken state', () => {
    expect(readWorkView('deck', { state: '{', plan: null, prompts: null })).toBeNull();
    expect(readWorkView('deck', { state: JSON.stringify({ ...state, schemaVersion: 'next' }), plan: null, prompts: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test packages/extensions/creation/panel/readers.test.ts`
Expected: FAIL with `Cannot find module './readers.ts'`.

- [ ] **Step 3: Write the shared types and the deck reader**

```ts
import type { Kind } from './wizard.ts';

export type StepState = 'done' | 'now' | 'next';
export type Step = { id: string; label: string; state: StepState };

export type GateChoice = {
  styleId: string;
  styleName: string;
  levels: number[];
  palettes: Array<{ id: string; name: string }>;
};

export type Gate = {
  key: 'deck-style' | 'deck-sample' | 'deck-deliver' | 'doc-review' | 'video-script' | 'video-sample' | 'video-final';
  title: string;
  excerpt: string;
  version: string;
  revision?: string;
  decisionId?: string;
  object?: { id: string; version: number; label: string };
  choices?: GateChoice[];
  prompts?: Record<string, string>;
};

export type WorkView = {
  kind: Kind;
  steps: Step[];
  gate: Gate | null;
  deliveredPath: string | null;
  note: string | null;
};

export type WorkFiles = { state?: string | null; plan?: string | null; prompts?: string | null; artifact?: string | null };
type Choice = { styleId: string; level: number; paletteId: string };

const steps = (labels: string[], current: number): Step[] =>
  labels.map((label, index) => ({ id: `${index}`, label, state: index < current ? 'done' : index === current ? 'now' : 'next' }));

const parse = (raw: string | null | undefined): Record<string, unknown> | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const DECK_STEPS = ['方案', '选款', '样页', '整套', '交付'];
const DECK_STAGE_INDEX: Record<string, number> = {
  planning: 0,
  'plan-review': 1,
  'sample-generation': 2,
  'sample-review': 2,
  'deck-generation': 3,
  'deck-qa': 3,
  'deck-review': 3,
  delivered: 4,
};

const deckChoices = (plan: Record<string, unknown> | null): GateChoice[] => {
  const styles = Array.isArray(plan?.styles) ? plan.styles : [];
  return styles.flatMap((entry) => {
    const style = record(entry);
    if (!style) return [];
    const tiers = Array.isArray(style.tiers) ? style.tiers : [];
    const palettes = Array.isArray(style.palettes) ? style.palettes : [];
    return [{
      styleId: text(style.id),
      styleName: text(style.name) || text(style.id),
      levels: tiers.map((tier) => Number(record(tier)?.level)).filter((level) => Number.isInteger(level)),
      palettes: palettes.flatMap((palette) => {
        const item = record(palette);
        return item ? [{ id: text(item.id), name: text(item.name) || text(item.id) }] : [];
      }),
    }];
  }).filter((choice) => choice.styleId && choice.levels.length > 0 && choice.palettes.length > 0);
};

const deckView = (stateRaw: string, files: WorkFiles): WorkView | null => {
  const state = parse(stateRaw);
  if (!state || state.schemaVersion !== 'superppt-task-vnext') return null;
  const stage = text(state.stage);
  const index = DECK_STAGE_INDEX[stage];
  if (index === undefined) return null;
  const plan = parse(files.plan);
  const promptsRecord = parse(files.prompts);
  const prompts = promptsRecord
    ? Object.fromEntries(Object.entries(promptsRecord).filter(([, value]) => typeof value === 'string')) as Record<string, string>
    : {};
  const decision = record(state.pendingDecision);
  const kind = text(decision?.kind);
  const delivery = record(state.delivery);
  let gate: Gate | null = null;

  const revision = text(state.contentRevision);
  const decisionId = text(decision?.id);
  if (kind === 'select-style-and-generate-sample') {
    gate = {
      key: 'deck-style',
      title: '选风格',
      excerpt: `${text(record(plan?.brief)?.title) || text(state.title)} · ${Array.isArray(plan?.slides) ? plan.slides.length : 0} 页 · 选好后先生成 1 张样页`,
      version: `方案版本 ${revision} · 决定 ${decisionId}`,
      revision,
      decisionId,
      choices: deckChoices(plan),
      prompts,
    };
  } else if (kind === 'approve-sample-and-generate-deck') {
    gate = {
      key: 'deck-sample',
      title: '样页看过了吗',
      excerpt: '样页和整套预算在对话里刚展示过。确认后会生成剩下的页面。',
      version: `方案版本 ${revision} · 决定 ${decisionId}`,
      revision,
      decisionId,
    };
  } else if (kind === 'confirm-delivery') {
    gate = {
      key: 'deck-deliver',
      title: '确认交付',
      excerpt: text(record(state.currentDeck)?.relativePath) || '整套已经在对话里打开。',
      version: `方案版本 ${revision} · 决定 ${decisionId}`,
      revision,
      decisionId,
    };
  }

  return {
    kind: 'deck',
    steps: steps(DECK_STEPS, index),
    gate,
    deliveredPath: delivery ? text(delivery.relativePath) : null,
    note: null,
  };
};

export type FileRequest = { plan?: string; prompts?: string; artifact?: string };

export const workFilePaths = (kind: Kind, stateRaw: string): FileRequest => {
  const state = parse(stateRaw);
  if (!state) return {};
  if (kind === 'deck') {
    const revision = text(state.contentRevision);
    return {
      ...(text(state.planPath) ? { plan: text(state.planPath) } : {}),
      ...(revision ? { prompts: `planning/${revision}/sample-prompts.json` } : {}),
    };
  }
  if (kind === 'doc') {
    const objects = record(state.objects);
    const active = record(objects?.[text(state.active_object_id)]);
    return text(active?.path) ? { artifact: text(active?.path) } : {};
  }
  return {};
};

export const readWorkView = (kind: Kind, files: WorkFiles): WorkView | null => {
  if (kind === 'deck') return deckView(files.state ?? '', files);
  return null;
};

export const confirmMessage = (kind: Kind, gate: Gate, choice?: Choice): string | null => {
  if (kind !== 'deck') return null;
  if (!gate.revision || !gate.decisionId) return null;
  if (gate.key === 'deck-style') {
    if (!choice) return null;
    const key = `${choice.styleId}/${choice.level}/${choice.paletteId}`;
    if (!gate.prompts?.[key]) return null;
    const style = gate.choices?.find((entry) => entry.styleId === choice.styleId);
    const palette = style?.palettes.find((entry) => entry.id === choice.paletteId);
    if (!style || !palette) return null;
    return `方案版本：${gate.revision}；决定编号：${gate.decisionId}；选择${style.styleName}，${choice.level} 档，${palette.name}（${key}）；授权新增生图调用：1 次。`;
  }
  if (gate.key === 'deck-sample') {
    return `方案版本：${gate.revision}；决定编号：${gate.decisionId}；确认样页，生成整套。`;
  }
  return `方案版本：${gate.revision}；决定编号：${gate.decisionId}；确认交付当前完整 PPTX。`;
};
```

- [ ] **Step 4: Run the tests again**

Run: `bun test packages/extensions/creation/panel/readers.test.ts`
Expected: PASS.

- [ ] **Step 5: Render the deck running view**

In `app.ts`, import `readWorkView`, `workFilePaths` and `type WorkFiles` from `./readers.ts`, add `view: WorkView | null` to `State`, and add a `reload()` that reads `需求.md` to learn the kind, then the state file and the files `workFilePaths` names, then calls `readWorkView`. `reload` only changes the phase when the directory actually holds a brief, so a project switch cannot wipe a wizard in progress.

```ts
const readText = async (path: string): Promise<string | null> => {
  try {
    return (await host.readFile(path)).content;
  } catch {
    return null;
  }
};

const kindFromBrief = (brief: string | null): Kind | null => {
  const match = brief?.match(/^- 类型：(doc|deck|video|page)$/m);
  return match ? match[1] as Kind : null;
};

const reload = async (): Promise<void> => {
  const brief = await readText('需求.md');
  const kind = kindFromBrief(brief);
  if (!kind) {
    // No work here: stay in the wizard, whatever the session events say.
    if (state.phase === 'work') {
      state.phase = 'wizard';
      state.view = null;
      render();
    }
    return;
  }
  state.phase = 'work';
  state.kind = kind;
  if (kind === 'page') {
    state.view = null;
    render();
    return;
  }
  const stateRaw = await readText({ doc: '协作状态.json', deck: 'superppt.json', video: 'project.json' }[kind]);
  state.view = stateRaw ? readWorkView(kind, await collectFiles(kind, stateRaw)) : null;
  render();
};

const collectFiles = async (kind: Kind, stateRaw: string): Promise<WorkFiles> => {
  const request = workFilePaths(kind, stateRaw);
  const [plan, prompts, artifact] = await Promise.all([
    request.plan ? readText(request.plan) : Promise.resolve(null),
    request.prompts ? readText(request.prompts) : Promise.resolve(null),
    request.artifact ? readText(request.artifact) : Promise.resolve(null),
  ]);
  return { state: stateRaw, plan, prompts, artifact };
};
```

`render` now dispatches on the phase:

```ts
const render = (): void => {
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
    wrap.append(el('p', 'cr-sub', '已开始，等 AI 接手。'));
    const open = el('button', 'cr-btn', '打开对话');
    open.addEventListener('click', () => void openChat());
    wrap.append(open);
    return wrap;
  }
  wrap.append(renderStrip(state.view));
  wrap.append(renderGate(state.view));
  return wrap;
};

const renderStrip = (view: WorkView): HTMLElement => {
  const list = el('ol', 'cr-steps');
  for (const step of view.steps) {
    const item = el('li', '', step.label);
    item.dataset.state = step.state;
    list.append(item);
  }
  return list;
};
```

`openChat` is still a stub in this task and becomes real in Task 3. Call `void reload()` from the `onReady` handler and after a successful start, so a panel opened on an existing work project shows its stage immediately.

The gate card in this task shows the style pickers and a details block:

```ts
const renderGate = (view: WorkView): HTMLElement => {
  const card = el('section', 'cr-gate');
  const gate = view.gate;
  if (!gate) {
    card.append(el('p', 'cr-sub', view.deliveredPath ? `已交付：${view.deliveredPath}` : 'AI 正在处理，等它停下来。'));
    return card;
  }
  card.append(el('h3', '', gate.title), el('p', 'cr-excerpt', gate.excerpt), el('div', 'cr-meta', gate.version));
  if (gate.key === 'deck-style') {
    const choice = pickDeck(gate);
    for (const style of gate.choices ?? []) {
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
    const selected = gate.choices?.find((style) => style.styleId === choice.styleId);
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
    const prompt = gate.prompts?.[`${choice.styleId}/${choice.level}/${choice.paletteId}`];
    if (prompt) {
      const details = el('details', 'cr-details');
      details.append(el('summary', '', '将发送的提示词'), el('pre', '', prompt));
      card.append(details);
    }
  }
  const row = el('div', 'cr-row');
  const message = confirmMessage(view.kind, gate, gate.choices ? pickDeck(gate) : undefined);
  const confirm = el('button', 'cr-primary', gate.key === 'deck-style' ? '生成样页' : gate.key === 'deck-sample' ? '确认样片，做整套' : '确认交付');
  confirm.disabled = !message || state.busy;
  confirm.addEventListener('click', () => void sendConfirm(message));
  row.append(confirm);
  const talk = el('button', 'cr-btn', '打开对话');
  talk.addEventListener('click', () => void openChat());
  row.append(talk);
  card.append(row);
  return card;
};
```

`pickDeck` keeps the in-memory selection per gate:

```ts
const deckPick = { styleId: '', level: 1, paletteId: '' };
const pickDeck = (gate: Gate): typeof deckPick => {
  const first = gate.choices?.[0];
  if (!deckPick.styleId && first) {
    deckPick.styleId = first.styleId;
    deckPick.level = first.levels[0];
    deckPick.paletteId = first.palettes[1]?.id ?? first.palettes[0].id;
  }
  return deckPick;
};
```

`sendConfirm` and `openChat` are stubs until Task 3:

```ts
const sendConfirm = async (message: string | null): Promise<void> => {
  if (!message) return;
  hostNotice.show('确认会在接入会话后发送。', 'error');
};
const openChat = async (): Promise<void> => {
  hostNotice.show('打开对话将在下一步接入。', 'error');
};
```

- [ ] **Step 6: Run the panel build and the tests**

Run: `bun test packages/extensions/creation/panel` and `bun run extensions:build`
Expected: PASS and exit 0.

---

### Task 3: Confirmations and chat handoff

**Files:**
- Modify: `packages/extensions/creation/panel/readers.ts`
- Modify: `packages/extensions/creation/panel/readers.test.ts`
- Modify: `packages/extensions/creation/panel/app.ts`

**Interfaces:**
- Consumes: everything from Task 2.
- Produces: `sendConfirm(message)` and `openSurface('chat')` behavior; later tasks reuse `sendConfirm`.

- [ ] **Step 1: Write the failing message tests for document and video gates**

Add to `readers.test.ts` once the readers exist (Task 6 and Task 7). In this task, add a test that a gate without a decision id never yields a message:

```ts
test('no decision id means no confirmation text', () => {
  const gate = { key: 'deck-sample' as const, title: '样页', excerpt: '', version: '方案版本 abc' };
  expect(confirmMessage('deck', gate)).toBeNull();
});
```

- [ ] **Step 2: Implement send and open**

```ts
const sendConfirm = async (message: string | null): Promise<void> => {
  if (!message || state.busy) return;
  state.busy = true;
  hostNotice.show('已发出，等 AI 处理。');
  render();
  try {
    const result = await host.prompt({ text: message, send: true });
    if (!result.sent) throw new Error('消息没有发出去');
  } catch (error) {
    hostNotice.show(`没能发出去：${error instanceof Error ? error.message : String(error)}。可以直接在对话里确认。`, 'error');
  } finally {
    state.busy = false;
    render();
  }
};

const openChat = async (): Promise<void> => {
  try {
    await host.openSurface('chat');
  } catch {
    hostNotice.show('对话打不开，回到左侧会话列表试试。', 'error');
  }
};
```

`host.prompt` needs an open session. The running view is only shown when the work project has `需求.md`; a project without an open session returns `NO_SESSION`. In that case the button should read 在对话里确认 and call `openChat`. Use `state.ready?.session` to decide:

```ts
const canSend = Boolean(state.ready?.session);
```

When `canSend` is false, the confirm button calls `openChat` and says "先打开这个作品的会话". Add this in `renderGate`.

- [ ] **Step 3: Refresh after the agent stops**

```ts
host.onSessionLifecycle((event) => {
  if (event.phase === 'completed' || event.phase === 'failure') void reload();
});
host.onSession(() => void reload());
host.onDirectory(() => void reload());
```

- [ ] **Step 4: Verify in the app**

Build and open a real SuperPPT work at the plan-review gate. Expected: the confirmation appears in the chat as a normal user message, the button disables while sending, and the panel re-reads the state when the agent finishes.

---

### Task 4: Creation service and guest request

**Files:**
- Create: `packages/web/server/lib/projects/directory.js`
- Create: `packages/web/server/lib/projects/directory.test.js`
- Create: `packages/web/server/lib/projects/creation.js`
- Create: `packages/web/server/lib/projects/creation.test.js`
- Modify: `packages/web/server/lib/projects/routes.js`
- Modify: `packages/web/server/lib/guests/routes.js`
- Create: `packages/web/server/lib/guests/creation-request.test.js`
- Modify: `packages/web/server/lib/opencode/feature-routes-runtime.js`
- Modify: `packages/web/server/lib/projects/DOCUMENTATION.md`
- Modify: `packages/web/server/lib/guests/DOCUMENTATION.md`

**Interfaces:**
- Consumes: the existing `validateDirectoryPath`, `readSettingsFromDisk`, `sanitizeProjects`, `persistSettings`, `createProjectIdFromPath`.
- Produces: `activateDirectory(deps, requestedPath) -> { path, projectId, settings }`; `createCreationProject({ fsPromises, homedir, activate, kind, title, brief, now? }) -> { path, projectId }`; `creationProjectService.create(payload)` on the guest routes.

- [ ] **Step 1: Write the failing activation extraction test**

`directory.test.js` mirrors the existing `routes-directory.test.js` expectations but calls the helper directly:

```js
import { describe, expect, it, vi } from 'vitest';
import { activateDirectory } from './directory.js';

const deps = (overrides = {}) => ({
  validateDirectoryPath: vi.fn(async (directory) => ({ ok: true, directory })),
  readSettingsFromDisk: vi.fn(async () => ({ projects: [] })),
  sanitizeProjects: (projects) => projects,
  persistSettings: vi.fn(async (settings) => settings),
  ...overrides,
});

describe('activateDirectory', () => {
  it('reuses an existing project and keeps its metadata', async () => {
    const project = { id: 'existing', path: '/projects/existing', addedAt: 1, lastOpenedAt: 2 };
    const dependencies = deps({ readSettingsFromDisk: vi.fn(async () => ({ projects: [project] })) });
    const result = await activateDirectory(dependencies, '/projects/existing');
    expect(result.projectId).toBe('existing');
    expect(result.settings.projects).toEqual([project]);
  });

  it('surfaces the validator error without persisting', async () => {
    const dependencies = deps({ validateDirectoryPath: vi.fn(async () => ({ ok: false, error: 'not a directory' })) });
    await expect(activateDirectory(dependencies, '/nope')).rejects.toThrow('not a directory');
    expect(dependencies.persistSettings).not.toHaveBeenCalled();
  });
});
```

Run: `bunx vitest run packages/web/server/lib/projects/directory.test.js`
Expected: FAIL with `Cannot find module './directory.js'`.

- [ ] **Step 2: Extract the helper**

`directory.js`:

```js
import { createProjectIdFromPath } from './project-id.js';

export class ProjectDirectoryError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'ProjectDirectoryError';
    this.statusCode = statusCode;
  }
}

export const activateDirectory = async (
  { validateDirectoryPath, readSettingsFromDisk, sanitizeProjects, persistSettings },
  requestedPath,
) => {
  const validated = await validateDirectoryPath(requestedPath);
  if (!validated.ok) throw new ProjectDirectoryError(validated.error, 400);
  const resolvedPath = validated.directory;
  const currentSettings = await readSettingsFromDisk();
  const existingProjects = sanitizeProjects(currentSettings.projects) || [];
  const existing = existingProjects.find((project) => project.path === resolvedPath) || null;
  const nextProjects = existing
    ? existingProjects
    : [
        ...existingProjects,
        { id: createProjectIdFromPath(resolvedPath), path: resolvedPath, addedAt: Date.now(), lastOpenedAt: Date.now() },
      ];
  const projectId = existing ? existing.id : nextProjects[nextProjects.length - 1].id;
  const settings = await persistSettings({
    projects: nextProjects,
    activeProjectId: projectId,
    lastDirectory: resolvedPath,
  });
  return { path: resolvedPath, projectId, settings };
};
```

Modify `routes.js`: import `{ activateDirectory, ProjectDirectoryError } from './directory.js'`, drop the now-unused `createProjectIdFromPath` import, and call the helper while keeping the same response shape:

```js
app.post('/api/openchamber/directory', async (req, res) => {
  try {
    const { path: requestedPath, create } = directoryRequestSchema.parse(req.body);
    if (!requestedPath) return res.status(400).json({ error: 'Path is required' });
    if (create) await fsPromises.mkdir(path.resolve(requestedPath), { recursive: true });
    const result = await activateDirectory({ validateDirectoryPath, readSettingsFromDisk, sanitizeProjects, persistSettings }, requestedPath);
    return res.json({ success: true, restarted: false, path: result.path, settings: result.settings });
  } catch (error) {
    if (error instanceof ProjectDirectoryError) return res.status(error.statusCode).json({ error: error.message });
    console.error('Failed to update project directory:', error);
    return res.status(500).json({ error: error.message || 'Failed to update working directory' });
  }
});
```

Run the existing route tests: `bunx vitest run packages/web/server/lib/projects/routes-directory.test.js`
Expected: PASS unchanged.

- [ ] **Step 3: Write the failing creation service tests**

`creation.test.js` uses a temp home and a fake activate:

```js
import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCreationProject } from './creation.js';

const setup = async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-creation-'));
  const activate = vi.fn(async (target) => ({ projectId: `id-${path.basename(target)}`, path: target }));
  return { home, activate };
};

describe('createCreationProject', () => {
  it('creates the category folder, writes the brief and activates it', async () => {
    const { home, activate } = await setup();
    const result = await createCreationProject({
      fsPromises: fs, homedir: () => home, activate,
      kind: 'deck', title: '季度汇报', brief: '# 季度汇报\n', now: new Date(2026, 9, 21),
    });
    expect(result.path).toBe(path.join(home, 'Documents', 'SuperWagie', 'PPT', '季度汇报 2026-10-21'));
    expect(await fs.readFile(path.join(result.path, '需求.md'), 'utf8')).toBe('# 季度汇报\n');
    expect(activate).toHaveBeenCalledWith(result.path);
    expect(result.projectId).toBe('id-季度汇报 2026-10-21');
  });

  it('suffixes a duplicate title on the same day', async () => {
    const { home, activate } = await setup();
    const base = { fsPromises: fs, homedir: () => home, activate, kind: 'doc', title: '方案', brief: 'x', now: new Date(2026, 9, 21) };
    const first = await createCreationProject(base);
    const second = await createCreationProject(base);
    expect(second.path).toBe(`${first.path}-2`);
  });

  it('sanitizes separators and refuses an unknown kind', async () => {
    const { home, activate } = await setup();
    const result = await createCreationProject({ ...{ fsPromises: fs, homedir: () => home, activate, brief: 'x', now: new Date(2026, 9, 21) }, kind: 'doc', title: 'a/b:c' });
    expect(path.basename(result.path)).toBe('a-b-c 2026-10-21');
    await expect(createCreationProject({ fsPromises: fs, homedir: () => home, activate, kind: 'zip', title: 'x', brief: 'x' })).rejects.toThrow('unknown-kind');
  });

  it('removes the new folder when activation fails', async () => {
    const { home } = await setup();
    const activate = vi.fn(async () => { throw new Error('activation failed'); });
    await expect(createCreationProject({ fsPromises: fs, homedir: () => home, activate, kind: 'video', title: '片', brief: 'x', now: new Date(2026, 9, 21) })).rejects.toThrow('activation failed');
    expect(await fs.readdir(path.join(home, 'Documents', 'SuperWagie', '视频'))).toEqual([]);
  });
});
```

Run: `bunx vitest run packages/web/server/lib/projects/creation.test.js`
Expected: FAIL with `Cannot find module './creation.js'`.

- [ ] **Step 4: Write `creation.js`**

```js
import path from 'node:path';

const CATEGORIES = { doc: '文档', deck: 'PPT', video: '视频', page: '网页' };

export class CreationError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'CreationError';
    this.statusCode = statusCode;
  }
}

export const projectTitle = (value) => {
  const cleaned = String(value ?? '')
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 40)
    .trim();
  return cleaned || '未命名';
};

const dateOf = (date) => {
  const month = `${date.getMonth() + 1}`.padStart(2, '0');
  const day = `${date.getDate()}`.padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
};

const exists = async (fsPromises, target) => {
  try {
    await fsPromises.stat(target);
    return true;
  } catch {
    return false;
  }
};

export const createCreationProject = async ({ fsPromises, homedir, activate, kind, title, brief, now = new Date() }) => {
  const category = CATEGORIES[kind];
  if (!category) throw new CreationError('unknown-kind');
  if (typeof brief !== 'string' || brief.length === 0) throw new CreationError('brief-required');
  const folder = `${projectTitle(title)} ${dateOf(now)}`;
  const base = path.join(homedir(), 'Documents', 'SuperWagie', category);
  let target = path.join(base, folder);
  for (let suffix = 2; await exists(fsPromises, target); suffix += 1) {
    if (suffix > 99) throw new CreationError('too-many-duplicates');
    target = path.join(base, `${folder}-${suffix}`);
  }
  await fsPromises.mkdir(target, { recursive: true });
  try {
    await fsPromises.writeFile(path.join(target, '需求.md'), brief, 'utf8');
    const activated = await activate(target);
    return { path: target, projectId: activated.projectId };
  } catch (error) {
    await fsPromises.rm(target, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
};
```

Run: `bunx vitest run packages/web/server/lib/projects/creation.test.js`
Expected: PASS.

- [ ] **Step 5: Add the guest branch**

In `guests/routes.js`, extend the destructured dependencies with `creationProjectService = null` and add next to the schedule branch:

```js
const CREATION_GUEST_ID = 'openchamber-builtin-creation';
const CREATION_PATH = '/api/creation/projects';

// The creation panel names what to make; the server owns the directory.
const runCreationProjectRequest = async ({ guest, method, path: rawPath, body }) => {
  if (!creationProjectService || guest.id !== CREATION_GUEST_ID || method !== 'POST' || rawPath !== CREATION_PATH) return null;
  const payload = body ? JSON.parse(body) : {};
  const created = await creationProjectService.create(payload);
  return { status: 200, body: JSON.stringify(created) };
};
```

Call it before the `!guest.integration` refusal, exactly like the schedule branch:

```js
if (guest.id === CREATION_GUEST_ID) {
  const local = await runCreationProjectRequest({
    guest, method: req.body?.method, path: req.body?.path, body: req.body?.body,
  }).catch((error) => ({ status: error?.statusCode || 500, body: JSON.stringify({ error: error?.message || 'request-failed' }) }));
  if (local) return res.json(local);
}
```

- [ ] **Step 6: Write the failing guest request test**

`creation-request.test.js` reuses the fixture shape of `builtins.test.js` with `id = 'openchamber-builtin-creation'`, a manifest without an integration, and `registerGuestRoutes(app, { ..., creationProjectService: { create: vi.fn(async (payload) => ({ projectId: 'p1', path: `/works/${payload.title}` })) } })`.

```js
const created = await api.post(`/api/guests/${id}/request`).send({
  method: 'POST', path: '/api/creation/projects',
  body: JSON.stringify({ kind: 'deck', title: '季度汇报', brief: '# 季度汇报\n' }),
}).expect(200);
expect(created.body).toEqual({ projectId: 'p1', path: '/works/季度汇报' });

await api.post(`/api/guests/${id}/request`).send({ method: 'POST', path: '/api/other', body: '{}' }).expect(404);
await api.post(`/api/guests/${id}/request`).send({ method: 'GET', path: '/api/creation/projects' }).expect(404);
```

Run: `bun test packages/web/server/lib/guests/creation-request.test.js`
Expected: PASS. If it 404s on the allowed case, the `!guest.integration` reorder is missing; apply the working-tree change from the Global Constraints.

- [ ] **Step 7: Wire the runtime**

In `feature-routes-runtime.js`, build the service from the same dependencies the directory route already uses, then pass it to `registerGuestRoutes`:

```js
const projectDirectoryDependencies = { fsPromises, validateDirectoryPath, readSettingsFromDisk, sanitizeProjects, persistSettings };
const creationProjectService = {
  create: (payload) => createCreationProject({ ...payload, fsPromises, homedir: os.homedir(), activate: (target) => activateDirectory(projectDirectoryDependencies, target) }),
};
```

Use `projectDirectoryDependencies` in `registerProjectDirectoryRoutes` as well, so the route and the service share one activation path. Add the `os` import if absent.

- [ ] **Step 8: Update both module documents**

`projects/DOCUMENTATION.md`: state that activation lives in one helper, that the creation service builds paths only under `~/Documents/SuperWagie/<category>/<title> <date>`, writes `需求.md`, and removes the folder when activation fails.

`guests/DOCUMENTATION.md`: add the creation request to the local allowlist list, naming the guest id, the fixed path, the payload and the answer.

---

### Task 5: Panel creation flow

**Files:**
- Modify: `packages/extensions/creation/panel/app.ts`

**Interfaces:**
- Consumes: the wizard, `host.request`, `host.startSession`, `reload`.
- Produces: `startWork`, `firstMessage`, failure rendering.

- [ ] **Step 1: Implement the start flow**

```ts
const firstMessage = (kind: Kind): string => {
  if (kind === 'doc') return '请先调用 skill 工具加载 superwriter 技能，再读取本项目的 需求.md，按 SuperWriter 的流程开始。';
  if (kind === 'deck') return '请先调用 skill 工具加载 superppt 技能，再读取本项目的 需求.md，按 SuperPPT 的流程开始。';
  if (kind === 'video') return '请先调用 skill 工具加载 supervideo 技能，再读取本项目的 需求.md，按 SuperVideo 的流程开始。';
  return '请读取本项目的 需求.md，按其中的目标直接实现这个网页；需要预览时告诉我怎么打开。';
};

const readError = (body: string | null): string => {
  try {
    const parsed = JSON.parse(body ?? '');
    return typeof parsed.error === 'string' ? parsed.error : '建项目失败';
  } catch {
    return '建项目失败';
  }
};

const startWork = async (): Promise<void> => {
  if (!state.kind || state.busy) return;
  const kind = state.kind;
  const title = sanitizeTitle(state.title || defaultTitle(kind, state.answers));
  state.busy = true;
  hostNotice.show('正在建项目和会话…');
  render();
  try {
    const response = await host.request({
      method: 'POST',
      path: '/api/creation/projects',
      body: JSON.stringify({ kind, title, brief: briefMarkdown(kind, state.answers) }),
    });
    if (response.status >= 400) throw new Error(readError(response.body));
    const created = JSON.parse(response.body) as { projectId?: string };
    if (!created.projectId) throw new Error('服务没有返回项目编号');
    const session = await host.startSession({
      providerId: 'creation',
      id: '作品',
      title,
      url: `https://superwagie.local/work/${kind}`,
      text: firstMessage(kind),
      projectId: created.projectId,
      navigation: 'open',
    });
    if (!session.sessionId) throw new Error('会话没有建起来');
    hostNotice.clear();
    await reload();
  } catch (error) {
    hostNotice.show(`${error instanceof Error ? error.message : String(error)}。可以直接在对话里开始。`, 'error');
  } finally {
    state.busy = false;
    render();
  }
};
```

`state.title` is set when the confirm screen opens and updated as the user types. If they never edit it, it equals `defaultTitle`.

- [ ] **Step 2: Handle the directory switch**

After `startSession` navigates, the panel receives `onDirectory` for the new project and `reload()` finds `需求.md`. Until then, keep the wizard visible with the notice "正在建项目和会话…". Do not clear the answers in the same tick as the request: a failed start must keep them.

- [ ] **Step 3: Add the failure cases**

- `response.status === 400` with `unknown-kind`, `brief-required`: "这次没有建起来，返回上一步改一下再试。"
- `NO_DIRECTORY` or a 404: "创建面板没有拿到权限，先重启应用再试。"
- `startSession` failure after the folder exists: "项目建好了，但会话没开起来。打开项目列表就能进去。" Do not delete the folder: the server created it and the brief is valid.

- [ ] **Step 4: Verify end to end**

Run: `bun run extensions:build`, restart the dev server, then create one work of each type. Expected: a new folder under `~/Documents/SuperWagie/<category>/`, a `需求.md` whose `- 类型：` line matches, the project appears in the project switcher, and the session's first message names the right skill.

---

### Task 6: Document view model

**Files:**
- Modify: `packages/extensions/creation/panel/readers.ts`
- Modify: `packages/extensions/creation/panel/readers.test.ts`
- Create: `packages/extensions/creation/panel/fixtures/superwriter.json`

**Interfaces:**
- Consumes: `readWorkView`, `workFilePaths`, `confirmMessage`.
- Produces: the doc branch of all three functions.

- [ ] **Step 1: Add the fixture and the failing tests**

`superwriter.json` (trimmed real state):

```json
{
  "schema_version": 2,
  "project_id": "p-1",
  "revision": 12,
  "stage": "chapters",
  "active_object_id": "chapter-3",
  "objects": {
    "approach": { "id": "approach", "kind": "approach", "path": "方案.md", "version": 2, "sha256": "a", "dependencies": [], "status": "approved", "metadata": {} },
    "outline": { "id": "outline", "kind": "outline", "path": "大纲.md", "version": 3, "sha256": "b", "dependencies": ["approach"], "status": "approved", "metadata": { "chapter_order": ["chapter-1", "chapter-2", "chapter-3"] } },
    "chapter-1": { "id": "chapter-1", "kind": "chapter", "path": "章节/第一章.md", "version": 2, "sha256": "c", "dependencies": ["outline"], "status": "approved", "metadata": {} },
    "chapter-2": { "id": "chapter-2", "kind": "chapter", "path": "章节/第二章.md", "version": 2, "sha256": "d", "dependencies": ["outline"], "status": "approved", "metadata": {} },
    "chapter-3": { "id": "chapter-3", "kind": "chapter", "path": "章节/第三章.md", "version": 1, "sha256": "e", "dependencies": ["outline"], "status": "pending_review", "metadata": {} }
  },
  "materials": {},
  "decisions": [],
  "approvals": [],
  "processed_events": [],
  "invalidations": []
}
```

Tests:

```ts
test('document gate names the chapter and the version', () => {
  const view = readWorkView('doc', { state: JSON.stringify(writer), artifact: '# 第三章\n\n接口设计...' });
  expect(view?.gate?.key).toBe('doc-review');
  expect(view?.gate?.title).toBe('第 3/3 章');
  expect(view?.gate?.excerpt).toContain('接口设计');
  expect(confirmMessage('doc', view!.gate!)).toBe('确认第 3/3 章（对象 chapter-3，版本 1，revision 12），按 SuperWriter 流程记录批准。');
});

test('document steps show the chapter loop position', () => {
  const view = readWorkView('doc', { state: JSON.stringify(writer), artifact: '' });
  expect(view?.steps.map((step) => step.label)).toEqual(['需求', '方案', '大纲', '第 3 章', '配图', '合稿', '导出']);
});

test('an approved outline asks for the manuscript, not a chapter', () => {
  const done = {
    ...writer,
    objects: Object.fromEntries(Object.entries(writer.objects).map(([id, object]) => [id, { ...object, status: 'approved' }])),
    stage: 'manuscript',
    active_object_id: 'manuscript',
  };
  const view = readWorkView('doc', { state: JSON.stringify(done), artifact: '' });
  expect(view?.gate?.key).toBe('doc-review');
  expect(view?.gate?.title).toBe('合稿');
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `bun test packages/extensions/creation/panel/readers.test.ts`
Expected: FAIL because the doc branch returns `null`.

- [ ] **Step 3: Implement the doc branch**

```ts
const DOC_STEPS = ['需求', '方案', '大纲', '第 3 章', '配图', '合稿', '导出'];
const DOC_STAGE_INDEX: Record<string, number> = {
  intake: 0, approach: 1, outline: 2, chapters: 3, illustrations: 4, manuscript: 5, delivery: 6,
};
const DOC_GATE_LABEL: Record<string, string> = {
  approach: '写作方案', outline: '大纲', chapter: '这一章', figure_set: '配图集', manuscript: '合稿', delivery: '交付',
};
```

`docView(raw, artifact)`:

- parse; require `schema_version === 2` and an `objects` record.
- `stage` index from `DOC_STAGE_INDEX`; unknown stage → null.
- step labels: replace index 3 with `第 ${chapterNumber}/${chapterTotal} 章` when the outline carries `chapter_order`.
- gate: `active_object_id` → object; if status is `pending_review`, build the gate. Label: chapter → `第 n/total 章`; others from `DOC_GATE_LABEL[object.kind]`.
- excerpt: from `artifact`, first 3 non-empty lines, each cut at 80 characters.
- `confirmMessage` for doc reads `gate.object` and `gate.revision` (both already on `Gate`) and returns null when either is missing. Insert this branch at the top of the existing function:

```ts
export const confirmMessage = (kind: Kind, gate: Gate, choice?: Choice): string | null => {
  if (kind === 'doc') {
    if (!gate.object || !gate.revision) return null;
    return `确认${gate.object.label}（对象 ${gate.object.id}，版本 ${gate.object.version}，revision ${gate.revision}），按 SuperWriter 流程记录批准。`;
  }
  if (kind !== 'deck') return null;
  if (!gate.revision || !gate.decisionId) return null;
  // ... the deck branches from Task 2 stay unchanged
};
```

The doc branch sets `object: { id: object.id, version: object.version, label }` and `revision: String(state.revision)` on the gate.

- `workFilePaths('doc', raw)` returns `{ artifact: objects[active_object_id].path }` so the app can read the active chapter.
- `deliveredPath`: when a delivery object exists with `status === 'verified'`, its `path`.

- [ ] **Step 4: Run the tests**

Run: `bun test packages/extensions/creation/panel`
Expected: PASS.

- [ ] **Step 5: Verify with a real document**

Open a real SuperWriter work at a pending chapter. Expected: "第 3/9 章", the chapter excerpt, the version string, and a confirm message that names the same object and version.

---

### Task 7: Video view model, page works, delivered view

**Files:**
- Modify: `packages/extensions/creation/panel/readers.ts`
- Modify: `packages/extensions/creation/panel/readers.test.ts`
- Create: `packages/extensions/creation/panel/fixtures/supervideo.json`
- Modify: `packages/extensions/creation/panel/app.ts`
- Modify: `packages/extensions/workbench/panel/app.ts`
- Modify: `packages/extensions/DOCUMENTATION.md`

**Interfaces:**
- Consumes: everything so far.
- Produces: the video branch, the page view, the delivered view, the workbench entry.

- [ ] **Step 1: Add the video fixture and failing tests**

`supervideo.json`:

```json
{
  "schemaVersion": 1,
  "id": "v-1",
  "revision": 7,
  "mode": "ppt",
  "output": { "width": 1920, "height": 1080, "fps": 30 },
  "sources": [],
  "assets": [],
  "scenes": [
    { "id": "s1", "title": "开场", "sentences": [{ "id": "t1", "text": "第一句" }] },
    { "id": "s2", "title": "卖点", "sentences": [{ "id": "t2", "text": "第二句" }] }
  ],
  "approvals": [
    { "id": "a1", "stage": "script", "scope": ["s1", "s2"], "digest": "d", "decision": "approved", "evidence": "按这个来" }
  ],
  "jobs": [],
  "settings": {}
}
```

```ts
test('video steps follow approvals', () => {
  const view = readWorkView('video', { state: JSON.stringify(video) });
  expect(view?.steps.map((step) => step.state)).toEqual(['done', 'done', 'now', 'next', 'next']);
  expect(view?.gate?.key).toBe('video-sample');
  expect(confirmMessage('video', view!.gate!)).toBe('确认当前样片（revision 7），按 SuperVideo 流程记录批准。');
});

test('video final gate needs the full render approval', () => {
  const withSample = { ...video, approvals: [...video.approvals, { id: 'a2', stage: 'sample', scope: ['s1', 's2'], digest: 'e', decision: 'approved', evidence: '可以' }] };
  const view = readWorkView('video', { state: JSON.stringify(withSample) });
  expect(view?.gate?.key).toBe('video-final');
});
```

- [ ] **Step 2: Implement the video branch**

```ts
const VIDEO_STEPS = ['简报', '讲稿', '样片', '成片', '交付'];
```

Rules:
- scenes empty → step 0 now, no gate (the agent is writing the brief).
- script approval covering every scene id → 讲稿 done; else 讲稿 now, gate `video-script` titled `讲稿`.
- sample approval → 样片 done; else gate `video-sample`.
- final approval with a `target` → 交付 now, no gate, and `deliveredPath` from `target.manifestPath` if present.
- `confirmMessage`: `确认当前${stage}（revision ${revision}），按 SuperVideo 流程记录批准。` with stage 讲稿/样片/成片. Put the stage label on the gate as `object: { id: '', version: 0, label: stage }`, set `revision`, and add a branch above the deck one:

```ts
if (kind === 'video') {
  if (!gate.object || !gate.revision) return null;
  return `确认当前${gate.object.label}（revision ${gate.revision}），按 SuperVideo 流程记录批准。`;
}
```

The empty `id` and `0` version are deliberate: the engine binds the digest itself from the project revision, and the label carries the stage.
- excerpt: the first two scenes' narration, joined with ` / `, cut at 200 characters.

- [ ] **Step 3: Add the page view and the delivered view**

In `app.ts`:
- `kindFromBrief` returning `page` renders a "作品文件" list from `host.listDir('.')` plus 打开对话, with the note "网页没有阶段，进度以对话为准。"
- A delivered path renders the last step as 交付 and the card as `已交付` with the path, 继续改 (open the chat and prefill `我想改这份作品：`), and 再做一份 (reset the wizard).

- [ ] **Step 4: Replace the workbench chips**

In `packages/extensions/workbench/panel/app.ts`, remove the `skillPresets` block and its chip loop; add one chip before 创建待办:

```ts
const createChip = el('button', 'chip', '开始创作');
createChip.type = 'button';
createChip.addEventListener('click', () => {
  void host.openSurface('plugin:openchamber-builtin-creation').catch(() => {
    hostNotice.show('创作面板没有打开，先确认扩展已启用。', 'warn');
  });
});
chips.append(createChip);
```

`topicFromComposer` becomes unused; delete it.

- [ ] **Step 5: Update the extension documentation**

`packages/extensions/DOCUMENTATION.md` adds the creation package under Current built-ins: one rail panel, no page, capabilities `files`, `prompt`, `sessions`, one allowlisted creation request, and the rule that its panel reads the skills' state files and never writes them. Record that the panel ships Chinese copy first, matching the workbench and this build, and that an English copy follows as its own change. The twelve-locale rule is deferred deliberately, not dropped.

- [ ] **Step 6: Run the focused suites and the gate**

Run: `bun test packages/extensions/creation/panel packages/extensions/workbench/panel`
Run: `bun run extensions:build`
Run: `bun run check:changed`

Expected: tests PASS, build exits 0, `check:changed` passes with no new anti-slop findings.

- [ ] **Step 7: Manual pass**

At 320px and desktop width, light and dark: four cards, four screens, Back, confirm, start for each type; resume a document work at a chapter and a video work at the sample gate; open a delivered work; tab-only traversal. Report what was checked and what was not.

---

## Plan self-review

- **Spec coverage:** all four type cards (Task 1), three questions plus confirm (Task 1), project creation and naming (Task 4), session start (Task 5), deck gate and disclosure (Tasks 2 and 3), document loop (Task 6), video gates (Task 7), page works, delivered view, workbench entry, docs, tests and manual checks (Task 7). The spec's "state unreadable shows 以对话为准" is in `reload` (Task 2) and rechecked in Task 7's page and delivered views.
- **Placeholders:** none. Every code step carries runnable code; `startWork` is a stub only inside Task 1, and Task 5 replaces it with the final body.
- **Type consistency:** `Kind`, `Answers`, `WorkView`, `Gate`, `GateChoice`, `confirmMessage(kind, gate, choice?)` and `workFilePaths(kind, stateRaw)` keep the same names and shapes across tasks. The deck branch fills `gate.revision` and `gate.decisionId`; the doc branch fills `gate.object` and `gate.revision`; `confirmMessage` reads those fields and never parses the display string.
