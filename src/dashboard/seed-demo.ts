import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { seedDemoState } from './demo-state.ts';

/**
 * `npm run seed:demo` — write a fresh demo database for the frontend dev
 * loop, into a git-ignored dev path. The builder always reseeds from
 * scratch: demo state is reachable only by this explicit command and never
 * lingers half-stale (CONTEXT.md: Demo state). The path is deliberately
 * fixed — honoring ORCHESTRATOR_DB_PATH here would let ambient daemon env
 * aim this destructive reseed at a real database. Dev-only — excluded from
 * the published build (tsconfig.build.json).
 */

const dbPath = resolve('.dev/demo.db');
mkdirSync(dirname(dbPath), { recursive: true });
seedDemoState(dbPath, new Date());
console.log(`demo state seeded → ${dbPath}`);
