#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const schemaDir = path.dirname(fileURLToPath(import.meta.url));
const contractsDir = path.resolve(schemaDir, '..');
const common = 'superwagie://schemas/v1/public-method-common#/$defs/';
const ref = (name) => ({ $ref: common + name });
const str = (minLength = 1, maxLength = 10000) => ({ type: 'string', minLength, maxLength });
const en = (...values) => ({ enum: values });
const arr = (items, minItems = 0, maxItems = 128, extra = {}) => ({ type: 'array', items, minItems, maxItems, ...extra });
const obj = (required, properties, extra = {}) => ({ type: 'object', additionalProperties: false, required, properties, ...extra });
const id = ref('Identifier');
const rev = ref('Revision');
const artifact = ref('ArtifactRef');
const receipt = ref('OperationReceipt');
const usage = ref('UsageReceipt');
const logicalPath = ref('LogicalPath');
const contentScope = ref('ContentScope');
const workingSet = ref('WorkingSet');
const cursor = ref('Cursor');
const outputSchema = ref('OutputSchemaRequest');
const publicHttpsUrl = ref('PublicHttpsUrl');

const timestamp = '2026-09-01T00:00:00Z';
const hash = 'sha256:' + 'a'.repeat(64);
const artifactFixture = (suffix = '1', mediaType = 'application/octet-stream', logical = '/output/artifact.bin') => ({
  artifact_id: `artifact-${suffix}`,
  artifact_revision_id: `artifact-revision-${suffix}`,
  owner_type: 'project',
  owner_id: 'project-1',
  media_type: mediaType,
  logical_path: logical,
  content_hash: hash,
  provenance: { producer: 'capability.public', input_hashes: [] },
  acceptance_state: 'structurally_valid',
});
const receiptFixture = (suffix = '1') => ({ receipt_id: `receipt-${suffix}`, status: 'completed', recorded_at: timestamp });
const usageFixture = (category) => ({
  usage_receipt_id: `usage-${category}-1`, capability_category: category, credits: 1, status: 'settled', recorded_at: timestamp,
});
const scopeFixture = { logical_paths: ['/workspace/project.md'] };
const outputSchemaFixture = { schema_id: 'result.schema.v1', root_type: 'object', required_fields: ['summary'] };
const taskRef = { task_id: 'task-1', title: 'Prepare delivery', state: 'planned', revision: 1 };
const resourceHandleFixture = {
  handle_id: 'handle-1', resource_type: 'staged_output', resource_id: 'staged-1', resource_revision: 'revision-1',
  audience: { kind: 'capability', id: 'artifact.register' }, allowed_operations: ['read'], project_id: 'project-1',
  owner_type: 'project', owner_id: 'project-1', media_type: 'application/octet-stream', size_limit_bytes: 1048576,
  range_limit_bytes: 65536, issued_at: timestamp, expires_at: '2026-09-01T00:05:00Z', one_shot: true,
  auth_tag: 'A'.repeat(43),
};

const methods = [
  {
    name: 'workspace.read',
    input: obj(['logical_path', 'range', 'expected_revision'], {
      logical_path: logicalPath,
      range: obj(['offset', 'length'], { offset: { type: 'integer', minimum: 0 }, length: { type: 'integer', minimum: 1, maximum: 1048576 } }),
      expected_revision: rev,
    }),
    output: obj(['content', 'workspace_revision', 'content_hash'], { content: str(0, 1048576), workspace_revision: rev, content_hash: ref('Hash') }),
    sample: { input: { logical_path: '/workspace/project.md', range: { offset: 0, length: 4096 }, expected_revision: 3 }, output: { content: '# Project', workspace_revision: 3, content_hash: hash } },
  },
  {
    name: 'workspace.search',
    input: obj(['query', 'scope', 'limit'], { query: str(1, 1000), scope: contentScope, limit: { type: 'integer', minimum: 1, maximum: 200 }, cursor }),
    output: obj(['results'], {
      results: arr(obj(['document_id', 'logical_path', 'excerpt'], { document_id: id, logical_path: logicalPath, block_id: id, excerpt: str(0, 2000), score: { type: 'number', minimum: 0, maximum: 1 } }), 0, 200),
      cursor,
    }),
    sample: { input: { query: 'delivery', scope: scopeFixture, limit: 20 }, output: { results: [{ document_id: 'document-1', logical_path: '/workspace/project.md', excerpt: 'delivery plan', score: 0.9 }] } },
  },
  {
    name: 'workspace.propose_change',
    input: obj(['base_revision', 'working_set', 'operations'], {
      base_revision: rev, working_set: workingSet,
      operations: arr(obj(['kind', 'logical_path'], {
        kind: en('insert', 'replace', 'delete', 'move'), logical_path: logicalPath, block_id: id, content: str(0, 200000), destination_logical_path: logicalPath,
      }), 1, 1000),
    }),
    output: obj(['proposal_id', 'diff', 'impact'], {
      proposal_id: id,
      diff: obj(['summary', 'change_count'], { summary: str(1, 10000), change_count: { type: 'integer', minimum: 1, maximum: 1000 } }),
      impact: arr(obj(['logical_path', 'kind'], { logical_path: logicalPath, kind: en('created', 'modified', 'deleted', 'moved') }), 1, 1000),
    }),
    sample: { input: { base_revision: 3, working_set: scopeFixture, operations: [{ kind: 'replace', logical_path: '/workspace/project.md', content: '# Updated' }] }, output: { proposal_id: 'proposal-1', diff: { summary: 'Replace project heading', change_count: 1 }, impact: [{ logical_path: '/workspace/project.md', kind: 'modified' }] } },
  },
  {
    name: 'workspace.apply_change',
    input: obj(['proposal_id', 'expected_revision'], { proposal_id: id, expected_revision: rev }),
    output: obj(['workspace_revision', 'receipt'], { workspace_revision: rev, receipt }),
    sample: { input: { proposal_id: 'proposal-1', expected_revision: 3 }, output: { workspace_revision: 4, receipt: receiptFixture('workspace-apply') } },
  },
  {
    name: 'task.query',
    input: obj(['project_ref', 'filter', 'limit'], {
      project_ref: id,
      filter: obj([], { state: en('inbox', 'planned', 'in_progress', 'waiting_user', 'blocked', 'completed', 'cancelled', 'superseded'), origin: en('manual', 'agent', 'project_milestone') }),
      limit: { type: 'integer', minimum: 1, maximum: 200 }, cursor,
    }),
    output: obj(['tasks'], { tasks: arr(ref('TaskRef'), 0, 200), cursor }),
    sample: { input: { project_ref: 'project-1', filter: { state: 'planned' }, limit: 20 }, output: { tasks: [taskRef] } },
  },
  {
    name: 'task.create',
    input: obj(['project_ref', 'task', 'base_revision'], {
      project_ref: id, target_logical_path: logicalPath, base_revision: rev,
      task: obj(['title', 'state', 'responsibility'], { title: str(1, 500), state: en('inbox', 'planned'), responsibility: en('user', 'agent', 'shared'), due_at: ref('Timestamp') }),
    }),
    output: obj(['task_id', 'workspace_revision', 'receipt'], { task_id: id, workspace_revision: rev, receipt }),
    sample: { input: { project_ref: 'project-1', target_logical_path: '/workspace/tasks.md', task: { title: 'Prepare delivery', state: 'planned', responsibility: 'shared' }, base_revision: 1 }, output: { task_id: 'task-1', workspace_revision: 2, receipt: receiptFixture('task-create') } },
  },
  {
    name: 'task.update',
    input: obj(['task_id', 'patch', 'base_revision'], {
      task_id: id, base_revision: rev,
      patch: obj([], { title: str(1, 500), state: en('inbox', 'planned', 'in_progress', 'waiting_user', 'blocked', 'completed', 'cancelled', 'superseded'), responsibility: en('user', 'agent', 'shared'), due_at: ref('Timestamp') }, { minProperties: 1 }),
    }),
    output: obj(['task_projection', 'workspace_revision'], { task_projection: ref('TaskRef'), workspace_revision: rev }),
    sample: { input: { task_id: 'task-1', patch: { state: 'in_progress' }, base_revision: 1 }, output: { task_projection: { ...taskRef, state: 'in_progress', revision: 2 }, workspace_revision: 2 } },
  },
  {
    name: 'task.start_execution',
    input: obj(['task_id', 'content_scope'], { task_id: id, content_scope: contentScope, working_set: workingSet }),
    output: obj(['task_thread_id', 'state'], { task_thread_id: id, state: en('ready', 'running', 'awaiting_user', 'user_stopped', 'credits_blocked', 'disconnected', 'recoverable_failed', 'completed', 'archived') }),
    sample: { input: { task_id: 'task-1', content_scope: scopeFixture, working_set: scopeFixture }, output: { task_thread_id: 'thread-1', state: 'ready' } },
  },
  {
    name: 'task.open_source',
    input: obj(['task_id'], { task_id: id }),
    output: obj(['workspace_ref', 'logical_path', 'block_id', 'revision'], { workspace_ref: id, logical_path: logicalPath, block_id: id, revision: rev }),
    sample: { input: { task_id: 'task-1' }, output: { workspace_ref: 'workspace-1', logical_path: '/workspace/tasks.md', block_id: 'block-1', revision: 2 } },
  },
  {
    name: 'diagram.create',
    input: obj(['format', 'semantic_plan', 'target_logical_path'], {
      format: en('excalidraw', 'drawio'), target_logical_path: logicalPath,
      semantic_plan: obj(['nodes', 'edges'], {
        nodes: arr(obj(['node_id', 'label'], { node_id: id, label: str(1, 500), kind: en('concept', 'process', 'decision', 'actor', 'artifact') }), 1, 1000),
        edges: arr(obj(['from', 'to'], { from: id, to: id, label: str(0, 500) }), 0, 2000),
      }),
    }),
    output: obj(['artifact', 'workspace_revision'], { artifact, workspace_revision: rev }),
    sample: { input: { format: 'excalidraw', semantic_plan: { nodes: [{ node_id: 'node-1', label: 'Start', kind: 'process' }], edges: [] }, target_logical_path: '/assets/flow.excalidraw' }, output: { artifact: artifactFixture('diagram', 'application/json', '/assets/flow.excalidraw'), workspace_revision: 5 } },
  },
  {
    name: 'diagram.render',
    input: obj(['source', 'format', 'width', 'height'], { source: artifact, format: en('png', 'svg'), width: { type: 'integer', minimum: 64, maximum: 8192 }, height: { type: 'integer', minimum: 64, maximum: 8192 } }),
    output: obj(['preview_artifact'], { preview_artifact: artifact }),
    sample: { input: { source: artifactFixture('diagram-source', 'application/json', '/assets/flow.excalidraw'), format: 'png', width: 1280, height: 720 }, output: { preview_artifact: artifactFixture('diagram-preview', 'image/png', '/temp/flow.png') } },
  },
  {
    name: 'diagram.export',
    input: obj(['source', 'format', 'target_logical_path'], { source: artifact, format: en('svg', 'png', 'pdf'), target_logical_path: logicalPath }),
    output: obj(['artifact', 'receipt'], { artifact, receipt }),
    sample: { input: { source: artifactFixture('diagram-source', 'application/json', '/assets/flow.excalidraw'), format: 'svg', target_logical_path: '/output/flow.svg' }, output: { artifact: artifactFixture('diagram-export', 'image/svg+xml', '/output/flow.svg'), receipt: receiptFixture('diagram-export') } },
  },
  {
    name: 'artifact.get',
    input: obj(['artifact_id'], { artifact_id: id, artifact_revision_id: id }),
    output: obj(['artifact', 'revision_graph'], { artifact, revision_graph: arr(obj(['artifact_revision_id'], { artifact_revision_id: id, parent_revision_id: id }), 1, 1000) }),
    sample: { input: { artifact_id: 'artifact-1', artifact_revision_id: 'artifact-revision-1' }, output: { artifact: artifactFixture(), revision_graph: [{ artifact_revision_id: 'artifact-revision-1' }] } },
  },
  {
    name: 'artifact.register',
    input: obj(['staged_ref', 'owner', 'provenance'], {
      staged_ref: ref('ResourceHandle'), owner: ref('ArtifactOwner'),
      provenance: obj(['producer', 'input_hashes'], { producer: id, input_hashes: arr(ref('Hash'), 0, 128, { uniqueItems: true }) }),
    }),
    output: obj(['artifact'], { artifact }),
    sample: { input: { staged_ref: resourceHandleFixture, owner: { owner_type: 'project', owner_id: 'project-1' }, provenance: { producer: 'capability.public', input_hashes: [] } }, output: { artifact: artifactFixture('registered') } },
  },
  {
    name: 'artifact.preview',
    input: obj(['artifact', 'renderer_target'], { artifact, renderer_target: en('embedded', 'wps', 'office', 'browser', 'media') }),
    output: obj(['preview_revision_id', 'status'], { preview_revision_id: id, status: en('queued', 'rendering', 'ready', 'failed'), page_refs: arr(artifact, 0, 1000) }),
    sample: { input: { artifact: artifactFixture(), renderer_target: 'embedded' }, output: { preview_revision_id: 'preview-1', status: 'ready', page_refs: [artifactFixture('page-1', 'image/png', '/temp/page-1.png')] } },
  },
  {
    name: 'runtime.probe',
    input: obj(['dependency_id', 'required_features'], { dependency_id: id, required_features: arr(str(1, 128), 1, 64, { uniqueItems: true }) }),
    output: obj(['runtime_identity', 'version', 'features', 'health'], { runtime_identity: id, version: { type: 'string', minLength: 1, maxLength: 128, pattern: '^[0-9A-Za-z][0-9A-Za-z.+_-]*$' }, features: arr(str(1, 128), 0, 128, { uniqueItems: true }), health: en('healthy', 'degraded', 'unavailable', 'incompatible') }),
    sample: { input: { dependency_id: 'wps-office', required_features: ['document-render'] }, output: { runtime_identity: 'external-host:wps-office', version: '12.1.0', features: ['document-render'], health: 'healthy' } },
  },
  {
    name: 'wps.generate',
    input: obj(['plan', 'staging_owner'], { plan: ref('WpsPlan'), staging_owner: ref('ArtifactOwner') }),
    output: obj(['artifact', 'receipt'], { artifact, receipt }),
    sample: { input: { plan: { document_kind: 'document', operations: [{ kind: 'create_document' }] }, staging_owner: { owner_type: 'delivery_project', owner_id: 'delivery-1' } }, output: { artifact: artifactFixture('wps-generated', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '/output/document.docx'), receipt: receiptFixture('wps-generate') } },
  },
  {
    name: 'wps.apply_plan',
    input: obj(['source_artifact', 'plan'], { source_artifact: artifact, plan: ref('WpsPlan') }),
    output: obj(['artifact', 'receipt'], { artifact, receipt }),
    sample: { input: { source_artifact: artifactFixture('wps-source', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '/output/document.docx'), plan: { document_kind: 'document', operations: [{ kind: 'replace_text', target_ref: 'paragraph-1', text: 'Updated' }] } }, output: { artifact: artifactFixture('wps-updated', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '/output/document-v2.docx'), receipt: receiptFixture('wps-apply') } },
  },
  {
    name: 'wps.render_preview',
    input: obj(['artifact', 'renderer_target'], { artifact, renderer_target: en('wps', 'office') }),
    output: obj(['preview_revision_id', 'page_refs', 'status'], { preview_revision_id: id, page_refs: arr(artifact, 1, 1000), status: en('ready', 'partial', 'failed') }),
    sample: { input: { artifact: artifactFixture('wps-source', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '/output/document.docx'), renderer_target: 'wps' }, output: { preview_revision_id: 'preview-wps-1', page_refs: [artifactFixture('wps-page-1', 'image/png', '/temp/wps-page-1.png')], status: 'ready' } },
  },
  {
    name: 'wps.smoke_acceptance',
    input: obj(['artifact', 'acceptance_script'], { artifact, acceptance_script: obj(['actions'], { actions: arr(en('edit', 'undo', 'save', 'discard', 'reopen'), 1, 20) }) }),
    output: obj(['acceptance_receipt', 'evidence_refs'], { acceptance_receipt: obj(['receipt_id', 'status', 'recorded_at'], { receipt_id: id, status: en('accepted', 'rejected'), recorded_at: ref('Timestamp') }), evidence_refs: arr(artifact, 1, 100) }),
    sample: { input: { artifact: artifactFixture('wps-source', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '/output/document.docx'), acceptance_script: { actions: ['edit', 'undo', 'discard', 'reopen'] } }, output: { acceptance_receipt: { receipt_id: 'acceptance-1', status: 'accepted', recorded_at: timestamp }, evidence_refs: [artifactFixture('wps-evidence', 'application/json', '/temp/wps-evidence.json')] } },
  },
  {
    name: 'browser.fetch',
    input: obj(['url', 'method', 'declared_purpose', 'redirect_policy', 'max_redirects'], {
      url: publicHttpsUrl,
      method: en('GET', 'HEAD', 'POST'),
      declared_purpose: str(1, 500),
      redirect_policy: en('same_origin', 'https_only'),
      max_redirects: { type: 'integer', minimum: 0, maximum: 10 },
      request_artifact: artifact,
    }),
    output: obj(['response_artifact', 'metadata'], { response_artifact: artifact, metadata: obj(['status_code', 'media_type'], { status_code: { type: 'integer', minimum: 100, maximum: 599 }, media_type: { type: 'string', pattern: '^[a-z0-9.+-]+/[a-z0-9.+-]+$' }, final_url: publicHttpsUrl }) }),
    sample: { input: { url: 'https://example.com/data', method: 'GET', declared_purpose: 'Retrieve cited source', redirect_policy: 'same_origin', max_redirects: 3 }, output: { response_artifact: artifactFixture('browser-response', 'text/html', '/temp/response.html'), metadata: { status_code: 200, media_type: 'text/html', final_url: 'https://example.com/data' } } },
  },
  {
    name: 'browser.review_site',
    input: obj(['site_artifact', 'viewports', 'checks'], { site_artifact: artifact, viewports: arr(obj(['width', 'height'], { width: { type: 'integer', minimum: 320, maximum: 7680 }, height: { type: 'integer', minimum: 320, maximum: 4320 } }), 1, 16), checks: arr(en('navigation', 'layout', 'links', 'accessibility', 'content'), 1, 16, { uniqueItems: true }) }),
    output: obj(['report', 'screenshots', 'receipt'], { report: obj(['checks'], { checks: arr(obj(['check', 'status'], { check: en('navigation', 'layout', 'links', 'accessibility', 'content'), status: en('passed', 'failed', 'warning') }), 1, 1000) }), screenshots: arr(artifact, 1, 100), receipt }),
    sample: { input: { site_artifact: artifactFixture('site', 'application/zip', '/output/site.zip'), viewports: [{ width: 1440, height: 1000 }], checks: ['layout', 'links'] }, output: { report: { checks: [{ check: 'layout', status: 'passed' }, { check: 'links', status: 'passed' }] }, screenshots: [artifactFixture('site-shot', 'image/png', '/temp/site-shot.png')], receipt: receiptFixture('site-review') } },
  },
  {
    name: 'publish.prepare',
    input: obj(['static_artifact', 'share_policy'], { static_artifact: artifact, share_policy: obj(['visibility'], { visibility: en('private', 'unlisted', 'public'), expires_at: ref('Timestamp') }) }),
    output: obj(['deployment_id', 'preview_url', 'impact'], { deployment_id: id, preview_url: publicHttpsUrl, impact: obj(['visibility', 'external_effect'], { visibility: en('private', 'unlisted', 'public'), external_effect: { const: true } }) }),
    sample: { input: { static_artifact: artifactFixture('site', 'application/zip', '/output/site.zip'), share_policy: { visibility: 'unlisted' } }, output: { deployment_id: 'deployment-1', preview_url: 'https://preview.example.com/deployment-1', impact: { visibility: 'unlisted', external_effect: true } } },
  },
  {
    name: 'publish.promote',
    input: obj(['deployment_id'], { deployment_id: id }),
    output: obj(['stable_url', 'publish_receipt'], { stable_url: publicHttpsUrl, publish_receipt: receipt }),
    sample: { input: { deployment_id: 'deployment-1' }, output: { stable_url: 'https://example.com/site', publish_receipt: receiptFixture('publish') } },
  },
  {
    name: 'publish.rollback',
    input: obj(['deployment_id', 'target_revision'], { deployment_id: id, target_revision: rev }),
    output: obj(['stable_url', 'rollback_receipt'], { stable_url: publicHttpsUrl, rollback_receipt: receipt }),
    sample: { input: { deployment_id: 'deployment-1', target_revision: 2 }, output: { stable_url: 'https://example.com/site', rollback_receipt: receiptFixture('rollback') } },
  },
  {
    name: 'publish.revoke',
    input: obj(['deployment_id'], { deployment_id: id }),
    output: obj(['revoke_receipt'], { revoke_receipt: receipt }),
    sample: { input: { deployment_id: 'deployment-1' }, output: { revoke_receipt: receiptFixture('revoke') } },
  },
  {
    name: 'workflow.get',
    input: obj(['workflow_run_id'], { workflow_run_id: id }),
    output: obj(['state', 'stage', 'next_actions'], { state: en('created', 'checking_readiness', 'awaiting_gate', 'running_stage', 'paused', 'credits_blocked', 'disconnected', 'recoverable_failed', 'completed', 'cancelled', 'superseded', 'terminal_failed', 'abandoned'), stage: obj(['stage_id', 'status'], { stage_id: id, status: en('pending', 'running', 'awaiting_gate', 'completed', 'invalidated', 'failed') }), checkpoint_ref: id, next_actions: arr(str(1, 128), 0, 32, { uniqueItems: true }) }),
    sample: { input: { workflow_run_id: 'workflow-1' }, output: { state: 'running_stage', stage: { stage_id: 'stage-1', status: 'running' }, checkpoint_ref: 'checkpoint-1', next_actions: ['wait'] } },
  },
  {
    name: 'workflow.resume',
    input: obj(['workflow_run_id', 'expected_revision'], { workflow_run_id: id, expected_revision: rev }),
    output: obj(['workflow_run_id', 'accepted', 'revision'], { workflow_run_id: id, accepted: { type: 'boolean' }, revision: rev }),
    sample: { input: { workflow_run_id: 'workflow-1', expected_revision: 2 }, output: { workflow_run_id: 'workflow-1', accepted: true, revision: 3 } },
  },
  {
    name: 'workflow.stop',
    input: obj(['workflow_run_id', 'expected_revision'], { workflow_run_id: id, expected_revision: rev }),
    output: obj(['checkpoint_ref', 'state', 'revision'], { checkpoint_ref: id, state: en('paused', 'user_stopped'), revision: rev }),
    sample: { input: { workflow_run_id: 'workflow-1', expected_revision: 3 }, output: { checkpoint_ref: 'checkpoint-2', state: 'paused', revision: 4 } },
  },
  {
    name: 'ai.chat',
    input: obj(['messages', 'scope_refs', 'output_schema'], { messages: arr(obj(['role', 'content'], { role: en('user', 'assistant'), content: str(1, 100000) }), 1, 256), scope_refs: arr(artifact, 0, 128), output_schema: outputSchema }),
    output: obj(['usage_receipt'], { text: ref('SafeAiText'), structured_result: ref('SafeStructuredValue'), usage_receipt: usage }, { anyOf: [{ required: ['text'] }, { required: ['structured_result'] }] }),
    sample: { input: { messages: [{ role: 'user', content: 'Summarize the project.' }], scope_refs: [], output_schema: outputSchemaFixture }, output: { text: 'Project summary.', usage_receipt: usageFixture('chat') } },
  },
  {
    name: 'ai.reason',
    input: obj(['problem', 'scope_refs', 'output_schema'], { problem: str(1, 100000), scope_refs: arr(artifact, 0, 128), output_schema: outputSchema }),
    output: obj(['structured_result', 'usage_receipt'], { structured_result: ref('SafeStructuredValue'), usage_receipt: usage }),
    sample: { input: { problem: 'Select a delivery strategy.', scope_refs: [], output_schema: outputSchemaFixture }, output: { structured_result: { summary: 'Use staged delivery.' }, usage_receipt: usageFixture('reason') } },
  },
  {
    name: 'ai.vision',
    input: obj(['artifacts', 'questions', 'output_schema'], { artifacts: arr(artifact, 1, 16), questions: arr(str(1, 2000), 1, 64), output_schema: outputSchema }),
    output: obj(['structured_result', 'usage_receipt'], { structured_result: ref('SafeStructuredValue'), usage_receipt: usage }),
    sample: { input: { artifacts: [artifactFixture('vision-input', 'image/png', '/assets/image.png')], questions: ['What is shown?'], output_schema: outputSchemaFixture }, output: { structured_result: { summary: 'A workflow diagram.' }, usage_receipt: usageFixture('vision') } },
  },
  {
    name: 'ai.ocr',
    input: obj(['source_artifacts', 'language_hint'], { source_artifacts: arr(artifact, 1, 64), language_hint: { type: 'string', minLength: 2, maxLength: 35, pattern: '^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*$' } }),
    output: obj(['text_artifact', 'usage_receipt'], { text_artifact: artifact, layout_artifact: artifact, usage_receipt: usage }),
    sample: { input: { source_artifacts: [artifactFixture('ocr-input', 'image/png', '/assets/page.png')], language_hint: 'zh-CN' }, output: { text_artifact: artifactFixture('ocr-text', 'text/plain', '/temp/ocr.txt'), layout_artifact: artifactFixture('ocr-layout', 'application/json', '/temp/ocr-layout.json'), usage_receipt: usageFixture('ocr') } },
  },
  {
    name: 'ai.generate_image',
    input: obj(['prompt', 'input_artifacts', 'size', 'style_profile'], { prompt: str(1, 100000), input_artifacts: arr(artifact, 0, 16), size: en('1024x1024', '1536x1024', '1024x1536'), style_profile: en('natural', 'illustration', 'diagram', 'photographic') }),
    output: obj(['images', 'usage_receipt'], { images: arr(artifact, 1, 16), usage_receipt: usage }),
    sample: { input: { prompt: 'A clean architecture illustration.', input_artifacts: [], size: '1536x1024', style_profile: 'illustration' }, output: { images: [artifactFixture('generated-image', 'image/png', '/output/generated.png')], usage_receipt: usageFixture('image') } },
  },
  {
    name: 'ai.generate_audio',
    input: obj(['script', 'voice_profile', 'timing'], { script: str(1, 100000), voice_profile: en('neutral', 'warm', 'authoritative'), timing: obj(['speaking_rate'], { speaking_rate: { type: 'number', minimum: 0.5, maximum: 2 }, target_duration_seconds: { type: 'number', minimum: 0.1, maximum: 7200 } }) }),
    output: obj(['audio_artifact', 'usage_receipt'], { audio_artifact: artifact, usage_receipt: usage }),
    sample: { input: { script: 'Welcome to SuperWagie.', voice_profile: 'neutral', timing: { speaking_rate: 1 } }, output: { audio_artifact: artifactFixture('generated-audio', 'audio/wav', '/output/generated.wav'), usage_receipt: usageFixture('audio') } },
  },
];

const catalog = JSON.parse(fs.readFileSync(path.join(contractsDir, 'public-capability-methods.json'), 'utf8'));
const catalogNames = catalog.methods.map(({ name }) => name);
const definitionNames = methods.map(({ name }) => name);
if (JSON.stringify(catalogNames) !== JSON.stringify(definitionNames)) {
  throw new Error(`method definitions do not match catalog order: catalog=${catalogNames.length} definitions=${definitionNames.length}`);
}

for (const method of methods) {
  for (const direction of ['input', 'output']) {
    const uri = catalog.methods.find(({ name }) => name === method.name)[`${direction}_schema`];
    const schema = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: uri,
      title: `${method.name} ${direction} schema v1`,
      ...method[direction],
    };
    const target = path.join(schemaDir, `${method.name}.${direction}.schema.json`);
    fs.writeFileSync(target, JSON.stringify(schema, null, 2) + '\n');
  }
}

const fixtureCatalog = {
  schema_id: 'superwagie.public-capability-method-fixtures.v1',
  schema_version: 1,
  methods: methods.map(({ name, sample }) => ({ name, ...sample })),
};
fs.writeFileSync(path.join(schemaDir, 'method-fixtures.json'), JSON.stringify(fixtureCatalog, null, 2) + '\n');
console.log(`generated ${methods.length * 2} schemas and ${methods.length} method fixtures`);
