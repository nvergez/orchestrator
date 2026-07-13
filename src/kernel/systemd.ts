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
 * Why `systemctl --user` could not answer (issue #91). The two failures look
 * alike and need opposite fixes: `unreachable` is THIS shell's problem (no
 * XDG_RUNTIME_DIR — export it and everything works), while `absent` means the
 * box has no systemd user manager at all and never will host a unit. Telling
 * an unreachable-bus operator to go find another supervisor sends them down
 * the wrong path entirely.
 */
export type UserBusStatus = 'reachable' | 'unreachable' | 'absent';

/** The cheapest question that reaches the user manager and reads back. */
export async function probeUserBus(run: CommandRunner): Promise<UserBusStatus> {
  try {
    await run('systemctl', ['--user', 'show-environment']);
    return 'reachable';
  } catch (error) {
    return userBusUnreachable(error) ? 'unreachable' : 'absent';
  }
}

/** The one-liner fix for an unreachable bus — the doctor's wording, verbatim. */
export function userBusFixLine(uid: number): string {
  return `export XDG_RUNTIME_DIR=/run/user/${uid} (or run from a login shell)`;
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
