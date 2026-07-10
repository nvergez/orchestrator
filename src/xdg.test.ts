import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveConfigDir,
  resolveDefaultDbPath,
  resolveRoutingHintsPath,
  resolveStateDir,
} from './xdg.ts';

describe('resolveConfigDir', () => {
  it('honors an absolute $XDG_CONFIG_HOME', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '/srv/config' })).toBe('/srv/config/orchestrator');
  });

  it('falls back to ~/.config when unset', () => {
    expect(resolveConfigDir({})).toBe(join(homedir(), '.config', 'orchestrator'));
  });

  it('ignores a relative or empty $XDG_CONFIG_HOME, per the XDG spec', () => {
    expect(resolveConfigDir({ XDG_CONFIG_HOME: 'relative/config' })).toBe(
      join(homedir(), '.config', 'orchestrator'),
    );
    expect(resolveConfigDir({ XDG_CONFIG_HOME: '' })).toBe(
      join(homedir(), '.config', 'orchestrator'),
    );
  });
});

describe('resolveStateDir', () => {
  it('honors an absolute $XDG_STATE_HOME', () => {
    expect(resolveStateDir({ XDG_STATE_HOME: '/srv/state' })).toBe('/srv/state/orchestrator');
  });

  it('falls back to ~/.local/state when unset', () => {
    expect(resolveStateDir({})).toBe(join(homedir(), '.local', 'state', 'orchestrator'));
  });
});

describe('resolveRoutingHintsPath', () => {
  it('lets ORCHESTRATOR_ROUTING_HINTS_PATH override everything', () => {
    expect(
      resolveRoutingHintsPath({
        ORCHESTRATOR_ROUTING_HINTS_PATH: './routing-hints.json',
        XDG_CONFIG_HOME: '/srv/config',
      }),
    ).toBe('./routing-hints.json');
  });

  it('defaults to routing-hints.json in the config dir', () => {
    expect(resolveRoutingHintsPath({ XDG_CONFIG_HOME: '/srv/config' })).toBe(
      '/srv/config/orchestrator/routing-hints.json',
    );
    expect(resolveRoutingHintsPath({})).toBe(
      join(homedir(), '.config', 'orchestrator', 'routing-hints.json'),
    );
  });
});

describe('resolveDefaultDbPath', () => {
  it('puts the DB under the state dir', () => {
    expect(resolveDefaultDbPath({ XDG_STATE_HOME: '/srv/state' })).toBe(
      '/srv/state/orchestrator/orchestrator.db',
    );
    expect(resolveDefaultDbPath({})).toBe(
      join(homedir(), '.local', 'state', 'orchestrator', 'orchestrator.db'),
    );
  });
});
