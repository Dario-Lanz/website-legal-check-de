// --grep: case-insensitive regex search in page text, footer text and links of all pages
// (or one page), run in a worker thread with a hard time limit.

import { Worker } from 'node:worker_threads';
import { compilePattern, MAX_SNIPPETS, MAX_SNIPPETS_ONE_PAGE } from './grep-core.mjs';
import { listedPages } from './format.mjs';

const MAX_LISTED_PAGES = 10;

export const GREP_TIME_LIMIT_MS = 5000;
const WORKER_MEMORY_MB = 256;

/** Only what the search needs, so little data is copied into the worker. */
function slim(scan) {
  return { pages: scan.pages.map((p) => ({ index: p.index, facts: { bodyText: p.facts?.bodyText, footerText: p.facts?.footerText, links: p.facts?.links } })) };
}

/** Run the search in a worker; rejects with a clear message on timeout, bad pattern or worker failure. */
function runInWorker(scan, pattern, page, timeLimitMs) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./grep-worker.mjs', import.meta.url), { workerData: { scan: slim(scan), pattern, page }, resourceLimits: { maxOldGenerationSizeMb: WORKER_MEMORY_MB } });
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error(`--grep stopped after ${timeLimitMs / 1000} s: the pattern is too slow (catastrophic backtracking?); use a simpler pattern`));
    }, timeLimitMs);
    worker.once('message', (msg) => { clearTimeout(timer); worker.terminate(); if (msg.error) reject(new Error(msg.error)); else resolve(msg.result); });
    worker.once('error', (error) => { clearTimeout(timer); reject(new Error(`--grep failed: ${error.message}`)); });
  });
}

/** Page indexes as `#1, #2, …`, at most MAX_LISTED_PAGES, then how many more. */
function cutPages(indexes) {
  const shown = indexes.slice(0, MAX_LISTED_PAGES).map((n) => `#${n}`).join(', ');
  return indexes.length > MAX_LISTED_PAGES ? `${shown} and ${indexes.length - MAX_LISTED_PAGES} more pages` : shown;
}

function snippetLine(s, urlOf) {
  return `[${s.field}] ${listedPages(s.pages, urlOf)}: ${s.text}${s.matches > 1 ? ` (${s.matches} matches)` : ''}`;
}

/**
 * @param {object} scan parsed scan.json
 * @param {string} pattern regular expression, case-insensitive
 * @param {{page?: number, timeLimitMs?: number}} [options] restrict to one page; test hook for the time limit
 * @returns {Promise<string>}
 */
export async function grepPages(scan, pattern, { page, timeLimitMs = GREP_TIME_LIMIT_MS } = {}) {
  compilePattern(pattern);
  if (page !== undefined && !scan.pages.some((p) => p.index === page)) throw new Error(`no page with index ${page} (valid: 1-${scan.pages.length})`);
  const result = await runInWorker(scan, pattern, page, timeLimitMs);
  const urlOf = new Map(scan.pages.map((p) => [p.index, p.url]));
  const scope = page === undefined ? `${scan.pages.length} pages` : `page #${page}`;
  const limit = page === undefined ? MAX_SNIPPETS : MAX_SNIPPETS_ONE_PAGE;
  const count = result.capped ? `more than ${limit} distinct matches, showing the first ${result.snippets.length}` : `${result.snippets.length} distinct matches`;
  const note = result.shortened.length > 0 ? `; more matches than shown on ${cutPages(result.shortened)} (use --page <index> to see all matches of one page)` : '';
  return [`grep /${pattern}/i in ${scope} (page text, footer text, links; identical snippets merged): ${count}${note}`, ...result.snippets.map((s) => snippetLine(s, urlOf))].join('\n');
}


