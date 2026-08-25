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

## Where tablet sign-ups actually land (as of Aug 2026)

Nobody could say where the booth tablet submitted to. It turned out there is no
single form — a form gets **cloned per event**, so submissions scatter.

Found in the portal:

- **`a1c2de59-d637-4e1e-8efd-805d89587093`** — "Big Money Show 4/6/2024".
  Fields: `email, company, warehouse_distributor_provider, primary_brake_pad_brand`.
- **`897e89b6-62c8-48a8-a9db-a44b99043690`** — a clone of the above, adds
  `auto_shop_name` and `firstname`. Real submissions on the show date.
- **`5bf4f1ba-e692-4ac9-9d4f-6420003f6d04`** — "DFC event-checkin".
  Fields: `firstname, email, phone, year, make, model, sub_model`. This is a
  consumer/vehicle check-in, a different thing from the trade show form.

None of them capture consent, and none carry a show identifier — the only link
between a submission and a show is which clone it came through.

Two consequences:

1. `data/shows.json` has a `formIds` array. Use `tsf show link-form` to attach
   the clone to the show so submissions can be traced afterwards.
2. Going forward, use **one durable form** with a hidden show field rather than
   a clone per event. Then `formIds` stops being needed.

Use `tsf discover forms --match "show"` to find these again.

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
to rather than inventing a parallel field:

| Business unit | Id |
| --- | --- |
| Dynamic Friction | 311464 |
| Drilled Rotors | 311463 |
| R1 Concepts | root unit — **id unknown** |

The ids came from the `business_unit_optout_*` contact properties.
`hs_all_assigned_business_unit_ids` ("Brands") is the property that holds them.
Reading the business-units API directly returns 403 — the app lacks the scope —
so R1's id is `null` in `data/brands.json`. Fill it in when you have it.

Note that Drilled Rotors is a third brand in the portal. It is not in
`data/brands.json` because this program covers two; add it there if that changes.

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
