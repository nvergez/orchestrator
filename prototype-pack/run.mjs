#!/usr/bin/env node
// PROTOTYPE (#67) — throwaway. One command: `node prototype-pack/run.mjs`
//
// Question: should the published @nvergez/orchestrator ship TypeScript source
// directly (bin src/index.ts, Node ≥22.18 type stripping) or tsc-compiled
// dist/? Builds BOTH shapes, packs each, installs each tarball into a clean
// prefix, runs the `orc` bin (success = exit 1 at config validation), and
// compares startup time, stack traces, npx behavior, tarball contents and
// engines floor. Writes prototype-pack/RESULTS.md.
//
// Requires: npm ci already run in the repo root, network access for the
// clean-prefix installs.

import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WORK = join(HERE, '.work');
const PKG_NAME = '@nvergez/orchestrator';

// Clean env for every child process: npm needs PATH/HOME; none of the
// daemon's SLACK_*/CLAUDE_* vars may leak in or the boot would get past
// config validation and try to reach Slack.
const CLEAN_ENV = { PATH: process.env.PATH, HOME: process.env.HOME };

const log = (msg) => console.log(`[pack-proto] ${msg}`);

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', env: CLEAN_ENV, ...opts });
}

// -- staging ----------------------------------------------------------------

function stageSource() {
  rmSync(WORK, { recursive: true, force: true });
  const srcDir = join(WORK, 'source', 'src');
  mkdirSync(srcDir, { recursive: true });
  cpSync(join(ROOT, 'src'), srcDir, { recursive: true });
  // Shape A ships this file as the bin — it needs a shebang. tsc preserves
  // the shebang in emitted output, so shape B inherits it from here too.
  const indexPath = join(srcDir, 'index.ts');
  writeFileSync(indexPath, '#!/usr/bin/env node\n' + readFileSync(indexPath, 'utf8'));
  cpSync(join(HERE, 'prototype-crash.ts'), join(srcDir, 'prototype-crash.ts'));
}

function basePackageJson() {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  delete pkg.private;
  delete pkg.scripts;
  delete pkg.devDependencies;
  return {
    ...pkg,
    name: PKG_NAME,
    license: 'MIT',
    repository: { type: 'git', url: 'git+https://github.com/nvergez/orchestrator.git' },
    publishConfig: { access: 'public' },
  };
}

function stageShapeSrc() {
  const dir = join(WORK, 'shape-src');
  mkdirSync(dir, { recursive: true });
  cpSync(join(WORK, 'source', 'src'), join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    ...basePackageJson(),
    version: '0.0.0-prototype-src',
    bin: { orc: 'src/index.ts' },
    files: ['src', '!src/**/*.test.ts'],
    engines: { node: '>=22.18' },
  }, null, 2));
  return dir;
}

function stageShapeDist() {
  const dir = join(WORK, 'shape-dist');
  mkdirSync(dir, { recursive: true });
  sh(join(ROOT, 'node_modules', '.bin', 'tsc'), ['-p', join(HERE, 'tsconfig.dist.json')], { cwd: ROOT });
  const emittedIndex = join(dir, 'dist', 'index.js');
  if (!readFileSync(emittedIndex, 'utf8').startsWith('#!')) {
    throw new Error('tsc did not preserve the shebang — prepend it here');
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    ...basePackageJson(),
    version: '0.0.0-prototype-dist',
    bin: { orc: 'dist/index.js' },
    files: ['dist'],
    // The deps only ask for >=18 (agent-sdk, bolt), but db.ts imports
    // node:sqlite, which shipped in Node 22.5 — proven by the Node 20 run
    // failing with ERR_UNKNOWN_BUILTIN_MODULE. Compiling barely moves the floor.
    engines: { node: '>=22.5' },
  }, null, 2));
  return dir;
}

// -- measurements -------------------------------------------------------------

function pack(dir) {
  const out = JSON.parse(sh('npm', ['pack', '--json', '--pack-destination', WORK], { cwd: dir }))[0];
  return { tarball: join(WORK, out.filename), ...out };
}

function installClean(shape, tarball) {
  const prefix = join(WORK, `prefix-${shape}`);
  mkdirSync(prefix, { recursive: true });
  const t0 = performance.now();
  sh('npm', ['install', '--global', '--prefix', prefix, '--no-audit', '--no-fund', tarball]);
  const installMs = performance.now() - t0;
  return { prefix, bin: join(prefix, 'bin', 'orc'), installMs };
}

// The bin passing this prototype's bar = boots to config validation and exits
// 1 with the ConfigError fatal line. Anything else is recorded as a verdict,
// not an abort — "cannot boot at all" is a result too (and for shape src it
// turned out to be THE result: Node refuses to type-strip under node_modules).
function classify(res) {
  const out = ((res.stdout ?? '') + (res.stderr ?? '')).trim();
  if (res.status === 1 && out.includes('invalid configuration')) {
    return { verdict: 'config-validation', out };
  }
  if (out.includes('ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING')) {
    return { verdict: 'type-stripping-refused', out };
  }
  return { verdict: `unexpected (status ${res.status})`, out };
}

function timeBoot(bin) {
  const probe = classify(spawnSync(bin, [], { encoding: 'utf8', env: CLEAN_ENV }));
  if (probe.verdict !== 'config-validation') {
    return { ...probe, medianMs: null, minMs: null, sample: probe.out };
  }
  const runs = [];
  for (let i = 0; i < 7; i++) {
    const t0 = performance.now();
    spawnSync(bin, [], { encoding: 'utf8', env: CLEAN_ENV });
    runs.push(performance.now() - t0);
  }
  runs.sort((a, b) => a - b);
  return {
    verdict: probe.verdict,
    medianMs: runs[Math.floor(runs.length / 2)],
    minMs: runs[0],
    sample: probe.out,
  };
}

function crashTrace(file, extraFlags = []) {
  const res = spawnSync('node', [...extraFlags, file], { encoding: 'utf8', env: CLEAN_ENV });
  return ((res.stdout ?? '') + (res.stderr ?? '')).trim();
}

// `npx --yes <tarball>` treats the positional as the command to exec, not a
// package spec (it fails 126 trying to run the .tgz as a shell script) — the
// working form is `--package=<tarball> orc`. An isolated npm cache makes the
// first run genuinely cold (dep download included), the second warm.
function timeNpx(tarball) {
  const env = { ...CLEAN_ENV, npm_config_cache: join(WORK, 'npx-cache') };
  const run = () => {
    const t0 = performance.now();
    const res = spawnSync('npx', ['--yes', `--package=${tarball}`, 'orc'], { encoding: 'utf8', env });
    const ms = performance.now() - t0;
    return { ms, ...classify(res) };
  };
  const cold = run();
  const warm = run();
  return { coldMs: cold.ms, warmMs: warm.ms, verdict: warm.verdict, out: warm.out };
}

// Best-effort: fetch a Node 20 binary via the `node` npm package and run both
// entries under it. Proves (or disproves) the compiled shape's lower floor.
function node20(entry, pkgDir) {
  try {
    const res = spawnSync('npx', ['--yes', 'node@20', join(pkgDir, entry)], {
      encoding: 'utf8', env: CLEAN_ENV, timeout: 300_000,
    });
    return { status: res.status, out: ((res.stdout ?? '') + (res.stderr ?? '')).trim() };
  } catch (err) {
    return { status: null, out: `skipped: ${err.message}` };
  }
}

// -- drive --------------------------------------------------------------------

if (!existsSync(join(ROOT, 'node_modules', '.bin', 'tsc'))) {
  console.error('run `npm ci` in the repo root first');
  process.exit(1);
}

log('staging shared source (shebang + crash module)…');
stageSource();

const shapes = {};
for (const [shape, stage] of [['src', stageShapeSrc], ['dist', stageShapeDist]]) {
  log(`shape ${shape}: staging + npm pack…`);
  const dir = stage();
  const tarball = pack(dir);
  log(`shape ${shape}: clean-prefix install…`);
  const install = installClean(shape, tarball.tarball);
  log(`shape ${shape}: timing boot-to-config-validation…`);
  const boot = timeBoot(install.bin);
  const pkgDir = join(install.prefix, 'lib', 'node_modules', PKG_NAME);
  const crashFile = shape === 'src' ? 'src/prototype-crash.ts' : 'dist/prototype-crash.js';
  log(`shape ${shape}: stack trace + npx…`);
  const trace = crashTrace(join(pkgDir, crashFile));
  const traceSourceMaps = shape === 'dist'
    ? crashTrace(join(pkgDir, crashFile), ['--enable-source-maps'])
    : null;
  const npx = timeNpx(tarball.tarball);
  shapes[shape] = { dir, tarball, install, boot, pkgDir, crashFile, trace, traceSourceMaps, npx };
}

log('best-effort Node 20 floor check (downloads node@20 via npx once)…');
const node20Src = node20('src/index.ts', shapes.src.pkgDir);
const node20Dist = node20('dist/index.js', shapes.dist.pkgDir);

const fmt = (ms) => (ms === null ? 'n/a' : `${ms.toFixed(0)} ms`);
const errCode = (out) => out.match(/\[(ERR_[A-Z_]+)\]/)?.[1] ?? 'no error';
const results = `# PROTOTYPE results (#67): ship TS source vs compiled dist/

Generated by \`node prototype-pack/run.mjs\` on Node ${process.version}.

| Measure | shape **src** (ship .ts) | shape **dist** (tsc → dist/) |
| --- | --- | --- |
| installed \`orc\` boots to | ${shapes.src.boot.verdict} | ${shapes.dist.boot.verdict} |
| tarball size | ${(shapes.src.tarball.size / 1024).toFixed(1)} KiB | ${(shapes.dist.tarball.size / 1024).toFixed(1)} KiB |
| unpacked size | ${(shapes.src.tarball.unpackedSize / 1024).toFixed(1)} KiB | ${(shapes.dist.tarball.unpackedSize / 1024).toFixed(1)} KiB |
| files in tarball | ${shapes.src.tarball.entryCount} | ${shapes.dist.tarball.entryCount} |
| clean-prefix install | ${fmt(shapes.src.install.installMs)} | ${fmt(shapes.dist.install.installMs)} |
| boot→config-fail, median (min) of 7 | ${fmt(shapes.src.boot.medianMs)} (${fmt(shapes.src.boot.minMs)}) | ${fmt(shapes.dist.boot.medianMs)} (${fmt(shapes.dist.boot.minMs)}) |
| npx --package=<tgz> orc, cold / warm | ${shapes.src.npx.verdict}, ${fmt(shapes.src.npx.coldMs)} / ${fmt(shapes.src.npx.warmMs)} | ${shapes.dist.npx.verdict}, ${fmt(shapes.dist.npx.coldMs)} / ${fmt(shapes.dist.npx.warmMs)} |
| engines floor | \`>=22.18\` (type stripping) | \`>=22.5\` (node:sqlite; deps alone: >=18) |
| Node 20 run | ${errCode(node20Src.out)} | ${errCode(node20Dist.out)} |

## Boot output (shape src)
\`\`\`
${shapes.src.boot.sample}
\`\`\`

## Boot output (shape dist)
\`\`\`
${shapes.dist.boot.sample}
\`\`\`

## Stack trace — shape src (${shapes.src.crashFile})
\`\`\`
${shapes.src.trace}
\`\`\`

## Stack trace — shape dist (${shapes.dist.crashFile})
\`\`\`
${shapes.dist.trace}
\`\`\`

## Stack trace — shape dist with --enable-source-maps
\`\`\`
${shapes.dist.traceSourceMaps}
\`\`\`

## Node 20 — shape src (expect failure: no type stripping)
\`\`\`
${node20Src.out}
\`\`\`

## Node 20 — shape dist
\`\`\`
${node20Dist.out}
\`\`\`

## Tarball contents (shape src)
\`\`\`
${shapes.src.tarball.files.map((f) => f.path).sort().join('\n')}
\`\`\`

## Tarball contents (shape dist)
\`\`\`
${shapes.dist.tarball.files.map((f) => f.path).sort().join('\n')}
\`\`\`
`;

writeFileSync(join(HERE, 'RESULTS.md'), results);
log('wrote prototype-pack/RESULTS.md');
