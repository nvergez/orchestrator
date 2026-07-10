import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

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
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
    // Dev over a tailnet: bind past loopback per-invocation with
    // `npm run dev -w web -- --host "$(tailscale ip -4)"` — bind to the
    // tailnet IP, not 0.0.0.0, on machines with a public interface. The
    // MagicDNS Host header is pre-allowed here so the *.ts.net URL isn't
    // rejected by Vite's DNS-rebinding protection.
    allowedHosts: ['.ts.net'],
  },
});
