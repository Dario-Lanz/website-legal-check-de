# report.json

Input for `scripts/build-reports.mjs`, which builds the requested PDFs and the prompt text file from it. It lives in `<run folder>/daten/report.json`; figure and mock-up paths are relative to `daten/`. All text is German, plain text (no HTML; the builder escapes everything). File paths are relative to the output folder. Findings may be listed in any order; the builder sorts them by `prio` and numbers them 1..n, so short and long report share one order.

**How it is created:** `scripts/report-skeleton.mjs --run "<run folder>" --lang <code>` (workflow step 4) writes the file with the mechanical fields filled: `language`, `platform`, `site`, `date` and `time` (Europe/Berlin; left out if the scan time is unreadable), `pagesScanned`, `checklistStatus` (status date of `references/checklist.md`), `scanNotes`, and one finding per non-`ok` candidate with `check`, the empty judgement fields, `sources` (title and URL of the sources on the checklist entry's Help line, `use` and `retrieved` empty) and four hints that the build ignores: `pages` (paths concerned, a hint for `where`), `scannerStatus` (`gap` or `hint`, a hint for `kind`), `figureCandidates` (screenshot paths ranked by relevance to the check, a hint for `figures`) and `abmahnungHint` (the checklist line "Common reason for a warning letter" when it is not an unqualified yes). `abmahnung: true` is prefilled only for an unqualified yes. `prio`, `kind`, `title`, `summary`, `plain`, `what`, `where`, `law`, `fix`, `evidence`, the `use` and `retrieved` of each source, and every caption of `figures` must be filled by hand (the build rejects the file otherwise, decision 98a); `okChecks`, `assumptions`, `manualChecks`, `dropped` and `upcoming` start empty. Delete the four hint fields when you are done. `scripts/check-sources.mjs --write` (step 5) sets `retrieved` on reachable sources and clears it on unreachable ones.

```json
{
  "language": "de",
  "platform": { "name": "WordPress", "confidence": "high", "evidence": ["…"], "extras": ["WooCommerce"] },
  "site": "xyz.de",
  "date": "07.11.2026",
  "time": "14:35",
  "pagesScanned": 18,
  "checklistStatus": "07.11.2026",
  "findings": [
    {
      "check": "TDD-01",
      "prio": 1,
      "kind": "gap",
      "abmahnung": true,
      "title": "Google Analytics ohne Einwilligung",
      "summary": "One or two plain sentences for laypeople: what happens on the site and why it matters.",
      "plain": { "where": "Plain explanation of the location", "law": "What this law requires, in everyday words", "evidence": "What was observed, in everyday words" },
      "what": "One sentence for the short report: what is missing.",
      "where": "Alle Seiten | /pfad/",
      "law": "§ 25 Abs. 1 TDDDG",
      "fix": "One sentence for the short report: how to fix it.",
      "evidence": "What was observed (requests, cookies, texts).",
      "figures": [{ "src": "belege/seite-01-ansicht.jpg", "caption": "…" }],
      "steps": ["Step 1", "Step 2"],
      "draft": "Text draft with [Platzhaltern] or null",
      "mockup": { "file": "20261107_01_v1_Mockup-Cookieabfrage.html", "description": "…" },
      "sources": [{ "title": "§ 25 TDDDG", "url": "https://…", "use": "what it helps with", "retrieved": "07.11.2026" }],
      "aiTask": "Optional: precise instruction for an AI coding agent (where in the code, what to change).",
      "done": ["Checkable criterion, e.g. no request to fonts.googleapis.com on first load"]
    }
  ],
  "assumptions": [{ "question": "Verkauf an Verbraucher?", "assumption": "Ja.", "evidence": "…", "consequence": "…" }],
  "manualChecks": [{ "question": "…", "law": "Art. 28 DSGVO" }],
  "okChecks": ["Checked without finding, one line each"],
  "dropped": ["Check ID: why the automatic hit was discarded"],
  "scanNotes": ["Deep check decision, skipped or unreachable pages"],
  "sourceUpdate": {
    "checked": "07.12.2026", "statusBefore": "07.11.2026",
    "changes": [{ "what": "Act, date, what changed", "effect": "Effect on checks and on this report" }],
    "unverified": ["What could not be confirmed"],
    "todo": ["references/checklist.md, TDD-04: …"]
  },
  "upcoming": [{
    "title": "…", "status": "Vorschlag | beschlossen, gilt ab TT.MM.JJJJ",
    "short": "One line for the short report.", "detail": "Paragraph for the long report.",
    "relevance": "Why it concerns this site.", "sources": [{ "title": "…", "url": "https://…", "use": "…", "retrieved": "…" }]
  }]
}
```

Rules:
- `time`: HH:MM of the scan (the skeleton sets it from `daten/scan.json` in Europe/Berlin time), shown after the date; if missing, taken from `daten/scan.json`.
- `language`: ISO 639-1 code of the document language (question 1a), e.g. `de`, `en`, `fr`. All texts in that language except `draft`, which stays German. For languages other than `de` and `en` the fixed texts come from the translated file passed with `--texts`.
- `platform`: copied from `findings.json` → `siteProfile.platform` by the skeleton; shown on the cover and used in the AI prompt.
- `summary`: shown in the fact sheet of the long report right after the location; written for laypeople (no jargon, no paragraph numbers, say what happens and why it matters). Required (decision 98a).
- `plain`: required (decision 98a): one short everyday-language sentence each for `where`, `law` and `evidence`, shown as a second line in the same row, without a label (the priority row gets its explanation automatically). Name what the law requires, not the paragraph; translate technical evidence (requests, cookie names) into what it means for visitors.
- `steps`: written for laypeople (see SKILL.md step 4); platform-specific only with click paths from `references/platforms.md`.
- `prio`: 1, 2 or 3 per the priority rules in `references/checklist.md`. `kind`: `gap` (Lücke) or `check` (Bitte prüfen).
- `abmahnung`: `true` only if the checklist entry of the duty says it is a common reason for a warning letter.
- `sources`: only sources fetched successfully in this run (`scripts/check-sources.mjs`); `retrieved` (TT.MM.JJJJ) is required for every source of findings and upcoming rules (decision 98a); `url` must start with `https://` or `http://`.
- `figures`: at most one screenshot per finding, only where it proves something visible; `src` and `caption` are required for each entry (decision 98a); the build shrinks it (about 1000 px wide JPEG, cropped to the visible area). `src` lies in `belege/` of this run's `daten/` folder; in reuse mode it may instead point to the `belege/` folder of an earlier run beside it (`../../<earlier run>/daten/belege/<file>`, decision 32a). Any other path, also one that leaves `belege/` by `..` or a symbolic link, is refused.
- `mockup.file`: a mock-up page in `daten/` (must end in `.html` and lie inside `daten/`; rendered into the long report as an image, the page stays for rebuilds). While rendering, the mock-up may load only files inside `daten/` and, in reuse mode, files in `belege/` of an earlier run beside this one (`../../<earlier run>/daten/belege/<file>`); everything else (network, other local files, links leading out) is blocked; omit `mockup` when there is none. `draft`: omit or `null` when no text draft fits.
- `upcoming`: only entries from `references/upcoming.md` that concern this site.
- `aiTask`, `done`: feed the prompt for AI coding agents (long report). Write `done` as checks a coding agent can run itself (requests, cookies, visible texts, labels). Decide technical choices in `aiTask` so the agent needs no follow-up questions; never decide facts only the site owner knows – those stay placeholders. Without `done`, the prompt falls back to "fix reached, observation gone".
- `sourceUpdate`: only when the source update ran (workflow step 1, question U2 = Y); omit otherwise.
