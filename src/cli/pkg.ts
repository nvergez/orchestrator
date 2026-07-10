import { readFileSync } from 'node:fs';

/**
 * The package's own metadata, read from the package.json two levels above
 * this module — the same relative hop from `src/cli/` (dev runs) and from
 * the compiled `dist/cli/` (installed runs), so `orc --version` needs no
 * config, no env, and no loose files in the tarball (issues #69/#70).
 */

export interface PackageMeta {
  /** The npm package name — what `orc update` asks the registry about. */
  name: string;
  version: string;
  /** The `engines.node` range — doctor compares the running node against it. */
  enginesNode?: string;
  /** The GitHub releases page, derived from `repository.url` — where update points when it gates a breaking release. */
  releasesUrl?: string;
}

/** `git+https://github.com/o/r.git` → `https://github.com/o/r/releases`. */
function releasesUrlFrom(repositoryUrl: unknown): string | undefined {
  if (typeof repositoryUrl !== 'string') return undefined;
  const match = /^(?:git\+)?(https:\/\/.+?)(?:\.git)?$/.exec(repositoryUrl);
  return match === null ? undefined : `${match[1]}/releases`;
}

export function readPackageMeta(): PackageMeta {
  const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
  const pkg = JSON.parse(raw) as {
    name?: unknown;
    version?: unknown;
    engines?: { node?: unknown };
    repository?: { url?: unknown };
  };
  const releasesUrl = releasesUrlFrom(pkg.repository?.url);
  return {
    name: typeof pkg.name === 'string' ? pkg.name : '',
    version: typeof pkg.version === 'string' ? pkg.version : '0.0.0',
    ...(typeof pkg.engines?.node === 'string' && { enginesNode: pkg.engines.node }),
    ...(releasesUrl !== undefined && { releasesUrl }),
  };
}
