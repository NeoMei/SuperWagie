import { randomBytes } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type Gate,
  type Route,
  type Stage,
  type SuperwebState,
  StateError,
  parseState,
} from './schema.js';

export const STATE_FILE = 'superweb.json';
export const BRIEF_FILE = '需求.md';
export const DIRECTIONS_FILE = '设计方向.md';
export const GUIDED_BUILD_FILE = '设计引导.md';
export const COPY_FILE = '文案.md';
export const PREVIEW_DIR = '预览';
export const SAMPLE_FILE = '预览/v0.html';
export const PREVIEW_FILE = '预览/index.html';
export const ACCEPTANCE_DIR = '验收';
export const REPORT_FILE = '验收/report.json';
export const DELIVERY_DIR = '交付';

export const STAGE_ORDER: Stage[] = [
  'brief',
  'direction',
  'sample',
  'full',
  'acceptance',
  'delivered',
];

export const STAGE_LABELS: Record<Stage, string> = {
  brief: '需求',
  direction: '选择方向',
  sample: '制作样页',
  full: '制作整页',
  acceptance: '浏览器验收',
  delivered: '交付',
};

export interface DecideInput {
  gate: Gate;
  choice: string;
  revision: number;
  decisionId: string;
  target?: 'full' | 'sample';
  acknowledgeIssues?: boolean;
  now?: string;
}

export interface DecideResult {
  state: SuperwebState;
  idempotent: boolean;
  nextStage: Stage;
}

export function newTaskId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'task';
  return `${slug}-${randomBytes(3).toString('hex')}`;
}

export function createState(options: {
  taskId: string;
  route: Route;
  briefPath?: string;
}): SuperwebState {
  return {
    version: 1,
    taskId: options.taskId,
    route: options.route,
    stage: 'brief',
    stageRevision: 1,
    briefPath: options.briefPath ?? BRIEF_FILE,
    selectedDirectionId: null,
    decisions: [],
    artifacts: { brief: options.briefPath ?? BRIEF_FILE },
    acceptance: { passed: false },
  };
}

function gateStage(gate: Gate): Stage {
  return gate === 'direction' ? 'direction' : gate === 'sample' ? 'sample' : 'acceptance';
}

export function applyDecision(state: SuperwebState, input: DecideInput): DecideResult {
  const previous = state.decisions.find((decision) => decision.id === input.decisionId);
  if (previous) {
    const normalizedTarget = input.gate === 'acceptance' && input.choice === 'rework' ? input.target ?? 'full' : undefined;
    const previousTarget = previous.gate === 'acceptance' && previous.choice === 'rework' ? previous.target ?? 'full' : undefined;
    const same =
      previous.gate === input.gate &&
      previous.choice === input.choice &&
      previous.revision === input.revision &&
      previousTarget === normalizedTarget &&
      Boolean(previous.acknowledgedIssues) === Boolean(input.acknowledgeIssues);
    if (same) {
      return { state, idempotent: true, nextStage: state.stage };
    }
    throw new StateError(
      `决定 ${input.decisionId} 已用于 ${previous.gate}/${previous.choice}（revision ${previous.revision}），不能改成 ${input.gate}/${input.choice}。`,
      '每次新的确认使用新的 decision-id。',
    );
  }

  const expectedStage = gateStage(input.gate);
  const reworkingAfterDelivery = input.gate === 'acceptance' && input.choice === 'rework' && state.stage === 'delivered';
  if (state.stage !== expectedStage && !reworkingAfterDelivery) {
    throw new StateError(
      `当前阶段是 ${state.stage}（${STAGE_LABELS[state.stage]}），不能提交 ${input.gate} 决定。`,
      `先运行 superweb continue 查看下一步。`,
    );
  }

  if (input.revision !== state.stageRevision) {
    throw new StateError(
      `stageRevision 已过期：提交的是 ${input.revision}，当前是 ${state.stageRevision}。`,
      '重新读取 superweb.json 或 continue，用当前 revision 重新确认。',
    );
  }

  if (input.gate === 'sample' && input.choice !== 'accept') {
    throw new StateError(`样页决定只接受 accept，收到 ${input.choice}。`);
  }

  if (input.target && !(input.gate === 'acceptance' && input.choice === 'rework')) {
    throw new StateError('target 只适用于 acceptance/rework 决定。');
  }
  if (input.acknowledgeIssues && input.gate !== 'acceptance') {
    throw new StateError('acknowledgeIssues 只适用于 acceptance 决定。');
  }

  if (input.gate === 'acceptance' && input.choice !== 'accept' && input.choice !== 'rework') {
    throw new StateError(`验收决定只接受 accept 或 rework，收到 ${input.choice}。`);
  }

  if (input.gate === 'acceptance' && input.choice === 'accept' && !state.acceptance.passed && !input.acknowledgeIssues) {
    throw new StateError(
      '验收未通过或未完成，不能直接接受。',
      '修复后重新 inspect；确实要带问题交付时加 --acknowledge-issues。',
    );
  }

  const decision = {
    id: input.decisionId,
    gate: input.gate,
    revision: state.stageRevision,
    choice: input.choice,
    at: input.now ?? new Date().toISOString(),
    ...(input.gate === 'acceptance' && input.choice === 'rework' ? { target: input.target ?? 'full' } : {}),
    ...(input.acknowledgeIssues ? { acknowledgedIssues: true } : {}),
  };

  const next: SuperwebState = {
    ...state,
    decisions: [...state.decisions, decision],
    stageRevision: state.stageRevision + 1,
  };

  if (input.gate === 'direction') {
    next.stage = 'sample';
    next.selectedDirectionId = input.choice;
  } else if (input.gate === 'sample') {
    next.stage = 'full';
    next.artifacts = { ...next.artifacts, sample: SAMPLE_FILE };
  } else if (input.choice === 'accept') {
    next.stage = 'delivered';
  } else {
    const target = input.target ?? 'full';
    if (target !== 'full' && target !== 'sample') {
      throw new StateError(`返工目标只能是 full 或 sample，收到 ${target}。`);
    }
    next.stage = target;
  }

  return { state: next, idempotent: false, nextStage: next.stage };
}

export function markDirectionsReady(state: SuperwebState): SuperwebState {
  if (state.stage !== 'brief' && state.stage !== 'direction') {
    throw new StateError(
      `当前阶段是 ${state.stage}，不能重新生成设计方向。`,
      '方向确认后如需改方向，先走验收返工流程。',
    );
  }
  return {
    ...state,
    stage: 'direction',
    stageRevision: state.stageRevision + 1,
    selectedDirectionId: null,
    artifacts: { ...state.artifacts, directions: DIRECTIONS_FILE, guide: GUIDED_BUILD_FILE },
  };
}

export function markInspected(
  state: SuperwebState,
  result: {
    passed: boolean;
    reportPath: string;
    screenshots: string[];
    browserAvailable: boolean;
    issueCount: number;
    previewHash?: string;
    now?: string;
  },
): SuperwebState {
  if (state.stage !== 'full' && state.stage !== 'acceptance') {
    throw new StateError(
      `当前阶段是 ${state.stage}，只有 full 或 acceptance 阶段可以运行 inspect。`,
      '先完成样页确认，并生成 预览/index.html。',
    );
  }
  return {
    ...state,
    stage: 'acceptance',
    stageRevision: state.stageRevision + 1,
    artifacts: { ...state.artifacts, preview: PREVIEW_FILE },
    acceptance: {
      passed: result.passed,
      reportPath: result.reportPath,
      screenshots: result.screenshots,
      browserAvailable: result.browserAvailable,
      issueCount: result.issueCount,
      ...(result.previewHash ? { previewHash: result.previewHash } : {}),
      checkedAt: result.now ?? new Date().toISOString(),
    },
  };
}

export function statePath(taskDir: string): string {
  return join(taskDir, STATE_FILE);
}

export async function readState(taskDir: string): Promise<SuperwebState> {
  let raw: string;
  try {
    raw = await readFile(statePath(taskDir), 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new StateError(
        `在 ${taskDir} 找不到 superweb.json。`,
        '用 superweb start --dir <目录> 创建任务，或用 --dir 指向已有任务目录。',
      );
    }
    throw new StateError(
      `读取 ${statePath(taskDir)} 失败：${error instanceof Error ? error.message : String(error)}`,
      '检查文件权限、磁盘状态和任务目录后重试。',
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StateError(
      'superweb.json 不是合法 JSON，状态文件已保留，不会自动重置。',
      '检查文件末尾逗号或手工修复；如无法修复，备份后重新 start。',
    );
  }
  return parseState(parsed);
}

export async function writeState(taskDir: string, state: SuperwebState): Promise<void> {
  const target = statePath(taskDir);
  const temp = `${target}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temp, target);
  } finally {
    await unlink(temp).catch(() => {});
  }
}
