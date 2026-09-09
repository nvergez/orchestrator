import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENV_TEMPLATE, PERSONA_TEMPLATE, ROUTING_HINTS_TEMPLATE } from './templates.ts';
import { resolveConfigDir } from '../kernel/xdg.ts';

/**
 * `orc init` (issue #70): scaffold the XDG config dir with the instance
 * files from the embedded templates — the two required ones plus the
 * optional persona. Existing files are NEVER overwritten — re-running init
 * on a configured box is safe.
 */

export interface InitIo {
  out(line: string): void;
}

export function runInit(env: Record<string, string | undefined>, io: InitIo): number {
  const dir = resolveConfigDir(env);
  mkdirSync(dir, { recursive: true });

  const hintsPath = join(dir, 'routing-hints.json');
  const envPath = join(dir, 'env');
  const personaPath = join(dir, 'persona.md');
  scaffold(hintsPath, ROUTING_HINTS_TEMPLATE, undefined, io);
  // chmod 600 — the env file will hold live tokens (spec: issue #70).
  scaffold(envPath, ENV_TEMPLATE, 0o600, io);
  // Scaffolded fully commented: untouched, it leaves the stock voice.
  scaffold(personaPath, PERSONA_TEMPLATE, undefined, io);

  io.out('');
  io.out('Next steps:');
  io.out(`  1. Fill in your Slack + Claude tokens: ${envPath} (keep it chmod 600)`);
  io.out(`  2. Describe your repos: ${hintsPath}`);
  io.out(`  3. Optional — teach it your voice: ${personaPath}`);
  io.out('  4. Check the install: orc doctor');
  io.out('  5. Run it under systemd: orc service install');
  return 0;
}

function scaffold(path: string, content: string, mode: number | undefined, io: InitIo): void {
  // `wx` refuses atomically when the file exists — never overwrite.
  try {
    writeFileSync(path, content, { flag: 'wx', ...(mode !== undefined && { mode }) });
    io.out(`✔ wrote ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      io.out(`• ${path} already exists — left untouched`);
      return;
    }
    throw error;
  }
}
