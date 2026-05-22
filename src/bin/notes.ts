#!/usr/bin/env bun
import { runCli } from '../cli/index';

process.exit(await runCli(process.argv.slice(2)));
