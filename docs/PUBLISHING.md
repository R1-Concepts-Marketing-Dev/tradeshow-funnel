# Letting other people see it, and other people upload

Two different problems with two different answers. Worth keeping them apart —
conflating them is what makes this look harder than it is.

---

# Part 1 — Letting people SEE it

```bash
node bin/tsf.js publish --passphrase "your-team-passphrase"
```

Writes `published/index.html`. One self-contained file. Open it, type the
passphrase, see everything. No install, no login, no HubSpot access.

**It is encrypted.** The data inside is AES-GCM ciphertext behind a
PBKDF2-derived key (600,000 rounds). Without the passphrase the file is noise —
verified: no show name, audience name or email appears in it as readable text.

**It holds counts and spend only.** No names, emails or phone numbers, ever.
`buildPayload()` in `src/publish.js` is the only place that decides what goes
in, so it is the only place to check.

## Where to put it

`tsf publish` does **not** upload anything. It writes a file; where it goes is
your call. Three options:

### Send the file
Email or Teams it. Works immediately, no setup. Goes stale the moment you
generate the next one, and you will end up with five versions in circulation.
Fine for a one-off; poor as a habit.

### A new public repo on GitHub Pages ← what dfc-territory-map does
This is the pattern already working here: `dfc-territory-map` is a **public**
repo serving an encrypted page, with the raw data in a **private** repo next to
it (`dfc-territory-data`). Same split.

It has to be a *new, separate* repo because:

- **`tradeshow-funnel` is private, and this org is on the free GitHub plan.**
  Pages does not work on private repos there. The map is public for exactly
  this reason.
- Making *this* repo public would expose `data/` — show names, audience names,
  sizes, the whole history — as plain text. The encryption would be pointless.

So: a new public repo containing nothing but the generated `index.html`, Pages
turned on, and the passphrase shared separately. Everyone gets a permanent link
that is current whenever you last published.

**This is your decision to make, not mine.** Creating a public repo that holds
company data — even encrypted — is not something to do on someone's behalf.

### Somewhere you already host
If there is an intranet or a Teams/SharePoint site, drop the file there and skip
the public-internet question entirely. Simplest of all if it exists.

## On the passphrase

A published file sits on the public internet, so the ciphertext can be taken
away and attacked offline for as long as someone likes. The passphrase is what
stands in the way.

`tsf publish` refuses anything under 12 characters, letters-only, or containing
an obvious word. Four random words is the easy way to a good one. Share it
separately from the link — not in the same message.

Same reasoning applies to the map, which has 83k shops behind it. Worth
confirming with whoever built it that its passphrase is a strong one.

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
