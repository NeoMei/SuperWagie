import { mock } from 'bun:test';

export const gitService = {
  getGitRangeFiles: mock(),
  getGitRangeDiff: mock(),
  getGitStatus: mock(),
  getGitLog: mock(),
  getGitDiff: mock(),
};

// The extension owns Git IO; SDK wire tests keep OpenCode itself real.
mock.module('./gitService', () => gitService);
