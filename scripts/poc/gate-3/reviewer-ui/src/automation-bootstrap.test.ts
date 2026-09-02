import { describe, expect, it, vi } from 'vitest';
import type { HostArtifactOpened, OpenedArtifact } from './host-bridge';
import { installBufferedAutomationListener } from './automation-bootstrap';

const SESSION = 'a'.repeat(32);

function opened(index: number, overrides: Partial<HostArtifactOpened> = {}): HostArtifactOpened {
  const fixtures = [
    ['reviewer-torture-100p.pdf', 'application/pdf'],
    ['reviewer-torture-30p.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['reviewer-torture-20s.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation']
  ] as const;
  return {
    handle: String(index + 1).repeat(32),
    displayName: fixtures[index]?.[0] ?? 'invalid',
    mediaType: fixtures[index]?.[1] ?? 'application/octet-stream',
    size: 1,
    revisionHash: String(index + 4).repeat(64),
    automationSessionId: SESSION,
    automationIndex: index,
    ...overrides
  };
}

describe('buffered automation bootstrap', () => {
  it('announces client readiness only after the listener and runner are installed', async () => {
    const order: string[] = [];
    const bootstrap = await installBufferedAutomationListener(async () => {
      order.push('artifact-listener');
      return () => {};
    });
    expect(order).toEqual(['artifact-listener']);
    await bootstrap.markReady(
      async () => { order.push('runner'); },
      vi.fn(),
      async () => { order.push('ready'); }
    );

    expect(order).toEqual(['artifact-listener', 'ready']);
  });

  it('installs the listener before readiness and drains the three early events once ready', async () => {
    const starts: Array<{ sessionId: string; artifacts: OpenedArtifact[] }> = [];
    const bootstrap = await installBufferedAutomationListener(async (receive) => {
      receive(opened(2));
      receive(opened(0));
      receive(opened(1));
      return () => {};
    });

    expect(starts).toHaveLength(0);
    await bootstrap.markReady(async (start) => { starts.push(start); }, vi.fn());

    expect(starts).toHaveLength(1);
    expect(starts[0]?.sessionId).toBe(SESSION);
    expect(starts[0]?.artifacts.map((artifact) => artifact.automationIndex)).toEqual([0, 1, 2]);
  });

  it('keeps one bounded session, ignores exact-index duplicates, and never starts twice', async () => {
    let receive: ((payload: unknown) => void) | undefined;
    const bootstrap = await installBufferedAutomationListener(async (handler) => {
      receive = handler;
      return () => {};
    });
    const starts: Array<{ sessionId: string; artifacts: OpenedArtifact[] }> = [];
    const run = async (start: { sessionId: string; artifacts: OpenedArtifact[] }) => { starts.push(start); };
    await bootstrap.markReady(run, vi.fn());

    receive?.(opened(0));
    receive?.(opened(0, { handle: 'f'.repeat(32) }));
    receive?.(opened(1));
    receive?.(opened(2));
    receive?.(opened(0));
    receive?.(opened(1, { automationSessionId: 'b'.repeat(32) }));
    receive?.(opened(2, { automationSessionId: 'b'.repeat(32) }));
    await bootstrap.markReady(run, vi.fn());
    await Promise.resolve();

    expect(starts).toHaveLength(1);
    expect(starts[0]?.artifacts[0]?.handle).toBe('1'.repeat(32));
  });

  it('ignores malformed or non-automation events without consuming the valid session', async () => {
    let receive: ((payload: unknown) => void) | undefined;
    const bootstrap = await installBufferedAutomationListener(async (handler) => {
      receive = handler;
      return () => {};
    });
    const starts: Array<{ sessionId: string; artifacts: OpenedArtifact[] }> = [];
    await bootstrap.markReady(async (start) => { starts.push(start); }, vi.fn());

    receive?.({ ...opened(0), handle: 'native-path' });
    receive?.({ ...opened(0), automationIndex: 3 });
    receive?.({ ...opened(0), automationSessionId: undefined, automationIndex: undefined });
    receive?.(opened(0));
    receive?.(opened(1));
    receive?.(opened(2));
    await Promise.resolve();

    expect(starts).toHaveLength(1);
  });

  it('surfaces one conservative failure callback without retrying the rejected run', async () => {
    let receive: ((payload: unknown) => void) | undefined;
    const bootstrap = await installBufferedAutomationListener(async (handler) => {
      receive = handler;
      return () => {};
    });
    const onFailure = vi.fn();
    await bootstrap.markReady(async () => { throw new Error('render failed'); }, onFailure);

    receive?.(opened(0));
    receive?.(opened(1));
    receive?.(opened(2));
    await Promise.resolve();
    await Promise.resolve();
    receive?.(opened(2));
    await Promise.resolve();

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith({ sessionId: SESSION });
  });
});
