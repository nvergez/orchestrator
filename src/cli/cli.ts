import { realDoctorDeps, runDoctor } from './doctor.ts';
import { runInit } from './init.ts';
import { readPackageMeta } from './pkg.ts';
import { realServiceDeps, runServiceInstall, runServiceUninstall } from './service.ts';
import { realUpdateDeps, runUpdate } from './update.ts';

/**
 * The `orc` CLI dispatch (issues #69/#70/#74): bare `orc` is the daemon,
 * everything else is a small plain-argv subcommand — deliberately no
 * argument-parsing dependency for six verbs. `--version` and `--help`
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
  update: (yes: boolean) => Promise<number>;
  serviceInstall: () => Promise<number>;
  serviceUninstall: () => Promise<number>;
  dashboard: () => Promise<void>;
}

const USAGE = `Usage: orc [command]

  (no command)        run the daemon (reads env config + routing hints)
  dashboard           run the dashboard sidecar (read-only web view, ADR 0002)
  init                scaffold the config dir (routing-hints.json + env template)
  doctor              read-only install diagnosis — non-zero exit on any failure
  update [--yes]      update to the latest release: install + unit regen + restart
                      (a breaking major release is refused without --yes)
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
      const { runDaemon } = await import('../daemon/daemon.ts');
      await runDaemon();
    },
    dashboard: async () => {
      const { runDashboard } = await import('../dashboard/main.ts');
      await runDashboard();
    },
    init: () => runInit(process.env, { out }),
    doctor: () => runDoctor(realDoctorDeps(), { out, err }),
    update: (yes) => runUpdate(realUpdateDeps(), { yes }),
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
  if (command === 'dashboard' && sub === undefined) {
    await deps.dashboard();
    return 0;
  }
  if (command === 'init' && sub === undefined) {
    return deps.init();
  }
  if (command === 'doctor' && sub === undefined) {
    return deps.doctor();
  }
  if (command === 'update' && (sub === undefined || sub === '--yes') && rest.length === 0) {
    return deps.update(sub === '--yes');
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
