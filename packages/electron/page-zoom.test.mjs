import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { disableNativePageZoom } from './page-zoom.mjs';

test('current Electron uses disabled native zoom', () => {
  const modes = [];
  disableNativePageZoom({ setZoomMode: mode => modes.push(mode) }, () => assert.fail('unexpected failure'));
  assert.deepEqual(modes, ['disabled']);
});

test('Electron 43 starts without setZoomMode and keeps native zoom at the default', async () => {
  const contents = new EventEmitter();
  const limits = [], levels = [];
  contents.setVisualZoomLevelLimits = async (...values) => { limits.push(values); };
  contents.setZoomLevel = level => levels.push(level);
  disableNativePageZoom(contents, () => assert.fail('unexpected failure'));
  contents.emit('zoom-changed', {}, 'in');
  contents.emit('zoom-changed', {}, 'out');
  await Promise.resolve();
  assert.deepEqual(limits, [[1, 1]]);
  assert.deepEqual(levels, [0, 0]);
});

test('a closed legacy webContents reports rejected visual limits without an unhandled rejection', async () => {
  const contents = new EventEmitter();
  let failures = 0;
  contents.setVisualZoomLevelLimits = async () => { throw new Error('closed'); };
  contents.setZoomLevel = () => {};
  disableNativePageZoom(contents, () => { failures += 1; });
  await Promise.resolve();
  assert.equal(failures, 1);
});
