import { describe, expect, it } from 'vitest';
import { readPackageMeta } from './pkg.ts';

describe('readPackageMeta', () => {
  it('reads the real package.json two levels up — the same hop dist/cli/ makes', () => {
    const meta = readPackageMeta();
    expect(meta.name).toBe('@nvergez/orchestrator');
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.enginesNode).toBe('>=22.18');
  });

  it('derives the releases page from repository.url, shedding git+ and .git', () => {
    expect(readPackageMeta().releasesUrl).toBe('https://github.com/nvergez/orchestrator/releases');
  });
});
