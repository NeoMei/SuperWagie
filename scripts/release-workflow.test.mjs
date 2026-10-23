import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import yaml from 'yaml';

const workflowPath = fileURLToPath(new URL('../.github/workflows/release.yml', import.meta.url));
const workflow = yaml.parse(fs.readFileSync(workflowPath, 'utf8'));

test('manifests combine after partial build failures while publication stays strict', () => {
  assert.equal(
    workflow.jobs['combine-electron-manifests'].if,
    "${{ !cancelled() && needs.create-release.result == 'success' }}",
  );
  // Skipped jobs count as done; any failure still stops the release.
  assert.equal(workflow.jobs['finalize-release'].if, "${{ !cancelled() && !failure() && needs.create-release.result == 'success' }}");
});

test('upstream package publication is limited to the upstream repository', () => {
  assert.equal(workflow.jobs['create-release'].if, "github.repository == 'openchamber/openchamber'");
  const extensionWorkflow = yaml.parse(fs.readFileSync(new URL('../.github/workflows/vscode-extension.yml', import.meta.url), 'utf8'));
  assert.equal(extensionWorkflow.jobs.publish.if, "github.repository == 'openchamber/openchamber'");
});
