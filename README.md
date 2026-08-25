# tradeshow-funnel

Takes trade show contacts into HubSpot, and keeps a permanent record of every
audience built from them.

The record is the point. Anyone can build a list; six months later nobody can
say what it was, how big it got, or where it was used. This keeps that.

---

**Doing this for a show right now?** Read [RUNBOOK.md](RUNBOOK.md) — it is the
step-by-step from a list landing in your inbox to campaigns being ready. This
file is about how the thing works.

---

## Quick start

```bash
npm install
cp .env.example .env    # then fill it in
node bin/tsf.js ui
```

That opens the web interface at http://localhost:4477. It lands on **Upload**,
because that is the job: drop a list, say which brand and show it belongs to,
check the preview, commit, then pick which campaigns to build for that show.

Everything the UI does is also on the command line; `tsf` with no arguments
prints the list.

```bash
npm run tsf -- audience list
```

Or add `bin/tsf.js` to your PATH and just type `tsf`.

---

## The upload flow

1. **Drop the files.** Excel or CSV, several at once. A show usually arrives as
   three or four files — pre-show roster, badge scans, tablet export — and they
   go in as one batch. Each keeps its own source and its own column mapping.
2. **Brand and show.** The show field is a text box, not a dropdown — type any
   name. If it does not exist yet, the dates appear right there and the show is
   created when you run the preview. You never leave this screen.
3. **Check the mapping.** One tab per file. Fix anything the guess got wrong.
4. **Preview, then commit.** Nothing reaches HubSpot until Commit. The preview
   shows created / updated / merged / rejected, with the reason for every
   rejected row.
5. **Build campaigns.** Once the list is in, pick what to run for that show.

---

## Campaign types

Step 5 is the point of the whole thing: the list is loaded, so what do you run?
Each type is a recipe with the window, radius and source filter already decided,
so you are not re-making those calls every show.

| Type | Kind | What it does |
| --- | --- | --- |
| **Pre-show awareness** | geo | Campus and metro rings, the 5 days up to opening. Reaches people while they are deciding which booths are worth their time. |
| **Booth traffic** | geo | Venue ring only, the show days. Highest intent, and it does not care how many contacts you have. |
| **Post-show retargeting** | list | Everyone the show produced, any source. |
| **Booth-engaged nurture** | list | Only tablet and badge-scan — the people who actually stopped. Best segment for email. |
| **Lookalike seed** | list | The rolling pool across every show. Reused, never recreated per show, because that is what clears the platform floors. |

The two geo windows are built not to overlap: pre-show ends the day booth
traffic starts, so you are never bidding against yourself.

Each one creates an **audience**. You build the campaign itself in Google or
Meta — the audience carries the window, the radius and the presence setting.

```bash
tsf campaign types
tsf campaign create --brand dfc --show sema-2026 --all
tsf campaign create --brand dfc --show sema-2026 --types pre-show,booth-traffic --commit
```

---

## What it does with a real organizer file

Organizer exports are not clean CSV, so the reader deals with the mess rather
than making you do it:

- **Excel and CSV.** `.xlsx`, `.xlsm`, `.xls`, `.csv`, `.tsv`.
- **Junk above the header.** A logo row, a "Report generated…" line and a blank
  row get skipped — it finds the real header row and says how many it skipped.
- **Multi-sheet workbooks.** Picks the sheet with the contacts in it, not
  "Summary" or "Legend", and tells you which one it read.
- **Header names it has never seen.** "Badge Email", "Given Name", "Cell" and
  "Organization" all map correctly, while "Email Opt Out" is deliberately left
  alone.
- **The same person in two files.** Someone on the pre-show roster who also
  scanned their badge is counted once, and flagged — that overlap is the
  strongest signal a show produces.

---

## Two brands, kept apart

R1 Concepts and Dynamic Friction share a HubSpot portal but **not** their
audiences. Brand is required on every import and every audience — there is no
default and no "all brands" option when writing, only when looking.

Three things enforce it:

- Contacts carry `ts_brand`, and every list audience filters on it first.
- The dedupe key is brand-scoped (`tsf:dfc:someone@shop.com`), so the same
  person can be an R1 contact *and* a DFC contact without the two records
  merging into one.
- Audience ids are brand-prefixed (`dfc-sema-2026-contacts`), because both
  brands attend the same shows and would otherwise collide.

In the UI, the brand switch in the top right filters everything and recolours
the accent, so it is obvious at a glance which brand you are looking at. Brands
live in `data/brands.json`.

```bash
tsf brands
tsf audience list --brand dfc
tsf import --file roster.csv --brand r1 --show sema-2026 --source roster_pre
```

---

## The first run, in order

```bash
tsf setup --commit
```

Creates the `ts_*` contact properties in HubSpot. Run once per portal. Safe to
re-run — existing properties are left alone. Drop `--commit` to preview.

```bash
tsf show add --name "SEMA 2026" --start 2026-11-03 --end 2026-11-06 --city "Las Vegas, NV"
tsf show research --id sema-2026 --venue "Las Vegas Convention Center, Las Vegas, NV"
```

`show research` geocodes the venue so you can geo-target it. It prints the full
targeting spec — radius rings, run window, and the presence setting that people
get wrong.

```bash
tsf import --file roster.csv --brand dfc --show sema-2026 --source roster_pre
```

Previews. Nothing is written. Check the numbers, then re-run with `--commit`.

```bash
tsf audience create --type both --brand dfc --show sema-2026 --commit
tsf report
```

---

## The two kinds of audience

You get a choice, and usually you want both.

**`--type list`** — the people you collected. Syncs to ad platforms as a
customer list, and drives email. Subject to platform minimums, which a single
show often will not clear: Meta needs 1,000 *matched* users, and an email-only
list matches at roughly 40–60%. A 400-person booth list reaches about 200
people and will not deliver.

**`--type geo`** — the show itself: a venue, a radius, and a date window. No
contact data, no minimum, and it works *before* you have collected anyone.
Everyone at the show is in one building for four days; this reaches all of
them. Needs `tsf show research` to have run first.

**`--type both`** — creates one of each. Geo carries reach during the show,
the contact list carries retargeting after it.

`tsf audience show --id <id>` prints a readiness check against each platform's
floor, and tells you to go geo if the list is too small.

---

## What gets recorded, and where

| File | What it is | Editable? |
| --- | --- | --- |
| `AUDIENCES.md` | Generated summary of everything. Start here. | No — regenerated by `tsf report` |
| `data/audiences/*.json` | One file per audience, with full size history | Prefer `tsf` commands |
| `data/history/*.jsonl` | Append-only log of every event | **Never** — append only |
| `data/shows.json` | Shows, dates, venue coordinates, linked form IDs | Yes |
| `data/mappings.json` | Saved column mappings per organizer | Yes |

Sizes are only ever written by `tsf audience refresh`, which reads them from
HubSpot. A number nobody measured does not go in the file.

---

## Where the code lives

Plain JavaScript, no build step, one real dependency (`csv-parse`). Every file
opens with a comment saying what it does and when you would edit it.

| File | What it does |
| --- | --- |
| `bin/tsf.js` | The CLI. Argument parsing and printing only. |
| `src/config.js` | Paths and credentials. |
| `src/hubspot.js` | Every HubSpot call, with auth and retries. |
| `src/registry.js` | **The core.** Audience records and the history log. |
| `src/audiences.js` | Creating audiences; platform floors; readiness. |
| `src/geo.js` | Venue lookup, radius rings, run windows. |
| `src/readfile.js` | Reads .xlsx and .csv, finds the header row, picks the sheet. |
| `src/campaigns.js` | The campaign recipes. Add a new one here — it is all data. |
| `src/ingest.js` | CSV in, contacts out. |
| `src/normalize.js` | Cleaning emails, phones, names. Pure functions. |
| `src/merge.js` | Duplicate matching and which value wins. |
| `src/setup.js` | The HubSpot properties this tool needs. |
| `src/report.js` | Generates `AUDIENCES.md`. |
| `src/brands.js` | R1 and DFC, and the rules that keep them apart. |
| `src/server.js` | The local web UI's HTTP server and JSON API. |
| `ui/` | The web interface — plain HTML, CSS and JS. No build step. |

```bash
npm test
```

Tests cover the cleaning and merge logic — the parts where a mistake is
expensive and silent. They need no credentials and no network.

---

## Adding a show that uses a format we have not seen

Column mapping is guessed from the header row. If an organizer uses a name we
do not recognise, either add it to `COLUMN_GUESSES` in `src/ingest.js`, or map
it once and save the profile:

```bash
tsf import --file weird.csv --brand dfc --show sema-2026 --source roster_pre --save-profile "informa"
tsf import --file next-year.csv --brand dfc --show sema-2027 --source roster_pre --profile "informa"
```

---

## Known state

- `data/shows.json` contains **SEMA 2026 with placeholder dates** (2026-11-03 →
  2026-11-06) added while building this. Confirm the real dates before using it.
  The venue coordinates are real.
- The HubSpot properties have **not** been created yet — `tsf setup --commit` is
  yours to run against the live portal.
- **R1's HubSpot business unit id is unknown** and is `null` in
  `data/brands.json`. Dynamic Friction is 311464 and Drilled Rotors is 311463;
  R1 is the root unit and reading its id needs a scope this app does not have.
  Nothing breaks without it — the tool just cannot stamp HubSpot's own "Brands"
  field for R1.
- No list audience has been created yet, for the same reason.
- TikTok has no connector. HubSpot syncs Google, Meta and LinkedIn natively;
  TikTok is the only platform that would need custom code, and it is not built.

See `docs/DECISIONS.md` for why things are the way they are.
