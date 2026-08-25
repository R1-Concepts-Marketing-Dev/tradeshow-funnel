// publish.js — builds a single encrypted HTML page anyone on the team can open.
//
// The problem: people want to see this without installing Node, cloning a repo
// or holding a HubSpot token. GitHub Pages solves the hosting, but Pages does
// not work on a private repo on the free plan, so whatever gets published is
// on the public internet.
//
// The answer, which is the same one dfc-territory-map already uses: publish a
// public page whose contents are encrypted, and give the team a passphrase.
// The hosting being public stops mattering.
//
// WHAT GOES IN, AND WHAT DOES NOT
//
// Counts, sizes, spend, show names, audience names, ad names and creative.
// No contact-level data — no names, emails or phone numbers, ever. Even
// encrypted, a passphrase circulates the way passphrases do, and there is no
// reason for a viewer to hold personal data to answer "how big is the SEMA
// audience". buildPayload() is the only place that decides, so it is the only
// place to check.
//
// EDIT THIS FILE IF: you want the viewer to show something it does not yet.
// Add it to buildPayload, and check first that it is not personal data.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PATHS, ROOT } from "./config.js";
import * as registry from "./registry.js";
import * as brands from "./brands.js";
import * as audiencesLib from "./audiences.js";

/**
 * PBKDF2 rounds. The published file is public, so the ciphertext can be taken
 * away and attacked offline for as long as someone likes — the iteration count
 * is most of what stands in the way. 600k is the OWASP recommendation for
 * PBKDF2-HMAC-SHA256 and costs the viewer about a second on open.
 */
export const KDF_ITERATIONS = 600000;

/** Refuses a passphrase weak enough to make the rest pointless. */
export function checkPassphrase(passphrase) {
  const problems = [];
  if (!passphrase || passphrase.length < 12) {
    problems.push("Use at least 12 characters — this file will sit on the public internet.");
  }
  if (/^[a-z]+$/i.test(passphrase || "")) {
    problems.push("Letters only is weak. Mix in a number or a symbol, or use four random words.");
  }
  const lazy = ["password", "dfc", "r1concepts", "tradeshow", "12345", "letmein"];
  if (lazy.some((word) => String(passphrase || "").toLowerCase().includes(word))) {
    problems.push("It contains an obvious word. Anyone guessing would start there.");
  }
  return problems;
}

/**
 * What the viewer gets to see.
 *
 * Aggregates only. If you find yourself adding a field that identifies a
 * person, stop — that belongs in HubSpot, behind a HubSpot login.
 */
export function buildPayload() {
  const shows = registry.loadShows();
  const allAudiences = registry.listAudiences();

  const importEvents = registry.readHistory({ action: "import.committed" });
  const claimEvents = registry.readHistory({ action: "tablet.claimed" });

  return {
    generatedAt: new Date().toISOString(),

    brands: brands.loadBrands().map((b) => ({
      id: b.id,
      name: b.name,
      shortName: b.shortName,
      accent: b.accent,
    })),

    shows: shows.map((show) => {
      const mine = importEvents.filter((e) => e.showId === show.id);
      const claims = claimEvents.filter((e) => e.showId === show.id);
      const bySource = {};
      for (const e of mine) {
        const b = (bySource[e.source] ||= { contacts: 0, files: 0 });
        b.contacts += (e.created || 0) + (e.updated || 0);
        b.files += 1;
      }
      for (const e of claims) {
        const b = (bySource.booth_tablet ||= { contacts: 0, files: 0 });
        b.contacts += e.contacts || 0;
        b.files += 1;
      }
      return {
        id: show.id,
        name: show.name,
        startDate: show.startDate,
        endDate: show.endDate,
        city: show.city || "",
        brands: show.brands || [],
        venue: show.venue ? { name: show.venue.name } : null, // name only, no coordinates
        intake: bySource,
        totalContacts: Object.values(bySource).reduce((n, b) => n + b.contacts, 0),
      };
    }),

    audiences: allAudiences.map((a) => {
      let readiness = null;
      if (a.type !== "geo") {
        try {
          readiness = audiencesLib.checkReadiness(a).findings.map((f) => ({
            platform: f.platform,
            level: f.level,
            message: f.message,
          }));
        } catch { /* readiness is a nicety */ }
      }
      return {
        id: a.id,
        name: a.name,
        brand: a.brand,
        type: a.type,
        status: a.status,
        purpose: a.purpose,
        shows: a.shows,
        sources: a.sources,
        sizeHistory: a.sizeHistory,
        destinations: a.destinations,
        notes: a.notes,
        geo: a.type === "geo" ? a.definition?.geo || null : null,
        readiness,
      };
    }),

    // The activity log, minus anything carrying a filename that might name a
    // person, and minus the actor's email address.
    history: registry.readHistory({ limit: 400 }).map((e) => ({
      at: e.at,
      action: e.action,
      brand: e.brand || null,
      audienceName: e.audienceName || null,
      showName: e.showName || null,
      source: e.source || null,
      size: e.size ?? null,
      delta: e.delta ?? null,
      created: e.created ?? null,
      updated: e.updated ?? null,
      rejected: e.rejected ?? null,
      platform: e.platform || null,
      status: e.status || null,
      text: e.text || null,
    })),
  };
}

/**
 * Encrypts the payload the same way the viewer will decrypt it:
 * PBKDF2-SHA256 to a 256-bit key, then AES-GCM.
 */
export function encryptPayload(payload, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(passphrase, salt, KDF_ITERATIONS, 32, "sha256");

  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);

  // WebCrypto expects the auth tag appended to the ciphertext.
  const body = Buffer.concat([encrypted, cipher.getAuthTag()]);

  return {
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    ciphertext: body.toString("base64"),
    iterations: KDF_ITERATIONS,
  };
}

/**
 * Writes the published page.
 *
 * @param {object} options
 * @param {string} options.passphrase
 * @param {string} options.outFile     defaults to published/index.html
 * @param {boolean} options.force      skip the passphrase strength check
 */
export function publish({ passphrase, outFile, force = false }) {
  const problems = checkPassphrase(passphrase);
  if (problems.length && !force) {
    throw new Error(
      "That passphrase is too weak for a file that will be public:\n" +
        problems.map((p) => `  - ${p}`).join("\n") +
        "\n\nPick a stronger one, or pass --force if you have a reason."
    );
  }

  const payload = buildPayload();
  const sealed = encryptPayload(payload, passphrase);

  const target = outFile || path.join(ROOT, "published", "index.html");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, renderPage(sealed, payload), "utf8");

  registry.record(registry.ACTIONS.PUBLISHED, {
    file: path.relative(ROOT, target),
    shows: payload.shows.length,
    audiences: payload.audiences.length,
    bytes: fs.statSync(target).size,
  });

  return {
    file: target,
    bytes: fs.statSync(target).size,
    shows: payload.shows.length,
    audiences: payload.audiences.length,
    warnings: problems,
  };
}

/** The page itself. Everything is inline — it has to work as a single file. */
function renderPage(sealed, payload) {
  const generated = payload.generatedAt.slice(0, 10);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Trade Show Funnel</title>
<style>
:root{color-scheme:light dark;--ink:#12171f;--paper:#eceff3;--surface:#fff;
--line:#e3e7ec;--muted:#5c6673;--muted2:#8a94a1;--accent:#0f766e;--accent-wash:#e7f2f0;
--good:#1f8a56;--bad:#c0463c;--warn:#b0740f;
--sans:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
--mono:ui-monospace,"Cascadia Code",Consolas,monospace}
@media(prefers-color-scheme:dark){:root{--ink:#070a0d;--paper:#0f141a;--surface:#171e26;
--line:#29323c;--muted:#9aa5b1;--muted2:#717d89;--accent-wash:#1d2a2c}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font-family:var(--sans);
font-size:15px;line-height:1.55;-webkit-font-smoothing:antialiased}
@media(prefers-color-scheme:dark){body{color:#e2e8ee}}
.wrap{max-width:1180px;margin:0 auto;padding:0 24px}

/* gate */
#gate{min-height:100vh;display:grid;place-items:center;padding:24px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;
padding:32px;max-width:390px;width:100%;text-align:center;
box-shadow:0 1px 2px rgba(16,23,31,.06),0 10px 34px rgba(16,23,31,.08)}
.glyph{width:42px;height:42px;border-radius:10px;background:var(--accent);color:#fff;
display:grid;place-items:center;margin:0 auto 16px;font:700 14px var(--mono)}
.card h1{font-size:19px;margin:0 0 5px;letter-spacing:-.02em}
.card p{color:var(--muted);font-size:13.5px;margin:0 0 20px}
input{width:100%;padding:11px 12px;border:1px solid var(--line);border-radius:7px;
background:var(--paper);color:inherit;font-size:15px}
input:focus{outline:none;border-color:var(--accent)}
button{margin-top:12px;width:100%;padding:11px;border:none;border-radius:7px;
background:var(--accent);color:#fff;font:600 14px var(--sans);cursor:pointer}
button:disabled{opacity:.6;cursor:progress}
.err{color:var(--bad);font-size:13px;margin-top:12px;min-height:18px}

/* app */
#app{display:none}
header.top{background:var(--ink);color:#eef1f5;border-bottom:3px solid var(--accent)}
@media(prefers-color-scheme:dark){header.top{color:#e2e8ee}}
.top-in{display:flex;align-items:center;gap:16px;padding:14px 0}
.top .title{font-size:14.5px;font-weight:650}
.top .sub{font-family:var(--mono);font-size:10.5px;letter-spacing:.11em;
text-transform:uppercase;color:#8b95a3}
.spacer{flex:1}
.pills{display:flex;gap:4px;background:rgba(255,255,255,.08);padding:3px;border-radius:100px}
.pills button{width:auto;margin:0;background:none;color:#b7c0cb;padding:5px 13px;
border-radius:100px;font-size:12.5px}
.pills button.on{background:var(--accent);color:#fff}
main{padding:24px 0 70px}
h2{font-size:16px;font-weight:650;margin:26px 0 10px;letter-spacing:-.01em}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:9px;
overflow:hidden;margin-bottom:18px}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px;min-width:560px}
th{text-align:left;padding:9px 14px;background:var(--paper);font:500 10px var(--mono);
letter-spacing:.1em;text-transform:uppercase;color:var(--muted2);border-bottom:1px solid var(--line)}
td{padding:10px 14px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:none}
.r{text-align:right;font-variant-numeric:tabular-nums}
.chip{display:inline-block;font:500 10px var(--mono);letter-spacing:.06em;
text-transform:uppercase;padding:3px 7px;border-radius:100px;background:var(--paper);
color:var(--muted);border:1px solid var(--line)}
.chip.b{color:#fff;border-color:transparent}
.chip.ok{background:#e6f3ec;color:var(--good);border-color:transparent}
.chip.warn{background:#f7eedd;color:var(--warn);border-color:transparent}
.chip.bad{background:#f7e7e5;color:var(--bad);border-color:transparent}
.chip.geo{background:var(--accent-wash);color:var(--accent);border-color:transparent}
.muted{color:var(--muted);font-size:12.5px}
.mono{font-family:var(--mono);font-size:11.5px;color:var(--muted)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin-bottom:6px}
.stat{background:var(--surface);border:1px solid var(--line);border-radius:9px;padding:13px 15px}
.stat .k{font:500 10px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--muted2)}
.stat .v{font-size:25px;font-weight:660;letter-spacing:-.02em;font-variant-numeric:tabular-nums}
.foot{color:var(--muted2);font-size:12px;padding:20px 0}
</style>
</head>
<body>

<div id="gate">
  <div class="card">
    <div class="glyph">TS</div>
    <h1>Trade Show Funnel</h1>
    <p>Shows, audiences and spend. Enter the team passphrase.</p>
    <input id="pw" type="password" placeholder="Passphrase" autofocus
           onkeydown="if(event.key==='Enter')unlock()">
    <button id="go" onclick="unlock()">Unlock</button>
    <div class="err" id="err"></div>
    <p class="muted" style="margin-top:18px;font-size:11.5px">
      Data as of ${generated}. Contains no contact details — counts and spend only.
    </p>
  </div>
</div>

<div id="app">
  <header class="top">
    <div class="wrap top-in">
      <div>
        <div class="title">Trade Show Funnel</div>
        <div class="sub" id="asof"></div>
      </div>
      <div class="spacer"></div>
      <div class="pills" id="brands"></div>
    </div>
  </header>
  <main class="wrap" id="main"></main>
  <div class="wrap foot" id="foot"></div>
</div>

<script>
const SEALED = ${JSON.stringify(sealed)};
let DATA = null, BRAND = null;

const $ = (s) => document.querySelector(s);
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = (v) => v === null || v === undefined ? "—" : Number(v).toLocaleString("en-US");
const day = (v) => String(v || "").slice(0,10);

function b64(s){const b=atob(s);const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return a;}

async function unlock(){
  const btn = $("#go"), err = $("#err");
  const pass = $("#pw").value;
  if(!pass) return;
  btn.disabled = true; btn.textContent = "Unlocking…"; err.textContent = "";
  try{
    const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.subtle.deriveKey(
      {name:"PBKDF2", salt:b64(SEALED.salt), iterations:SEALED.iterations, hash:"SHA-256"},
      km, {name:"AES-GCM", length:256}, false, ["decrypt"]);
    const plain = await crypto.subtle.decrypt({name:"AES-GCM", iv:b64(SEALED.iv)}, key, b64(SEALED.ciphertext));
    DATA = JSON.parse(new TextDecoder().decode(plain));
    $("#gate").style.display = "none";
    $("#app").style.display = "block";
    render();
  }catch(e){
    err.textContent = "That passphrase did not work.";
    btn.disabled = false; btn.textContent = "Unlock";
  }
}

function render(){
  $("#asof").textContent = "As of " + day(DATA.generatedAt);
  $("#brands").innerHTML = [{id:null,shortName:"All"}, ...DATA.brands]
    .map(b => '<button data-b="'+(b.id||"")+'" class="'+(BRAND===b.id?"on":"")+'">'+esc(b.shortName)+'</button>').join("");
  $("#brands").onclick = (e) => { const b = e.target.closest("button"); if(!b) return;
    BRAND = b.dataset.b || null; render(); };

  const brandOf = (id) => DATA.brands.find(b => b.id === id);
  const auds = DATA.audiences.filter(a => !BRAND || a.brand === BRAND);
  const active = auds.filter(a => a.status === "active");
  const lists = active.filter(a => a.type !== "geo");
  const reach = lists.reduce((n,a) => n + (a.sizeHistory.at(-1)?.size ?? 0), 0);
  const shows = DATA.shows.filter(s => !BRAND || !s.brands.length || s.brands.includes(BRAND));

  let h = '<div class="stats">' +
    stat("Shows", num(shows.length), shows.reduce((n,s)=>n+s.totalContacts,0).toLocaleString()+" contacts") +
    stat("Contact audiences", num(lists.length), num(reach)+" people") +
    stat("Geo audiences", num(active.length - lists.length), "no size floor") +
    stat("Needs attention", num(lists.filter(a => (a.readiness||[]).some(f=>f.level==="blocked")).length), "below a platform floor") +
  '</div>';

  h += '<h2>Shows</h2><div class="panel"><div class="scroll"><table><thead><tr>' +
    '<th>Show</th><th>Dates</th><th>Venue</th><th class="r">Contacts</th><th>Sources loaded</th>' +
    '</tr></thead><tbody>' +
    (shows.length ? shows.map(s =>
      '<tr><td><b>'+esc(s.name)+'</b><div class="mono">'+esc(s.city)+'</div></td>' +
      '<td class="mono">'+esc(s.startDate)+' → '+esc(s.endDate)+'</td>' +
      '<td>'+(s.venue ? esc(s.venue.name) : '<span class="muted">not set</span>')+'</td>' +
      '<td class="r">'+num(s.totalContacts)+'</td>' +
      '<td>'+(Object.keys(s.intake).length ? Object.entries(s.intake).map(([k,v]) =>
        '<span class="chip">'+esc(k)+' '+num(v.contacts)+'</span>').join(" ") : '<span class="muted">none yet</span>')+'</td></tr>'
    ).join("") : '<tr><td colspan="5" class="muted" style="text-align:center;padding:22px">No shows yet.</td></tr>') +
    '</tbody></table></div></div>';

  h += '<h2>Audiences</h2><div class="panel"><div class="scroll"><table><thead><tr>' +
    '<th>Audience</th><th>Brand</th><th>Type</th><th class="r">Size</th><th>Trend</th><th>Used on</th>' +
    '</tr></thead><tbody>' +
    (auds.length ? auds.map(a => {
      const last = a.sizeHistory.at(-1);
      const isGeo = a.type === "geo";
      const worst = (a.readiness||[]).some(f=>f.level==="blocked") ? '<span class="chip bad">below floor</span>'
        : (a.readiness||[]).some(f=>f.level==="thin") ? '<span class="chip warn">thin</span>'
        : isGeo ? '<span class="chip geo">no floor</span>'
        : (a.readiness||[]).length ? '<span class="chip ok">ready</span>' : '';
      const b = brandOf(a.brand);
      return '<tr><td><b>'+esc(a.name)+'</b>'+(a.status!=="active"?' <span class="chip">retired</span>':'')+
        '<div class="mono">'+esc(a.purpose||"").slice(0,90)+'</div></td>' +
        '<td>'+(b?'<span class="chip b" style="background:'+esc(b.accent)+'">'+esc(b.shortName)+'</span>':'—')+'</td>' +
        '<td><span class="chip'+(isGeo?' geo':'')+'">'+(isGeo?"geo":"list")+'</span> '+worst+'</td>' +
        '<td class="r">'+(isGeo ? (a.geo?.window?.totalDays ?? "?")+" days" : num(last?.size))+'</td>' +
        '<td class="mono">'+(isGeo ? esc((a.geo?.window?.runStart||"")+" → "+(a.geo?.window?.runEnd||""))
          : a.sizeHistory.slice(-4).map(p=>num(p.size)).join(" → ") || "—")+'</td>' +
        '<td>'+(a.destinations.length ? a.destinations.map(d=>'<span class="chip">'+esc(d.platform)+'</span>').join(" ")
          : '<span class="muted">not recorded</span>')+'</td></tr>';
    }).join("") : '<tr><td colspan="6" class="muted" style="text-align:center;padding:22px">No audiences yet.</td></tr>') +
    '</tbody></table></div></div>';

  const hist = DATA.history.filter(e => !BRAND || !e.brand || e.brand === BRAND).slice(0, 50);
  h += '<h2>Recent activity</h2><div class="panel"><div class="scroll"><table><thead><tr>' +
    '<th>When</th><th>What</th><th>Detail</th></tr></thead><tbody>' +
    (hist.length ? hist.map(e =>
      '<tr><td class="mono">'+esc(e.at.replace("T"," ").slice(0,16))+'</td>' +
      '<td class="mono">'+esc(e.action)+'</td><td>'+esc(describe(e))+'</td></tr>').join("")
      : '<tr><td colspan="3" class="muted" style="text-align:center;padding:22px">Nothing yet.</td></tr>') +
    '</tbody></table></div></div>';

  $("#main").innerHTML = h;
  $("#foot").innerHTML = "Generated " + day(DATA.generatedAt) +
    " · read-only · counts and spend only, no contact details · ask Ben to refresh it";
}

function stat(k,v,s){return '<div class="stat"><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+
  '</div><div class="muted">'+esc(s)+'</div></div>';}

function describe(e){
  if(e.action==="import.committed") return (e.source||"")+": "+num(e.created)+" new, "+num(e.updated)+" updated, "+num(e.rejected)+" rejected";
  if(e.action==="tablet.claimed") return (e.showName||"")+": booth sign-ups claimed";
  if(e.action==="audience.refreshed") return (e.audienceName||"")+" now "+num(e.size)+(e.delta==null?"":" ("+(e.delta>=0?"+":"")+num(e.delta)+")");
  if(e.action==="audience.created") return e.audienceName||"";
  if(e.action==="audience.destination_set") return (e.audienceName||"")+" → "+(e.platform||"")+" "+(e.status||"");
  if(e.action==="show.created") return e.showName||"";
  if(e.action==="note") return (e.audienceName||"")+": "+(e.text||"");
  return e.audienceName || e.showName || "";
}
</script>
</body>
</html>
`;
}
