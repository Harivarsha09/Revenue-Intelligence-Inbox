# Revenue Intelligence Inbox

A working workspace for a sales manager: dashboard, routing with manual correction, organised exports, and repeat-safe imports. **Zero dependencies** - only Node.js 18+ (no `npm install`).

## Run it in VS Code
1. Unzip, then **File > Open Folder** on `revenue-inbox`.
2. Open the terminal (**Ctrl+`**) and run:
```
node -v          # must print v18 or higher
npm start        # same as: node server.js
```
3. Open http://localhost:3000. Press **Imports & export > Load demo (both batches)** for the final post-update state, or follow the replay below. (Other port: `PORT=4000 npm start`; on Windows PowerShell: `$env:PORT=4000; npm start`.)

Other commands: `npm run replay` (runs the whole replay contract with assertions, writes `exports/current/` and `docs/replay-report.txt`), `npm run reset` (clean start), `npm run seal` (re-bind analyses to source text after editing `analysis/analysis.src.json`).

## Reproduce the replay steps (UI)
Imports & export tab, after **Reset**: 1) *Import initial* (44 records, 17 texts) 2) *Import initial (shuffled order)* (0 added, 44 ignored) 3) Inbox > **M07** > tick routes (e.g. Customer issues + Internal) > *Save manual route* 4) *Import update* (1 replaced, still 44, 18 texts, M07 text appears, manual route stays) 5) *Import initial* again (44 ignored, M07 still revision 2) 6) refresh the browser or stop/restart the server: state is in `state/state.json`. Or run `npm run replay`.

## Where outputs are written
`exports/current/` (button **Write export folder + manifest**, or **Download ZIP**). Regenerated from state each time, so a changed route never leaves an obsolete active file. `manifest.json` and `manifest.csv` list per record: source type/id, applied revision, suggested and active routes, manual-override flag, review state, analysis freshness, output paths (relative; all exist). A pre-built sample from the replay is already in `exports/current/`. Structure: `routes/<route>/<ref>__<id8>__<kind>.md` (one file per active route, cross-linked), `records/<ref>__<id8>.json` (full context), `routes/log/intake-log.csv`, `daily/2026-08-21/`.

## Metric definitions (also in the app: Definitions tab)
- **Selected records**: distinct (source_type, source_id) after revisions. A selected sample, not a team day.
- **Usable text coverage**: nonblank call transcripts + meetings with at least one nonblank turn, over selected records in the filter (18/44 = 40.9% after update; 17/44 before).
- **Source-reported connection rate**: calls with is_connected=true over calls with non-null is_connected (11/30 = 36.7%, unknown 0). A stored label; the transcript-based check (8 of 10 transcribed calls were two-way conversations; source says 9) is shown separately.
- **Route assignments** (53) exceed unique records (44) because a conversation can have several routes.
- Call reps (rep_email) and meeting organisers (organizer_email) are separate roles; an organiser is not assumed to be a salesperson.

## Pre-generated vs computed
Pre-generated (AI-assisted, then human-reviewable): the 18 analyses and the 21 Aug brief wording in `analysis/analysis.src.json`. Each analysis is bound to the SHA of the source text it was written from; if the text changes, it is shown as **stale** and the record goes to review. Computed at runtime: import/revision logic, usable-text flags, freshness, rule-based routes for text-less records, repeat-counterparty detection, all metrics, live evidence verification, exports.

## Three findings (evidence -> where it affected the product)
1. **Stored `follow_up`/`referred` labels overstate intent.** C10 "No. I said I will contact you if there is anything to discuss."; C09 "No, please don't use my name."; C05 "If we ever decide to change the providers we already have, we could consider it then." -> Source-label check panel, *Labels challenged* tile, Deal-route next steps.
2. **Prepaid vs credit is a repeat surprise.** M03 turn 6; M04 turn 11 -> coaching points, M03/M04 routes, brief coaching item 1.
3. **Dated customer promises outrank prospect chasing.** M09 turns 21-22; M07 turn 19 -> Manager brief follow-up priorities 1-2, Customer-issues route.
Also: C02 `is_conversation=true` is a receptionist transfer; six text-less calls share counterparty PHONE-003 within ~6 minutes (shown as one exception).

## One rejected decision
Auto-merge records into account folders by company name (e.g. M04 + M13 "Cedarwave Distribution"). Rejected: only a *proposed* association is supported by the data contract. Trade-off: outputs are per record; the drawer shows a "proposed related record" note instead.

## Limits
No runtime AI; no deletion events; local single-user JSON state; owners shown only as stated speaker labels (e.g. "Team member A"); the dataset is private - do not publish it. Hosting: `node server.js` works on any Node host (Render, Railway, Fly); set `PORT`; free-tier disks reset, so use *Load demo*. Keep the link private.

Approximate time spent: **[fill in your own hours]**. 
