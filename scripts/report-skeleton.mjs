#!/usr/bin/env node
// CLI: write <run folder>/daten/report.json prefilled with everything mechanical (site, date,
// time, platform, candidates with sources and screenshot candidates). Claude fills the rest;
// build-reports.mjs rejects the file until the required fields are filled.
// Usage: node scripts/report-skeleton.mjs --run "<run folder>" --lang <code> [--force]

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { loadReferences, loadRun } from './lib/evidence/run-files.mjs';
import { buildSkeleton } from './lib/skeleton.mjs';

const OPTIONS = { run: { type: 'string' }, lang: { type: 'string' }, force: { type: 'boolean' } };

/** Build the skeleton and write it; refuses to overwrite an existing report.json without `force`. Returns the file path. */
export async function writeSkeleton({ run, lang, force }) {
  if (!run) throw new Error('--run "<run folder>" is required');
  if (!lang) throw new Error('--lang <code> is required');
  const data = await loadRun(run);
  const skeleton = buildSkeleton(data, await loadReferences(), lang);
  const file = path.join(data.dataDir, 'report.json');
  try {
    await writeFile(file, `${JSON.stringify(skeleton, null, 2)}\n`, { flag: force ? 'w' : 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${file} already exists; use --force to overwrite it`);
    throw error;
  }
  return { file, findings: skeleton.findings.length };
}

async function main() {
  try {
    const { values } = parseArgs({ options: OPTIONS, strict: true });
    const { file, findings } = await writeSkeleton(values);
    process.stdout.write(`wrote ${file} with ${findings} candidate findings; fill every empty field, then run build-reports.mjs\n`);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
