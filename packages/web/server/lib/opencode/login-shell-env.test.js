import { describe, expect, it } from 'vitest';
import { provideLoginShellEnvSnapshot, providedLoginShellEnvSnapshot } from './login-shell-env.js';

describe('embedding host login shell handoff', () => {
  it('copies the host snapshot so later caller changes do not alter the server handoff', () => {
    const snapshot = { PATH: '/initial', EXAMPLE: 'value' };
    provideLoginShellEnvSnapshot(snapshot);
    snapshot.PATH = '/changed';
    expect(providedLoginShellEnvSnapshot()).toEqual({ PATH: '/initial', EXAMPLE: 'value' });
  });

  it('retains an explicit failed probe as null', () => {
    provideLoginShellEnvSnapshot(null);
    expect(providedLoginShellEnvSnapshot()).toBeNull();
  });
});
