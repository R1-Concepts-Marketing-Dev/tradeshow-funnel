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

  // Upload is the job this tool exists for, so it is where you land.
  view: "upload",
  brandFilter: null, // null = all brands

  upload: {
    files: [],         // one entry per dropped file, each with its own mapping
    activeFile: 0,     // which file step 3 is showing
    fields: [],
    preview: null,
    showId: null,      // resolved once the show is created or matched
  },

  campaignTypes: [],
  campaigns: {
    showId: null,
    types: [],         // availability, per show
    selected: new Set(),
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
// Upload view — several files at once, each with its own source and mapping
// ---------------------------------------------------------------------------

const SOURCE_LABELS = {
  booth_tablet: "Booth tablet",
  badge_scan: "Badge scan",
  roster_pre: "Roster — pre-show",
  roster_post: "Roster — post-show",
  referral: "Referral",
};

const SOURCE_NOTES = {
  booth_tablet: "They typed their own details at your booth. Recorded as express opt-in.",
  badge_scan: "They handed you their badge to scan. Highest intent of any source.",
  roster_pre: "The organizer's list before the show. The only input that exists early enough for pre-show ads.",
  roster_post: "The organizer's list after the show.",
  referral: "Passed to you by someone else.",
};

/** Matches what has been typed in the show box against the known shows. */
function matchTypedShow() {
  const typed = $("#up-show").value.trim();
  if (!typed) return { typed, show: null };
  const needle = typed.toLowerCase();
  const show = state.shows.find(
    (s) => s.name.toLowerCase() === needle || s.id.toLowerCase() === needle
  );
  return { typed, show: show || null };
}

/** The files that are readable and therefore worth importing. */
function usableFiles() {
  return state.upload.files.filter((file) => file.ok);
}

function renderUpload() {
  const upload = state.upload;

  fillSelect($("#up-brand"), state.brands.map((b) => ({ value: b.id, label: b.name })), "Choose…");

  // The show field is a free-text box with suggestions, not a dropdown — you
  // should never have to leave this screen to add a show.
  $("#show-options").innerHTML = state.shows
    .map((s) => `<option value="${esc(s.name)}">${esc(s.startDate)} · ${esc(s.city || "")}</option>`)
    .join("");

  const { typed, show } = matchTypedShow();
  const isNew = Boolean(typed) && !show;
  $("#new-show").hidden = !isNew;
  $("#new-show-name").textContent = typed;
  $("#show-note").textContent = show
    ? `${show.name} — ${show.startDate} → ${show.endDate}${show.venue ? "" : " · no venue yet"}`
    : "Type any name. If it is new, you will be asked for the dates here.";

  if (state.brandFilter) $("#up-brand").value = state.brandFilter;

  renderFileList();
  renderFileTabs();
  renderMapping();

  const newShowOk = !isNew || ($("#ns-start").value && $("#ns-end").value);
  const ready = Boolean(usableFiles().length && $("#up-brand").value && typed && newShowOk);

  $("#btn-preview").disabled = !ready;
  $("#btn-commit").disabled = !upload.preview || upload.preview.totals.committed;
  $('[data-step="1"]').classList.toggle("is-done", usableFiles().length > 0);
  $('[data-step="2"]').classList.toggle("is-done", ready);
  $('[data-step="3"]').classList.toggle(
    "is-done",
    usableFiles().length > 0 && usableFiles().every((f) => f.mapping.email || f.mapping.phone)
  );
}

/** One row per dropped file: what we read, and what kind of list it is. */
function renderFileList() {
  const files = state.upload.files;
  const host = $("#file-list");

  if (!files.length) { host.innerHTML = ""; return; }

  host.innerHTML = files
    .map((file, index) => {
      if (!file.ok) {
        return `<div class="file-row is-bad">
          <div class="file-main">
            <div class="file-name">${esc(file.filename)}</div>
            <div class="file-meta">Could not read this — ${esc(file.error || "unknown format")}</div>
          </div>
          <button class="btn btn-sm file-drop-x" data-i="${index}">Remove</button>
        </div>`;
      }

      const noMap = !file.mapping.email && !file.mapping.phone;
      return `<div class="file-row ${noMap ? "is-warn" : ""}">
        <div class="file-main">
          <div class="file-name">${esc(file.filename)}</div>
          <div class="file-meta">
            <span class="num">${fmt(file.rowCount)}</span> rows ·
            ${file.headers.length} columns
            ${file.sheetName ? ` · sheet “${esc(file.sheetName)}”` : ""}
          </div>
          ${
            file.notes?.length
              ? `<div class="file-note">${file.notes.map(esc).join(" ")}</div>`
              : ""
          }
          ${noMap ? `<div class="file-note is-warn">No email or phone column found — map one at step 3.</div>` : ""}
        </div>
        <div class="file-source">
          <label>What is it?</label>
          <select class="file-src" data-i="${index}">
            ${state.sources
              .map((s) => `<option value="${esc(s)}" ${s === file.source ? "selected" : ""}>${esc(SOURCE_LABELS[s] || s)}</option>`)
              .join("")}
          </select>
          <p class="file-src-note">${esc(SOURCE_NOTES[file.source] || "")}</p>
        </div>
        <button class="btn btn-sm file-drop-x" data-i="${index}">Remove</button>
      </div>`;
    })
    .join("");
}

/** Tabs across the top of step 3, one per readable file. */
function renderFileTabs() {
  const files = usableFiles();
  const host = $("#file-tabs");

  if (files.length < 2) {
    host.innerHTML = "";
    host.hidden = true;
  } else {
    host.hidden = false;
    host.innerHTML = files
      .map((file) => {
        const index = state.upload.files.indexOf(file);
        const bad = !file.mapping.email && !file.mapping.phone;
        return `<button class="file-tab ${index === state.upload.activeFile ? "on" : ""} ${bad ? "bad" : ""}"
                        data-i="${index}">${esc(file.filename)}</button>`;
      })
      .join("");
  }

  // With tabs on screen the active filename is already obvious, so naming it
  // again in the heading is just noise. Only label it when there are no tabs.
  const active = state.upload.files[state.upload.activeFile];
  $("#mapping-for").textContent = files.length < 2 && active?.ok ? active.filename : "";
}

/** The column mapping table, for whichever file is selected. */
function renderMapping() {
  const body = $("#mapping-table tbody");
  const file = state.upload.files[state.upload.activeFile];

  if (!file || !file.ok) {
    body.innerHTML = `<tr><td colspan="3" class="hint">Drop a file first.</td></tr>`;
    return;
  }

  body.innerHTML = state.upload.fields
    .map((field) => {
      const selected = file.mapping[field] || "";
      const sample = selected ? file.sample.map((row) => row[selected]).find(Boolean) : "";
      const required = field === "email" || field === "phone";
      return `<tr>
        <td><b>${esc(field)}</b>${required ? ' <span class="hint">(one of these two is required)</span>' : ""}</td>
        <td><select data-field="${esc(field)}" class="map-select">
          <option value="">— not mapped —</option>
          ${file.headers
            .map((h) => `<option value="${esc(h)}" ${h === selected ? "selected" : ""}>${esc(h)}</option>`)
            .join("")}
        </select></td>
        <td class="hint">${esc(sample || "")}</td>
      </tr>`;
    })
    .join("");
}

function fillSelect(select, options, placeholder) {
  const current = select.value;
  select.innerHTML =
    (placeholder ? `<option value="">${esc(placeholder)}</option>` : "") +
    options.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join("");
  if (current) select.value = current;
}

/** Results for a whole batch: totals first, then a row per file. */
function renderPreview(result) {
  const t = result.totals;
  const out = $("#preview-out");

  const banner = t.committed
    ? `<div class="notice good"><b>Committed.</b> ${fmt(t.created)} contacts created and ${fmt(
        t.updated
      )} updated in HubSpot across ${fmt(t.files)} file(s).</div>`
    : `<div class="notice info"><b>Nothing has been written.</b> Check these numbers, then press Commit.</div>`;

  const perFile = result.results
    .map((r) => {
      if (!r.ok) {
        return `<tr class="bad-row">
          <td><b>${esc(r.filename)}</b></td>
          <td colspan="5">${esc(r.error)}</td>
        </tr>`;
      }
      const s = r.summary;
      return `<tr>
        <td>
          <b>${esc(r.filename)}</b>
          <div class="hint">${esc(SOURCE_LABELS[s.source] || s.source)}${
            s.sheetName ? ` · ${esc(s.sheetName)}` : ""
          }</div>
        </td>
        <td class="right num">${fmt(s.rowsRead)}</td>
        <td class="right num">${fmt(s.created)}</td>
        <td class="right num">${fmt(s.updated)}</td>
        <td class="right num">${fmt(s.mergedWithinFile)}</td>
        <td class="right num ${s.rejected ? "bad-num" : ""}">${fmt(s.rejected)}</td>
      </tr>`;
    })
    .join("");

  const allRejects = result.results.filter((r) => r.ok).flatMap((r) =>
    r.rejects.map((x) => ({ ...x, file: r.filename }))
  );
  const rejectTotal = result.results.filter((r) => r.ok).reduce((n, r) => n + r.rejectCount, 0);

  out.innerHTML = `
    ${banner}
    <div class="result-grid">
      ${resultTile("Files", fmt(t.files), t.failed ? "bad" : "")}
      ${resultTile("Rows read", fmt(t.rowsRead), "")}
      ${resultTile("People", fmt(t.contacts), "good")}
      ${resultTile("New", fmt(t.created), "")}
      ${resultTile("Updates", fmt(t.updated), "")}
      ${resultTile("In 2+ files", fmt(t.duplicatesAcrossFiles || 0), t.duplicatesAcrossFiles ? "warn" : "")}
      ${resultTile("Rejected", fmt(t.rejected), t.rejected ? "bad" : "")}
    </div>

    <div class="table-scroll">
      <table class="grid compact">
        <thead><tr>
          <th>File</th><th class="right">Rows</th><th class="right">New</th>
          <th class="right">Updated</th><th class="right">Merged</th><th class="right">Rejected</th>
        </tr></thead>
        <tbody>${perFile}</tbody>
      </table>
    </div>

    ${
      t.duplicatesAcrossFiles
        ? `<div class="notice info" style="margin-top:14px">
             <b>${fmt(t.duplicatesAcrossFiles)} ${t.duplicatesAcrossFiles === 1 ? "person appears" : "people appear"} in more than one of these files.</b>
             Counted once. Someone on the pre-show roster who then scanned their badge is one
             contact with both sources on it — which is the strongest signal a show produces.
           </div>`
        : ""
    }
    ${
      rejectTotal
        ? `<div class="notice bad" style="margin-top:14px"><b>${fmt(rejectTotal)} row(s) rejected.</b>
             <ul>${allRejects
               .slice(0, 8)
               .map((r) => `<li>${esc(r.file)} row ${r.rowNumber}: ${esc(r.reason)}</li>`)
               .join("")}</ul>
             ${rejectTotal > 8 ? `<p class="hint">…and ${fmt(rejectTotal - 8)} more.</p>` : ""}
           </div>`
        : ""
    }`;
}

// ---------------------------------------------------------------------------
// Step 5 — campaigns for the show that was just loaded
// ---------------------------------------------------------------------------

/** Loads which recipes are buildable for a show and shows the picker. */
async function openCampaignStep(showId) {
  const result = await api("/api/campaigns/available", { showId });
  state.campaigns.showId = showId;
  state.campaigns.types = result.types;
  // Pre-tick everything that can actually be built — the common case is "all
  // of them", and unticking is less work than ticking five boxes.
  state.campaigns.selected = new Set(
    result.types.filter((t) => t.available).map((t) => t.id)
  );
  $("#step-campaigns").hidden = false;
  renderCampaigns(result.show);
  $("#step-campaigns").scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderCampaigns(show) {
  const brand = brandOf($("#up-brand").value);
  $("#campaign-intro").innerHTML =
    `Pick what to run for <b>${esc(show.name)}</b>${brand ? ` as <b>${esc(brand.name)}</b>` : ""}. ` +
    `Each one creates an audience with the window, radius and source filter already set — ` +
    `you build the campaign itself in the ad platform.`;

  $("#campaign-grid").innerHTML = state.campaigns.types
    .map((type) => {
      const checked = state.campaigns.selected.has(type.id);
      return `<label class="campaign ${type.available ? "" : "is-blocked"} ${checked ? "is-on" : ""}">
        <input type="checkbox" class="ct" data-type="${esc(type.id)}"
               ${checked ? "checked" : ""} ${type.available ? "" : "disabled"}>
        <div class="campaign-body">
          <div class="campaign-title">
            ${esc(type.name)}
            <span class="chip ${type.kind === "geo" ? "geo" : ""}">${esc(type.kind)}</span>
          </div>
          <p class="campaign-summary">${esc(type.summary)}</p>
          <p class="campaign-creates"><b>Creates:</b> ${esc(type.creates)}</p>
          ${
            type.blockedReason
              ? `<p class="campaign-blocked">${esc(type.blockedReason)}
                   <button type="button" class="btn btn-sm ct-research" data-show="${esc(show.id)}">Look up venue</button>
                 </p>`
              : `<p class="campaign-name">→ <code>${esc(type.audienceName)}</code></p>`
          }
        </div>
      </label>`;
    })
    .join("");
}

/** Shows what the campaign step did, or would do. */
function renderCampaignResult(result, committed) {
  const lines = result.created
    .map((entry) => {
      const audience = entry.audience;
      const geo = audience.spec || audience.definition?.geo;
      const detail = geo
        ? `${geo.window.runStart} → ${geo.window.runEnd} · ${geo.rings.map((r) => r.name).join(", ")}`
        : audience.listName || audience.id;
      return `<li><b>${esc(entry.typeName)}</b> — <code>${esc(audience.id)}</code><br>
              <span class="hint">${esc(detail)}</span></li>`;
    })
    .join("");

  $("#campaign-out").innerHTML = `
    ${
      committed
        ? `<div class="notice good"><b>Created ${result.created.length} audience(s).</b>
             They are in the registry and on the Audiences tab. Build the campaigns
             themselves in Google and Meta — each audience carries the window and radius.</div>`
        : `<div class="notice info"><b>Nothing has been created.</b> This is what would be built.</div>`
    }
    ${lines ? `<ul class="campaign-result">${lines}</ul>` : ""}
    ${
      result.skipped.length
        ? `<div class="notice warn"><b>Skipped ${result.skipped.length}:</b>
             <ul>${result.skipped.map((sk) => `<li>${esc(sk.typeId)} — ${esc(sk.reason)}</li>`).join("")}</ul></div>`
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

/**
 * What a show has actually received, from the import log. This is the
 * "organize" half — at a glance, which lists are in and which are missing.
 */
function intakeFor(showId) {
  const imports = state.history.filter(
    (e) => e.action === "import.committed" && e.showId === showId
  );
  const bySource = {};
  for (const entry of imports) {
    const s = (bySource[entry.source] ||= { files: 0, created: 0, updated: 0, rejected: 0 });
    s.files += 1;
    s.created += entry.created || 0;
    s.updated += entry.updated || 0;
    s.rejected += entry.rejected || 0;
  }
  return bySource;
}

function showCard(show) {
  const brandChips = (show.brands || []).map(brandChip).join(" ");
  const audienceCount = state.audiences.filter((a) => a.shows.includes(show.id)).length;
  const intake = intakeFor(show.id);
  const SOURCE_ORDER = ["roster_pre", "booth_tablet", "badge_scan", "roster_post"];
  const intakeBlock = `<div class="intake">
    ${SOURCE_ORDER.map((src) => {
      const got = intake[src];
      return `<div class="intake-item ${got ? "got" : ""}">
        <div class="k">${esc(SOURCE_LABELS[src] || src)}</div>
        <div class="v">${got ? fmt(got.created + got.updated) : "—"}</div>
        <div class="s">${
          got
            ? `${got.files} file${got.files === 1 ? "" : "s"}${got.rejected ? ` · ${fmt(got.rejected)} rejected` : ""}`
            : "not loaded"
        }</div>
      </div>`;
    }).join("")}
  </div>`;

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
      ${intakeBlock}
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

  const fileTab = target.closest(".file-tab");
  if (fileTab) {
    state.upload.activeFile = Number(fileTab.dataset.i);
    return renderUpload();
  }

  const dropX = target.closest(".file-drop-x");
  if (dropX) {
    state.upload.files.splice(Number(dropX.dataset.i), 1);
    state.upload.activeFile = Math.max(0, Math.min(state.upload.activeFile, state.upload.files.length - 1));
    state.upload.preview = null;
    $("#preview-out").innerHTML = "";
    return renderUpload();
  }

  const row = target.closest("#audience-table tbody tr");
  if (row) return openDrawer(row.dataset.id);

  if (target.closest("#scrim")) return closeDrawer();

  // --- shows ---
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
      // Resolve the typed show name to a real show, creating it if new. This is
      // why the show field is a text box: no trip to another screen and back.
      const { typed } = matchTypedShow();
      const ensured = await api("/api/shows/ensure", {
        name: typed,
        startDate: $("#ns-start").value,
        endDate: $("#ns-end").value,
        city: $("#ns-city").value,
      });
      if (ensured.created) {
        toast(`Created show "${ensured.show.name}"`, "good");
        await loadState();
        state.view = "upload";
      }
      state.upload.showId = ensured.show.id;

      const files = usableFiles();
      toast(
        commit
          ? `Writing ${files.length} file${files.length === 1 ? "" : "s"} to HubSpot…`
          : "Running preview…"
      );

      const result = await api("/api/import/batch", {
        brand: $("#up-brand").value,
        showId: ensured.show.id,
        commit,
        files: files.map((file) => ({
          filename: file.filename,
          base64: file.base64,
          source: file.source,
          mapping: file.mapping,
        })),
      });

      state.upload.preview = result;
      renderUpload();
      renderPreview(result);
      $("#btn-commit").disabled = commit;
      $('[data-step="4"]').classList.toggle("is-done", commit);

      if (commit) {
        toast("Committed to HubSpot", "good");
        await loadState();
        state.view = "upload";
        render();
        renderPreview(result);
        // The list is in. Now the actual question: what do we run for it?
        await openCampaignStep(ensured.show.id);
      }
    });
  }

  // --- step 5: campaigns ---
  const ctResearch = target.closest(".ct-research");
  if (ctResearch) {
    return run(async () => {
      const show = state.shows.find((s) => s.id === ctResearch.dataset.show);
      const guess = prompt(
        "Venue name and city — the more complete, the better the match.",
        `${show?.city ? show.name + ", " + show.city : show?.name || ""}`
      );
      if (!guess) return;
      toast("Looking up the venue…");
      await api("/api/shows/research", { showId: ctResearch.dataset.show, venue: guess });
      toast("Venue found — geo campaigns unlocked", "good");
      await loadState();
      state.view = "upload";
      render();
      if (state.upload.preview) renderPreview(state.upload.preview);
      await openCampaignStep(ctResearch.dataset.show);
    });
  }

  const campaignButton = target.closest("#btn-campaign-preview, #btn-campaign-create");
  if (campaignButton) {
    const commit = campaignButton.id === "btn-campaign-create";
    return run(async () => {
      const typeIds = [...state.campaigns.selected];
      if (!typeIds.length) throw new Error("Pick at least one campaign type.");

      const result = await api("/api/campaigns", {
        brand: $("#up-brand").value,
        showId: state.campaigns.showId,
        typeIds,
        commit,
      });
      renderCampaignResult(result, commit);
      if (commit) {
        toast(`Created ${result.created.length} audience(s)`, "good");
        await loadState();
        state.view = "upload";
        render();
        if (state.upload.preview) renderPreview(state.upload.preview);
        $("#step-campaigns").hidden = false;
        renderCampaigns(state.shows.find((s) => s.id === state.campaigns.showId));
        renderCampaignResult(result, commit);
        $('[data-step="5"]').classList.add("is-done");
      }
    });
  }
});

document.addEventListener("change", async (event) => {
  const target = event.target;

  if (target.matches(".map-select")) {
    const file = state.upload.files[state.upload.activeFile];
    if (!file) return;
    const field = target.dataset.field;
    if (target.value) file.mapping[field] = target.value;
    else delete file.mapping[field];
    state.upload.preview = null;
    return renderUpload();
  }

  if (target.matches(".file-src")) {
    state.upload.files[Number(target.dataset.i)].source = target.value;
    state.upload.preview = null;
    return renderUpload();
  }

  if (target.matches("#up-brand, #up-show, #ns-start, #ns-end, #ns-city")) {
    state.upload.preview = null;
    return renderUpload();
  }

  if (target.matches(".ct")) {
    const id = target.dataset.type;
    if (target.checked) state.campaigns.selected.add(id);
    else state.campaigns.selected.delete(id);
    target.closest(".campaign")?.classList.toggle("is-on", target.checked);
    return;
  }

  if (target.matches("#file-input")) {
    if (target.files.length) await acceptFiles(target.files);
    target.value = ""; // so re-picking the same file still fires
  }
});

document.addEventListener("input", (event) => {
  if (event.target.matches("#up-show")) {
    state.upload.preview = null;
    renderUpload();
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
  const files = event.dataTransfer?.files;
  if (files?.length && state.view === "upload") await acceptFiles(files);
});

/** Browsers hand us bytes; the API wants base64 because JSON cannot hold binary. */
function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const CHUNK = 0x8000; // avoids blowing the argument limit on a big file
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Reads dropped files, asks the server what is in them, and adds them to the list. */
async function acceptFiles(fileList) {
  const incoming = [...fileList];
  if (!incoming.length) return;

  await run(async () => {
    toast(`Reading ${incoming.length} file${incoming.length === 1 ? "" : "s"}…`);

    const payload = await Promise.all(
      incoming.map(async (file) => ({
        filename: file.name,
        base64: toBase64(await file.arrayBuffer()),
      }))
    );

    const inspected = await api("/api/upload/inspect", { files: payload });
    state.upload.fields = inspected.fields;

    inspected.files.forEach((info, index) => {
      state.upload.files.push({
        ...info,
        base64: payload[index].base64,
        source: info.guessedSource || "roster_pre",
      });
    });

    // Show step 3 for the first readable file we just added.
    const firstNew = state.upload.files.findIndex((f) => f.ok && !f.seen);
    state.upload.activeFile = firstNew === -1 ? 0 : firstNew;
    state.upload.files.forEach((f) => (f.seen = true));
    state.upload.preview = null;

    renderUpload();
    $("#preview-out").innerHTML = "";

    const good = inspected.files.filter((f) => f.ok);
    const rows = good.reduce((n, f) => n + f.rowCount, 0);
    const bad = inspected.files.length - good.length;
    toast(
      `Read ${fmt(rows)} rows from ${good.length} file${good.length === 1 ? "" : "s"}` +
        (bad ? ` · ${bad} could not be read` : ""),
      bad ? "bad" : "good"
    );
  });
}

// ---------------------------------------------------------------------------
loadState().catch((error) => toast(error.message, "bad"));
