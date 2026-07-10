import { describe, expect, it } from 'vitest';
import { unitActiveState, userBusUnreachable } from './systemd.ts';

describe('unitActiveState', () => {
  it('reads the state off a zero-exit is-active', async () => {
    const result = await unitActiveState(
      (command, args) => {
        expect([command, ...args]).toEqual(['systemctl', '--user', 'is-active', 'orchestrator']);
        return Promise.resolve({ stdout: 'active\n' });
      },
      'orchestrator',
    );
    expect(result).toEqual({ state: 'active', busUnreachable: false });
  });

  it('reads the state off a non-zero exit — is-active reports every non-active state that way', async () => {
    const result = await unitActiveState(
      () => Promise.reject(Object.assign(new Error('exit 3'), { stdout: 'failed\n', stderr: '' })),
      'orchestrator-dashboard',
    );
    expect(result).toEqual({ state: 'failed', busUnreachable: false });
  });

  it('degrades to unknown, flagging the unreachable user bus, instead of claiming a state', async () => {
    const result = await unitActiveState(
      () =>
        Promise.reject(
          Object.assign(new Error('exit 1'), {
            stderr: 'Failed to connect to user scope bus via local transport: No medium found\n',
          }),
        ),
      'orchestrator',
    );
    expect(result).toEqual({ state: 'unknown', busUnreachable: true });
  });
});

describe('userBusUnreachable', () => {
  it('matches only the bus-connection failure, not ordinary unit errors', () => {
    expect(userBusUnreachable({ stderr: 'Failed to connect to bus: No medium found' })).toBe(true);
    expect(userBusUnreachable({ stderr: 'Unit foo.service not loaded.' })).toBe(false);
    expect(userBusUnreachable(new Error('plain'))).toBe(false);
  });
});
