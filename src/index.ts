#!/usr/bin/env node
import { realCliDeps, runCli } from './cli/cli.ts';

process.exitCode = await runCli(process.argv.slice(2), realCliDeps());
