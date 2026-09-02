import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Checker, argValue, writeResults, envFail, rmrf } from '../gate-1/lib.mjs';

const FIXTURE_ID = 'G5-EXT-001';
const EVIDENCE_REVISION = 'solution-b-v1';
const fixture = argValue(process.argv, '--fixture');
const resultsPath = argValue(process.argv, '--results-json');
const artifactsDir = argValue(process.argv, '--artifacts-dir');
if (fixture !== FIXTURE_ID || !resultsPath) {
  envFail('usage: ext-gate.mjs --fixture ' + FIXTURE_ID + ' --results-json <path> [--artifacts-dir <dir>]');
}

const startedAt = new Date().toISOString();
const checker = new Checker();
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'superwagie-g5-ext-'));
const now = Date.parse('2026-09-01T08:00:00Z');

try {
  const registryPath = path.join(tmpBase, 'ext-registry.json');
  const versionsDir = path.join(tmpBase, 'versions');
  fs.mkdirSync(versionsDir, { recursive: true });
  let registry = { extensions: {}, quarantined: {} };
  function saveRegistry() { fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + '\n'); }
  function sha(data) { return crypto.createHash('sha256').update(data).digest('hex'); }

  function putVersion(extId, version, files) {
    const dir = path.join(versionsDir, extId + '-' + version);
    fs.mkdirSync(dir, { recursive: true });
    const hashes = {};
    for (const name of Object.keys(files)) {
      fs.writeFileSync(path.join(dir, name), files[name]);
      hashes[name] = sha(files[name]);
    }
    return { dir: dir, hashes: hashes };
  }
  function installReceipt(ext) {
    return {
      receipt_type: 'install_gate',
      extension_id: ext.id,
      manifest_hash: sha(JSON.stringify({ id: ext.id, type: ext.type, source: ext.source, version: ext.version })),
      permissions_hash: sha([...(ext.permissions || [])].sort().join('|')),
      status: 'valid',
      expires_at: '2026-09-01T08:10:00Z'
    };
  }
  function validInstallReceipt(ext, receipt) {
    const expected = installReceipt(ext);
    return !!receipt && receipt.receipt_type === expected.receipt_type && receipt.status === 'valid' &&
      Date.parse(receipt.expires_at) > now &&
      receipt.extension_id === expected.extension_id && receipt.manifest_hash === expected.manifest_hash &&
      receipt.permissions_hash === expected.permissions_hash;
  }
  function install(ext, versionRecord, receipt, source) {
    if (source !== 'trusted-gateway') return { denied: 'untrusted-install-gate-source' };
    if (!validInstallReceipt(ext, receipt)) return { denied: 'install-gate-required' };
    if (ext.build_script && ext.build_script.malicious) {
      registry.quarantined[ext.id] = { reason: 'malicious-build-script', version: ext.version };
      saveRegistry();
      return { quarantined: true };
    }
    registry.extensions[ext.id] = {
      id: ext.id, type: ext.type, source: ext.source, version: ext.version,
      permissions: ext.permissions || [], enabled: true,
      files_hash: versionRecord.hashes, dir: versionRecord.dir
    };
    saveRegistry();
    return { installed: true };
  }
  function call(extId, capability, arg) {
    if (registry.quarantined[extId]) return { denied: 'quarantined' };
    const e = registry.extensions[extId];
    if (!e) return { denied: 'not-installed' };
    if (!e.enabled) return { denied: 'disabled' };
    if (e.permissions.indexOf(capability) < 0) return { denied: 'permission-not-granted:' + capability };
    return { ok: true, result: 'cap:' + capability + ':' + arg };
  }

  // ---- check 1: Skill/MCP identification ----
  const skillA = { id: 'skill-alpha', type: 'skill', source: 'marketplace:neo', version: '1.0.0', permissions: ['md.read'] };
  const mcpB = { id: 'mcp-beta', type: 'mcp', source: 'registry:mcp', version: '0.3.0', permissions: ['net.fetch'] };
  const vA = putVersion(skillA.id, skillA.version, { 'SKILL.md': '---\nname: alpha\n---\nbody' });
  const vB = putVersion(mcpB.id, mcpB.version, { 'mcp.json': '{"command":"node"}' });
  install(skillA, vA, installReceipt(skillA), 'trusted-gateway');
  install(mcpB, vB, installReceipt(mcpB), 'trusted-gateway');
  const ra = registry.extensions['skill-alpha'];
  const rb = registry.extensions['mcp-beta'];
  const identOk = !!(ra && rb) && ra.type === 'skill' && ra.source === 'marketplace:neo' && rb.type === 'mcp' && rb.version === '0.3.0';
  checker.check('ext:identify', identOk, 'skill=' + (ra ? ra.type + ':' + ra.source : 'missing') + ' mcp=' + (rb ? rb.type + ':' + rb.version : 'missing'));

  // ---- check 2: permission enforcement ----
  const deny = call('skill-alpha', 'md.write', 'x');
  const allow = call('skill-alpha', 'md.read', 'doc.md');
  const permOk = deny.denied === 'permission-not-granted:md.write' && allow.ok === true;
  checker.check('ext:permission', permOk, 'deny=' + deny.denied + ' allow=' + !!allow.ok);

  // ---- check 3: update then rollback, byte-identical ----
  const vA2 = putVersion(skillA.id, '1.1.0', { 'SKILL.md': '---\nname: alpha\n---\nbody v1.1.0' });
  skillA.version = '1.1.0';
  install(skillA, vA2, installReceipt(skillA), 'trusted-gateway');
  const updated = registry.extensions['skill-alpha'];
  const updatedBody = fs.readFileSync(path.join(updated.dir, 'SKILL.md'), 'utf8');
  skillA.version = '1.0.0';
  install(skillA, vA, installReceipt(skillA), 'trusted-gateway');
  const rolledBack = registry.extensions['skill-alpha'];
  const rolledBody = fs.readFileSync(path.join(rolledBack.dir, 'SKILL.md'), 'utf8');
  const originalBody = fs.readFileSync(path.join(vA.dir, 'SKILL.md'), 'utf8');
  const rollbackOk = updated.version === '1.1.0' && rolledBack.version === '1.0.0' && rolledBody === originalBody && sha(rolledBody) === sha(originalBody) && updatedBody !== originalBody;
  checker.check('ext:update-rollback', rollbackOk, 'updated=' + updated.version + ' rolled_back=' + rolledBack.version + ' byte_identical=' + (sha(rolledBody) === sha(originalBody)));

  // ---- check 4: disable / enable ----
  registry.extensions['skill-alpha'].enabled = false;
  saveRegistry();
  const whileDisabled = call('skill-alpha', 'md.read', 'doc.md');
  registry.extensions['skill-alpha'].enabled = true;
  saveRegistry();
  const reEnabled = call('skill-alpha', 'md.read', 'doc.md');
  const toggleOk = whileDisabled.denied === 'disabled' && reEnabled.ok === true;
  checker.check('ext:enable-disable', toggleOk, 'disabled_denied=' + whileDisabled.denied + ' reenabled=' + !!reEnabled.ok);

  // ---- check 5: malicious build script quarantined ----
  const evil = { id: 'skill-evil', type: 'skill', source: 'marketplace:unknown', version: '9.9.9', build_script: { malicious: true }, permissions: [] };
  const vEvil = putVersion(evil.id, evil.version, { 'SKILL.md': 'evil' });
  const evilResult = install(evil, vEvil, installReceipt(evil), 'trusted-gateway');
  const evilCall = call('skill-evil', 'md.read', 'x');
  const quarantineOk = evilResult.quarantined === true && !!registry.quarantined['skill-evil'] && evilCall.denied === 'quarantined';
  checker.check('ext:quarantine', quarantineOk, 'quarantined=' + !!registry.quarantined['skill-evil'] + ' call_denied=' + evilCall.denied);

  // ---- check 6: remove deletes files and registry entry ----
  const removeTarget = registry.extensions['mcp-beta'];
  const dirBefore = removeTarget.dir;
  const existedBefore = fs.existsSync(dirBefore);
  delete registry.extensions['mcp-beta'];
  fs.rmSync(dirBefore, { recursive: true, force: true });
  saveRegistry();
  const afterRemove = call('mcp-beta', 'net.fetch', 'http://x');
  const removeOk = existedBefore && !fs.existsSync(dirBefore) && !registry.extensions['mcp-beta'] && afterRemove.denied === 'not-installed';
  checker.check('ext:remove', removeOk, 'files_deleted=' + existedBefore + ' registry_empty=' + !registry.extensions['mcp-beta'] + ' call=' + afterRemove.denied);

  // ---- check 7: install receipt is bound to exact manifest and permissions ----
  const gated = { id: 'skill-gated', type: 'skill', source: 'marketplace:neo', version: '1.0.0', permissions: ['workspace.read'] };
  const gatedVersion = putVersion(gated.id, gated.version, { 'SKILL.md': 'gated' });
  const missingGate = install(gated, gatedVersion, null, 'trusted-gateway');
  const forgedGate = { ...installReceipt(gated), permissions_hash: sha('workspace.read|browser.fetch') };
  const rejectedForgery = install(gated, gatedVersion, forgedGate, 'trusted-gateway');
  const rejectedClientSource = install(gated, gatedVersion, installReceipt(gated), 'client-intent');
  const acceptedGate = install(gated, gatedVersion, installReceipt(gated), 'trusted-gateway');
  const installGateBindingVerified = missingGate.denied === 'install-gate-required' &&
    rejectedForgery.denied === 'install-gate-required' && acceptedGate.installed === true;
  const installGateTrustedSourceVerified = rejectedClientSource.denied === 'untrusted-install-gate-source';
  checker.check('ext:install-gate-binding', installGateBindingVerified && installGateTrustedSourceVerified,
    'missing=' + missingGate.denied + ' forged=' + rejectedForgery.denied + ' client=' + rejectedClientSource.denied + ' accepted=' + !!acceptedGate.installed);

  // ---- check 8: extension calls only the Public Capability Facade ----
  function extensionDispatch(target, capability) {
    if (target !== 'public-capability-facade') return { denied: 'direct-system-boundary' };
    return call('skill-gated', capability, 'fixture');
  }
  const directCore = extensionDispatch('product-core', 'workspace.read');
  const directWorker = extensionDispatch('host-worker', 'workspace.read');
  const throughFacade = extensionDispatch('public-capability-facade', 'workspace.read');
  const publicFacadeOnly = directCore.denied === 'direct-system-boundary' && directWorker.denied === 'direct-system-boundary' && throughFacade.ok === true;
  checker.check('ext:public-facade-only', publicFacadeOnly,
    'core=' + directCore.denied + ' worker=' + directWorker.denied + ' facade=' + !!throughFacade.ok);

  if (artifactsDir) {
    fs.mkdirSync(artifactsDir, { recursive: true });
    fs.copyFileSync(registryPath, path.join(artifactsDir, 'ext-registry.json'));
  }

  const pass = writeResults(resultsPath, {
    gate: 'gate-5',
    fixture: FIXTURE_ID,
    evidenceRevision: EVIDENCE_REVISION,
    startedAt: startedAt,
    checker: checker,
    decisionHint: 'CONDITIONAL_GO',
    limitation: '生命周期、Install Gate 和公开门面只在临时 stub 注册表中验证；真实签名 Installer/Extension Worker、OS 沙箱、网络代理和双平台落盘恢复仍待实现',
    metrics: {
      checks: checker.summary,
      install_gate_binding_verified: installGateBindingVerified,
      install_gate_trusted_source_verified: installGateTrustedSourceVerified,
      public_facade_only: publicFacadeOnly
    }
  });
  console.log((pass ? 'PASS' : 'FAIL') + ' ' + FIXTURE_ID + ' checks=' + JSON.stringify(checker.summary));
  rmrf(tmpBase);
  process.exit(pass ? 0 : 1);
} catch (e) {
  console.error('ERROR executor: ' + (e && e.stack ? e.stack : String(e)));
  rmrf(tmpBase);
  process.exit(2);
}
