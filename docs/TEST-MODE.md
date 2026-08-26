# Test mode

Nothing this tool does can change a system outside your machine.

```bash
node bin/tsf.js --test import --file roster.xlsx --show sema-2026 --source roster_pre --commit
```

Or leave it on permanently in `.env`:

```
TSF_TEST_MODE=true
```

## What it means exactly

**Reads are real. Writes are refused.**

That distinction is the whole design, so it is worth being precise about it:

| | Test mode |
|---|---|
| Reading contacts from HubSpot | works |
| Reading Meta and Google Ads reports | works |
| Claude reading your spreadsheet columns | works |
| Building an ad-platform CSV | works — it is a local file |
| Previewing an import, with real dedupe counts | works |
| **Writing contacts to HubSpot** | **refused** |
| **Creating or changing a HubSpot list** | **refused** |
| **Creating HubSpot properties (`tsf setup`)** | **refused** |
| **Publishing the team page to GitHub** | **refused** |

Reads stay on because a preview that cannot read HubSpot is worthless — it
could not tell you which contacts already exist, so "3 created, 0 updated"
would be a guess. In test mode those numbers are real.

The local registry still records what you did, stamped `testMode: true`. It is
not hidden from history, because a log that silently omits runs is as
misleading as one that claims a test was operational.

## Where the guard actually lives

In `src/hubspot.js`, inside the single function every HubSpot call goes
through — not at each call site. Test mode has to be a property of the tool,
not a discipline someone has to remember when adding a function.

Blocking by HTTP method would not work: HubSpot's search and batch-read
endpoints are POSTs. So there is an **allowlist** of read-only POSTs, and
anything not on it is treated as a write. That direction matters — a new
endpoint is refused until someone has looked at it and confirmed it is a read.
The other way round writes to the live portal.

`src/publish.js` has its own guard, because deploying pushes a branch to GitHub,
which is as much "leaving this machine" as a HubSpot write is.

## What you see

The CLI prints a banner before anything else:

```
  TEST MODE — reads are real, writes are refused.
  Nothing can reach HubSpot, and nothing can be published.
```

The web UI shows a permanent amber bar, and the Commit button says
**Commit (blocked in test mode)**.

`--commit` does not error. It runs the entire pipeline for real and stops at the
write:

```
  contacts to write   3
    · created         3
    · updated         0

  TEST MODE — this was a full dry run.
  3 contact(s) would have been written to HubSpot.
  Every number above is real. Nothing was sent.
```

An error would read as a failure. This is not a failure; it is the mode working.

The low-level guard is still there underneath, and it *does* throw. If you ever
see that message, it means a code path skipped the graceful check — the write
was still stopped, but the path should be fixed.

## Checking which mode you are in

```bash
node bin/tsf.js doctor
```

```
  Test mode  ON — reads are real, every write is refused
```

Worth doing before any real import. The failure that costs an afternoon is
believing you committed when you did not.

## Turning it off

Set `TSF_TEST_MODE=false` in `.env`, or remove the line. Then check `doctor`
says `off` before you rely on it.
