# Answering questions about audiences

This file is for Claude. If you are a person, read `README.md` instead.

## What this repo is

A tool that takes trade show contacts into HubSpot and keeps a permanent record
of every audience built from them. The point of the record is that someone can
ask, months later, what was built and how it performed — and get a real answer
rather than a guess.

## Where to look, in order

1. **`AUDIENCES.md`** — start here for almost any question. It is generated from
   the data below and holds the summary table, per-audience detail, the shows,
   and the last 60 activity entries. It is usually enough on its own.
2. **`data/audiences/*.json`** — one file per audience, full current state
   including the complete `sizeHistory` (AUDIENCES.md only shows a trend).
3. **`data/history/YYYY-MM.jsonl`** — the append-only log, one JSON object per
   line. Every event ever. Use this for "what happened in March" or "who
   changed this".
4. **`data/shows.json`** — shows, their dates, and their venue coordinates.

`AUDIENCES.md` can be stale if someone changed data without running
`tsf report`. If a question turns on exact numbers, read the JSON.

## Reading files

`src/readfile.js` handles what organizers actually send: Excel workbooks with
junk rows above the header and several sheets. It reports which sheet it read
and how many rows it skipped, in `summary.readNotes`.

Column guessing is two passes — exact header match, then a keyword pass so
"Badge Email" still maps. Anything matching opt-out / consent / unsubscribe is
never mapped, because mapping it would be worse than mapping nothing.

## Brands come first

Every audience belongs to **one** brand: `r1` (R1 Concepts) or `dfc` (Dynamic
Friction Company). They share a HubSpot portal but not their audiences.

When someone asks about "our audiences", ask which brand — or answer for both,
clearly separated. **Never sum across brands**, and never present a combined
figure as if it were one audience. Brand definitions are in `data/brands.json`.

History entries carry a `brand` field. Entries without one (a show being added,
a venue researched) are portfolio-level and apply to both.

## Audiences come from campaign types

Most audiences are built by a **campaign type** — a recipe in `src/campaigns.js`
that fixes the window, radius and source filter. The `purpose` field on an
audience is the recipe's summary, so it usually says which one made it.

The recipes are `pre-show`, `booth-traffic`, `post-show-retarget`,
`booth-engaged` and `lookalike-seed`. If asked what something is for, quote the
purpose rather than guessing from the name.

`lookalike-seed` is pooled: one audience per brand across every show, named
"Trade Show Universe". It is deliberately not per-show — a single show does not
clear the platform floors.

## The two kinds of audience

Check the `type` field before answering — they are not comparable.

- **`list`** — people we hold contact details for. Has a `hubspotListId` and a
  real `sizeHistory` in contacts. Subject to platform minimums.
- **`geo`** — a place and a date window, in `definition.geo`. No contacts, no
  size, no minimum. "How big is it" is not a meaningful question; "when does it
  run and what radius" is.

Never sum a geo audience's "size" with a list audience's. Never add two list
audiences together either — they overlap, because the same person attends more
than one show.

## Common questions and how to answer them

**"What audiences do we have?"**
Read `AUDIENCES.md`, summary table. Group by brand. Give type, current size or
run window, and where each is being used.

**"How big is the SEMA audience?"**
Read `data/audiences/<id>.json`, take the last entry in `sizeHistory`. Say when
it was measured — a size from three months ago is not a current answer. If the
audience is `geo`, say so and give the window instead.

**"Did it grow after the show?"**
The full `sizeHistory` array, with the `note` on each entry. Report the deltas.

**"Where is this audience being used?"**
The `destinations` array. `status` is one of planned, live, paused, removed.

**"Why isn't this delivering?"**
Most likely below a platform floor. Run `tsf audience show --id <id>` — it
prints a readiness check against each platform's minimum, using an assumed
match rate. Floors and match rates are in `src/audiences.js`.

**"What did we do for AAPEX last year?"**
`tsf history --since 2025-01-01` or read the relevant `data/history/*.jsonl`
directly. Filter by `audienceId` for one audience's whole story.

**"Which shows produced the most contacts?"**
`import.committed` entries in the history log carry `showId`, `created` and
`updated` counts per run. Sum by `showId`. Say plainly that this counts import
rows, not attributed revenue.

## Rules when writing to this repo

- **Never edit `AUDIENCES.md`.** It is overwritten by `tsf report`.
- **Never edit or delete a line in `data/history/*.jsonl`.** It is append-only.
  A wrong entry gets a correcting entry appended after it, not a rewrite.
- **Never hand-edit `sizeHistory`.** Sizes come from HubSpot via
  `tsf audience refresh`. A number nobody measured is worse than no number.
- Prefer running a `tsf` command over editing JSON directly, so the action is
  logged with an actor and a timestamp.

## Things that are true and worth stating when relevant

- A single show rarely clears the ad platform floors. Meta needs 1,000 *matched*
  users; email-only lists match at roughly 40–60%. That is why geo audiences
  exist and why list audiences pool across shows.
- Contacts are upserted against `ts_dedupe_key`, not email. HubSpot cannot do
  partial upserts on email — it would blank any field not sent.
- The tablet form in HubSpot has historically been cloned per event, which is
  why nobody could say where sign-ups landed. `data/shows.json` has a `formIds`
  array to tie clones back to a show. See `docs/DECISIONS.md`.
