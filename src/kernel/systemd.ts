import type { CommandRunner } from './orca.ts';

/**
 * Shared systemd user-unit probes: the doctor's dashboard check and the
 * dashboard's daemon-health read ask the same question — "what is this
 * unit's ActiveState?" — and both must degrade honestly when the user bus
 * is unreachable (SSH and Orca shells without XDG_RUNTIME_DIR).
 */

export interface UnitActiveState {
  /** systemd's ActiveState word, `unknown` when nothing could be read. */
  state: string;
  /** True when the answer says nothing about the unit — the bus was down. */
  busUnreachable: boolean;
}

/**
 * `systemctl --user is-active <unit>` needs the session's user bus; shells
 * without XDG_RUNTIME_DIR get "Failed to connect to … bus" — which says
 * nothing about the unit's state, so it must never read as one.
 */
export function userBusUnreachable(error: unknown): boolean {
  const stderr = (error as { stderr?: unknown }).stderr;
  return typeof stderr === 'string' && /failed to connect to .*bus/i.test(stderr);
}

/**
 * The unit's ActiveState (`active`/`inactive`/`failed`) — `is-active` exits
 * non-zero for every non-active state with the state word still on stdout,
 * so both paths read it; an unreadable answer degrades to `unknown`, never
 * to a claim.
 */
export async function unitActiveState(
  run: CommandRunner,
  unit: string,
): Promise<UnitActiveState> {
  let stdout: string;
  let busUnreachable = false;
  try {
    ({ stdout } = await run('systemctl', ['--user', 'is-active', unit]));
  } catch (error) {
    const failed = (error as { stdout?: unknown }).stdout;
    stdout = typeof failed === 'string' ? failed : '';
    busUnreachable = userBusUnreachable(error);
  }
  const state = stdout.trim();
  return { state: state === '' ? 'unknown' : state, busUnreachable };
}
