#!/usr/bin/env node
// Quarterly update check. Modes: --status | --laws | --mark-checked. Prints one JSON object, always exits 0
// (errors are part of the JSON). Test hooks: --root <skill folder>, --today YYYY-MM-DD.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseIsoDate, run, toIsoDate } from './lib/update-check.mjs';
import { createIo } from './lib/update-check-io.mjs';

function option(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const args = process.argv.slice(2);
const root = option(args, '--root') ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const today = option(args, '--today') ?? toIsoDate(new Date());
let output;
try {
  if (!parseIsoDate(today)) throw new Error(`invalid --today: ${today}`);
  output = await run(args.find((a) => ['--status', '--laws', '--mark-checked'].includes(a)), createIo(root), today);
} catch (error) {
  output = { error: error.message };
}
console.log(JSON.stringify(output));
