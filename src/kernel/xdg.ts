import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * XDG base-directory resolution (issue #70): the config dir homes the
 * per-instance files (routing-hints.json, the systemd env file), the state
 * dir homes the SQLite DB. Env vars stay the only boot-config channel —
 * these helpers only decide WHERE the instance files live.
 */

/** Per the XDG spec, a relative or empty base var must be ignored. */
function xdgBase(value: string | undefined, fallback: string): string {
  return value !== undefined && isAbsolute(value) ? value : fallback;
}

/** `$XDG_CONFIG_HOME/orchestrator`, else `~/.config/orchestrator`. */
export function resolveConfigDir(env: Record<string, string | undefined>): string {
  return join(xdgBase(env.XDG_CONFIG_HOME, join(homedir(), '.config')), 'orchestrator');
}

/** `$XDG_STATE_HOME/orchestrator`, else `~/.local/state/orchestrator`. */
export function resolveStateDir(env: Record<string, string | undefined>): string {
  return join(xdgBase(env.XDG_STATE_HOME, join(homedir(), '.local', 'state')), 'orchestrator');
}

/**
 * Where the routing hints live: the `ORCHESTRATOR_ROUTING_HINTS_PATH`
 * per-file override (tests, nonstandard setups, dev runs against the
 * example file) wins, else the XDG config dir. The package install dir is
 * never consulted (issue #70 — the loader stopped reading it).
 */
export function resolveRoutingHintsPath(env: Record<string, string | undefined>): string {
  return env.ORCHESTRATOR_ROUTING_HINTS_PATH ?? join(resolveConfigDir(env), 'routing-hints.json');
}

/**
 * The canonical env file — scaffolded by `orc init`, loaded by the unit's
 * `EnvironmentFile`. Nothing loads boot config from it (env vars stay the
 * only boot-config channel); doctor consults it to diagnose a bare shell,
 * the daemon's collision guard compares against it (ADR 0003).
 */
export function resolveEnvFilePath(env: Record<string, string | undefined>): string {
  return join(resolveConfigDir(env), 'env');
}

/** The DB default under the state dir — `ORCHESTRATOR_DB_PATH` overrides. */
export function resolveDefaultDbPath(env: Record<string, string | undefined>): string {
  return join(resolveStateDir(env), 'orchestrator.db');
}
