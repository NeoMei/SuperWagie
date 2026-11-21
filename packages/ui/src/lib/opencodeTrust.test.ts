import { describe, expect, test } from 'bun:test';
import { createFolderTrustCoordinator, type FolderAssessment } from './opencodeTrust';

const assessment: FolderAssessment = {
  directory: '/repo', fingerprint: 'before', trusted: false,
  items: [{ kind: 'mcp', source: 'opencode.json', name: 'fixture', detail: 'fixture-command' }],
};

const untilPrompt = async (getPrompt: () => ReturnType<ReturnType<typeof createFolderTrustCoordinator>['getPrompt']>) => {
  for (let tick = 0; tick < 20; tick++) {
    const prompt = getPrompt();
    if (prompt) return prompt;
    await Promise.resolve();
  }
  throw new Error('Expected folder trust prompt');
};

describe('folder trust prompt ownership', () => {
  test('shows a changed assessment before saving the replacement', async () => {
    const fingerprints: Array<string | null> = [];
    const updated: FolderAssessment = { ...assessment, fingerprint: 'after' };
    const owner = createFolderTrustCoordinator({
      read: async () => assessment,
      save: async (shown) => {
        fingerprints.push(shown.fingerprint);
        return shown === updated ? { ok: true, assessment: updated } : { ok: false, assessment: updated };
      },
    });
    const pending = owner.ask('/repo', false, () => true);
    const first = await untilPrompt(owner.getPrompt);
    await first.trust();
    const second = await untilPrompt(owner.getPrompt);
    expect(second.assessment.fingerprint).toBe('after');
    await second.trust();
    expect(await pending).toBe(true);
    expect(fingerprints).toEqual(['before', 'after']);
  });

  test('never sends a retired prompt answer to the new runtime', async () => {
    let current = true;
    let saves = 0;
    const owner = createFolderTrustCoordinator({
      read: async () => assessment,
      save: async (shown) => {
        saves++;
        return { ok: true, assessment: shown };
      },
    });
    const pending = owner.ask('/repo', false, () => current);
    const prompt = await untilPrompt(owner.getPrompt);
    current = false;
    owner.reset();
    await prompt.trust();
    expect(await pending).toBe(false);
    expect(saves).toBe(0);
    expect(owner.getPrompt()).toBeNull();
  });
});
