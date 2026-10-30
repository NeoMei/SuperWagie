import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { configurePackagedDesktopMode } from './desktop-mode.mjs';

function fixture(t, text) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-mode-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  if (text !== undefined) fs.writeFileSync(path.join(directory, 'desktop-mode.json'), text);
  return directory;
}

test('ordinary packages retain the inherited server preference', t => {
  const resourcesPath = fixture(t);
  const environment = { OPENCHAMBER_SKIP_LOCAL_SERVER: '0' };
  assert.equal(configurePackagedDesktopMode({ packaged: true, resourcesPath, environment }), 'standard');
  assert.equal(environment.OPENCHAMBER_SKIP_LOCAL_SERVER, '0');
});

test('remote-client packages force local server startup off', t => {
  const resourcesPath = fixture(t, '{"mode":"remote-client"}');
  for (const preference of ['0', 'false', '', undefined]) {
    const environment = preference === undefined ? {} : { OPENCHAMBER_SKIP_LOCAL_SERVER: preference };
    assert.equal(configurePackagedDesktopMode({ packaged: true, resourcesPath, environment }), 'remote-client');
    assert.equal(environment.OPENCHAMBER_SKIP_LOCAL_SERVER, '1');
  }
});

test('development ignores packaged distribution metadata', t => {
  const resourcesPath = fixture(t, 'malformed');
  const environment = {};
  assert.equal(configurePackagedDesktopMode({ packaged: false, resourcesPath, environment }), 'standard');
  assert.deepEqual(environment, {});
});

test('invalid distribution metadata never enables a local server', t => {
  const resourcesPath = fixture(t);
  for (const text of ['{', 'null', '[]', '1', '"remote-client"', '{}', '{"mode":"local"}', '{"mode":"remote-client","extra":true}']) {
    fs.writeFileSync(path.join(resourcesPath, 'desktop-mode.json'), text);
    const environment = { OPENCHAMBER_SKIP_LOCAL_SERVER: '0' };
    assert.throws(() => configurePackagedDesktopMode({ packaged: true, resourcesPath, environment }), /desktop_mode_invalid/);
    assert.equal(environment.OPENCHAMBER_SKIP_LOCAL_SERVER, '0');
  }
});

test('unreadable distribution metadata fails instead of assuming a full package', t => {
  const resourcesPath = fixture(t);
  fs.mkdirSync(path.join(resourcesPath, 'desktop-mode.json'));
  assert.throws(() => configurePackagedDesktopMode({ packaged: true, resourcesPath, environment: {} }));
});
