# Letting other people use this

The tool runs on one machine. This is how other people reach it.

There are two ways, and the difference is whether the address holds still.

---

## The quick way — a tunnel from your PC

Free, no host, no account, works today. Others open a link and use the tool
exactly as you do. It only works while your machine is on and this command is
running.

### One-time setup

Install the tunnel client:

```bash
winget install --id Cloudflare.cloudflared
```

Open a new terminal afterwards so the PATH picks it up.

Then put two lines in `.env`:

```
TSF_ACCESS_PASSPHRASE=whatever-phrase-you-want-to-share
TSF_SESSION_SECRET=any-long-random-string-nobody-guesses
```

The passphrase is what colleagues type. The session secret is not typed by
anyone — it signs the login cookie, and pinning it stops everyone being signed
out every time you restart.

### Every time

```bash
node bin/tsf.js tunnel
```

It prints a link. Send that link to whoever is uploading. They open it, type the
passphrase, and get the full tool — upload, preview, commit, reports.

Close the window and the link dies. **A new link is generated every time**, so
send the current one, not an old one.

### What it refuses to do

`tsf tunnel` will not open anything unless a gate is configured. A tunnel
forwards to `localhost`, so the server cannot tell on its own that it has just
become reachable from the internet — that check has to happen here, before the
URL exists.

There is a second, independent check: any request that arrives looking remote
(a non-localhost `Host` header, or a proxy header like `cf-connecting-ip`) is
refused outright when no gate is set. Both checks exist because getting this
wrong publishes a HubSpot token that can write to your portal.

If the tool is force-killed (`taskkill /F`, power cut), no cleanup handler can
run and `cloudflared` may survive. That matters because a tunnel forwards to a
*port*, so a leftover one would expose whatever binds that port next. Check with:

```bash
Get-Process cloudflared
```

### What it is not

One shared phrase, with no record of who used it. The history log records
`shared-link` rather than a person, because it genuinely does not know. If you
need to know who imported what, use the permanent option below.

---

## The permanent way — your own hostname and Google sign-in

Everything above is a workaround for one fact: **a free tunnel gets a new
hostname every restart, and Google will only redirect to URLs registered in
advance.** So Google sign-in cannot work behind a URL that changes.

Give the tool a hostname that holds still and it all gets better — a permanent
link, per-person sign-in restricted to your Workspace domain, and a history log
that records who did what.

### What that needs

R1's domains (`r1concepts.com`, `dynamicfriction.com`, `drilledrotors.com`) are
on **Route 53**, not Cloudflare, and a named Cloudflare tunnel needs the zone to
be on Cloudflare. Two ways round that, neither requiring a paid host:

**Option A — delegate one subdomain.** In Route 53, add `NS` records for
something like `tools.r1concepts.com` pointing at the nameservers Cloudflare
gives you, then add `tools.r1concepts.com` as a zone in a free Cloudflare
account. This is surgical: the apex, `www`, and the `MX` records that carry mail
are untouched. It is the cleanest route and needs Route 53 access.

**Option B — any other domain you control** that already sits on Cloudflare.

Then create a named tunnel rather than a quick one, and point it at your
hostname. Cloudflare's docs cover `cloudflared tunnel create` and
`cloudflared tunnel route dns`.

### Then switch the gate

Create an OAuth client in Google Cloud Console for your Workspace (Internal, so
only your domain can use it), with the redirect URI set to
`https://tools.r1concepts.com/auth/callback`. Put these in `.env`:

```
TSF_GOOGLE_CLIENT_ID=...
TSF_GOOGLE_CLIENT_SECRET=...
TSF_ALLOWED_DOMAIN=r1concepts.com
TSF_PUBLIC_URL=https://tools.r1concepts.com
TSF_SESSION_SECRET=any-long-random-string
```

Remove `TSF_ACCESS_PASSPHRASE`. Google sign-in takes precedence when both are
set, but leaving a shared phrase lying around defeats the point of moving.

---

## Which to use

| | Tunnel + passphrase | Hostname + Google |
|---|---|---|
| Cost | free | free |
| Link | changes every restart | permanent |
| Available | only while your PC is on | only while your PC is on |
| Who can get in | anyone with the phrase | anyone on your Workspace domain |
| History log says | `shared-link` | the person's email |
| Setup | 5 minutes | DNS change + OAuth client |

Note the row that does not change: **both run on your machine.** Neither makes
the tool available while your PC is asleep. That needs a host, which costs
money. See the option table in the README if that changes.

---

## What everyone else needs to know

Nothing about any of this. They get a link, they type a phrase or sign in, and
they drop a file. The preview, the duplicate checks, and Claude's read of the
columns all work exactly the same as they do for you — it is the same tool,
not a reduced version of it.

Nothing reaches HubSpot until someone presses Commit, and any import can be
undone with `tsf imports reverse`.
