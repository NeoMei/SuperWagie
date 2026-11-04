import { describe, expect, test } from 'bun:test';
import { formatMessage } from '@/lib/i18n/store';
import { dict as en } from '@/lib/i18n/messages/en';
import { dict as zh } from '@/lib/i18n/messages/zh-CN';
import { formatAgentStatusPhrase } from './agentStatus';

const phrase = (locale: 'en' | 'zh-CN', status: Parameters<typeof formatAgentStatusPhrase>[2]) =>
  formatAgentStatusPhrase((key, params) => formatMessage(locale === 'en' ? en : zh, key, params), locale, status);

describe('localized agent activity', () => {
  test('formats complete count messages in both product languages', () => {
    expect(phrase('en', { key: 'chat.agentStatus.read.count', count: 3 })).toBe('reading 3 files');
    expect(phrase('zh-CN', { key: 'chat.agentStatus.read.count', count: 3 })).toBe('正在读取3个文件');
    expect(phrase('zh-CN', { key: 'chat.agentStatus.usingTool', name: '$& lab' })).toBe('正在使用$& lab');
  });
  test('keeps rare thinking copy stable by reasoning identity', () => {
    const lines = new Set<string>();
    let playful = 0;
    for (let i = 0; i < 400; i += 1) {
      const status = { key: 'chat.agentStatus.thinking' as const, seed: `reasoning-${i}` };
      const first = phrase('zh-CN', status);
      for (let repeat = 0; repeat < 3; repeat += 1) expect(phrase('zh-CN', status)).toBe(first);
      if (first !== '正在思考') { playful += 1; lines.add(first); }
    }
    expect(playful).toBeGreaterThan(80);
    expect(playful).toBeLessThan(120);
    expect(lines.size).toBe(6);
    expect(lines).toContain('正在让点子小跑一圈');
    expect(lines).toContain('正在沿着线索找条好路');
  });
  test('permission and retry remain authoritative even with a thinking seed', () => {
    expect(phrase('en', { key: 'chat.agentStatus.waitingPermission', seed: 'reasoning-0' })).toBe('waiting for permission');
    expect(phrase('zh-CN', { key: 'chat.agentStatus.retry', seed: 'reasoning-0' })).toBe('正在重试');
  });
});
