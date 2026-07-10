import { readFileSync } from 'node:fs';

/**
 * The package's own metadata, read from the package.json one level above
 * this module — the same relative hop from `src/` (dev runs) and from the
 * compiled `dist/` (installed runs), so `orc --version` needs no config,
 * no env, and no loose files in the tarball (issues #69/#70).
 */

export interface PackageMeta {
  version: string;
  /** The `engines.node` range — doctor compares the running node against it. */
  enginesNode?: string;
}

export function readPackageMeta(): PackageMeta {
  const raw = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as { version?: unknown; engines?: { node?: unknown } };
  return {
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    ...(typeof pkg.engines?.node === 'string' && { enginesNode: pkg.engines.node }),
  };
}
