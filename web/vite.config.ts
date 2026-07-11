import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// This config runs under Node, but the app's type space stays DOM-only —
// declare the one global read here instead of pulling in @types/node.
declare const process: { env: Record<string, string | undefined> };

// Build lands in the root package's dist/ — the sidecar serves it from
// there and the npm tarball ships it pre-built (issue #87). Dev mode
// proxies /api to a running sidecar (`orc dashboard`), so the frontend
// hot-reloads against real snapshots without a rebuild per change.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../dist/web',
    emptyOutDir: true,
  },
  server: {
    // The proxy follows the sidecar wherever DASHBOARD_PORT put it, so a
    // sidecar on a nonstandard port never silently mismatches; unset means
    // the service default.
    proxy: {
      '/api': `http://127.0.0.1:${process.env.DASHBOARD_PORT || '8787'}`,
    },
    // Never a committed non-loopback bind (ADR 0002): unset — or empty, an
    // easy state for an env var passing through process-composition layers,
    // and one Vite would otherwise turn into a bind on ALL interfaces —
    // means Vite's loopback default. Dev over a tailnet:
    // `WEB_DEV_HOST="$(tailscale ip -4)" npm run dev:web` — bind to the
    // tailnet IP, not 0.0.0.0, on machines with a public interface. The
    // MagicDNS Host header is pre-allowed here so the *.ts.net URL isn't
    // rejected by Vite's DNS-rebinding protection.
    host: process.env.WEB_DEV_HOST || undefined,
    allowedHosts: ['.ts.net'],
  },
});
