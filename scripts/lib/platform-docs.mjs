// Which detected systems have verified click paths? Exactly those with a numbered section in references/platforms.md
// (`## N. <name>`); systems that are only detected (e.g. Framer) get generic fix steps.

import { readFileSync } from 'node:fs';
import { platformSection } from './evidence/markdown.mjs';

let platformsMd;

/**
 * @param {string|null|undefined} name detected system, e.g. "WordPress"
 * @returns {boolean} true when references/platforms.md has a section with click paths for it
 */
export function hasClickPaths(name) {
  platformsMd ??= readFileSync(new URL('../../references/platforms.md', import.meta.url), 'utf8');
  return platformSection(platformsMd, name) !== null;
}
