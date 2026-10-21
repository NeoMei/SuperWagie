# Creation panel: guided documents, decks, videos and pages

## Problem Statement

A beginner arrives with a goal ("a quarterly report", "a product deck", "a
five-minute explainer") and no way to drive an AI through it. The three bundled
skills already define what must happen: SuperWriter waits for approval of the
approach, the outline, every chapter, the figure set and the manuscript;
SuperPPT waits at three points; SuperVideo waits for a brief, a script, a sample
and the final cut. Those gates are precise, version-bound, and invisible to the
user.

Today the workbench's three chips only prefill a prompt and hand the user to
chat. The user cannot see which step they are on, what the AI needs from them
right now, whether an answer was already given, or what "done" looks like. On a
long document they lose track after the second chapter. The result is abandoned
work, not a bad draft.

## Solution

A "创作" rail panel that sits beside the chat, next to the conversation where the
drafts, decks and videos actually render. It does three things and nothing else:

1. Turns "I want to make something" into a work: four equal type cards, three
   questions one screen at a time, a confirmation screen, then a new project and
   a session running the right skill.
2. Mirrors the skill's own state: the steps for this type, the current gate, the
   version under review, a short excerpt of the artifact.
3. Offers exactly one decision at a time. A confirmation becomes a chat message
   that names the object and version the user saw; the skill records the
   approval. The panel never writes skill state and never invents progress.

Everything a work produces stays in chat and the file panel. One work is one
project, so opening the work later means opening its project.

## User Stories

1. As a beginner with no plan, I want four equal entry cards for document, deck,
   video and page, so that I pick what I want to make without being steered.
2. As a beginner, I want the same wizard whether I start from the workbench or
   from the rail icon, so that there is one way to begin.
3. As a beginner, I want to answer one question per screen, so that I never face
   a wall of fields.
4. As a beginner, I want to go back one screen without losing earlier answers, so
   that a typo does not restart the wizard.
5. As a beginner, I want to paste text, point at a file, or just give a topic, so
   that the wizard accepts whatever I already have.
6. As a beginner, I want the third question to match the type I chose, so that a
   deck asks about the occasion and pages, and a video asks what the viewer
   should be able to do afterwards.
7. As a beginner, I want a final screen that shows the name, the folder, the
   skill being used and the defaults, so that I know what is about to happen
   before it happens.
8. As a beginner, I want to edit the proposed name, so that the folder reads the
   way I will look for it later.
9. As a beginner, I want the folder to be `文稿/SuperWagie/<type>/<title> <date>`,
   so that every work is findable in Finder without opening the app.
10. As a beginner, I want each work to become its own project, so that its chats,
    files and progress stay together and the project list becomes my work
    history.
11. As a beginner, I want the workbench to keep one "开始创作" entry, so that the
    app's landing page leads somewhere without pretending to preselect a type it
    cannot pass on.
12. As a beginner, I want a step strip that shows only the current step and the
    finished ones, so that seven steps do not read as seven obligations.
13. As a beginner, I want a one-line "看什么" for each gate, so that I know what
    to check before I confirm.
14. As a beginner, I want a short excerpt of the artifact in the panel and a
    "打开对话" action, so that I can read the whole thing where it renders.
15. As a beginner, I want to confirm the exact version shown to me, so that my
    click counts as the approval the skill requires.
16. As a beginner, I want to ask for changes instead of confirming, so that a
    wrong draft is a normal step and not a dead end.
17. As a beginner writing a long document, I want to see "第 3 章 / 共 9 章", so
    that I know how much is left.
18. As a beginner making a deck, I want to pick style, tier and palette in the
    panel, so that I do not have to copy a reply out of a review page.
19. As a beginner making a deck, I want to see the exact prompt and the one
    image call in the panel, with the references and output location disclosed
    in chat, so that nothing is generated or billed without my knowledge.
20. As a beginner making a video, I want the sample cut to open in chat with a
    "确认样片" action in the panel, so that watching and approving are separate
    acts.
21. As a user coming back later, I want to open the work's project and see its
    current step, so that I can resume without re-reading the whole chat.
22. As a user whose skill state is missing or unreadable, I want the panel to say
    "以对话为准" instead of showing a made-up percentage, so that I never trust a
    progress bar that is guessing.
23. As a user whose session is already working, I want the panel to show that and
    keep my confirm button disabled, so that I do not queue a second decision
    against a stale version.
24. As a user who just delivered, I want the panel to show the file, offer
    "继续改" back in chat, and offer "再做一份", so that finishing one thing is
    not the end of the session.
25. As a user making a page, I want a project and a chat without a step strip, so
    that the app does not invent gates a page does not have.
26. As a user with no project open, I want to be told to open one first, so that
    the panel never writes into an unknown directory.
27. As a user in light or dark theme, I want the panel to follow the app's theme
    tokens, so that it does not look bolted on.
28. As a keyboard user, I want to tab through the wizard and activate cards with
    Enter, so that the panel works without a mouse.
29. As a user on a narrow window, I want the panel to fit at 320px without
    horizontal scrolling, so that the side panel stays usable.
30. As a user who mistypes a name with `/` or `:`, I want it replaced rather than
    rejected, so that starting never fails on punctuation.

## Implementation Decisions

**Package and surfaces.** A new first-party built-in extension owns one rail
panel, named 创作, with no full page. It declares `files`, `prompt` and
`sessions`. The workbench page gains a single 开始创作
action that calls `openSurface('plugin:<creation>')`; the panel's first screen is
the four type cards. The type is chosen exactly once, in the panel. Cross-panel
calls carry no parameters and extension storage is per package, so any
workbench card that named a type could not hand it over; the workbench shows one
door, the panel shows the choices.

**Screens.** Type → question 1 (content: paste, file path, or one-line topic) →
question 2 (audience: 自己 / 同事 / 客户 / 学生 / 其他) → question 3 (type-specific)
→ confirmation. Every step keeps a Back action and retains earlier answers.
Question 3 by type:

| Type | Question 3 | Defaults shown on the confirmation screen |
| --- | --- | --- |
| 文档 | 文档类型 (标书 / 方案 / 报告 / 白皮书 / 其他) and rough length | delivery format DOCX + PDF; 投标 yes/no |
| PPT | occasion and rough page count | 16:9; style chosen later |
| 视频 | what the viewer should be able to do after watching | inferred mode (PPT 讲解 / 绘本 / 网站教程 / 教学), voice, aspect ratio, no BGM |
| 网页 | what a visitor should be able to complete | none |

The confirmation screen shows the editable title, the computed folder, the skill
that will be loaded, and the defaults above. 开始 is the only primary action.

**Work location and naming.** Root `~/Documents/SuperWagie`, category folder
`文档 / PPT / 视频 / 网页`, work folder `<title> <YYYY-MM-DD>`. Titles replace
`/ \ : * ? " < > |` with `-`, collapse whitespace, truncate at 40 characters;
a duplicate folder in the same category and date appends `-2`.

**Project creation.** The panel cannot create directories through the SDK. The
creation guest gets one allowlisted internal call: the request channel accepts a
creation request for that guest id only, carrying `kind`, `title` and the
assembled brief. The server builds the path itself from the fixed root, the
category and the sanitized title, creates the directory, writes `需求.md` there,
and activates the directory through the same path the app's own folder picker
uses. It returns the project id and path. Any other guest, method, path or
category is refused; there is no way to name an arbitrary absolute path. If the
directory cannot be created or activated, the panel reports which step failed
and leaves no half-registered project.

**Session start.** After activation the panel calls `startSession` with that
project id, `navigation: 'open'`, and a first message that names the skill to
load and points at `需求.md`. The workbench session list, the project switcher
and the panel then all speak about the same work. For 网页 no skill is named; the
first message carries the same brief and asks for the page directly.

**State readers.** The panel reads the skills' own files at the work project's
root, never a parallel state file:

| Type | File | What the panel takes |
| --- | --- | --- |
| 文档 | `协作状态.json` | `stage`, `revision`, active object id, per-object `status` and version |
| PPT | `superppt.json` | `stage`, `contentRevision`, `pendingDecision`, current deck, delivery |
| 视频 | `project.json` | `revision`, `approvals`, mode, current job state |

One pure function per mode turns the raw text into a view model: steps, current
step, gate kind, gate title, excerpt, version string, and the actions available
now. It returns `null` when the file is missing, unreadable, or from an unknown
schema version; the panel then shows 以对话为准 and only 打开对话. The panel never
computes the skills' blockers, budgets or approvals itself.

**Steps per type.** 文档: 需求, 方案, 大纲, 逐章, 配图, 合稿, 导出. PPT: 方案, 选款,
样页, 整套, 交付. 视频: 简报, 讲稿, 样片, 成片, 交付. 网页 has no strip. Finished
steps are derived from the state file, never from elapsed time or previous
sessions.

**Confirmation contract.** Every gate button composes a chat message that names
the stage, the object and the version the panel displayed, for example
`确认当前大纲（对象 outline，版本 3，revision 12），按 SuperWriter 流程记录批准并进入逐章写作。`
The deck selection gate sends the tuple plus the one-call budget:
`方案版本：<rev>；决定编号：<id>；选择玻璃，2 档，偏冷（glass/2/cool）；授权新增生图调用：1 次。`
The deck sample and delivery gates name the version and decision id and rely on
the sample, budget and deck link the agent disclosed in the immediately
preceding chat message. A video gate names the revision. If the view model has
no version, the panel shows no confirm button and points at the chat.
Sending disables the action and shows "已发出，等 AI 处理" until the state file
changes; a failed send restores the button and reports the reason.

**Deck disclosure.** At the plan-review gate the panel reads the published plan
and sample-prompts files and shows the selected combination's exact prompt in a
collapsed block, beside the one-call budget. Reference purpose and output
location stay in the agent's chat disclosure. The sample-generation action is
only present when the prompt was read successfully; otherwise the gate points at
the chat.

**Artifacts.** The panel reads a short excerpt where the format allows it:
the active chapter's first paragraphs, the work title and page count, the first
scenes' narration. Decks, videos, HTML review pages and full manuscripts open in
chat or the file panel. No media player, no PPTX viewer, no embedded HTML inside
the panel.

**Delivered view.** When the state file reports delivery, the panel shows 已交付,
the artifact path, 打开对话, 继续改 and 再做一份. 继续改 sends the user back to the
same session; the skills' own revision routes handle the change.

**Failure and empty states.** No project open, creation refused, activation
failed, session creation failed, state unreadable, and a busy session each get
one reserved status line with the reason in plain Chinese and the available next
action. Nothing is reported as success until the server or the state file says
so.

**Theme and layout.** The panel uses the workbench's presentation helpers and
the host theme tokens through `applyHostReady`; flat tonal surfaces, a 16px
radius, no nested cards. It fits 320px, stacks every row, and ships Chinese
copy first. An English version follows as a separate change, so the copy stays
in one place rather than scattering strings through the rendering code.

## Testing Decisions

A good test here asserts what the user sees for a given set of files and
actions, not how the panel builds its DOM. The highest seam is the view model:
one function takes the type and the raw contents of the state files and returns
the complete screen state.

- **View model, unit tests.** Fixtures copied from real `superppt.json`,
  `协作状态.json` and `project.json` outputs. Cover every stage, the extraction of
  the gate version, the chapter counter, delivery, an unknown schema version, a
  truncated JSON file and a missing file. The expected result is the step strip,
  the gate title, the excerpt, the actions and the confirm text.
- **Confirmation text, unit tests.** Exact strings for the three modes, including
  the version and decision ids; no confirm text when the version is absent.
- **Creation endpoint, route tests.** With the server's existing supertest
  patterns: a normal title creates one directory under the fixed root and
  activates it; `..`, separators, absolute paths, a foreign category, an unknown
  guest id and a non-POST method are refused; a duplicate title gets a suffix; a
  creation failure does not register a project.
- **Wizard model, unit tests.** Screen order per type, Back retaining answers,
  the skip rules in question 3, title sanitizing and truncation, the computed
  path shown on the confirmation screen.
- **Manual checks.** The panel at 320px and at desktop width, light and dark,
  each mode with its fixture, keyboard-only traversal, and one complete run with
  the real skills on this machine. Deck and video playback are checked in chat,
  not in the panel.

## Out of Scope

- Guided steps for 网页; it gets a project, a chat and a file list.
- Per-page or per-scene edit pickers; 继续改 goes back to chat.
- Several works inside one project.
- Embedding SuperPPT's HTML selection page, deck thumbnails or video preview in
  the panel.
- Voice, BGM and aspect-ratio pickers beyond the defaults shown on the
  confirmation screen.
- Mobile and VS Code; guests are unsupported there today.
- Reworking the workbench's task, calendar or session surfaces.

## Further Notes

- Build order is an implementation concern. The four types ship at parity; no
  type is marked recommended and none is hidden behind a feature flag.
- Vocabulary: a **work** (作品) is one project under a category folder; a
  **category** (分类) is one of the four folders; a **gate** (关口) is a point where
  a skill requires the user's explicit, version-bound approval; the **brief**
  (需求) is `需求.md`, written once at creation.
- SuperWriter needs Python 3.10+ and WPSComposer for a full delivery. When that
  environment is missing, the panel shows the chat's explanation through
  打开对话 and does not claim a later stage was reached.
- The deck's category folder keeps the plain name `PPT`, including on case-
  insensitive filesystems where it may read back as `ppt`.
