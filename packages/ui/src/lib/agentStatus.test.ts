import { describe, expect, test } from 'bun:test';
import { formatMessage, type Locale } from '@/lib/i18n/store';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import { applyPlural, agentStatusSignature, formatAgentStatus, formatAgentStatusPhrase, type AgentStatus } from './agentStatus';

const translate = (locale: Locale) => (key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]) =>
  formatMessage(locale === 'en' ? en : zh, key, params);

describe('upstream agent status copy', () => {
  test('formats counted activity in each supported language', () => {
    const activity: AgentStatus = { key: 'chat.agentStatus.read.count', count: 3 };
    expect(formatAgentStatusPhrase(translate('en'), 'en', activity)).toBe('reading 3 files');
    expect(formatAgentStatusPhrase(translate('zh-CN'), 'zh-CN', activity)).toContain('3');
    expect(formatAgentStatusPhrase(translate('zh-CN'), 'zh-CN', activity)).not.toContain('{count');
  });

  test('keeps tool names literal and command labels unchanged', () => {
    const name = "cash$&tool $$ $' $`";
    expect(formatAgentStatusPhrase(translate('en'), 'en', { key: 'chat.agentStatus.usingTool', name })).toContain(name);
    expect(formatAgentStatusPhrase(translate('zh-CN'), 'zh-CN', { key: 'chat.agentStatus.usingTool', name })).toContain(name);
    expect(formatAgentStatusPhrase(translate('en'), 'en', { key: 'chat.agentStatus.command' })).toBe(en['chat.agentStatus.command']);
  });

  test('puts activity after the model and capitalizes it when no model is known', () => {
    const activity: AgentStatus = { key: 'chat.agentStatus.command' };
    expect(formatAgentStatus(translate('en'), 'en', activity, 'Model')).toBe('Model is running a command');
    const label = formatAgentStatus(translate('en'), 'en', activity);
    expect(label[0]).toBe(label[0]?.toUpperCase());
  });

  test('retains the same semantic identity independently of locale', () => {
    const activity: AgentStatus = { key: 'chat.agentStatus.thinking', seed: 'source' };
    expect(agentStatusSignature(activity)).toBe(agentStatusSignature({ ...activity }));
    expect(agentStatusSignature(activity)).not.toBe(agentStatusSignature({ ...activity, seed: 'next' }));
  });

  test('uses exact plural cases and the locale number', () => {
    expect(applyPlural('{count, plural, =2 {both} other {# files}}', 2, 'en')).toBe('both');
    expect(applyPlural('{count, plural, one {# file} other {# files}}', 3, 'en')).toBe('3 files');
  });
});
