#!/usr/bin/env node
import { register } from 'tsx/esm/api';

register();

const { run } = await import('../src/cli.ts');
process.exitCode = await run(process.argv.slice(2));
