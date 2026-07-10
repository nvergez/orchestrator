#!/usr/bin/env node
import { realCliDeps, runCli } from './cli.ts';

process.exitCode = await runCli(process.argv.slice(2), realCliDeps());
