# Uploading an audience to an ad platform

`tsf audience export` writes a CSV that the platform will accept as-is. The
formatting rules live in [`src/adPlatforms.js`](../src/adPlatforms.js) as a
table, one entry per platform.

```bash
node bin/tsf.js audience export --id sema-2026-all-r1 --platform meta
```

Or open the audience in the web UI and press the platform's button.

## Why this is not just "export the emails"

The four platforms want the same facts and disagree about nearly all of it.
Two examples from the same contact:

| | Google Ads | Meta |
|---|---|---|
| Header for email | `Email` | `email` |
| Last name `O'Brien` | `o'brien` | `obrien` |
| Country | `US` | `us` |
| Is ZIP hashed? | never | yes |

None of those differences produce an error. The upload succeeds and matches
fewer people than it should, and nobody finds out. That is the failure this
file exists to prevent, and it is why `test/adPlatforms.test.js` asserts the
`US` / `us` difference directly rather than trusting it to stay right.

## What each platform gets

| Platform | Columns | Minimum | Suggested |
|---|---|---|---|
| `google-ads` | Email, Phone, First Name, Last Name, Country, Zip | 100 | 5,000 |
| `meta` | email, phone, fn, ln, ct, st, zip, country | 1,000 | 10,000 |
| `tiktok` | Email, Phone | 1,000 | 10,000 |
| `linkedin` | email, firstname, lastname, companyname, jobtitle, country | 300 | 10,000 |

**LinkedIn is the one to check by hand.** It does not publish its template
headers and rejects files whose headers it does not recognise. Download the
template from Campaign Manager and compare the header row. Everything else here
comes from the platform's own documentation, checked 2026-08-26.

## Plain text or hashed?

Plain text by default. Every one of these platforms hashes the file in your
browser before anything is sent, and letting them do it means their
normalisation applies rather than ours — which matches slightly better.

Add `--hash` when the file has to leave your machine. It is SHA-256, hex,
lowercase, applied only to the columns each platform expects hashed. Google's
Country and Zip stay readable even in a hashed file, because that is how Google
matches them.

The hash is always taken **after** normalisation. Hashing `Dana@X.com ` instead
of `dana@x.com` produces a completely unrelated value and a 0% match rate; the
test suite pins this.

## Who gets left out

Every export excludes three groups, and says how many of each:

- **Opted out of marketing.** Someone who asked not to be marketed to did not
  mean "except on Facebook". Override with `--include-opted-out` only if you
  have a specific reason and you know what it is.
- **Hard bounced.** The address does not exist, cannot match, and drags the
  match rate down.
- **Shared mailboxes.** `info@`, `sales@`, `service@` — not a person, will
  never match.

Then rows that carry no identifier the platform can use are dropped, and
duplicates are collapsed.

On R1's own data this is not a rounding error. A 13,607-contact list exported
to Meta produced **12,116 rows** — 769 hard bounces, 718 opt-outs and 4 shared
mailboxes removed. Roughly one row in nine would have been dead weight.

## Things the exporter quietly fixes

**Leading zeros on US ZIPs.** A US ZIP is always five digits, so a stored
`8052` is `08052` with the zero eaten by a spreadsheet upstream. 14% of the ZIPs
in the live portal are like this. They are padded back on export. Non-US codes
are never padded, because length guarantees nothing outside the US.

**Phone numbers into E.164.** `(702) 555-0184` becomes `+17025550184`. A number
that cannot be resolved confidently is left blank rather than guessed — a
wrongly guessed country code shows your ads to a stranger.

**Country and state spellings.** `United States`, `USA`, `U.S.A.` all become
`US`. `Nevada` becomes `nv`. An unrecognised country is left blank rather than
passed through, because a wrong country is worse than an empty cell.

**Gmail dots, for Google only.** `bob.smith@gmail.com` and `bobsmith@gmail.com`
are the same mailbox and Google matches them as one. This is applied only to
gmail.com and googlemail.com — a dot is significant everywhere else.

## Where the files go

`<TSF_DATA_DIR>/exports/`, named for the audience, platform, date, and whether
it is hashed. Override with `--out`.

**These files contain contact data.** The exports folder is gitignored in the
data repo. Delete them once uploaded — the audience is reproducible from the
registry any time, so there is no reason to keep a copy of everyone's email
address sitting in a folder.

Every export is logged to the history as `audience.exported` with the row count
and whether it cleared the platform's floor, so "what did we upload to Meta for
SEMA, and how big was it" stays answerable.

## When the file is too small

The tool says so before you upload rather than after. A single show rarely
clears Meta's or TikTok's 1,000-match floor — email-only lists match at roughly
40–60%, so 1,000 rows is not 1,000 matched users.

Two ways out, both already in the tool:

- **Pool shows.** The `lookalike-seed` campaign type builds one audience per
  brand across every show, deliberately.
- **Target the venue instead.** A geo audience has no size floor at all. See
  `tsf show geo`.

## Sources

Checked 2026-08-26:

- [Google Ads — format your customer data file](https://support.google.com/google-ads/answer/7659867)
- [Google Ads — about the customer matching process](https://support.google.com/google-ads/answer/7474263)
- [Meta — custom audiences from a customer list](https://developers.facebook.com/docs/marketing-api/audiences/guides/custom-audiences/)
- [TikTok — create a custom audience with a customer file](https://ads.tiktok.com/help/article/how-to-create-a-custom-audience-with-a-customer-file?lang=en)
- [LinkedIn — requirements for contact targeting lists](https://www.linkedin.com/help/lms/answer/a1489764)
