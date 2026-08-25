# Letting other people see it, and other people upload

Two different problems with two different answers. Worth keeping them apart —
conflating them is what makes this look harder than it is.

---

# Part 1 — Letting people SEE it

```bash
node bin/tsf.js publish --deploy
```

Builds the page and pushes it live. It is already set up:

**Live at <https://r1-concepts-marketing-dev.github.io/tradeshow-funnel/>**

## Where the password is set

In `.env`, one line:

```
TSF_PUBLISH_PASSPHRASE=your-passphrase-here
```

Change it, run `publish --deploy` again, and the page is re-encrypted with the
new one. **The old passphrase stops working immediately** — that is how you
remove someone's access.

`.env` is gitignored, so it never reaches GitHub. It is the only place the
passphrase is written down. You can also pass `--passphrase "..."` per run, but
then it sits in your shell history.

The tool refuses anything under 12 characters, letters-only, or containing an
obvious word — the file is on the public internet, so it can be attacked
offline for as long as someone likes.

## How it is wired

`--deploy` pushes to the `gh-pages` branch via a throwaway git worktree, so
your working tree is never touched — safe to run mid-edit. Pages serves that
branch. The `main` branch has no page in it.

---

## What the page is

One self-contained HTML file. Open it, type the passphrase, see everything. No
install, no login, no HubSpot access.

**It is encrypted.** AES-GCM ciphertext behind a PBKDF2-derived key, 600,000
rounds. Without the passphrase the file is noise — verified: no show name,
audience name or email appears in it as readable text.

**It holds counts and spend only.** No names, emails or phone numbers, ever.
`buildPayload()` in `src/publish.js` is the only place that decides what goes
in, so it is the only place to check.

## Why it is encrypted even though it is our own repo

`tradeshow-funnel` is a **public** repo — Pages does not serve private repos on
the free plan, which is why `dfc-territory-map` is public too. So the file is on
the open internet and the encryption is what makes that fine.

The registry it is built from stays in the **private** `tradeshow-funnel-data`
repo. The public repo holds code and one encrypted page, nothing else.

## Refreshing it

Run `publish --deploy` again after a show. The page is rebuilt from whatever the
registry says at that moment, so pull the data repo first:

```bash
cd ../tradeshow-funnel-data && git pull && cd -
node bin/tsf.js publish --deploy
```

Anyone holding the link sees the new numbers on their next load.

---

# Part 2 — Letting other people UPLOAD

Harder, because uploading needs three things a viewer does not: the HubSpot
write token, the merge pipeline, and somewhere to run it.

Four ways, roughly cheapest first.

### A. They send you the file, you upload it
What happens today. Costs nothing, works now, and you are the bottleneck — if
you are out during a show, nothing moves. Honest answer: at a few shows a year,
this is mostly fine.

### B. A HubSpot form with a file upload field ← the interesting one
Make a form: brand, show, source, and a file. Anyone submits a roster from a
browser or a phone. The tool reads the submissions, downloads the files and runs
them through the same pipeline.

Why this one is appealing here:

- **No new infrastructure.** HubSpot is already the system of record.
- **Nothing to install** for the person uploading. No token, no Node, no repo.
- **It already works in this portal** — 12 existing forms use file-upload
  fields, including "Shirly - Vendor PO Upload Form", which is the same shape
  of problem.
- Files land in HubSpot's file manager, not in git, so no contact data ends up
  in version history.

You still run the commit, so the dry-run check does not get skipped. It turns
"send Ben the file" into "submit the form", which is the difference between
something that gets done at the show and something that gets done next week.

Not built yet. Roughly half a day.

### C. Install it on a second machine
`git clone`, `npm install`, a copy of the credentials. Whoever else uploads gets
the same tool. Removes the single point of failure without any hosting.

The catch is the registry: two people uploading means two `data/` folders and
git conflicts on the append-only log. Workable with discipline (pull before,
push after), unpleasant without.

### D. Deploy it properly
One URL, everyone uploads there, no bottleneck and no conflicts. Roughly
$7–14/month on Render or similar, plus a persistent disk so the registry
survives redeploys.

**The sign-in for this is already built** — Google, restricted to
r1concepts.com — and the app already refuses to bind to a public interface
without it. Config, not code.

This is the right answer if uploading stops being a handful of times a year.

## What I would do

**Publish the viewer now** (Part 1), because several people want to look and it
costs nothing.

**Leave uploading as A for the next show.** Then, if being the bottleneck
actually bites, build B — it is cheap, it uses what you already have, and it
does not put contact data on a server that is not HubSpot.

Keep D in your pocket. Nothing about the current setup blocks it, and the
awkward half is already done.
