# Decisions

Why things are the way they are. Read this before changing something that looks
odd — most of the odd things are load-bearing.

---

## Contacts are upserted against `ts_dedupe_key`, not email

HubSpot's batch upsert does not support **partial** upserts when `email` is the
`idProperty`. Sending a subset of fields would blank everything not included —
so an import carrying only new show attendance would wipe the contact's company,
phone and consent.

A custom unique property avoids that, and has a second benefit: re-running the
same file is a no-op instead of creating duplicates. Organizers send corrected
rosters routinely, so this matters more than it sounds.

Source: [HubSpot CRM API — Contacts](https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/contacts/guide)

---

## Name + company never merges automatically

There are three match passes: email, phone, then last name + company domain.
The first two merge. The third only flags a suggestion for a human.

A wrong merge is close to unrecoverable — two people's data are now one record
and you cannot tell which field came from whom. "Smith at brakeworld.com" is
right often enough to be useful and wrong often enough to be dangerous.

Related: `companyDomain()` returns `""` for gmail, yahoo and the other free
hosts. Two people at gmail.com are not colleagues, and without this guard every
pair of Smiths on gmail would be flagged.

---

## Free-mail addresses are kept, role inboxes are dropped

`info@`, `sales@`, `noreply@` and friends are rejected at the door — they match
badly on ad platforms and should never enter a nurture.

A personal gmail address is kept. At a trade show, a shop owner's gmail is often
the only address you will get, and it matches on ad platforms perfectly well.

---

## Geo audiences exist because one show is not an audience

Every ad platform enforces a floor, measured in **matched** users:

| Platform | Minimum | Notes |
| --- | --- | --- |
| Google Customer Match | 100 per file; 5,000+ recommended | Below that, reach is negligible |
| Meta customer list | 1,000 matched | Cannot be targeted below this |
| TikTok customer file | 1,000 rows and 1,000 matched | Both apply |
| LinkedIn | ~300 matched | |

Email-only lists match at roughly 40–60%; email + phone + name reaches 60–75%.
So a strong booth week of 400 sign-ups yields around 200 matched users — below
every floor above.

Geo targeting sidesteps this entirely. Everyone at the show is inside one
building for four days. Target the building for the window and list size stops
mattering — and it works before you have collected a single contact, which a
customer list can never do.

This is why `--type both` is usually the right answer: geo for reach during the
show, the contact list for retargeting after it.

Sources: [Google Ads Customer Match](https://developers.google.com/google-ads/api/docs/remarketing/audience-segments/customer-match/get-started),
[Google list size troubleshooting](https://support.google.com/google-ads/answer/7474166?hl=en),
[TikTok customer file](https://ads.tiktok.com/help/article/how-to-create-a-custom-audience-with-a-customer-file)

---

## The run window is wider than the show

Default is 2 days before and 1 day after. Attendees fly in the day before, and
the lead days let you build frequency before the floor opens — which is when
people decide which booths to visit. Override with `--lead-days` / `--lag-days`.

The presence setting matters as much as the radius. Google's and Meta's defaults
include people merely *interested in* a location, which for Las Vegas means an
enormous irrelevant audience. `tsf show geo` prints the correct setting.

---


## Where booth tablet sign-ups land

There is no single tablet form — one gets cloned per event, so submissions
scatter and carry no show identifier. That is why `shows.json` has a `formIds`
array and why `tsf tablet claim` works off a form plus a date window rather
than off the contact record.

The actual form ids, and the rest of our portal's specifics, are in
`docs/PORTAL-NOTES.md` in the private data repo. `tsf discover forms` finds
them again from scratch.

---

## Sizes are never written by hand

`sizeHistory` is only appended to by `tsf audience refresh`, which reads the
real number from HubSpot. The whole value of the registry is that the numbers
in it were actually measured. One typed-in figure and nobody can trust the rest.

Note that a newly created DYNAMIC list reports 0 until HubSpot finishes
evaluating it. That first 0 is recorded honestly, with a note; refresh a few
minutes later to correct it.

---

## The history log is append-only

`data/history/*.jsonl` is never edited or deleted, including by tooling. A wrong
entry gets a correcting entry appended after it.

If the log can be rewritten, it cannot answer "what did we actually do", which
is the only reason it exists.

---

## What is deliberately not built

- **TikTok sync.** HubSpot reaches Google, Meta and LinkedIn natively — no
  connector code, no token refresh to maintain, nothing to fix when an ad API
  versions. TikTok is the only platform that would need custom code, and it is
  not worth it until a pooled audience reliably clears 1,000 matched users.
- **Campaign creation.** Ben builds paid search and social himself; someone else
  owns email. This tool tracks audiences and records where they are used. The
  `destinations` array is the handoff.
- **A hosted web app.** There is a local UI (`tsf ui`), but it binds to
  localhost and is meant to be run by the person doing the work. Putting contact
  data and a write-capable HubSpot token on a shared server is a different
  project with different security requirements.

---

## Brand separation is enforced in three places, not one

R1 Concepts and Dynamic Friction share a HubSpot portal. They do not share
audiences, and a leak between them is the kind of mistake nobody notices until
a DFC email lands on an R1 customer.

One check would not be enough, so brand is enforced at three levels:

1. **`ts_brand` on the contact**, and every list audience filters on it first.
2. **A brand-scoped dedupe key** — `tsf:dfc:someone@shop.com`. The same person
   can be an R1 contact *and* a DFC contact; they are two records with separate
   consent and engagement history, and merging them would be wrong.
3. **Brand-prefixed audience ids** — `dfc-sema-2026-contacts`. Both brands
   attend the same shows, so unprefixed ids would collide on the same slug.

There is no default brand and no "all brands" option when writing. `--brand` is
required on `import` and on `audience create`, and `requireBrand()` throws with
the valid options rather than guessing. Reading is different — the UI's brand
switch and `--brand` on read commands are filters, and "All" is fine there.

The ids and accent colours are duplicated from
`paid-media-console/src/data/catalog.ts` so the two tools read as one suite.

### HubSpot business units

The portal already has Business Units, and those are the right thing to align
to rather than inventing a parallel field. The ids, and which brand is which,
are in `docs/PORTAL-NOTES.md` in the private data repo — they are our portal's
internals, not something this public repo needs to carry.

`hs_all_assigned_business_unit_ids` ("Brands") is the property that holds them.


---

## The UI is plain HTML with no build step

`tsf ui` starts a small Node HTTP server that serves `ui/` and a JSON API. No
framework, no bundler, no TypeScript. Open `ui/app.js` in any editor and what
you see is what runs — which is the point, because someone else in the org has
to be able to change it.

The whole UI re-renders on every state change. That is slower than a real
framework and much easier to follow, which is the right trade for a tool a few
people run locally.

It binds to `127.0.0.1` only. The tool holds contact data and a HubSpot token
with write access, and neither should be reachable from the network.

Uploads are sent as JSON text rather than multipart, because the browser has
already read the file and a multipart parser would be a dependency for no gain.

---

## The show field is a text box, not a dropdown

A dropdown means: notice the show is missing, leave the upload screen, go to
Shows, add it, come back, re-pick your file. Five steps to type a name you
already knew.

So the field is free text with suggestions. Type anything; if it does not match
an existing show, the date fields appear inline and the show is created when you
run the preview. The preview is the natural commit point — you were going to
press it anyway, and creating a show is a local write to `data/shows.json`, not
a HubSpot one.

Matching is on the show's name or id, case-insensitive. A near-miss creates a
second show rather than guessing, which is the safer failure: a duplicate show
is visible and fixable, a wrongly-merged one is not.

---

## Campaign types are recipes, not campaigns

`src/campaigns.js` holds five named recipes. Each turns one show into one
audience with the window, radius and source filter already decided.

They exist because those decisions are the same every show, and re-deriving them
by hand each time is how you end up with a booth-traffic campaign running a
25-mile radius for three weeks.

What they are **not** is campaign creation. Nothing here calls the Google or
Meta APIs to build a campaign — Ben does that himself. The audience is the
handoff, and it carries the window, the rings and the presence setting.

The two geo recipes are built not to overlap:

| Recipe | Window | Rings |
| --- | --- | --- |
| Pre-show awareness | 5 days before → opening day | campus, metro |
| Booth traffic | the show days | venue |

Pre-show ends the day booth traffic starts. Overlapping them means bidding
against yourself for the same person on the same day.

`lookalike-seed` is `pooled: true`, which means it takes no show filter and
keeps a fixed name. Building one seed per show is exactly the mistake that puts
every audience under the platform floors — see the section above on why one show
is not an audience. Running it for a second show reports "already exists —
reusing it", which is the correct outcome, not an error.

Adding a recipe is data: append to `CAMPAIGN_TYPES`. No logic changes.

---

## Reading whatever the organizer sent

Real exports are not clean CSV. They are `.xlsx` with a logo merged across the
first three rows, a "Report generated 14/10/2026" line, a blank row, and *then*
the headers — in a workbook whose other three sheets are Summary, Legend and
Pivot.

`src/readfile.js` deals with that so nothing downstream has to. It scores each
of the first 25 rows on how much it looks like a header — short cells, mostly
unique, not numeric, and crucially **containing no email address**, because a
header row never does — and picks the best. Then it scores each sheet on
whether it has an email column and how many rows it has, and reads the winner.

It reports what it did (`summary.readNotes`) rather than doing it silently. An
operator who can see "skipped 4 rows, read the Lead Detail sheet" can tell at a
glance whether it guessed right.

`raw: false` on the sheet read is deliberate — it keeps everything as strings so
a phone number does not lose its leading zero to Excel's number coercion.

---

## Column guessing runs two passes, and the second one matters

Pass one matches the header exactly against a list of known names. Pass two
looks for a distinctive keyword inside the header.

The second pass exists because of a bug found during the build: a badge-scan
export used **"Badge Email"**, which matched nothing, so the file imported with
no email addresses at all. The counts looked plausible and the audience was
empty. That is the worst failure mode this tool has — wrong silently — and it
is what `test/mapping.test.js` guards.

The corresponding risk is over-matching, so `NEVER_MATCH` blocks any header
containing opt-out, opt-in, consent, unsubscribe, bounce or verified. "Email
Opt Out" is not the email column, and mapping it would be worse than leaving it
unmapped. Where several headers match, the shortest wins — "Email" beats "Email
Address Confirmed At".

---

## Claude reads the file, but never reads the contacts

The two-pass guesser above only knows headers someone has already taught it.
The whole point of this tool is that anyone can use it, and "anyone" includes
the person who has never seen a column mapping and will not notice that email
came through unmapped.

So when `ANTHROPIC_API_KEY` is set, `src/columnAI.js` asks Claude what the
columns are, and — more usefully — asks it to say so in a sentence:

> Found 2,847 people. I'm using 'Badge Email' for email and 'Cell' for phone,
> and splitting 'Attendee Name' into first and last names.

That sentence is the feature. The mapping table underneath is now something you
glance at to confirm, rather than something you have to fill in.

### What is actually sent

Not the file. For each column, Claude gets:

- the header
- how full it is (`75% filled`)
- how varied it is (`100% distinct`)
- what the values look like as patterns (`100% email`, `94% phoneish`)
- three **masked** examples — `d***@b***.com`, `########84`, `D*** W****`

Nothing identifying survives the masking, and it turns out Claude maps just as
well from the shape as from the values. `test/columnAI.test.js` asserts that
real names, domains and phone digits cannot appear in the payload; those are
the important tests in this repo, and a failing one is never fixed by
loosening the assertion.

### It is optional, and failure is not fatal

No key means the rule-based guesser runs alone, exactly as before. An API error
means the same, with a note in the UI saying so. An upload must never be
blocked by a network call — the rules got this far without one.

Claude's answer is also checked rather than trusted: any header it names that
is not actually in the file is discarded, and the operator sees the result
before anything reaches HubSpot.

### One name column

The most common thing the rules could not do is split `Attendee Name` into a
first and a last. That is now a real field (`fullName`) rather than an
AI-only trick, so it works with or without a key. It only ever fills gaps — a
file with proper First/Last columns keeps them, because a split is a guess and
a column is not.

---

## Several files are one batch

A show arrives as three or four files: pre-show roster, badge retrieval export,
tablet export, post-show roster. They share a brand and a show but not a source
or a column layout, so the batch carries one brand and one show while each file
keeps its own source and mapping.

The source is guessed from the filename (`badge`, `tablet`, `pre`, `post`) and
shown for the operator to correct. It is a time-saver, never a decision.

**Cross-file deduplication is done at the batch level.** Each file is deduped on
its own, so without it the preview double-counts someone who is on the roster
*and* scanned their badge. The commit was always right — the upsert key
collapses them — but the preview was not, and a preview whose numbers are wrong
is worse than no preview. The overlap is surfaced rather than hidden, because a
contact with both `roster_pre` and `badge_scan` on it is the highest-intent
record a show produces.

One bad file does not stop the batch; it is reported and the rest still run.

---

## Meta campaigns say which show they belong to, in their name

Campaigns and ad sets for this program are built per event, so the show id goes
in the name as a tag:

```
DFC | SEMA 2026 | Booth traffic [tsf:sema-2026/booth-traffic]
```

Everything before the bracket is whatever Meta naming convention you like; the
tool only reads the tag. `tsf show meta-names --id <show> --brand <brand>`
prints the names to paste in.

A tag rather than matching on the show name, because names get abbreviated,
edited and typo'd, and "SEMA" appears in things that have nothing to do with
the show — `Sema Data Prospects` is the SEMA Data Co-op, not the trade show.
Matching on that would have put 3,000 product-data prospects into a show report.

A tag naming a **different** show is a definite exclusion, whatever else about
the ad set looks like a match. That is the one rule that makes the tag
trustworthy.

There are three weaker fallbacks for ad sets that predate the convention:
a Meta id recorded against the audience, an ad set that targets one of our
synced HubSpot audiences (`HubSpot - <list name>`), and the venue city. The
report always says which one fired, and nudges you to add a tag when anything
matched without one — a number nobody can trace is worse than a gap.

---

## Report numbers are escaped, because the naming convention uses pipes

`AD | General | Video` turned a six-column markdown table into eight columns.
Every value from Meta or HubSpot goes through `cell()` in `src/markdown.js`,
which escapes pipes and collapses newlines.

Found by running the report against the live account rather than a fixture,
which is the argument for doing that.

---

## The report degrades rather than fails

No Meta token means a report with no paid social section, not an error. A dead
integration reports itself in a "Gaps in this report" section and the rest still
renders. A partial report is useful; a crashed one is not, and the person
running it before a management meeting cannot debug an API.

Each empty section says *why* it is empty — "no audience here has a HubSpot
list, so no email can be attributed to it" rather than a silent zero. A zero
that means "nothing happened" and a zero that means "I could not look" are very
different numbers to put in front of management.

---

## Reach is not summed

Spend, impressions and clicks add up across ads. Reach does not — the same
person sees more than one ad, and adding it would overstate. The report shows
the largest single figure and says so.

---

## The code is public; the numbers are not

`tradeshow-funnel` is a public repo. `tradeshow-funnel-data` is private and
holds the registry — shows, audiences, sizes, history, spend.

The code being public is harmless and arguably useful. The numbers are not:
audience sizes, contact counts per show, ad spend and which shows we target are
all worth something to a competitor, and `docs/` explains the whole approach.

This mirrors the split already working here — `dfc-territory-map` is a public
repo serving an encrypted page, `dfc-territory-data` is private and holds the
83k-shop database behind it.

`data/` and `AUDIENCES.md` were removed from this repo's **history**, not just
its tip, and force-pushed. A fresh clone was checked afterwards to confirm.

**Neither repo holds contact records.** The history log records counts —
`created: 2611, rejected: 214` — never rows. Rejected rows land next to the
input file and are gitignored; export bundles likewise. Contacts belong in
HubSpot, behind a HubSpot login.

`tsf doctor` exists because the failure mode here is quiet: with `TSF_DATA_DIR`
unset the tool happily writes to a gitignored `./data`, and everything appears
to work while being invisible to everyone else and backed up nowhere.
