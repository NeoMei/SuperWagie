#!/usr/bin/env node
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  APP_BLUEPRINT,
  PAGE_BLUEPRINT,
  assessBrief,
  detectRoute,
  parseOfferedDirectionIds,
  pickDirections,
  renderDirectionsDoc,
  type Direction,
} from './directions.js';
import { DeliveryError, deliverTask } from './delivery.js';
import { inspectTask } from './inspect.js';
import { type Route, type SuperwebState, StateError } from './schema.js';
import {
  BRIEF_FILE,
  DELIVERY_DIR,
  DIRECTIONS_FILE,
  PREVIEW_DIR,
  PREVIEW_FILE,
  REPORT_FILE,
  SAMPLE_FILE,
  STAGE_LABELS,
  STATE_FILE,
  applyDecision,
  createState,
  markDirectionsReady,
  markInspected,
  newTaskId,
  readState,
  statePath,
  writeState,
} from './state.js';

const VERSION = '1.1.0';

type FlagValue = string | boolean;
type Flags = Record<string, FlagValue>;

interface CliIO {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

class CliError extends Error {
  readonly exitCode: number;
  readonly hint?: string;

  constructor(message: string, exitCode = 3, hint?: string) {
    super(message);
    this.name = 'CliError';
    this.exitCode = exitCode;
    this.hint = hint;
  }
}

const BOOLEAN_FLAGS = new Set(['json', 'help', 'version', 'acknowledge-issues', 'adopt-brief']);
const GLOBAL_FLAGS = new Set(['dir', 'json', 'help']);

function parseArgv(argv: string[]): { command?: string; flags: Flags; positionals: string[] } {
  const flags: Flags = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token === '-h') {
      flags.help = true;
      continue;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      if (!body) continue;
      const equals = body.indexOf('=');
      if (equals !== -1) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (!command) command = token;
    else positionals.push(token);
  }

  return { command, flags, positionals };
}

function allowedFlags(command: string): Set<string> {
  switch (command) {
    case 'start':
      return new Set([...GLOBAL_FLAGS, 'name', 'route', 'brief', 'brief-file', 'adopt-brief']);
    case 'directions':
      return new Set([...GLOBAL_FLAGS, 'seed']);
    case 'decide':
      return new Set([...GLOBAL_FLAGS, 'gate', 'choice', 'revision', 'decision-id', 'target', 'acknowledge-issues']);
    case 'inspect':
      return new Set([...GLOBAL_FLAGS, 'chrome', 'timeout']);
    case 'deliver':
      return new Set(GLOBAL_FLAGS);
    case 'continue':
    case 'status':
      return new Set(GLOBAL_FLAGS);
    default:
      return new Set(GLOBAL_FLAGS);
  }
}

function assertKnownFlags(command: string, flags: Flags): void {
  const allowed = allowedFlags(command);
  for (const key of Object.keys(flags)) {
    if (!allowed.has(key)) {
      throw new CliError(`未知参数 --${key}（命令 ${command}）。`, 2, '运行 superweb --help 查看用法。');
    }
  }
}

function stringFlag(flags: Flags, name: string, required = false): string | undefined {
  const value = flags[name];
  if (value === undefined) {
    if (required) throw new CliError(`缺少参数 --${name}。`, 2, '运行 superweb --help 查看用法。');
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new CliError(`参数 --${name} 需要一个值。`, 2);
  }
  return value;
}

function intFlag(flags: Flags, name: string, required = false): number | undefined {
  const raw = stringFlag(flags, name, required);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new CliError(`参数 --${name} 必须是正整数，收到 ${raw}。`, 2);
  }
  return value;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(() => true).catch(() => false);
}

function relativeCommandPath(taskDir: string, cwd: string): string {
  const relative = resolve(taskDir).startsWith(`${resolve(cwd)}/`) ? resolve(taskDir).slice(resolve(cwd).length + 1) : taskDir;
  return relative === '' ? '.' : relative;
}

interface NextAction {
  action: string;
  command: string;
  note?: string;
}

function nextActions(state: SuperwebState, taskDir: string, cwd: string): NextAction[] {
  const dir = relativeCommandPath(taskDir, cwd);
  const base = `superweb --dir ${dir}`;
  switch (state.stage) {
    case 'brief':
      return [
        {
          action: '生成设计方向',
          command: `${base} directions`,
          note: '需求至少 40 个有效字符；不够时先补全 需求.md（目标、受众、必须内容、素材）。',
        },
      ];
    case 'direction': {
      const directionsRelative = join(dir, state.artifacts.directions ?? DIRECTIONS_FILE);
      return [
        {
          action: '确认方向和内容结构',
          command: `${base} decide --gate direction --choice <方向ID>`,
          note: `三个方向见 ${directionsRelative}；先给用户看，得到明确选择后再提交。`,
        },
        {
          action: '重新抽取',
          command: `${base} directions --seed <新seed>`,
          note: '会推进 revision，旧的确认失效。',
        },
      ];
    }
    case 'sample':
      return [
        {
          action: '制作样页',
          command: `写 ${join(dir, SAMPLE_FILE)}`,
          note: '只做首屏 + 一个代表区块；app 路线做应用外壳 + 一个代表屏幕。使用已确认的 token 和真实文案。',
        },
        {
          action: '确认样页',
          command: `${base} decide --gate sample --choice accept`,
          note: '让用户先看 预览/v0.html；必要时用浏览器打开或截图给用户。',
        },
      ];
    case 'full':
      return [
        {
          action: '展开整页',
          command: `写 ${join(dir, PREVIEW_FILE)}`,
          note: '延续已确认方向；补全所有内容与响应式，不要重新设计。',
        },
        {
          action: '运行浏览器验收',
          command: `${base} inspect`,
          note: '桌面 1440、平板 768、手机 390 三档截图与检查。',
        },
      ];
    case 'acceptance': {
      const browserNote = state.acceptance.browserAvailable === false ? '本机 Chrome 不可用，交付会标注“未完成浏览器验收”。' : undefined;
      return [
        {
          action: '查看验收报告',
          command: `打开 ${join(dir, state.acceptance.reportPath ?? REPORT_FILE)}`,
          note: browserNote ?? '报告包含横向溢出、文字裁切、坏图片、控制台错误、主操作和键盘焦点检查。',
        },
        {
          action: '接受并交付',
          command: `${base} decide --gate acceptance --choice accept`,
          note: state.acceptance.passed
            ? '提交后会自动生成交付目录；如需重试，再运行 deliver。'
            : '验收存在问题：修复后重新 inspect；如果用户明确接受问题，加 --acknowledge-issues。',
        },
        {
          action: '返工',
          command: `${base} decide --gate acceptance --choice rework --target full`,
          note: '只改有问题的区块；--target sample 表示回到样页。旧确认会失效。',
        },
      ];
    }
    case 'delivered':
      return state.artifacts.delivery
        ? [
            {
              action: '打开交付页面',
              command: `打开 ${join(dir, state.artifacts.delivery, 'index.html')}`,
              note: '交付目录已生成；说明和验收证据在 交付/ 内。',
            },
            {
              action: '交付后返工',
              command: `${base} decide --gate acceptance --choice rework`,
              note: '新开 revision；旧交付保留，下一次 deliver 会归档为 交付-vN。',
            },
          ]
        : [
            {
              action: '生成交付目录',
              command: `${base} deliver`,
              note: '检查自包含并复制页面、素材、验收截图和说明。已有交付不会被覆盖。',
            },
            {
              action: '交付后返工',
              command: `${base} decide --gate acceptance --choice rework`,
              note: '新开 revision；旧交付保留，下一次 deliver 会归档为 交付-vN。',
            },
          ];
  }
}

function stateSummary(state: SuperwebState, taskDir: string, cwd: string) {
  return {
    ok: true,
    taskId: state.taskId,
    route: state.route,
    stage: state.stage,
    stageLabel: STAGE_LABELS[state.stage],
    stageRevision: state.stageRevision,
    selectedDirectionId: state.selectedDirectionId,
    decisions: state.decisions,
    artifacts: state.artifacts,
    acceptance: state.acceptance,
    next: nextActions(state, taskDir, cwd),
  };
}

function printNext(actions: NextAction[]): string {
  return actions.map((action, index) => `${index + 1}. ${action.action}\n   ${action.command}${action.note ? `\n   ${action.note}` : ''}`).join('\n');
}

function renderStatusHuman(state: SuperwebState, taskDir: string, cwd: string): string {
  const lines = [
    `任务：${state.taskId}`,
    `目录：${taskDir}`,
    `路线：${state.route}　阶段：${state.stage}（${STAGE_LABELS[state.stage]}）　revision：${state.stageRevision}`,
    `已选方向：${state.selectedDirectionId ?? '(未选择)'}`,
    `产物：${Object.entries(state.artifacts).map(([key, value]) => `${key}=${value}`).join('　') || '(无)'}`,
    `验收：${state.acceptance.passed ? '通过' : state.acceptance.browserAvailable === false ? '未完成浏览器验收' : '未通过或未运行'}`,
  ];
  if (state.acceptance.reportPath) lines.push(`报告：${state.acceptance.reportPath}`);
  lines.push('', '下一步：', printNext(nextActions(state, taskDir, cwd)));
  return lines.join('\n');
}

function renderContinueHuman(state: SuperwebState, taskDir: string, cwd: string): string {
  return renderStatusHuman(state, taskDir, cwd);
}

function renderStartHuman(state: SuperwebState, taskDir: string, cwd: string, directions?: Direction[]): string {
  const lines = [
    `已创建 SuperWeb 任务：${state.taskId}`,
    `目录：${taskDir}`,
    `路线：${state.route}（${state.route === 'page' ? '浏览型页面' : '工作型界面'}）　阶段：${state.stage}（${STAGE_LABELS[state.stage]}）　revision：${state.stageRevision}`,
  ];
  if (directions && directions.length > 0) {
    lines.push('', '已抽取 3 个方向：');
    for (const direction of directions) {
      lines.push(`- ${direction.id} — ${direction.nameZh}：${direction.concept}`);
    }
    lines.push(`方向与内容结构：${join(relativeCommandPath(taskDir, cwd), DIRECTIONS_FILE)}`);
  }
  lines.push('', '下一步：', printNext(nextActions(state, taskDir, cwd)));
  return lines.join('\n');
}

function autoDecisionId(gate: string, choice: string): string {
  const safe = choice.replace(/[^a-zA-Z0-9-]+/g, '-').slice(0, 24) || 'choice';
  return `d-${gate}-${safe}-${randomBytes(3).toString('hex')}`;
}

async function generateDirections(
  taskDir: string,
  state: SuperwebState,
  seed: string,
): Promise<{ state: SuperwebState; directions: Direction[] }> {
  if (state.stage !== 'brief' && state.stage !== 'direction') {
    throw new CliError(`当前阶段是 ${state.stage}，方向已确认，不能重新抽取。`, 3, '需要改方向时先走验收返工流程。');
  }
  const briefPath = join(taskDir, state.briefPath);
  const brief = await readFile(briefPath, 'utf8').catch(() => {
    throw new CliError(`找不到需求文件：${briefPath}。`, 3);
  });
  const assessment = assessBrief(brief);
  if (!assessment.ok) {
    throw new CliError(`需求还不够，不能给出方向：${assessment.reason}`, 3, `先补全 ${join(taskDir, BRIEF_FILE)}。`);
  }

  const directions = pickDirections(state.route, seed, 3);
  const doc = renderDirectionsDoc({
    taskId: state.taskId,
    route: state.route,
    seed,
    revision: state.stageRevision + 1,
    directions,
    blueprint: state.route === 'page' ? PAGE_BLUEPRINT : APP_BLUEPRINT,
  });
  await writeFile(join(taskDir, DIRECTIONS_FILE), doc, 'utf8');
  const nextState = markDirectionsReady(state);
  await writeState(taskDir, nextState);
  return { state: nextState, directions };
}

const BRIEF_TEMPLATE = `# 需求

## 要做什么


## 目标受众


## 必须出现的内容


## 素材（没有写“暂无”）
`;

export async function run(argv: string[], io: CliIO = {}): Promise<number> {
  const write = io.stdout ?? ((text: string) => process.stdout.write(text));
  const writeError = io.stderr ?? ((text: string) => process.stderr.write(text));
  const cwd = io.cwd ?? process.cwd();
  const { command, flags, positionals } = parseArgv(argv);
  const json = flags.json === true;

  const outputJson = (value: unknown) => write(`${JSON.stringify(value, null, 2)}\n`);
  const outputHuman = (text: string) => write(`${text}\n`);

  if (flags.help === true || command === 'help') {
    outputHuman(helpText());
    return 0;
  }
  if (flags.version === true) {
    outputHuman(`superweb ${VERSION}`);
    return 0;
  }
  if (!command) {
    writeError(`${helpText()}\n`);
    return 2;
  }
  if (positionals.length > 0) {
    writeError(`错误：命令 ${command} 不接受位置参数：${positionals.join(' ')}\n`);
    return 2;
  }

  try {
    assertKnownFlags(command, flags);

    switch (command) {
      case 'start': {
        const taskDir = resolve(cwd, stringFlag(flags, 'dir') ?? '.');
        const name = stringFlag(flags, 'name') ?? basename(taskDir);
        const routeFlag = stringFlag(flags, 'route');
        if (routeFlag && routeFlag !== 'page' && routeFlag !== 'app') {
          throw new CliError('--route 只接受 page 或 app。', 2);
        }
        const briefInline = stringFlag(flags, 'brief');
        const briefFile = stringFlag(flags, 'brief-file');
        if (briefInline && briefFile) throw new CliError('--brief 和 --brief-file 不能同时使用。', 2);

        if (await pathExists(statePath(taskDir))) {
          throw new CliError(`${taskDir} already contains ${STATE_FILE}；不会覆盖已有任务。`, 3, '换一个 --dir，或先备份并删除旧任务。');
        }
        const briefPath = join(taskDir, BRIEF_FILE);
        const hasExistingBrief = await pathExists(briefPath);
        if (hasExistingBrief && (briefInline || briefFile)) {
          throw new CliError(`${briefPath} already exists；不会覆盖需求文件。`, 3, '已有需求时加 --adopt-brief 直接接管，或换一个 --dir。');
        }
        if (hasExistingBrief && !flags['adopt-brief']) {
          throw new CliError(`${briefPath} already exists；不会覆盖需求文件。`, 3, '已有需求时加 --adopt-brief 直接接管，或换一个 --dir。');
        }
        if (!hasExistingBrief && flags['adopt-brief']) {
          throw new CliError('--adopt-brief 需要目录里已有 需求.md。', 2);
        }

        let briefText: string;
        if (hasExistingBrief) {
          briefText = await readFile(briefPath, 'utf8');
        } else if (briefFile) {
          briefText = await readFile(resolve(cwd, briefFile), 'utf8').catch(() => {
            throw new CliError(`读不到 --brief-file：${briefFile}。`, 3);
          });
        } else if (briefInline) {
          briefText = briefInline;
        } else {
          briefText = BRIEF_TEMPLATE;
        }

        await mkdir(taskDir, { recursive: true });
        await mkdir(join(taskDir, PREVIEW_DIR), { recursive: true });
        await mkdir(join(taskDir, '验收'), { recursive: true });

        const route: Route = (routeFlag as Route | undefined) ?? detectRoute(briefText === BRIEF_TEMPLATE ? name : briefText);
        const state = createState({ taskId: newTaskId(name), route });
        if (!hasExistingBrief) {
          const briefContent = briefInline || briefFile ? `# 需求：${name}\n\n${briefText.trim()}\n` : briefText;
          await writeFile(briefPath, briefContent, 'utf8');
        }
        await writeState(taskDir, state);

        let nextState = state;
        let directions: Direction[] | undefined;
        if ((briefInline || briefFile || hasExistingBrief) && assessBrief(briefText).ok) {
          const generated = await generateDirections(taskDir, state, state.taskId);
          nextState = generated.state;
          directions = generated.directions;
        }

        if (json) {
          outputJson({
            ...stateSummary(nextState, taskDir, cwd),
            ...(directions
              ? {
                  directions: directions.map((direction) => ({ id: direction.id, nameZh: direction.nameZh, nameEn: direction.nameEn })),
                  directionsPath: DIRECTIONS_FILE,
                }
              : {}),
          });
        } else {
          outputHuman(renderStartHuman(nextState, taskDir, cwd, directions));
        }
        return 0;
      }

      case 'directions': {
        const taskDir = resolve(cwd, stringFlag(flags, 'dir') ?? '.');
        const state = await readState(taskDir);
        const seed = stringFlag(flags, 'seed') ?? state.taskId;
        const generated = await generateDirections(taskDir, state, seed);
        const nextState = generated.state;
        const directions = generated.directions;

        const summary = {
          ok: true,
          stage: nextState.stage,
          stageRevision: nextState.stageRevision,
          seed,
          path: DIRECTIONS_FILE,
          directions: directions.map((direction) => ({ id: direction.id, nameZh: direction.nameZh, nameEn: direction.nameEn })),
          blueprint: (state.route === 'page' ? PAGE_BLUEPRINT : APP_BLUEPRINT).map((section) => ({
            id: section.id,
            title: section.title,
            required: section.required,
            proves: section.proves,
          })),
          next: nextActions(nextState, taskDir, cwd),
        };
        if (json) outputJson(summary);
        else {
          outputHuman(
            [
              `已抽取 3 个方向（${state.route}，seed=${seed}），写入 ${join(relativeCommandPath(taskDir, cwd), DIRECTIONS_FILE)}：`,
              ...directions.map((direction, index) => `${index + 1}. ${direction.id} — ${direction.nameZh}：${direction.concept}`),
              '',
              '内容结构：',
              ...(state.route === 'page' ? PAGE_BLUEPRINT : APP_BLUEPRINT).map(
                (section) => `- ${section.title}（${section.required ? '必需' : '可选'}）：${section.proves}`,
              ),
              '',
              '下一步：',
              printNext(nextActions(nextState, taskDir, cwd)),
            ].join('\n'),
          );
        }
        return 0;
      }

      case 'decide': {
        const taskDir = resolve(cwd, stringFlag(flags, 'dir') ?? '.');
        const state = await readState(taskDir);
        const gate = stringFlag(flags, 'gate', true) as 'direction' | 'sample' | 'acceptance';
        if (!['direction', 'sample', 'acceptance'].includes(gate)) {
          throw new CliError('--gate 只接受 direction、sample 或 acceptance。', 2);
        }
        const choice = stringFlag(flags, 'choice', true)!;
        const revision = intFlag(flags, 'revision') ?? state.stageRevision;
        const decisionId = stringFlag(flags, 'decision-id') ?? autoDecisionId(gate, choice);
        const target = stringFlag(flags, 'target');
        if (target && target !== 'full' && target !== 'sample') {
          throw new CliError('--target 只接受 full 或 sample。', 2);
        }

        if (gate === 'direction') {
          const directionsPath = join(taskDir, state.artifacts.directions ?? DIRECTIONS_FILE);
          const doc = await readFile(directionsPath, 'utf8').catch(() => {
            throw new CliError(`找不到 ${DIRECTIONS_FILE}，不能确认方向。`, 3, '先运行 superweb directions。');
          });
          const offered = parseOfferedDirectionIds(doc);
          if (!offered.includes(choice)) {
            throw new CliError(`方向 ${choice} 不在当前 3 个方向中（${offered.join('、')}）。`, 3, '重新给用户看当前方向，或重新 directions 抽取。');
          }
        }
        if (gate === 'sample' && !(await pathExists(join(taskDir, SAMPLE_FILE)))) {
          throw new CliError(`找不到 ${SAMPLE_FILE}，不能确认样页。`, 3, '先完成首屏 + 一个代表区块，并让用户看过。');
        }
        if (gate === 'acceptance') {
          const reportPath = join(taskDir, state.acceptance.reportPath ?? REPORT_FILE);
          if (!(await pathExists(reportPath))) {
            throw new CliError('找不到验收报告，不能提交验收决定。', 3, '先运行 superweb inspect。');
          }
        }

        const result = applyDecision(state, {
          gate,
          choice,
          revision,
          decisionId,
          ...(target ? { target: target as 'full' | 'sample' } : {}),
          acknowledgeIssues: flags['acknowledge-issues'] === true,
        });
        if (!result.idempotent) await writeState(taskDir, result.state);

        let stateAfter = result.state;
        let delivery: Record<string, unknown> | undefined;
        let exitCode = 0;
        if (!result.idempotent && gate === 'acceptance' && choice === 'accept') {
          try {
            const delivered = await deliverTask({ taskDir, state: result.state });
            stateAfter = {
              ...result.state,
              artifacts: { ...result.state.artifacts, delivery: DELIVERY_DIR },
            };
            await writeState(taskDir, stateAfter);
            delivery = { ok: true, ...delivered };
          } catch (error) {
            if (!(error instanceof DeliveryError)) throw error;
            delivery = { ok: false, error: error.message, issues: error.issues };
            exitCode = 1;
          }
        }

        const summary = {
          ok: delivery ? delivery.ok === true : true,
          idempotent: result.idempotent,
          stage: stateAfter.stage,
          stageRevision: stateAfter.stageRevision,
          selectedDirectionId: stateAfter.selectedDirectionId,
          decisionId,
          path: stateAfter.artifacts.delivery ?? null,
          ...(delivery ? { delivery } : {}),
          next: nextActions(stateAfter, taskDir, cwd),
        };
        if (json) outputJson(summary);
        else {
          const lines = [
            result.idempotent
              ? `决定 ${decisionId} 已提交过，本次幂等返回。`
              : `已记录决定 ${decisionId}（${gate}/${choice}）。`,
            `阶段：${stateAfter.stage}（${STAGE_LABELS[stateAfter.stage]}）　revision：${stateAfter.stageRevision}`,
          ];
          if (delivery) {
            if (delivery.ok === true) {
              lines.push(`已自动交付：${join(relativeCommandPath(taskDir, cwd), DELIVERY_DIR)}`);
            } else {
              lines.push(`交付未完成：${String(delivery.error)}`);
              for (const issue of (delivery.issues as Array<{ file: string; message: string }>) ?? []) {
                lines.push(`- ${issue.file}: ${issue.message}`);
              }
            }
          }
          lines.push('', '下一步：', printNext(nextActions(stateAfter, taskDir, cwd)));
          outputHuman(lines.join('\n'));
        }
        return exitCode;
      }

      case 'inspect': {
        const taskDir = resolve(cwd, stringFlag(flags, 'dir') ?? '.');
        const state = await readState(taskDir);
        if (state.stage !== 'full' && state.stage !== 'acceptance') {
          throw new CliError(`当前阶段是 ${state.stage}，只有 full 或 acceptance 阶段可以运行 inspect。`, 3);
        }
        if (!(await pathExists(join(taskDir, PREVIEW_FILE)))) {
          throw new CliError(`找不到 ${PREVIEW_FILE}，无法验收。`, 3, '先完成整页。');
        }
        const timeout = intFlag(flags, 'timeout');
        const result = await inspectTask({
          taskDir,
          route: state.route,
          taskId: state.taskId,
          ...(stringFlag(flags, 'chrome') ? { chrome: stringFlag(flags, 'chrome') } : {}),
          ...(timeout ? { timeoutMs: timeout } : {}),
        });
        const nextState = markInspected(state, {
          passed: result.report.passed,
          reportPath: result.reportPath,
          screenshots: result.report.viewports.map((viewport) => viewport.screenshot),
          browserAvailable: result.report.browser.available,
          issueCount: result.report.issueCount,
        });
        await writeState(taskDir, nextState);

        const summary = {
          ok: result.report.passed,
          stage: nextState.stage,
          stageRevision: nextState.stageRevision,
          passed: result.report.passed,
          browserAvailable: result.report.browser.available,
          reportPath: result.reportPath,
          screenshots: result.report.viewports.map((viewport) => viewport.screenshot),
          issueCount: result.report.issueCount,
          issues: result.report.issues,
          next: nextActions(nextState, taskDir, cwd),
        };
        if (json) outputJson(summary);
        else {
          const header = !result.report.browser.available
            ? '浏览器验收未完成（本机 Chrome 不可用）'
            : result.report.passed
              ? '浏览器验收通过'
              : `浏览器验收未通过：${result.report.issueCount} 个问题`;
          outputHuman(
            [
              header,
              ...(result.report.browser.reason ? [`原因：${result.report.browser.reason}`] : []),
              `报告：${result.reportPath}`,
              ...(result.report.viewports.length ? [`截图：${result.report.viewports.map((viewport) => viewport.screenshot).join('、')}`] : []),
              ...result.report.issues.map((issue) => `- [${issue.viewport}/${issue.check}] ${issue.message}`),
              '',
              '下一步：',
              printNext(nextActions(nextState, taskDir, cwd)),
            ].join('\n'),
          );
        }
        return result.exitCode;
      }

      case 'deliver': {
        const taskDir = resolve(cwd, stringFlag(flags, 'dir') ?? '.');
        const state = await readState(taskDir);
        try {
          const result = await deliverTask({ taskDir, state });
          const nextState: SuperwebState = {
            ...state,
            artifacts: { ...state.artifacts, delivery: DELIVERY_DIR },
          };
          await writeState(taskDir, nextState);
          const summary = {
            ok: true,
            delivery: result,
            stage: nextState.stage,
            stageRevision: nextState.stageRevision,
            path: DELIVERY_DIR,
            next: nextActions(nextState, taskDir, cwd),
          };
          if (json) outputJson(summary);
          else {
            outputHuman(
              [
                `交付完成：${join(relativeCommandPath(taskDir, cwd), DELIVERY_DIR)}`,
                ...(result.archived ? [`上一版已归档：${join(relativeCommandPath(taskDir, cwd), result.archived)}`] : []),
                `文件数：${result.fileCount}　验收问题：${result.issueCount}`,
                '直接双击 交付/index.html 即可打开。',
                '',
                '下一步：',
                printNext(nextActions(nextState, taskDir, cwd)),
              ].join('\n'),
            );
          }
          return 0;
        } catch (error) {
          if (error instanceof DeliveryError) {
            const details = error.issues.map((issue) => `- ${issue.file}: ${issue.message}`).join('\n');
            if (json) {
              outputJson({ ok: false, error: error.message, issues: error.issues });
            } else {
              writeError(`交付被拒绝：${error.message}\n${details}\n`);
            }
            return 1;
          }
          throw error;
        }
      }

      case 'status':
      case 'continue': {
        const taskDir = resolve(cwd, stringFlag(flags, 'dir') ?? '.');
        const state = await readState(taskDir);
        if (json) outputJson(stateSummary(state, taskDir, cwd));
        else outputHuman(command === 'status' ? renderStatusHuman(state, taskDir, cwd) : renderContinueHuman(state, taskDir, cwd));
        return 0;
      }

      default:
        throw new CliError(`未知命令：${command}。`, 2, '运行 superweb --help 查看可用命令。');
    }
  } catch (error) {
    if (error instanceof StateError) {
      if (json) outputJson({ ok: false, error: error.message, hint: error.hint });
      else writeError(`错误：${error.message}${error.hint ? `\n提示：${error.hint}` : ''}\n`);
      return 3;
    }
    if (error instanceof CliError) {
      if (json) outputJson({ ok: false, error: error.message, hint: error.hint });
      else writeError(`错误：${error.message}${error.hint ? `\n提示：${error.hint}` : ''}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (json) outputJson({ ok: false, error: message });
    else writeError(`错误：${message}\n`);
    return 1;
  }
}

function helpText(): string {
  return `SuperWeb ${VERSION} — 有阶段门的网页创作流程

用法：
  superweb <命令> [参数]

任务目录参数：
  --dir <目录>              任务目录，默认当前目录
  --json                    输出机器可读 JSON

命令：
  start                     创建任务、superweb.json 和 需求.md；需求足够时直接抽方向
      --name <名称>         任务名称，默认目录名
      --route page|app      覆盖自动路线判断
      --brief <文本>        需求正文
      --brief-file <路径>   从文件读取需求
      --adopt-brief         接管已有 需求.md，不覆盖
  directions                重新抽 3 个方向 + 内容结构（通常不需要手动运行）
      --seed <字符串>       可复现的抽取种子，默认 taskId
  decide                    提交决定（校验阶段；revision 默认当前值）
      --gate direction|sample|acceptance
      --choice <方向ID|accept|rework>
      --revision <数字>     可选；默认使用当前 stageRevision
      --decision-id <ID>    可选；默认自动生成，显式传入可保证幂等
      --target full|sample  仅验收返工：回到哪个阶段
      --acknowledge-issues  验收未通过时明确接受问题
  inspect                   用本机 Chrome 在桌面/平板/手机三档验收
      --chrome <路径>       指定 Chrome 可执行文件
      --timeout <毫秒>      单页加载超时，默认 15000
  deliver                   重新生成交付目录（接受验收时会自动交付）
  continue                  查看当前阶段、决定、产物和下一步（只读）
  status                    只读查看状态（不推进阶段）

退出码：0 成功；1 验收/交付检查失败；2 参数错误；3 状态或决定被拒绝；4 本机 Chrome 不可用
`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await run(process.argv.slice(2));
}
