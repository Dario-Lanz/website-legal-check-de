#!/usr/bin/env node
// CLI: fetch every source cited in report.json (only URLs listed in references/sources.md or
// written in references/upcoming.md), print one line per URL and, with --write, set `retrieved`
// to today's date on reachable ones and clear it on unreachable ones (SKILL.md step 5).
// Usage: node scripts/check-sources.mjs --data "<run folder>/daten/report.json" [--write]

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkSources, formatRow } from './lib/sources/check.mjs';

const REFERENCES = path.join(path.dirname(fileURLToPath(import.meta.url)), '../references');
const SOURCES_FILE = path.join(REFERENCES, 'sources.md');
const UPCOMING_FILE = path.join(REFERENCES, 'upcoming.md');
const OPTIONS = { data: { type: 'string' }, write: { type: 'boolean' } };

async function readReport(file) {
  let report;
  try {
    report = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${file}: ${error.message}`);
  }
  if (!Array.isArray(report.findings)) throw new Error(`${file} has no "findings" array`);
  return report;
}

/** Run the check; returns the printable report and whether every source was reachable and listed. With `write`, report.json is updated. */
export async function runCheck({ data, write }, deps = {}) {
  if (!data) throw new Error('--data "<run folder>/daten/report.json" is required');
  const report = await readReport(data);
  const sourcesMd = await readFile(SOURCES_FILE, 'utf8');
  const upcomingMd = await readFile(UPCOMING_FILE, 'utf8');
  const { rows, unlisted, updated } = await checkSources(report, sourcesMd, { write, upcomingMd, ...deps });
  if (write) await writeFile(data, `${JSON.stringify(report, null, 2)}\n`);
  const reachable = rows.filter((r) => r.reachable).length;
  const problems = rows.length - reachable + unlisted.length;
  const lines = [
    ...rows.map(formatRow),
    ...unlisted.map((url) => `not in sources.md or upcoming.md, check by hand: ${url}`),
    `${rows.length} fetched: ${reachable} reachable, ${rows.length - reachable} not reachable; ${unlisted.length} not in sources.md or upcoming.md${write ? `; ${updated} source entries updated (date set on reachable, cleared on unreachable)` : ' (dry run, report.json unchanged; add --write to set the date)'}`,
  ];
  if (problems > 0) lines.push(`PROBLEM: ${problems} source(s) not reachable or not in sources.md or upcoming.md. Remove them from report.json or replace them with a reachable source before building (exit code 1).`);
  return { text: lines.join('\n'), ok: problems === 0 };
}

async function main() {
  try {
    const { values } = parseArgs({ options: OPTIONS, strict: true });
    const { text, ok } = await runCheck(values);
    process.stdout.write(`${text}\n`);
    if (!ok) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
