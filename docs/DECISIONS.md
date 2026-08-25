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
- **A web UI.** A CLI is easier for someone else in the org to read, edit and
  trust than a server they have to run.
