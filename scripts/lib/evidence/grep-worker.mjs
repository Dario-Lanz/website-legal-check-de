// Worker thread for --grep: runs the regex search off the main thread (see grep.mjs).

import { parentPort, workerData } from 'node:worker_threads';
import { compilePattern, findMatches, MAX_SNIPPETS, MAX_SNIPPETS_ONE_PAGE, MAX_SNIPPETS_PER_TEXT, searchTexts } from './grep-core.mjs';

try {
  const result = findMatches(searchTexts(workerData.scan, workerData.page), compilePattern(workerData.pattern), ...(workerData.page === undefined ? [MAX_SNIPPETS_PER_TEXT, MAX_SNIPPETS] : [Infinity, MAX_SNIPPETS_ONE_PAGE]));
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error.message });
}
