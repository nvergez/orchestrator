import { resolve } from 'node:path';
import { parseEnvFile } from '../kernel/env-file.ts';
import type { CommandRunner } from '../kernel/orca.ts';
import { unitActiveState } from '../kernel/systemd.ts';
import { resolveDefaultDbPath, resolveEnvFilePath } from '../kernel/xdg.ts';

/**
 * The dev-instance collision guard (ADR 0003): a daemon started from a
 * checkout coexists with the installed service by isolation — its own
 * Slack app and its own database. Sharing the app splits Socket Mode
 * events nondeterministically between the two; sharing the database
 * interleaves two writers' state. Either is a provable collision, and a
 * provable collision refuses the boot. Provable only: the guard fails
 * open when systemd cannot be asked or the canonical env file cannot be
 * read — ignorance must never block dev on a machine running no service.
 */

export interface CollisionDeps {
  env: Record<string, string | undefined>;
  /** systemctl runner for the unit probe. */
  run: CommandRunner;
  /** Reads the canonical env file — throws like readFileSync. */
  readFile(path: string): string;
}

/** Null when boot may proceed; otherwise the human-readable refusal. */
export async function serviceCollision(deps: CollisionDeps): Promise<string | null> {
  // Under systemd this process IS the service — units carry $INVOCATION_ID —
  // and the guard exists only for checkout-run daemons.
  if (deps.env.INVOCATION_ID !== undefined) return null;

  const { state } = await unitActiveState(deps.run, 'orchestrator');
  if (state !== 'active' && state !== 'activating') return null;

  let service: Record<string, string>;
  try {
    service = parseEnvFile(deps.readFile(resolveEnvFilePath(deps.env)));
  } catch {
    return null; // no readable canonical env file — nothing provable
  }

  if (deps.env.SLACK_APP_TOKEN !== undefined && deps.env.SLACK_APP_TOKEN === service.SLACK_APP_TOKEN) {
    return (
      'the orchestrator service is active on this machine and this daemon holds its SLACK_APP_TOKEN — ' +
      'Slack would split Socket Mode events between the two. Point this instance at a dev Slack app.'
    );
  }

  // The service's default resolves over THIS process's env — the closest
  // stand-in for the unit's environment we can see. Imperfect on purpose:
  // a false match is recoverable (the refusal names the fix), a missed
  // match corrupts silently.
  const serviceDb = resolve(service.ORCHESTRATOR_DB_PATH ?? resolveDefaultDbPath({ ...deps.env, ...service }));
  const devDb = resolve(deps.env.ORCHESTRATOR_DB_PATH ?? resolveDefaultDbPath(deps.env));
  if (serviceDb === devDb) {
    return (
      `the orchestrator service is active on this machine and this daemon would write its database (${devDb}) — ` +
      'set ORCHESTRATOR_DB_PATH to a dev-instance path (`npm run dev:all` defaults it to .dev/ under the checkout).'
    );
  }

  return null;
}
