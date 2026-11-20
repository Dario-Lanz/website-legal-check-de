// Report skeleton: everything in report.json that follows mechanically from the scan, the
// candidate findings and the reference files. Judgement fields stay empty or missing, so
// the validation in scripts/lib/report/model.mjs rejects the file until Claude fills them.

import { berlinDateTime } from './berlin-time.mjs';
import { candidateScreenshots, pagesByUrl } from './evidence/findings-view.mjs';
import { shortUrl } from './evidence/format.mjs';
import { checklistEntry, checklistStatusDate, helpSourceIds, parseSources, warningLetterLine } from './evidence/markdown.mjs';

const MAX_FIGURE_CANDIDATES = 3;
const MAX_PAGES_LISTED = 10;
const LANGUAGE = /^[a-z]{2}$/;

/** Site name as the existing reports show it: start URL without scheme, a bare "/" path dropped. */
export function siteName(startUrl) {
  const u = new URL(startUrl);
  return `${u.host}${u.pathname === '/' ? '' : u.pathname}${u.search}`;
}

function pathsOf(finding, scan) {
  const byUrl = pagesByUrl(scan);
  const paths = [...new Set((finding.pages ?? []).map((url) => shortUrl(byUrl.get(url)?.finalUrl ?? url)))];
  if (paths.length <= MAX_PAGES_LISTED) return paths;
  return [...paths.slice(0, MAX_PAGES_LISTED), `(+${paths.length - MAX_PAGES_LISTED} more pages)`];
}

function sourcesFor(entry, sources) {
  return helpSourceIds(entry ?? '').flatMap((id) => {
    const s = sources.get(id);
    return s ? [{ title: s.title, url: s.url, use: '', retrieved: '' }] : [];
  });
}

const UNQUALIFIED_YES = /^yes\.?$/i;

/** `abmahnung: true` only for an unqualified yes; any other checklist line is handed over as a hint for Claude to judge. */
function warningLetterFields(entry) {
  const line = entry ? warningLetterLine(entry) : null;
  if (line !== null && UNQUALIFIED_YES.test(line)) return { abmahnung: true };
  return line === null ? {} : { abmahnungHint: line };
}

function findingSkeleton(f, ctx) {
  const entry = checklistEntry(ctx.checklist, f.check);
  return {
    check: f.check,
    scannerStatus: f.status,
    ...warningLetterFields(entry),
    title: '',
    summary: '',
    what: '',
    where: '',
    law: '',
    fix: '',
    evidence: '',
    pages: pathsOf(f, ctx.scan),
    figureCandidates: candidateScreenshots(f, ctx.scan).slice(0, MAX_FIGURE_CANDIDATES),
    sources: sourcesFor(entry, ctx.sources),
  };
}

/**
 * @param {{scan: object, findings: object}} run parsed scan.json and findings.json
 * @param {{checklist: string, sources: string}} refs reference file texts
 * @param {string} language ISO 639-1 code of the document language
 * @returns {object} report data with the mechanical fields filled
 */
export function buildSkeleton(run, refs, language) {
  if (!LANGUAGE.test(language ?? '')) throw new Error(`--lang needs a two-letter ISO 639-1 code (e.g. de, en, fr), got "${language}"`);
  const { scan, findings } = run;
  const when = berlinDateTime(scan.scannedAt);
  const ctx = { scan, checklist: refs.checklist, sources: parseSources(refs.sources) };
  const open = findings.findings.filter((f) => f.status !== 'ok');
  return {
    language,
    platform: findings.siteProfile?.platform ?? null,
    site: siteName(scan.startUrl),
    ...(when ? { date: when.date, time: when.time } : {}),
    pagesScanned: findings.siteProfile?.pagesScanned ?? scan.pages.length,
    checklistStatus: checklistStatusDate(refs.checklist) ?? '',
    findings: open.map((f) => findingSkeleton(f, ctx)),
    assumptions: [],
    manualChecks: [],
    okChecks: [],
    dropped: [],
    scanNotes: [...(scan.notes ?? [])],
    upcoming: [],
  };
}
