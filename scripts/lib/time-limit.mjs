// The scan's total time limit as set from outside (--max-minutes).

import { DEFAULTS } from './scanner.mjs';

const MAX_MINUTES = 120;
const MS_PER_MINUTE = 60_000;

/**
 * Turn the --max-minutes value into the total time limit in milliseconds (scanner option maxTotalMs).
 * @param {string|undefined} value raw CLI value; undefined keeps the default
 * @returns {number}
 * @throws {Error} unless the value is a positive decimal number of minutes, at most MAX_MINUTES
 */
export function parseMaxMinutes(value) {
  if (value === undefined) return DEFAULTS.maxTotalMs;
  const minutes = /^\d+(\.\d+)?$/.test(value) ? Number(value) : NaN;
  if (!(minutes > 0 && minutes <= MAX_MINUTES)) {
    throw new Error(`--max-minutes must be a positive number of minutes, at most ${MAX_MINUTES}`);
  }
  return Math.round(minutes * MS_PER_MINUTE);
}
