// app.js — the whole UI. Plain JavaScript, no framework, no build step.
//
// Shape of it: `state` holds everything the server gave us plus what the user
// has selected. Anything that changes state calls render(), which redraws.
// That is slower than a real framework and far easier to follow, which is the
// right trade for a tool a few people run locally.
//
// EDIT THIS FILE IF: you want the UI to do something new. Find the view's
// render function and change it.

"use strict";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const state = {
  brands: [],
  shows: [],
  audiences: [],
  history: [],
  sources: [],
  platforms: [],

  view: "audiences",
  brandFilter: null, // null = all brands

  upload: {
    filename: null,
    text: null,
    headers: [],
    rowCount: 0,
    mapping: {},
    sample: [],
    fields: [],
    preview: null,
  },
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

/** Escapes text before it goes into innerHTML. Contact data is user input. */
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character])
  );
}

const fmt = (value) =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US");

const day = (iso) => (iso || "").slice(0, 10);

function brandOf(id) {
  return state.brands.find((brand) => brand.id === id) || null;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

async function api(path, body) {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

async function loadState() {
  Object.assign(state, await api("/api/state"));
  render();
}

let toastTimer;
function toast(message, kind = "") {
  const element = $("#toast");
  element.textContent = message;
  element.className = "toast " + kind;
  element.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (element.hidden = true), kind === "bad" ? 7000 : 3500);
}

/** Wraps an action so any thrown message reaches the user instead of the console. */
async function run(action) {
  try {
    return await action();
  } catch (error) {
    toast(error.message, "bad");
    return null;
  }
}

// ---------------------------------------------------------------------------
// Brand theming — the accent colour IS the brand indicator
// ---------------------------------------------------------------------------

function applyBrandTheme() {
  const brand = state.brandFilter ? brandOf(state.brandFilter) : null;
  const root = document.documentElement.style;

  if (brand) {
    root.setProperty("--accent", brand.accent);
    root.setProperty("--accent-wash", brand.accentWash);
    $("#brand-glyph").textContent = brand.shortName;
    $("#brand-sub").textContent = brand.name;
  } else {
    root.removeProperty("--accent");
    root.removeProperty("--accent-wash");
    $("#brand-glyph").textContent = "TS";
    $("#brand-sub").textContent = "All brands";
  }
}

function renderBrandSwitch() {
  const options = [{ id: null, shortName: "All" }, ...state.brands];
  $("#brand-switch").innerHTML = options
    .map(
      (option) =>
        `<button data-brand="${option.id ?? ""}" class="${
          state.brandFilter === option.id ? "is-active" : ""
        }">${esc(option.shortName)}</button>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// Audiences view
// ---------------------------------------------------------------------------

function visibleAudiences() {
  return state.audiences.filter((a) => !state.brandFilter || a.brand === state.brandFilter);
}

function brandChip(brandId) {
  const brand = brandOf(brandId);
  if (!brand) return `<span class="chip">unbranded</span>`;
  return `<span class="chip brand" style="background:${esc(brand.accent)}">${esc(brand.shortName)}</span>`;
}

/** Worst finding wins — a blocked platform matters more than four fine ones. */
function readinessChip(audience) {
  if (audience.type === "geo") return `<span class="chip geo">no floor</span>`;
  const findings = audience.readiness?.findings || [];
  if (findings.some((f) => f.level === "blocked")) return `<span class="chip blocked">below floor</span>`;
  if (findings.some((f) => f.level === "thin")) return `<span class="chip thin">thin</span>`;
  if (findings.length) return `<span class="chip ok">ready</span>`;
  return "";
}

function renderAudiences() {
  const list = visibleAudiences();
  const active = list.filter((a) => a.status === "active");
  const lists = active.filter((a) => a.type !== "geo");
  const geos = active.filter((a) => a.type === "geo");
  const reach = lists.reduce((sum, a) => sum + (a.sizeHistory.at(-1)?.size ?? 0), 0);

  $("#stats").innerHTML = [
    stat("Contact audiences", fmt(lists.length), `${fmt(reach)} contacts total`),
    stat("Geo audiences", fmt(geos.length), "no size floor"),
    stat("Shows tracked", fmt(state.shows.length), `${state.shows.filter((s) => s.venue).length} with a venue`),
    stat(
      "Needs attention",
      fmt(lists.filter((a) => a.readiness?.findings?.some((f) => f.level === "blocked")).length),
      "below a platform floor"
    ),
  ].join("");

  $("#audience-scope").textContent = state.brandFilter
    ? `${brandOf(state.brandFilter).name} only`
    : "All brands — audiences are never mixed between them";

  const body = $("#audience-table tbody");
  $("#audience-empty").hidden = list.length > 0;
  $("#audience-table").hidden = list.length === 0;

  body.innerHTML = list
    .map((audience) => {
      const latest = audience.sizeHistory.at(-1);
      const isGeo = audience.type === "geo";
      const spec = audience.definition?.geo;
      const reachCell = isGeo
        ? `${spec?.window?.totalDays ?? "?"} days`
        : `<span class="num">${fmt(latest?.size)}</span>`;
      const trendCell = isGeo
        ? `${spec?.window?.runStart ?? ""} → ${spec?.window?.runEnd ?? ""}`
        : audience.sizeHistory.slice(-4).map((p) => fmt(p.size)).join(" → ") || "—";
      const destinations = audience.destinations.length
        ? audience.destinations.map((d) => `<span class="chip">${esc(d.platform)}</span>`).join("")
        : '<span class="hint">not set</span>';

      return `<tr class="clickable" data-id="${esc(audience.id)}">
        <td>
          <div class="aud-name">${esc(audience.name)}${
        audience.status !== "active" ? ' <span class="chip retired">retired</span>' : ""
      }</div>
          <div class="aud-id">${esc(audience.id)}</div>
        </td>
        <td>${brandChip(audience.brand)}</td>
        <td><span class="chip ${isGeo ? "geo" : ""}">${isGeo ? "geo" : "list"}</span> ${readinessChip(audience)}</td>
        <td>${esc(audience.shows.join(", ") || "—")}</td>
        <td class="right">${reachCell}</td>
        <td class="trend">${esc(trendCell)}</td>
        <td>${destinations}</td>
        <td class="trend">${esc(isGeo ? day(audience.createdAt) : day(latest?.at) || "never")}</td>
      </tr>`;
    })
    .join("");
}

function stat(key, value, sub) {
  return `<div class="stat"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div><div class="s">${esc(sub)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Audience detail drawer
// ---------------------------------------------------------------------------

function openDrawer(id) {
  const audience = state.audiences.find((a) => a.id === id);
  if (!audience) return;

  const isGeo = audience.type === "geo";
  const spec = audience.definition?.geo;
  const latest = audience.sizeHistory.at(-1);

  const sizeSection = isGeo
    ? `<section>
         <h4>Targeting spec</h4>
         <div class="pre">${esc(geoSpecText(spec))}</div>
       </section>`
    : `<section>
         <h4>Size over time</h4>
         ${
           audience.sizeHistory.length
             ? `<table class="grid compact"><thead><tr><th>Date</th><th class="right">Size</th><th class="right">Change</th><th>Note</th></tr></thead><tbody>${audience.sizeHistory
                 .map((point, index) => {
                   const previous = index > 0 ? audience.sizeHistory[index - 1].size : null;
                   const delta =
                     previous === null ? "—" : (point.size - previous >= 0 ? "+" : "") + fmt(point.size - previous);
                   return `<tr><td>${esc(day(point.at))}</td><td class="right num">${fmt(
                     point.size
                   )}</td><td class="right num">${esc(delta)}</td><td>${esc(point.note || "")}</td></tr>`;
                 })
                 .join("")}</tbody></table>`
             : '<p class="hint">Never measured. Press Refresh sizes.</p>'
         }
       </section>
       ${
         audience.readiness
           ? `<section><h4>Platform readiness</h4>
                <p class="hint">Assuming a ${Math.round(
                  audience.readiness.matchRateUsed * 100
                )}% match rate → about ${fmt(audience.readiness.estimatedMatched)} matched users.</p>
                ${audience.readiness.findings
                  .map(
                    (f) =>
                      `<div class="notice ${
                        f.level === "blocked" ? "bad" : f.level === "thin" ? "warn" : "good"
                      }"><b>${esc(f.platform)}</b> — ${esc(f.message)}</div>`
                  )
                  .join("")}
              </section>`
           : ""
       }`;

  $("#drawer").innerHTML = `
    <button class="btn btn-ghost btn-sm close" id="drawer-close">Close</button>
    <h2>${esc(audience.name)}</h2>
    <div class="aud-id">${esc(audience.id)}</div>
    <div style="margin-top:10px">${brandChip(audience.brand)} ${readinessChip(audience)}</div>

    <section>
      <h4>What this is</h4>
      <dl class="kv">
        <dt>Purpose</dt><dd>${esc(audience.purpose || "Not recorded")}</dd>
        <dt>Type</dt><dd>${isGeo ? "Geo — a place and a date window" : "List — contacts we hold"}</dd>
        <dt>Shows</dt><dd>${esc(audience.shows.join(", ") || "—")}</dd>
        ${isGeo ? "" : `<dt>Sources</dt><dd>${esc(audience.sources.join(", ") || "any")}</dd>`}
        ${isGeo ? "" : `<dt>HubSpot list</dt><dd>${esc(audience.hubspotListId ?? "none")}</dd>`}
        ${isGeo ? "" : `<dt>Current size</dt><dd class="num">${fmt(latest?.size)}</dd>`}
        <dt>Created</dt><dd>${esc(day(audience.createdAt))} by ${esc(audience.createdBy)}</dd>
      </dl>
    </section>

    ${sizeSection}

    <section>
      <h4>Where it is used</h4>
      ${
        audience.destinations.length
          ? `<table class="grid compact"><thead><tr><th>Platform</th><th>Status</th><th>Notes</th></tr></thead><tbody>${audience.destinations
              .map(
                (d) =>
                  `<tr><td>${esc(d.platform)}</td><td><span class="chip">${esc(
                    d.status
                  )}</span></td><td>${esc(d.notes || "")}</td></tr>`
              )
              .join("")}</tbody></table>`
          : '<p class="hint">Not recorded anywhere yet.</p>'
      }
      <div class="field-row" style="margin-top:12px">
        <div class="field">
          <label>Platform</label>
          <select id="dest-platform">${state.platforms
            .map((p) => `<option value="${esc(p)}">${esc(p)}</option>`)
            .join("")}</select>
        </div>
        <div class="field">
          <label>Status</label>
          <select id="dest-status">
            <option value="planned">planned</option>
            <option value="live" selected>live</option>
            <option value="paused">paused</option>
            <option value="removed">removed</option>
          </select>
        </div>
        <div class="field"><label>Notes</label><input id="dest-notes" placeholder="optional"></div>
      </div>
      <div class="actions">
        <button class="btn btn-primary btn-sm" id="dest-save">Record destination</button>
      </div>
    </section>

    ${
      audience.notes.length
        ? `<section><h4>Notes</h4>${audience.notes
            .map((n) => `<p class="hint"><b>${esc(day(n.at))}</b> ${esc(n.actor)}: ${esc(n.text)}</p>`)
            .join("")}</section>`
        : ""
    }

    <section>
      <h4>Add a note</h4>
      <div class="field"><input id="note-text" placeholder="Why this exists, what changed…"></div>
      <div class="actions"><button class="btn btn-sm" id="note-save">Save note</button></div>
    </section>
  `;

  $("#drawer").hidden = false;
  $("#scrim").hidden = false;

  $("#drawer-close").onclick = closeDrawer;
  $("#dest-save").onclick = () =>
    run(async () => {
      await api("/api/audiences/destination", {
        id: audience.id,
        platform: $("#dest-platform").value,
        status: $("#dest-status").value,
        notes: $("#dest-notes").value,
      });
      toast("Destination recorded", "good");
      await loadState();
      openDrawer(audience.id);
    });
  $("#note-save").onclick = () =>
    run(async () => {
      const text = $("#note-text").value.trim();
      if (!text) return;
      await api("/api/audiences/note", { id: audience.id, text });
      toast("Note saved", "good");
      await loadState();
      openDrawer(audience.id);
    });
}

function closeDrawer() {
  $("#drawer").hidden = true;
  $("#scrim").hidden = true;
}

function geoSpecText(spec) {
  if (!spec) return "No spec recorded.";
  const lines = [
    `Venue       ${spec.venue.name}`,
    `Coordinates ${spec.venue.lat}, ${spec.venue.lng}`,
    ``,
    `Show dates  ${spec.window.showStart} → ${spec.window.showEnd}`,
    `Run dates   ${spec.window.runStart} → ${spec.window.runEnd}  (${spec.window.totalDays} days)`,
    ``,
    `Rings`,
    ...spec.rings.map((r) => `  ${r.name.padEnd(8)} ${String(r.radiusMiles).padStart(3)} mi / ${r.radiusKm} km`),
    ``,
    `Presence setting`,
    `  ${spec.presenceSetting}`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Upload view
// ---------------------------------------------------------------------------

const SOURCE_NOTES = {
  booth_tablet: "Someone typed their own details at your booth. Consent is recorded as express opt-in.",
  badge_scan: "They handed you their badge to scan. Highest intent of any source.",
  roster_pre: "The organizer's list, before the show. The only input that exists early enough for pre-show ads.",
  roster_post: "The organizer's list, after the show.",
  referral: "Passed to you by someone else.",
};

function renderUpload() {
  const upload = state.upload;

  fillSelect($("#up-brand"), state.brands.map((b) => ({ value: b.id, label: b.name })), "Choose…");
  fillSelect(
    $("#up-show"),
    state.shows.map((s) => ({ value: s.id, label: `${s.name} (${s.startDate})` })),
    "Choose…"
  );
  fillSelect($("#up-source"), state.sources.map((s) => ({ value: s, label: s })));

  if (state.brandFilter) $("#up-brand").value = state.brandFilter;
  $("#source-note").textContent = SOURCE_NOTES[$("#up-source").value] || "";

  // File chip
  const chip = $("#file-chip");
  chip.hidden = !upload.filename;
  if (upload.filename) {
    chip.innerHTML = `<span class="name">${esc(upload.filename)}</span>
      <span class="meta">${fmt(upload.rowCount)} rows · ${upload.headers.length} columns</span>`;
  }
  $('[data-step="1"]').classList.toggle("is-done", Boolean(upload.filename));

  // Mapping table
  const body = $("#mapping-table tbody");
  if (!upload.headers.length) {
    body.innerHTML = `<tr><td colspan="3" class="hint">Choose a file first.</td></tr>`;
  } else {
    body.innerHTML = upload.fields
      .map((field) => {
        const selected = upload.mapping[field] || "";
        const sample = selected ? upload.sample.map((row) => row[selected]).find(Boolean) : "";
        const required = field === "email" || field === "phone";
        return `<tr>
          <td><b>${esc(field)}</b>${required ? ' <span class="hint">(one of these two is required)</span>' : ""}</td>
          <td><select data-field="${esc(field)}" class="map-select">
            <option value="">— not mapped —</option>
            ${upload.headers
              .map((h) => `<option value="${esc(h)}" ${h === selected ? "selected" : ""}>${esc(h)}</option>`)
              .join("")}
          </select></td>
          <td class="hint">${esc(sample || "")}</td>
        </tr>`;
      })
      .join("");
  }

  const ready = Boolean(upload.text && $("#up-brand").value && $("#up-show").value);
  $("#btn-preview").disabled = !ready;
  $("#btn-commit").disabled = !upload.preview || upload.preview.summary.committed;
  $('[data-step="2"]').classList.toggle("is-done", ready);
  $('[data-step="3"]').classList.toggle("is-done", Boolean(upload.mapping.email || upload.mapping.phone));
}

function fillSelect(select, options, placeholder) {
  const current = select.value;
  select.innerHTML =
    (placeholder ? `<option value="">${esc(placeholder)}</option>` : "") +
    options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  if (current) select.value = current;
}

function renderPreview(result) {
  const s = result.summary;
  const out = $("#preview-out");

  const banner = s.committed
    ? `<div class="notice good"><b>Committed.</b> ${fmt(s.created)} contacts created and ${fmt(
        s.updated
      )} updated in HubSpot. Refresh your audience sizes to see the effect.</div>`
    : `<div class="notice info"><b>Nothing has been written.</b> Check these numbers, then press Commit.</div>`;

  out.innerHTML = `
    ${banner}
    <div class="result-grid">
      ${resultTile("Rows read", fmt(s.rowsRead), "")}
      ${resultTile("Contacts", fmt(s.contacts), "good")}
      ${resultTile("New", fmt(s.created), "")}
      ${resultTile("Updates", fmt(s.updated), "")}
      ${resultTile("Merged", fmt(s.mergedWithinFile), s.mergedWithinFile ? "warn" : "")}
      ${resultTile("Rejected", fmt(s.rejected), s.rejected ? "bad" : "")}
    </div>
    ${
      result.rejectCount
        ? `<div class="notice bad"><b>${fmt(result.rejectCount)} row(s) rejected.</b>
             <ul>${result.rejects
               .slice(0, 8)
               .map((r) => `<li>row ${r.rowNumber}: ${esc(r.reason)}</li>`)
               .join("")}</ul>
             ${result.rejectCount > 8 ? `<p class="hint">…and ${fmt(result.rejectCount - 8)} more.</p>` : ""}
           </div>`
        : ""
    }
    ${
      result.review.length
        ? `<div class="notice warn"><b>${result.review.length} possible duplicate(s) need a human.</b>
             These matched on name and company only, which is right often enough to be useful and
             wrong often enough that nothing is merged automatically.
             <ul>${result.review.slice(0, 8).map((r) => `<li>${esc(r.email)}</li>`).join("")}</ul>
           </div>`
        : ""
    }`;
}

function resultTile(key, value, kind) {
  return `<div class="result ${kind}"><div class="k">${esc(key)}</div><div class="v">${esc(value)}</div></div>`;
}

// ---------------------------------------------------------------------------
// Shows view
// ---------------------------------------------------------------------------

function renderShows() {
  const shows = state.shows.filter(
    (show) => !state.brandFilter || !show.brands?.length || show.brands.includes(state.brandFilter)
  );

  $("#show-cards").innerHTML = shows.length
    ? shows.map(showCard).join("")
    : `<div class="panel"><p class="empty">No shows yet. Add one above.</p></div>`;
}

function showCard(show) {
  const brandChips = (show.brands || []).map(brandChip).join(" ");
  const audienceCount = state.audiences.filter((a) => a.shows.includes(show.id)).length;

  const venueBlock = show.venue
    ? `<div class="venue-known">
         <b>${esc(show.venue.name)}</b>
         <div class="coords">${esc(show.venue.lat)}, ${esc(show.venue.lng)}</div>
       </div>
       <div class="rings">
         ${(show.rings || [{ name: "venue", radiusMiles: 2 }, { name: "campus", radiusMiles: 5 }, { name: "metro", radiusMiles: 25 }])
           .map(
             (ring) =>
               `<div class="ring"><div class="n">${esc(ring.name)}</div><div class="r">${esc(
                 ring.radiusMiles
               )} mi</div></div>`
           )
           .join("")}
       </div>`
    : `<div class="notice warn">
         No venue yet, so this show cannot be geo-targeted. Look it up below — it takes a second and
         means you can reach everyone at the show without depending on list size.
       </div>
       <div class="field-row">
         <div class="field">
           <label>Venue name and city</label>
           <input class="venue-input" data-show="${esc(show.id)}" placeholder="Las Vegas Convention Center, Las Vegas, NV">
         </div>
       </div>`;

  return `<div class="show-card">
    <div class="head">
      <h3>${esc(show.name)}</h3>
      <span class="dates">${esc(show.startDate)} → ${esc(show.endDate)}</span>
      ${brandChips}
      <div class="topbar-spacer"></div>
      <span class="hint">${audienceCount} audience${audienceCount === 1 ? "" : "s"}</span>
    </div>
    <div class="body">
      ${show.notes ? `<div class="notice warn">${esc(show.notes)}</div>` : ""}
      ${venueBlock}
      <div class="actions">
        ${
          show.venue
            ? ""
            : `<button class="btn btn-primary btn-sm" data-research="${esc(show.id)}">Look up venue</button>`
        }
        ${
          show.venue
            ? `<button class="btn btn-primary btn-sm" data-create-aud="${esc(show.id)}">Create audiences…</button>`
            : ""
        }
      </div>
      <div class="create-slot" data-slot="${esc(show.id)}"></div>
    </div>
  </div>`;
}

/** The create-audience form, shown inline under a show. */
function createForm(showId) {
  const brandOptions = state.brands
    .map(
      (b) =>
        `<option value="${esc(b.id)}" ${state.brandFilter === b.id ? "selected" : ""}>${esc(b.name)}</option>`
    )
    .join("");

  return `<div class="panel" style="margin-top:14px">
    <div class="panel-head"><h2>Create audiences for this show</h2></div>
    <div class="panel-body">
      <div class="field-row">
        <div class="field">
          <label>Brand <span class="req">required</span></label>
          <select class="ca-brand"><option value="">Choose…</option>${brandOptions}</select>
        </div>
        <div class="field">
          <label>What to create</label>
          <select class="ca-type">
            <option value="both">Both — geo and contact list</option>
            <option value="geo">Geo only — the venue and dates</option>
            <option value="list">Contact list only</option>
          </select>
          <p class="field-note">Both is usually right: geo carries reach during the show, the contact list carries retargeting after it.</p>
        </div>
        <div class="field">
          <label>Purpose</label>
          <input class="ca-purpose" placeholder="Post-show retargeting for paid social">
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-sm ca-preview" data-show="${esc(showId)}">Preview</button>
        <button class="btn btn-primary btn-sm ca-commit" data-show="${esc(showId)}">Create</button>
        <button class="btn btn-ghost btn-sm ca-cancel" data-show="${esc(showId)}">Cancel</button>
      </div>
      <div class="ca-out"></div>
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// History view
// ---------------------------------------------------------------------------

const ACTION_TEXT = {
  "audience.created": (e) =>
    e.type === "geo"
      ? `<b>${esc(e.audienceName)}</b> created — geo, ${esc(e.venue)}, ${esc(e.runStart)} → ${esc(e.runEnd)}`
      : `<b>${esc(e.audienceName)}</b> created — HubSpot list ${esc(e.hubspotListId ?? "?")}`,
  "audience.refreshed": (e) =>
    `<b>${esc(e.audienceName)}</b> now ${fmt(e.size)}${
      e.delta === null || e.delta === undefined ? "" : ` (${e.delta >= 0 ? "+" : ""}${fmt(e.delta)})`
    }`,
  "audience.destination_set": (e) =>
    `<b>${esc(e.audienceName)}</b> → ${esc(e.platform)} is <i>${esc(e.status)}</i>`,
  "audience.retired": (e) => `<b>${esc(e.audienceName)}</b> retired at ${fmt(e.finalSize)}`,
  "import.committed": (e) =>
    `${esc(e.file)} → ${esc(e.showId)} / ${esc(e.source)}: ${fmt(e.created)} created, ${fmt(
      e.updated
    )} updated, ${fmt(e.rejected)} rejected`,
  "show.created": (e) => `<b>${esc(e.showName)}</b> added (${esc(e.startDate)} → ${esc(e.endDate)})`,
  "show.researched": (e) => `<b>${esc(e.showName)}</b> venue set to ${esc(e.venue)}`,
  note: (e) => `<b>${esc(e.audienceName)}</b>: ${esc(e.text)}`,
};

function renderHistory() {
  // Unbranded entries are portfolio-level (a show added, a venue researched)
  // and stay visible whichever brand is selected.
  const entries = state.history.filter(
    (e) => !state.brandFilter || !e.brand || e.brand === state.brandFilter
  );
  $("#feed").innerHTML = entries.length
    ? entries
        .map((entry) => {
          const describe = ACTION_TEXT[entry.action];
          return `<li>
            <span class="when">${esc(entry.at.replace("T", " ").slice(0, 16))}</span>
            <span class="act">${esc(entry.action)}</span>
            <span>${describe ? describe(entry) : esc(JSON.stringify(entry).slice(0, 160))}</span>
          </li>`;
        })
        .join("")
    : `<li><span class="hint">Nothing logged for this brand yet.</span></li>`;
}

// ---------------------------------------------------------------------------
// Render + events
// ---------------------------------------------------------------------------

function render() {
  applyBrandTheme();
  renderBrandSwitch();
  $$(".view").forEach((section) => (section.hidden = section.dataset.view !== state.view));
  $$(".tab").forEach((tab) => tab.classList.toggle("is-active", tab.dataset.view === state.view));

  if (state.view === "audiences") renderAudiences();
  if (state.view === "upload") renderUpload();
  if (state.view === "shows") renderShows();
  if (state.view === "history") renderHistory();
}

// --- global click handling, so re-rendered markup never loses its handlers ---
document.addEventListener("click", async (event) => {
  const target = event.target;

  const tab = target.closest(".tab");
  if (tab) {
    state.view = tab.dataset.view;
    return render();
  }

  const brandButton = target.closest("#brand-switch button");
  if (brandButton) {
    state.brandFilter = brandButton.dataset.brand || null;
    return render();
  }

  if (target.closest("#refresh-all")) {
    return run(async () => {
      toast("Reading sizes from HubSpot…");
      const result = await api("/api/audiences/refresh", { brand: state.brandFilter });
      await loadState();
      toast(`Refreshed ${result.refreshed.length} audience(s)`, "good");
    });
  }

  const row = target.closest("#audience-table tbody tr");
  if (row) return openDrawer(row.dataset.id);

  if (target.closest("#scrim")) return closeDrawer();

  // --- shows ---
  if (target.closest("#btn-add-show")) {
    return run(async () => {
      await api("/api/shows", {
        name: $("#show-name").value.trim(),
        startDate: $("#show-start").value,
        endDate: $("#show-end").value,
        city: $("#show-city").value.trim(),
      });
      $("#show-name").value = $("#show-city").value = "";
      toast("Show added", "good");
      await loadState();
    });
  }

  const research = target.closest("[data-research]");
  if (research) {
    const showId = research.dataset.research;
    const input = $(`.venue-input[data-show="${CSS.escape(showId)}"]`);
    return run(async () => {
      toast("Looking up the venue…");
      await api("/api/shows/research", { showId, venue: input?.value.trim() || "" });
      toast("Venue found — you can geo-target this show now", "good");
      await loadState();
    });
  }

  const createButton = target.closest("[data-create-aud]");
  if (createButton) {
    const showId = createButton.dataset.createAud;
    const slot = $(`.create-slot[data-slot="${CSS.escape(showId)}"]`);
    slot.innerHTML = slot.innerHTML ? "" : createForm(showId);
    return;
  }

  const cancel = target.closest(".ca-cancel");
  if (cancel) {
    $(`.create-slot[data-slot="${CSS.escape(cancel.dataset.show)}"]`).innerHTML = "";
    return;
  }

  const caButton = target.closest(".ca-preview, .ca-commit");
  if (caButton) {
    const commit = caButton.classList.contains("ca-commit");
    const slot = caButton.closest(".panel-body");
    return run(async () => {
      const result = await api("/api/audiences", {
        brand: $(".ca-brand", slot).value,
        showId: caButton.dataset.show,
        type: $(".ca-type", slot).value,
        purpose: $(".ca-purpose", slot).value,
        commit,
      });
      if (commit) {
        toast(`Created ${result.created.length} audience(s)`, "good");
        await loadState();
      } else {
        $(".ca-out", slot).innerHTML = `<div class="notice info"><b>Would create:</b><ul>${result.created
          .map((c) => `<li>${esc(c.id)}${c.listName ? ` — HubSpot list "${esc(c.listName)}"` : ""}</li>`)
          .join("")}</ul>Nothing has been created.</div>`;
      }
    });
  }

  // --- upload ---
  if (target.closest("#btn-preview") || target.closest("#btn-commit")) {
    const commit = Boolean(target.closest("#btn-commit"));
    return run(async () => {
      toast(commit ? "Writing to HubSpot…" : "Running preview…");
      const result = await api("/api/import", {
        text: state.upload.text,
        filename: state.upload.filename,
        brand: $("#up-brand").value,
        showId: $("#up-show").value,
        source: $("#up-source").value,
        mapping: state.upload.mapping,
        commit,
      });
      state.upload.preview = result;
      renderPreview(result);
      $("#btn-commit").disabled = commit;
      $('[data-step="4"]').classList.toggle("is-done", commit);
      if (commit) {
        toast("Committed to HubSpot", "good");
        await loadState();
        state.view = "upload";
        render();
        renderPreview(result);
      }
    });
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;

  if (target.matches(".map-select")) {
    const field = target.dataset.field;
    if (target.value) state.upload.mapping[field] = target.value;
    else delete state.upload.mapping[field];
    state.upload.preview = null;
    return renderUpload();
  }

  if (target.matches("#up-brand, #up-show, #up-source")) {
    state.upload.preview = null;
    return renderUpload();
  }

  if (target.matches("#file-input")) {
    const file = target.files[0];
    if (file) await acceptFile(file);
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !$("#drawer").hidden) closeDrawer();
});

// --- drag and drop ---
const drop = () => $("#drop");
["dragenter", "dragover"].forEach((name) =>
  document.addEventListener(name, (event) => {
    if (state.view !== "upload") return;
    event.preventDefault();
    drop()?.classList.add("is-over");
  })
);
["dragleave", "drop"].forEach((name) =>
  document.addEventListener(name, (event) => {
    event.preventDefault();
    drop()?.classList.remove("is-over");
  })
);
document.addEventListener("drop", async (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file && state.view === "upload") await acceptFile(file);
});

async function acceptFile(file) {
  const text = await file.text();
  await run(async () => {
    const inspected = await api("/api/upload/inspect", { text, filename: file.name });
    Object.assign(state.upload, inspected, { text, preview: null });
    renderUpload();
    $("#preview-out").innerHTML = "";
    toast(`Read ${fmt(inspected.rowCount)} rows`, "good");
  });
}

// ---------------------------------------------------------------------------
loadState().catch((error) => toast(error.message, "bad"));
