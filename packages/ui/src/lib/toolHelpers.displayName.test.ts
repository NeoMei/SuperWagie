import { expect, test } from 'bun:test';
import { dict as en } from './i18n/messages/en';
import { dict as zh } from './i18n/messages/zh-CN';
import { appToolDisplayName } from './toolHelpers';

test('direct, namespaced and indexed calls use the same localized tool label', () => {
  for (const name of ['openchamber_secret', 'OpenChamber_Secret:2', 'functions.openchamber_secret', 'openchamber_secret.run', 'openchamber.secret']) {
    expect(appToolDisplayName(name, key => en[key])).toBe('Secrets');
    expect(appToolDisplayName(name, key => zh[key])).toBe('密钥');
  }
  expect(appToolDisplayName('openchamber_secret.forget', key => zh[key], true)).toBe('密钥 · forget');
  expect(appToolDisplayName('openchamber_library', key => zh[key])).toBe('知识库');
  expect(appToolDisplayName('openchamber_workflow_answer', key => zh[key])).toBe('工作流答复');
  expect(appToolDisplayName('functions.openchamber_future_tool', key => en[key])).toBe('SuperWagie tools');
  for (const name of ['linear.list_issues', 'my_openchamber_secret', 'openchamberlain.lookup']) {
    expect(appToolDisplayName(name, key => zh[key])).toBeUndefined();
  }
});
