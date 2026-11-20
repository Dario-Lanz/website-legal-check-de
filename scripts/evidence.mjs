#!/usr/bin/env node
// CLI: evidence digest of a scan for the verification step (workflow step 4), written to
// <run folder>/daten/evidence.txt, and sub-modes that print answers to ad-hoc questions.
// Usage: node scripts/evidence.mjs --run "<run folder>" [--grep <regex> [--page <index>] | --page <index> | --requests [--host <substring>] | --entry <ID> | --upcoming <UP-nn>]

import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { buildDigest } from './lib/evidence/digest.mjs';
import { sourceLines } from './lib/evidence/findings-view.mjs';
import { clip } from './lib/evidence/format.mjs';
import { grepPages } from './lib/evidence/grep.mjs';
import { checklistEntry, checklistIds, manualCheckRow, parseSources, upcomingEntry } from './lib/evidence/markdown.mjs';
import { describePage, describeRequests } from './lib/evidence/queries.mjs';
import { loadReferences, loadRun } from './lib/evidence/run-files.mjs';

const MAX_OUTPUT_CHARS = 150000;
const MAX_FILE_CHARS = 1000000;
const DIGEST_FILE = 'evidence.txt';
const CHECK_ID = /^(?:[A-Z]{2,4}-\d{2}|MAN-\d{2})$/;
const UPCOMING_ID = /^UP-\d{2}$/;
const ALLOWED_COMBINATIONS = ['', 'grep', 'page', 'grep,page', 'requests', 'host,requests', 'entry', 'upcoming'];

const OPTIONS = {
  run: { type: 'string' },
  grep: { type: 'string' },
  page: { type: 'string' },
  requests: { type: 'boolean' },
  host: { type: 'string' },
  entry: { type: 'string' },
  upcoming: { type: 'string' },
};

function lookupEntry(refs, id) {
  if (!CHECK_ID.test(id)) throw new Error(`invalid check ID "${id}" (expected e.g. TDD-01 or MAN-06)`);
  const found = checklistEntry(refs.checklist, id) ?? manualCheckRow(refs.checklist, id);
  if (!found) return `no entry for ${id} in references/checklist.md. Known IDs: ${checklistIds(refs.checklist).join(', ')}`;
  return [found, 'sources named in this entry:', ...sourceLines(found, parseSources(refs.sources))].join('\n');
}

function lookupUpcoming(refs, id) {
  if (!UPCOMING_ID.test(id)) throw new Error(`invalid ID "${id}" (expected e.g. UP-02)`);
  return upcomingEntry(refs.upcoming, id) ?? `no entry for ${id} in references/upcoming.md`;
}

function parsePageIndex(value) {
  if (!/^\d{1,4}$/.test(value)) throw new Error(`--page needs a page number, got "${value}"`);
  return Number(value);
}

/** Only meaningful option combinations are accepted; anything else is named instead of silently ignored. */
function checkCombination(values) {
  const given = Object.keys(OPTIONS).filter((k) => k !== 'run' && values[k] !== undefined && values[k] !== false).sort();
  if (ALLOWED_COMBINATIONS.includes(given.join(','))) return;
  if (given.length === 1 && given[0] === 'host') throw new Error('--host only works together with --requests');
  throw new Error(`unsupported combination: ${given.map((k) => `--${k}`).join(' ')}. Allowed: no option (digest file), --grep [--page], --page, --requests [--host], --entry, --upcoming`);
}

async function writeDigest(run, refs) {
  const text = clip(buildDigest(run, refs), MAX_FILE_CHARS);
  const file = path.join(run.dataDir, DIGEST_FILE);
  await writeFile(file, `${text}\n`);
  const lines = text.split('\n').length;
  return `wrote ${file}: ${text.length} characters, ${lines} lines. Read it with the Read tool (in parts with offset and limit if the tool says it is too large). Sections in order: site header, checklist general sections, platform, upcoming rules, findings.`;
}

/** Pick the mode from the options and return its output text. */
export async function runEvidence(values) {
  if (!values.run) throw new Error('--run "<run folder>" is required');
  checkCombination(values);
  const run = await loadRun(values.run);
  const page = values.page === undefined ? undefined : parsePageIndex(values.page);
  if (values.grep !== undefined) return grepPages(run.scan, values.grep, { page });
  if (page !== undefined) return describePage(run.scan, page);
  if (values.requests) return describeRequests(run.scan, values.host);
  const refs = await loadReferences();
  if (values.entry !== undefined) return lookupEntry(refs, values.entry);
  if (values.upcoming !== undefined) return lookupUpcoming(refs, values.upcoming);
  return writeDigest(run, refs);
}

async function main() {
  try {
    const { values } = parseArgs({ options: OPTIONS, strict: true });
    process.stdout.write(`${clip(await runEvidence(values), MAX_OUTPUT_CHARS)}\n`);
  } catch (error) {
    process.stderr.write(`error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) await main();
