# Run options

Branches of the workflow that only apply to some checks. `SKILL.md` says when to read each section; read only the section that applies.

## More than five websites (workflow step 0)

**More than five websites:** ask questions 1 and 1a (dialogue and document language) once for all websites (decision 42a). Then ask: `Sollen alle Websites gleich untersucht werden? (Y/N)` – English: `Should all websites be checked the same way? (Y/N)`. With Y, ask questions 1b–6 once, phrased for all websites (`Frühere Scans wiederverwenden, wo vorhanden? (…) (Y/N)` only if at least one website has one, `PDF Kurzfassung für alle Websites gewünscht? (Y/N)`, `PDF Langfassung für alle Websites gewünscht? (Y/N)`, `Uhrzeit der Prüfung in allen Dokumenten angeben? (Y/N)`, `Wurden alle Websites mit KI (Vibe-Coding) erstellt? (Y/N, U = unbekannt)`, `Den Prompt zur Behebung mit KI für alle Websites zusätzlich als Textdatei (.txt) speichern? (Y/N)`, `Mock-ups für alle Websites mit erstellen? (…) (Y/N)`; English: `… for all websites …`) and apply the answers to every website. With N, ask questions 1b–6 for each website in turn; the languages chosen once stay valid for all websites (user decision). With five or fewer websites, ask all questions (1–6 with 1a, 1b only when an earlier scan exists) per website.

## Reusing an earlier scan (question 1b = Y; workflow steps 3 and 4)

Step 3, scan command:

If question 1b was answered Y, add `--reuse "<earlier run folder>"`: the scan then re-checks every page of the earlier scan quickly (no photos, no accessibility test), takes unchanged pages over with their data and evidence photos, and scans changed or previously failed pages fully again (`scan.json` → `reuse` lists both); the sitemap pass is skipped. Mention the reuse and the date of the earlier scan in `scanNotes`. Unchanged pages keep their evidence photos in the earlier folder: their paths in `scan.json` point there (`../../<earlier run>/daten/belege/…`); nothing is copied (decision 32a).

Step 4, verification:

- **With a reused scan (token saving):** read the earlier `daten/report.json`. A finding whose check ID, status, title and affected pages are unchanged and that concerns only unchanged pages is taken over as verified, including its texts, figures (rewrite their paths to the earlier folder, `../../<earlier run>/daten/belege/…`) and sources; do not open its screenshots again. Sources fetched on the same day may be reused; older ones are fetched again (step 5). Verify only new or changed findings and open only photos of changed pages. Note the takeover in `scanNotes`.

The skeleton from step 4 is written as usual; copy the taken-over findings from the earlier `report.json` into it.

## Other document language (question 1a not G or E; workflow step 7)

**Other document language (question 1a not G or E):** create the template with `node "<skill folder>/scripts/translation.mjs" --template "<run folder>/daten/texte-vorlage.json"`, translate every string into the document language and save it as `daten/texte-<code>.json` (keep `{placeholders}`, `[[ ]]` markers, HTML tags, Markdown and German legal terms in quotes; set `lang` and `languageName`; translate the `abbreviations` values too). Check it with `node "<skill folder>/scripts/translation.mjs" --check "<file>"` and fix every reported point until it prints `ok`. Then add `--texts "<file>"` to the build command.
