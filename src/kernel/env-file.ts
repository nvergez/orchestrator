/**
 * Minimal KEY=VALUE parser for the canonical env file: blank lines and `#`
 * comments skipped, an optional `export ` prefix and one layer of matching
 * quotes stripped — enough for the `orc init` template and the shell-sourcing
 * style the operations guide suggests. Read-only consumers only: doctor's
 * bare-shell fallback and the daemon's dev-instance collision guard compare
 * against it; nothing ever *loads* boot config from it (spec §10 — env vars
 * stay the only boot-config channel; systemd's EnvironmentFile materializes
 * the file).
 */
export function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    if (key === '') continue;
    let value = line.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }
    vars[key] = value;
  }
  return vars;
}
