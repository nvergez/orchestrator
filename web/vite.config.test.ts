import { afterEach, describe, expect, it, vi } from 'vitest';

const originalDashboardPort = process.env.DASHBOARD_PORT;
const originalWebDevHost = process.env.WEB_DEV_HOST;

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}

async function loadServerConfig() {
  vi.resetModules();
  const { default: config } = await import('./vite.config.ts');

  if (typeof config === 'function' || config instanceof Promise) {
    throw new Error('expected a static Vite config');
  }

  return config.server;
}

afterEach(() => {
  restoreEnv('DASHBOARD_PORT', originalDashboardPort);
  restoreEnv('WEB_DEV_HOST', originalWebDevHost);
});

describe('dashboard frontend dev server', () => {
  it('follows the sidecar port and frontend bind host from the environment', async () => {
    process.env.DASHBOARD_PORT = '9123';
    process.env.WEB_DEV_HOST = '127.0.0.2';

    const server = await loadServerConfig();

    expect(server?.proxy?.['/api']).toBe('http://127.0.0.1:9123');
    expect(server?.host).toBe('127.0.0.2');
    expect(server?.allowedHosts).toContain('.ts.net');
  });

  it('keeps the sidecar default and Vite loopback bind when unset', async () => {
    delete process.env.DASHBOARD_PORT;
    delete process.env.WEB_DEV_HOST;

    const server = await loadServerConfig();

    expect(server?.proxy?.['/api']).toBe('http://127.0.0.1:8787');
    expect(server?.host).toBeUndefined();
  });

  it('treats empty env as unset — an empty host must never become a bind on all interfaces', async () => {
    // Vite turns `host: ''` into a bind on ALL interfaces, so `host` must
    // come out undefined, not '' (ADR 0002: no committed non-loopback bind).
    process.env.DASHBOARD_PORT = '';
    process.env.WEB_DEV_HOST = '';

    const server = await loadServerConfig();

    expect(server?.proxy?.['/api']).toBe('http://127.0.0.1:8787');
    expect(server?.host).toBeUndefined();
  });
});
