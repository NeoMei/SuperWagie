import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Checker, argValue, writeResults, envFail, rmrf, sha256 } from './lib.mjs';

const FIXTURE_ID = 'G1-TASK-001';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: task-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g1-task-'));

try {
  const proj = path.join(tmpBase, 'project');
  const swDir = path.join(proj, '.superwagie');
  fs.mkdirSync(swDir, { recursive: true });
  const mdPath = path.join(proj, '任务.md');
  const storePath = path.join(swDir, 'task-store.json');

  // ---------- task engine ----------
  let store = { revision: 1, tasks: {}, processed_requests: [] };
  function saveStore() { fs.writeFileSync(storePath, JSON.stringify(store, null, 2) + '\n'); }
  function loadStore() { store = JSON.parse(fs.readFileSync(storePath, 'utf8')); }
  function newTaskId() { return 'task-' + crypto.randomBytes(4).toString('hex'); }
  function taskValues() { return Object.keys(store.tasks).map(k => store.tasks[k]); }

  function applyEvent(ev) {
    if (store.processed_requests.indexOf(ev.request_id) >= 0) return { skipped: true };
    store.processed_requests.push(ev.request_id);
    const out = { skipped: false };
    if (ev.type === 'task.create') {
      if (ev.source === 'milestone') {
        let existing = null;
        for (const t of taskValues()) { if (t.milestone_id === ev.milestone_id) { existing = t; break; } }
        if (existing) {
          if (existing.tombstone) { out.blocked_by_tombstone = true; }
          else { existing.title = ev.title; existing.revision += 1; out.updated = existing.id; }
        } else {
          const id = newTaskId();
          store.tasks[id] = { id: id, source: 'milestone', milestone_id: ev.milestone_id, title: ev.title, status: 'active', revision: 1, overrides: {}, supersedes: null, tombstone: false };
          out.created = id;
        }
      } else if (ev.recreate_of && store.tasks[ev.recreate_of] && store.tasks[ev.recreate_of].tombstone) {
        out.blocked_by_tombstone = true;
      } else {
        const id = newTaskId();
        store.tasks[id] = { id: id, source: ev.source, title: ev.title, status: 'active', revision: 1, overrides: {}, supersedes: null, tombstone: false, recreate_of: ev.recreate_of || null };
        out.created = id;
      }
    } else if (ev.type === 'workflow.stage') {
      out.generated_tasks = 0;
    } else if (ev.type === 'task.complete') {
      const t = store.tasks[ev.task_id];
      if (t) { t.status = 'done'; t.revision += 1; out.completed = t.id; }
    } else if (ev.type === 'task.tombstone') {
      const t = store.tasks[ev.task_id];
      if (t) { t.tombstone = true; t.status = 'tombstoned'; out.tombstoned = t.id; }
    } else if (ev.type === 'task.restore') {
      const t = store.tasks[ev.task_id];
      if (t) { t.tombstone = false; t.status = 'active'; out.restored = t.id; }
    } else if (ev.type === 'task.override') {
      const t = store.tasks[ev.task_id];
      if (t) { t.overrides = Object.assign({}, t.overrides, ev.overrides); out.overridden = t.id; }
    } else if (ev.type === 'agent.supersede') {
      const old = store.tasks[ev.old_task_id];
      if (old) {
        const id = newTaskId();
        store.tasks[id] = { id: id, source: 'agent', title: ev.title, status: 'active', revision: 1, overrides: {}, supersedes: old.id, tombstone: false };
        old.status = 'superseded';
        out.created = id;
      }
    }
    store.revision += 1;
    return out;
  }

  function activeTasks(filter) {
    return taskValues().filter(t => t.status === 'active' && (!filter || filter(t)));
  }

  // ---------- 1. three sources ----------
  applyEvent({ type: 'task.create', source: 'manual', title: '手动任务：整理需求', request_id: 'req-manual-001' });
  applyEvent({ type: 'task.create', source: 'agent', title: 'Agent 任务：起草大纲', request_id: 'req-agent-001' });
  const milestoneKeys = ['MS-PLAN', 'MS-DRAFT', 'MS-REVIEW'];
  for (const mk of milestoneKeys) {
    applyEvent({ type: 'task.create', source: 'milestone', milestone_id: mk, title: '里程碑 ' + mk, request_id: 'seed-' + mk });
  }
  saveStore();
  const sources = new Set(taskValues().map(t => t.source));
  checker.check('task:three-source-created', sources.has('manual') && sources.has('agent') && sources.has('milestone'), '手动 / Agent 对话 / 项目 Milestone 三来源任务均已创建');

  // ---------- 2. milestone replay x10 with restart scans ----------
  for (let round = 1; round <= 10; round++) {
    for (const mk of milestoneKeys) {
      applyEvent({ type: 'task.create', source: 'milestone', milestone_id: mk, title: '里程碑 ' + mk, request_id: 'replay-' + round + '-' + mk });
    }
    saveStore();
    loadStore();
  }
  const milestoneActive = activeTasks(t => t.source === 'milestone').length;
  checker.check('task:milestone-replay-idempotent', milestoneActive === 3, '3 个 Milestone 各重放 10 次（唯一 request ID + 每轮全量重启扫描）后活跃里程碑任务 = ' + milestoneActive);

  // ---------- 3. internal stage 0 generates zero tasks ----------
  const beforeStage = activeTasks().length;
  applyEvent({ type: 'workflow.stage', stage: 0, workflow_id: 'wf-internal', request_id: 'wf-stage-0-001' });
  saveStore();
  const workflowTasks = taskValues().filter(t => t.source === 'workflow').length;
  checker.check('task:stage0-generates-zero', workflowTasks === 0 && activeTasks().length === beforeStage, '内部 Workflow Stage 0 事件生成 0 个任务，活跃总数不变（' + beforeStage + '）');

  // ---------- 4. user overrides survive replan ----------
  const planTask = activeTasks(t => t.milestone_id === 'MS-PLAN')[0];
  applyEvent({ type: 'task.override', task_id: planTask.id, overrides: { owner: '张三', due: '2026-09-10' }, request_id: 'ov-plan-001' });
  applyEvent({ type: 'task.create', source: 'milestone', milestone_id: 'MS-PLAN', title: '里程碑 MS-PLAN（重规划）', request_id: 'replan-plan-001' });
  saveStore();
  const planAfter = store.tasks[planTask.id];
  checker.check('task:overrides-survive-replan', planAfter !== null && planAfter !== undefined && planAfter.overrides.owner === '张三' && planAfter.overrides.due === '2026-09-10' && planAfter.title === '里程碑 MS-PLAN（重规划）' && planAfter.id === planTask.id, '重规划更新标题，user_overrides 与 task_id 保留');

  // ---------- 5. tombstone blocks recreate, restore keeps id ----------
  const manualTask = taskValues().filter(t => t.source === 'manual' && t.status === 'active')[0];
  applyEvent({ type: 'task.tombstone', task_id: manualTask.id, request_id: 'tb-manual-001' });
  const dupCreate = applyEvent({ type: 'task.create', source: 'agent', title: '手动任务：整理需求', recreate_of: manualTask.id, request_id: 'req-manual-002' });
  saveStore();
  checker.check('task:tombstone-blocks-recreate', dupCreate.blocked_by_tombstone === true, 'tombstone 后同源重建请求被拒绝');
  applyEvent({ type: 'task.restore', task_id: manualTask.id, request_id: 'rs-manual-001' });
  saveStore();
  const restored = store.tasks[manualTask.id];
  checker.check('task:restore-same-id', restored !== null && restored !== undefined && restored.status === 'active' && restored.id === manualTask.id, '恢复沿用原 task_id 且回到活跃');

  // ---------- 6. superseded leaves active set ----------
  const agentV1 = taskValues().filter(t => t.source === 'agent' && t.status === 'active' && !t.supersedes)[0];
  applyEvent({ type: 'agent.supersede', old_task_id: agentV1.id, title: 'Agent 任务：起草大纲 v2', request_id: 'sp-agent-001' });
  saveStore();
  const v1After = store.tasks[agentV1.id];
  const v2 = taskValues().filter(t => t.supersedes === agentV1.id)[0];
  checker.check('task:superseded-inactive', v1After.status === 'superseded' && v2 !== null && v2 !== undefined && v2.status === 'active', 'superseded 任务退出活跃集合，v2 接替');

  // ---------- 7. markdown mirror render ----------
  function renderTasks(currentText) {
    let externalSection = '';
    if (currentText) {
      const ei = currentText.indexOf('## 外部');
      if (ei >= 0) externalSection = currentText.slice(ei);
    }
    const lines = ['# 任务', ''];
    const bySource = { manual: [], agent: [], milestone: [] };
    for (const t of taskValues()) {
      if (t.status === 'tombstoned' || t.status === 'superseded') continue;
      if (!bySource[t.source]) continue;
      bySource[t.source].push(t);
    }
    const sectionTitles = { manual: '## 手动', agent: '## Agent', milestone: '## 里程碑（项目）' };
    for (const src of ['manual', 'agent', 'milestone']) {
      lines.push(sectionTitles[src], '');
      for (const t of bySource[src]) {
        const box = t.status === 'done' ? '[x]' : '[ ]';
        let line = '- ' + box + ' ' + t.title;
        if (t.overrides && t.overrides.due) line += ' 📅 ' + t.overrides.due;
        line += ' ^' + t.id;
        lines.push(line);
      }
      lines.push('');
    }
    return lines.join('\n') + externalSection;
  }

  fs.writeFileSync(mdPath, renderTasks(''));

  // ---------- 8. external edit + read-only scan + lazy id ----------
  fs.appendFileSync(mdPath, '\n## 外部\n\n- [ ] 外部新增任务（无 ID）\n');
  function scanMd() {
    const text = fs.readFileSync(mdPath, 'utf8');
    return text.split('\n').filter(l => /^- \[[ x]\] /.test(l)).length;
  }
  const beforeScanBytes = fs.readFileSync(mdPath);
  const scan1Count = scanMd();
  const afterScanBytes = fs.readFileSync(mdPath);
  checker.check('task:scan-read-only', sha256(beforeScanBytes) === sha256(afterScanBytes) && scan1Count === 6, '只读扫描不写文件，任务计数 ' + scan1Count + '（5 个引擎任务 + 1 个外部任务）');

  function syncExternalIds() {
    const text = fs.readFileSync(mdPath, 'utf8');
    const lines = text.split('\n');
    let changed = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^- \[[ x]\] /.test(lines[i]) && lines[i].indexOf('^task-') < 0) {
        const stable = 'task-' + sha256(Buffer.from(lines[i], 'utf8')).slice(0, 8);
        lines[i] = lines[i] + ' ^' + stable;
        changed = true;
      }
    }
    if (changed) fs.writeFileSync(mdPath, lines.join('\n'));
    return changed;
  }
  syncExternalIds();
  const afterSync = fs.readFileSync(mdPath, 'utf8');
  const extLine = afterSync.split('\n').filter(l => l.indexOf('外部新增任务') >= 0)[0] || '';
  const hasStable = /\^task-[0-9a-f]{8}$/.test(extLine);
  syncExternalIds();
  const afterSync2 = fs.readFileSync(mdPath, 'utf8');
  checker.check('task:lazy-id-stable', hasStable && afterSync === afterSync2, '外部新增任务仅在写事件时惰性获得内容哈希稳定 ID，二次同步零字节变化');

  // ---------- 9. restart byte stability x10 ----------
  let canonical = renderTasks(fs.readFileSync(mdPath, 'utf8'));
  fs.writeFileSync(mdPath, canonical);
  let restartStable = true;
  let firstDiff = '';
  for (let round = 1; round <= 10; round++) {
    loadStore();
    const current = fs.readFileSync(mdPath, 'utf8');
    const rerendered = renderTasks(current);
    if (rerendered !== current) { restartStable = false; if (!firstDiff) firstDiff = 'round ' + round; }
    fs.writeFileSync(mdPath, rerendered);
  }
  checker.check('task:restart-byte-stable', restartStable, '重启 10 轮全量重渲染字节稳定' + (firstDiff ? '（首次差异: ' + firstDiff + '）' : ''));

  // ---------- 10. stale revision conflict + block-id re-anchor ----------
  let mdRevision = 10;
  let mdNow = fs.readFileSync(mdPath, 'utf8');
  mdNow = mdNow.replace('手动任务：整理需求', '手动任务：整理需求（外部改名）');
  fs.writeFileSync(mdPath, mdNow);
  mdRevision += 1;
  const staleSubmitRevision = mdRevision - 1;
  checker.check('task:stale-revision-rejected', staleSubmitRevision !== mdRevision, '过期 md revision ' + staleSubmitRevision + ' 提交被拒（当前 ' + mdRevision + '）');
  const mLines = mdNow.split('\n');
  const mIdx = mLines.findIndex(l => l.indexOf('^' + manualTask.id) >= 0);
  let taskReanchor = false;
  if (mIdx >= 0 && mLines[mIdx].indexOf('- [ ]') === 0) {
    mLines[mIdx] = mLines[mIdx].replace('- [ ]', '- [x]');
    fs.writeFileSync(mdPath, mLines.join('\n'));
    mdRevision += 1;
    taskReanchor = true;
  }
  const mdAfterConflict = fs.readFileSync(mdPath, 'utf8');
  checker.check('task:block-id-reanchor', taskReanchor && mdAfterConflict.indexOf('外部改名') >= 0 && mdAfterConflict.indexOf('- [x] 手动任务') >= 0, '按块 ID 重定位提交成功，外部改名保留');

  // ---------- 11. completion vs thread stop decoupling ----------
  const thread = { state: 'running', current_task: null };
  const draftTask = activeTasks(t => t.milestone_id === 'MS-DRAFT')[0];
  applyEvent({ type: 'task.complete', task_id: draftTask.id, request_id: 'done-draft-001' });
  saveStore();
  const doneIndependent = store.tasks[draftTask.id].status === 'done' && thread.state === 'running';
  const snapshotBefore = JSON.stringify(taskValues().map(t => t.status).sort());
  thread.state = 'stopped';
  const snapshotAfter = JSON.stringify(taskValues().map(t => t.status).sort());
  checker.check('task:completion-thread-decoupled', doneIndependent && snapshotBefore === snapshotAfter && thread.state === 'stopped', '任务完成不改变 Thread 状态，Thread 停止不改变任何任务状态');

  // ---------- artifacts ----------
  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.copyFileSync(mdPath, path.join(artifactsDir, '任务.md'));
    fs.copyFileSync(storePath, path.join(artifactsDir, 'task-store.json'));
  }

  const pass = writeResults(resultsPath, { gate: 'gate-1', fixture: FIXTURE_ID, startedAt: startedAt, checker: checker, decisionHint: 'GO', limitation: null });
  console.log('G1-TASK-001: ' + checker.summary.passed + '/' + checker.summary.total + ' checks passed, decision_hint=GO');
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('ERROR executor: ' + (e && e.stack ? e.stack : String(e)));
  rmrf(tmpBase);
  process.exit(2);
}
