import { describe, expect, test } from 'bun:test';
import { formatMessage, type Locale } from '@/lib/i18n/store';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import {
  agentStatusVariants,
  agentStatusSignature,
  formatAgentStatus,
  formatAgentStatusPhrase,
  type AgentStatus,
} from './agentStatus';

const phrase = (locale: Locale, status: AgentStatus): string =>
  formatAgentStatusPhrase((key, params) => formatMessage(locale === 'en' ? en : zh, key, params), locale, status);

const translated = (locale: Locale, key: Parameters<typeof formatMessage>[1], params?: Parameters<typeof formatMessage>[2]): string =>
  formatMessage(locale === 'en' ? en : zh, key, params);

const variants = (locale: Locale, key: Parameters<typeof formatMessage>[1]): readonly string[] =>
  agentStatusVariants(key).map((variant) => translated(locale, variant));

const variantsWith = (
  locale: Locale,
  key: Parameters<typeof formatMessage>[1],
  params: Parameters<typeof formatMessage>[2],
): readonly string[] => agentStatusVariants(key).map((variant) => translated(locale, variant, params));

const DOLLAR_LAB = String.fromCharCode(36) + '& lab';

describe('localized agent activity', () => {
  test('formats complete count messages in both product languages', () => {
    const count = { key: 'chat.agentStatus.read.count' as const, count: 3 };
    expect(phrase('en', count)).toBe('reading 3 files');
    expect(phrase('zh-CN', count)).toBe('正在读取3个文件');

    const named = { key: 'chat.agentStatus.usingTool' as const, name: DOLLAR_LAB };
    expect(phrase('en', named)).toBe('getting ' + DOLLAR_LAB + ' to help carry the load');
    expect(phrase('zh-CN', named)).toBe('正拉着' + DOLLAR_LAB + '一起搬砖');
  });

  test('keeps a special replacement target literal in either wording', () => {
    const status: AgentStatus = { key: 'chat.agentStatus.command.withTarget', target: DOLLAR_LAB };
    const expected = variantsWith('en', 'chat.agentStatus.command.withTarget', { target: DOLLAR_LAB });
    expect(expected).toContain(phrase('en', status));

    const chinese = variantsWith('zh-CN', 'chat.agentStatus.command.withTarget', { target: DOLLAR_LAB });
    expect(chinese).toContain(phrase('zh-CN', status));
    expect(phrase('en', status)).toContain(DOLLAR_LAB);
    expect(phrase('zh-CN', status)).toContain(DOLLAR_LAB);
    expect(phrase('en', status)).not.toContain('running ' + DOLLAR_LAB + ' like another errand like another errand');
  });

  test('keeps the six thinking lines stable and reachable by reasoning identity', () => {
    const lines = new Set<string>();
    for (let index = 0; index < 400; index += 1) {
      const status: AgentStatus = { key: 'chat.agentStatus.thinking', seed: `reasoning-${index}` };
      const first = phrase('zh-CN', status);
      for (let repeat = 0; repeat < 3; repeat += 1) expect(phrase('zh-CN', status)).toBe(first);
      lines.add(first);
    }
    const expected = new Set(agentStatusVariants('chat.agentStatus.thinking').map((key) => translated('zh-CN', key)));
    expect(lines).toEqual(expected);
  });

  test('changes the chosen wording when the tool target changes', () => {
    const first: AgentStatus = { key: 'chat.agentStatus.read.withTarget', target: 'a.ts' };
    const second: AgentStatus = { ...first, target: 'b.ts' };
    expect(agentStatusSignature(first)).not.toBe(agentStatusSignature(second));
    expect(agentStatusSignature(first)).toBe(agentStatusSignature({ ...first }));

    const expectedFirst = variantsWith('en', 'chat.agentStatus.read.withTarget', { target: 'a.ts' });
    const expectedSecond = variantsWith('en', 'chat.agentStatus.read.withTarget', { target: 'b.ts' });
    expect(expectedFirst).toContain(phrase('en', first));
    expect(expectedSecond).toContain(phrase('en', second));
    expect(phrase('en', first)).not.toBe(phrase('en', second));
  });

  test('permission and retry remain authoritative even with a thinking seed', () => {
    const permission = { key: 'chat.agentStatus.waitingPermission' as const, seed: 'reasoning-0' };
    expect(variants('en', 'chat.agentStatus.waitingPermission')).toContain(phrase('en', permission));
    expect(phrase('zh-CN', { key: 'chat.agentStatus.retry', seed: 'reasoning-0' })).toBe('正在重试');
  });

  test('a model name joins the status through the product dictionary', () => {
    const status: AgentStatus = { key: 'chat.agentStatus.working', seed: 'turn' };
    const label = formatAgentStatus(
      (key, params) => formatMessage(en, key, params),
      'en',
      status,
      'Hy4 Free',
    );
    expect(label).toBe(translated('en', 'chat.statusRow.modelStatus', {
      model: 'Hy4 Free',
      status: phrase('en', status),
    }));
    expect(label).toContain('Hy4 Free');
  });
});
