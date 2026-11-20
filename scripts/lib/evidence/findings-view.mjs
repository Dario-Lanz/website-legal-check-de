// Findings part of the evidence digest: one block per candidate finding with its evidence,
// screenshots and the checklist entry (printed once per check ID).

import { checklistEntry, manualCheckRow, parseSources, sourceIdsIn } from './markdown.mjs';
import { clip, listLimited, shortUrl } from './format.mjs';

const MAX_PAGES_LISTED = 12;
const MAX_SCREENSHOTS = 6;
const MAX_EVIDENCE_CHARS = 6000;

/** Scanned pages by requested and final URL (findings name either). */
export function pagesByUrl(scan) {
  return new Map(scan.pages.flatMap((p) => [[p.finalUrl, p], [p.url, p]]));
}

const KIND_RANK = { cookieabfrage: 0, ansicht: 1, fusszeile: 2 };
const CONSENT_CHECK = /^TDD-/;
const FOOTER_CHECK = /^(IMP|DSE|WID|AGB|VSB|ODR|KUE)-/;

/** Screenshots a finding names in its evidence, then those of its pages (consent dialog first, then view, then footer); no duplicates. */
export function findingScreenshots(finding, scan) {
  const byUrl = pagesByUrl(scan);
  const fromPages = (finding.pages ?? []).flatMap((url) => Object.entries(byUrl.get(url)?.screenshots ?? {}));
  const ranked = fromPages.sort((a, b) => (KIND_RANK[a[0]] ?? 3) - (KIND_RANK[b[0]] ?? 3)).map(([, file]) => file);
  return [...new Set([...(finding.evidence?.screenshots ?? []), ...ranked])];
}

/** Screenshot kinds that can prove a check, best first: dialog for consent checks, footer for link checks, else the view. */
function relevantKinds(check) {
  if (CONSENT_CHECK.test(check)) return ['cookieabfrage', 'ansicht'];
  if (FOOTER_CHECK.test(check)) return ['fusszeile', 'ansicht'];
  return ['ansicht'];
}

/** Screenshot candidates for report.json: those named in the evidence, then only the kinds relevant to the check. */
export function candidateScreenshots(finding, scan) {
  const byUrl = pagesByUrl(scan);
  const kinds = relevantKinds(finding.check);
  const fromPages = kinds.flatMap((kind) => (finding.pages ?? []).map((url) => byUrl.get(url)?.screenshots?.[kind]).filter(Boolean));
  return [...new Set([...(finding.evidence?.screenshots ?? []), ...fromPages])];
}

function pagesLine(finding, scan) {
  const urls = [...new Set(finding.pages ?? [])];
  if (urls.length === 0) return 'pages: none named';
  if (urls.length >= scan.pages.length && scan.pages.length > 1) return `pages: all ${urls.length} scanned pages`;
  const byUrl = pagesByUrl(scan);
  const labelled = urls.map((u) => `#${byUrl.get(u)?.index ?? '?'} ${shortUrl(u)}`);
  return `pages (${urls.length}): ${listLimited(labelled, MAX_PAGES_LISTED)}`;
}

/** Lines resolving every SRC ID named anywhere in `text` to ID, title and URL from sources.md. */
export function sourceLines(text, sources) {
  return sourceIdsIn(text).map((id) => {
    const s = sources.get(id);
    return s ? `  ${s.id}: ${s.title} <${s.url}>` : `  ${id}: not found in sources.md`;
  });
}

function entryBlock(id, checklistMd, sources) {
  const entry = checklistEntry(checklistMd, id) ?? manualCheckRow(checklistMd, id);
  if (!entry) return [`checklist entry: no entry for ${id} in references/checklist.md (unknown ID)`];
  return ['checklist entry (verbatim):', entry, 'sources named in this entry:', ...sourceLines(entry, sources)];
}

function findingBlock(finding, no, ctx, shownIds) {
  const shots = findingScreenshots(finding, ctx.scan);
  const lines = [
    `--- F${no} ${finding.check} [${finding.status}] ${finding.title}`,
    pagesLine(finding, ctx.scan),
    `evidence: ${clip(JSON.stringify(finding.evidence ?? {}), MAX_EVIDENCE_CHARS)}`,
    `screenshots: ${listLimited(shots, MAX_SCREENSHOTS) || 'none'}`,
  ];
  if (shownIds.has(finding.check)) {
    lines.push(`checklist entry: printed at F${shownIds.get(finding.check)}`);
  } else {
    shownIds.set(finding.check, no);
    lines.push(...entryBlock(finding.check, ctx.checklist, ctx.sources));
  }
  return lines;
}

/** Findings block as an array of lines; `ok` findings only as short lines at the end. */
export function findingsLines(findings, scan, refs) {
  const ctx = { scan, checklist: refs.checklist, sources: parseSources(refs.sources) };
  const open = findings.filter((f) => f.status !== 'ok');
  const ok = findings.filter((f) => f.status === 'ok');
  const shownIds = new Map();
  const lines = [`=== FINDINGS (${open.length} candidates to verify, ${ok.length} ok) ===`];
  open.forEach((f, i) => lines.push(...findingBlock(f, i + 1, ctx, shownIds)));
  lines.push('--- ok findings');
  lines.push(...ok.map((f) => `ok ${f.check}: ${f.title}`));
  return lines;
}
