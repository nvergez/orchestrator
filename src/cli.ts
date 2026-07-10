import { realDoctorDeps, runDoctor } from './doctor.ts';
import { runInit } from './init.ts';
import { readPackageMeta } from './pkg.ts';
import { realServiceDeps, runServiceInstall, runServiceUninstall } from './service.ts';

/**
 * The `orc` CLI dispatch (issues #69/#70/#74): bare `orc` is the daemon,
 * everything else is a small plain-argv subcommand — deliberately no
 * argument-parsing dependency for five verbs. `--version` and `--help`
 * need no config, no env, and must not load the Slack stack (the daemon
 * module is imported lazily), so the pack-smoke CI gate can run them from
 * a bare `npm install -g`.
 */

export interface CliDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  version: () => string;
  daemon: () => Promise<void>;
  init: () => number;
  doctor: () => Promise<number>;
  serviceInstall: () => Promise<number>;
  serviceUninstall: () => Promise<number>;
}

const USAGE = `Usage: orc [command]

  (no command)        run the daemon (reads env config + routing hints)
  init                scaffold the config dir (routing-hints.json + env template)
  doctor              read-only install diagnosis — non-zero exit on any failure
  service install     generate + enable the systemd user unit (always regenerates)
  service uninstall   disable and remove the systemd user unit
  --version           print the version and exit`;

export function realCliDeps(): CliDeps {
  const out = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };
  const err = (line: string): void => {
    process.stderr.write(`${line}\n`);
  };
  return {
    out,
    err,
    version: () => readPackageMeta().version,
    daemon: async () => {
      const { runDaemon } = await import('./daemon.ts');
      await runDaemon();
    },
    init: () => runInit(process.env, { out }),
    doctor: () => runDoctor(realDoctorDeps(), { out, err }),
    serviceInstall: () => runServiceInstall(realServiceDeps()),
    serviceUninstall: () => runServiceUninstall(realServiceDeps()),
  };
}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
  const [command, sub, ...rest] = argv;
  if (command === undefined) {
    await deps.daemon();
    return 0;
  }
  if (command === '--version' || command === '-v') {
    deps.out(deps.version());
    return 0;
  }
  if (command === '--help' || command === '-h' || command === 'help') {
    deps.out(USAGE);
    return 0;
  }
  if (command === 'init' && sub === undefined) {
    return deps.init();
  }
  if (command === 'doctor' && sub === undefined) {
    return deps.doctor();
  }
  if (command === 'service' && sub === 'install' && rest.length === 0) {
    return deps.serviceInstall();
  }
  if (command === 'service' && sub === 'uninstall' && rest.length === 0) {
    return deps.serviceUninstall();
  }
  deps.err(`orc: unknown command "${argv.join(' ')}"`);
  deps.err('');
  deps.err(USAGE);
  return 1;
}
