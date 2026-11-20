// Pure helpers that cut the reference files (checklist, platforms, upcoming, sources) into
// sections and entries. All functions take the file text; nothing here reads files.

const SRC_ID = /SRC-\d{2,3}/g;

/** Text from the line starting with `start` up to (not including) the next line matching `stop`. */
function cut(md, startPattern, stopPattern) {
  const lines = md.split('\n');
  const from = lines.findIndex((l) => startPattern.test(l));
  if (from < 0) return null;
  let to = lines.findIndex((l, i) => i > from && stopPattern.test(l));
  if (to < 0) to = lines.length;
  return trimBlock(lines.slice(from, to).join('\n'));
}

/** Drop surrounding blank lines and a trailing `---` separator. */
function trimBlock(text) {
  return text.replace(/\n+---\s*$/, '').trim();
}

/** A general section `## <title>` of a reference file, verbatim; null if absent. */
export function generalSection(md, title) {
  return cut(md, new RegExp(`^## ${escapeRegex(title)}\\s*$`), /^## /);
}

/** One checklist entry `### <ID> – …` verbatim; null if the ID has no entry. */
export function checklistEntry(md, id) {
  return cut(md, new RegExp(`^### ${escapeRegex(id)} `), /^##+ /);
}

/** One upcoming entry `## UP-nn …` verbatim; null if absent. */
export function upcomingEntry(md, id) {
  return cut(md, new RegExp(`^## ${escapeRegex(id)} `), /^## /);
}

/** All check IDs that have an entry in the checklist (`### XXX-nn`). */
export function checklistIds(md) {
  return [...md.matchAll(/^### ([A-Z]+-\d{2}) /gm)].map((m) => m[1]);
}

/** Row of the manual-checks table for an ID like MAN-06, with the table header; null if absent. */
export function manualCheckRow(md, id) {
  const lines = md.split('\n');
  const row = lines.find((l) => l.startsWith(`| ${id} |`));
  if (!row) return null;
  const header = lines.findIndex((l) => l.startsWith('| ID | Duty |'));
  return header < 0 ? row : [lines[header], lines[header + 1], row].join('\n');
}

/** Platforms intro: everything before the first numbered system section. */
export function platformsIntro(md) {
  return cut(md, /^# /, /^## \d+\. /);
}

/** Section of the detected platform (`## N. <name> …`), matched by name prefix; null if none. */
export function platformSection(md, name) {
  if (!name) return null;
  return cut(md, new RegExp(`^## \\d+\\. ${escapeRegex(name)}\\b`, 'i'), /^## /);
}

/** The summary table of upcoming.md (heading line included), verbatim. */
export function upcomingSummary(md) {
  return generalSection(md, 'Summary table');
}

/** SRC IDs named on the Help line of a checklist entry (duplicates removed, order kept). */
export function helpSourceIds(entry) {
  const line = entry.split('\n').find((l) => l.startsWith('- **Help:**')) ?? '';
  return [...new Set(line.match(SRC_ID) ?? [])];
}

/** Every SRC ID named anywhere in a text (duplicates removed, order kept). */
export function sourceIdsIn(text) {
  return [...new Set(text.match(SRC_ID) ?? [])];
}

/** Text after "Common reason for a warning letter:" of an entry, or null. */
export function warningLetterLine(entry) {
  const m = entry.match(/^- \*\*Common reason for a warning letter:\*\*\s*(.*)$/m);
  return m ? m[1].trim() : null;
}

/** Parse the source tables: Map of SRC ID to {id, title, url, retrieved}. */
export function parseSources(md) {
  const map = new Map();
  for (const line of md.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    if (cells.length < 6 || !/^SRC-\d{2,3}$/.test(cells[1])) continue;
    map.set(cells[1], { id: cells[1], title: cells[2], url: cells[3], retrieved: cells[4] });
  }
  return map;
}

/** Date after "Checklist status:" as TT.MM.JJJJ, or null. */
export function checklistStatusDate(md) {
  const m = md.match(/^Checklist status:\s*(\d{4})-(\d{2})-(\d{2})/m);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : null;
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
