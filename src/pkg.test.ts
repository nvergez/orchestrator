import { describe, expect, it } from 'vitest';
import { readPackageMeta } from './pkg.ts';

describe('readPackageMeta', () => {
  it('reads the real package.json one level up — the same hop dist/ makes', () => {
    const meta = readPackageMeta();
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.enginesNode).toBe('>=22.18');
  });
});
