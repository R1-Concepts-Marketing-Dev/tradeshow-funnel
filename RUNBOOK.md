# Runbook

What to do, from a list landing in your inbox to campaigns being ready.

Written for the person doing it, not the person who built it. If something here
does not match what you see on screen, trust the screen and tell Claude.

---

## Before the first show ever — once, then never again

**1. Create the properties in HubSpot.**

```bash
node bin/tsf.js setup --commit
```

Creates 13 `ts_*` contact properties. Takes about ten seconds. **Nothing else in
this tool works until you have run it.** Safe to run again — anything already
there is left alone.

Drop `--commit` first if you want to see what it would do.

**2. Set a marketing-contact ceiling in HubSpot.**

HubSpot → Settings → Contacts → Marketing contacts → set a maximum. This is what
stops a 3,000-row roster from bumping you into the next pricing tier on the 1st
of the month. Two minutes, saves a nasty invoice.

---

## Every show

Start the tool:

```bash
node bin/tsf.js ui
```

It opens at `http://localhost:4477`. Everything below happens there.

### Step 1 — Drop the files

Drag them all in at once. A show usually arrives as three or four:

- the pre-show registrant list from the organizer
- the badge scan / lead retrieval export
- the tablet export
- the post-show list, a week later

Excel or CSV, both fine. It handles the mess — logo rows above the header, a
"Report generated…" line, a workbook where the attendees are on the third sheet.
It will tell you what it skipped.

**What you do:** check the source dropdown on each file. It guesses from the
filename and is usually right, but a file called `export_final_v2.xlsx` will
guess wrong. Getting this right matters — it decides consent status and which
audiences the contact lands in.

### Step 2 — Brand and show

**Brand** — R1 or Dynamic Friction. No default, on purpose. This is the one
field where a mistake is expensive: it is what keeps the two brands' audiences
apart.

**Show** — just type the name. If it already exists it fills in the dates. If it
is new, date fields appear right there and the show gets created when you run
the preview. You never leave this screen.

### Step 3 — Check the columns

One tab per file. It has guessed which column is which; you are confirming.

**Look at the email row.** That is the one that matters. If email is unmapped
and phone is unmapped, that file will reject every row.

Most of the time this step is a two-second glance.

### Step 4 — Preview, then commit

**Preview writes nothing.** Read the numbers:

| What it says | What to think |
| --- | --- |
| **Rows read** | Should roughly match the file. Wildly off means the wrong sheet or header row. |
| **People** | Unique contacts after merging. Lower than rows read is normal. |
| **In 2+ files** | Someone on the roster who also scanned a badge. Good — that is your best segment. |
| **Rejected** | Every one has a reason listed. Usually role inboxes (`info@`, `sales@`) and rows with no email or phone. |

A handful of rejects is normal and healthy. **A lot of rejects means something
is wrong** — usually the email column mapped to the wrong thing. Go back to step
3 rather than committing.

When it looks right, **Commit**. That is the moment anything reaches HubSpot.

Re-running the same file later is safe — it updates rather than duplicating.

### Step 5 — Build campaigns

Once the list is in, pick what to run for that show. Five recipes, each creating
one audience with the window, radius and filters already set:

| | What it is |
| --- | --- |
| **Pre-show awareness** | Geo. Campus + metro rings, the 5 days before opening. |
| **Booth traffic** | Geo. Venue ring only, the show days. |
| **Post-show retargeting** | Everyone the show produced. |
| **Booth-engaged** | Only tablet + badge scan — the people who actually stopped. |
| **Lookalike seed** | The pooled list across every show. Reused, not recreated. |

The two geo ones need the venue looked up first — there is a **Look up venue**
button right on the blocked card. One click, it geocodes it.

Tick what you want, press Create. You then build the actual campaigns in Google
and Meta; each audience carries the window, radius and presence setting for you
to copy.

---

## Booth sign-ups that never came as a file

If people signed up on the tablet and it went straight into HubSpot, there is no
file to drop. Claim them by the show's dates instead:

```bash
node bin/tsf.js tablet claim --brand dfc --show sema-2026
```

It finds submissions to that show's form inside the show window and stamps them
as booth contacts. Add `--commit` when the numbers look right.

**This needs the show's form linked first:**

```bash
node bin/tsf.js discover forms --match "sema"
node bin/tsf.js show link-form --show sema-2026 --form <the-form-id>
```

---

## After the show

**Refresh the sizes.** Press *Refresh sizes* in the top right, or:

```bash
node bin/tsf.js audience refresh --all
```

A new list reads 0 until HubSpot finishes evaluating it, so do this a few
minutes after creating audiences, not immediately.

**Record where you used each audience.** Click an audience → Record destination.
Thirty seconds, and it is what makes "where is this being used" answerable in
six months instead of a guess.

**Commit the repo.**

```bash
git add -A && git commit -m "SEMA 2026 intake" && git push
```

This is your backup, and it is how anyone else sees the current state —
`AUDIENCES.md` renders on GitHub, so they get the whole picture without
installing anything.

---

## When something looks wrong

**Lots of rejected rows** — the email column is probably mapped wrong. Step 3.

**"Show has no venue"** — the geo campaigns need coordinates. Use the *Look up
venue* button, or `tsf show research --id <show> --venue "<venue and city>"`.

**An audience says "below floor"** — too small for that platform to deliver.
Meta needs 1,000 matched users and email-only lists match at about half. Use a
geo campaign for that show, and let the pooled Lookalike Seed do the customer-
list work.

**A list reads 0 right after creating it** — normal. HubSpot is still evaluating
it. Refresh in a few minutes.

**Something wrote the wrong thing** — every contact carries `ts_import_batch`,
and every run is in `data/history/*.jsonl`. Find the batch, and you can find
every record it touched.

---

## Where things live

| | |
| --- | --- |
| `AUDIENCES.md` | The readable summary. Regenerated automatically. |
| `data/audiences/*.json` | One file per audience, full size history. |
| `data/history/*.jsonl` | Every event, append-only. Never edit this. |
| `data/shows.json` | Shows, dates, venues, linked form IDs. |

You can ask Claude anything about these — "how big is the SEMA audience", "what
did we do for AAPEX", "which show produced the most contacts". `CLAUDE.md` tells
it where to look.
