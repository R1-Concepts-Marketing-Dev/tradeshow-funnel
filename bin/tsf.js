#!/usr/bin/env node
// tsf.js — the one command. Run `tsf` with no arguments for help.
//
// EDIT THIS FILE IF: you are adding a command. Each command is a small function
// in COMMANDS below; keep the real work in src/ and keep this file about
// parsing arguments and printing results.

import { parseArgs } from "node:util";
import path from "node:path";
import fs from "node:fs";

import { ensureDataDirs } from "../src/config.js";
import * as hubspot from "../src/hubspot.js";
import * as registry from "../src/registry.js";
import * as audiences from "../src/audiences.js";
import * as ingest from "../src/ingest.js";
import * as geo from "../src/geo.js";
import * as brands from "../src/brands.js";
import { writeReport } from "../src/report.js";
import { setupProperties } from "../src/setup.js";

const num = (value) => (value == null ? "—" : Number(value).toLocaleString("en-US"));

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

const COMMANDS = {
  "setup": {
    summary: "Create the ts_* contact properties in HubSpot. Run this once, first.",
    options: { commit: { type: "boolean", default: false } },
    async run({ values }) {
      const result = await setupProperties({ commit: values.commit });
      for (const item of result.properties) {
        console.log(`  ${item.status.padEnd(9)} ${item.name}`);
        if (item.error) console.log(`            ${item.error.slice(0, 150)}`);
      }
      console.log(
        values.commit
          ? `\nDone. ${result.created} created, ${result.existing} already there.`
          : `\nPreview only — nothing written. Re-run with --commit to create them.`
      );
    },
  },

  "ui": {
    summary: "Open the web interface — upload lists and browse audiences.",
    // parseArgs has no "--no-x" negation, so the flag is named for what it does.
    options: { port: { type: "string", default: "4477" }, "no-open": { type: "boolean", default: false } },
    async run({ values }) {
      const { startServer } = await import("../src/server.js");
      const { url } = await startServer({ port: Number(values.port) });

      console.log(`\n  Trade Show Funnel is running at ${url}`);
      console.log("  Bound to localhost only. Press Ctrl+C to stop.\n");

      if (!values["no-open"]) {
        // Best effort — if the browser does not open, the URL is printed above.
        const opener = process.platform === "win32" ? "start" : process.platform === "darwin" ? "open" : "xdg-open";
        const { spawn } = await import("node:child_process");
        try {
          spawn(opener, [url], { shell: true, stdio: "ignore", detached: true }).unref();
        } catch {}
      }

      // Hold the process open until the user stops it.
      await new Promise(() => {});
    },
  },

  "tunnel": {
    summary: "Put the tool on a URL others can open, from this machine, for free.",
    options: { port: { type: "string", default: "4477" } },
    async run({ values }) {
      const port = Number(values.port);
      const tunnel = await import("../src/tunnel.js");
      const auth = await import("../src/auth.js");

      // Everything that must be true BEFORE a public URL exists. A tunnel
      // forwards to localhost, so nothing else in the stack can tell that the
      // tool just became reachable from the internet.
      const { blockers, warnings } = tunnel.preflight();
      if (blockers.length) {
        console.log("\n  Not opening a tunnel:\n");
        for (const problem of blockers) console.log(`  !  ${problem}\n`);
        process.exitCode = 1;
        return;
      }
      for (const warning of warnings) console.log(`\n  Note: ${warning}\n`);

      const { startServer } = await import("../src/server.js");
      await startServer({ port });
      console.log(`
  Serving on http://localhost:${port} — opening a tunnel…`);

      const { url, child } = await tunnel.openQuickTunnel({ port });

      const mode = auth.authMode();
      console.log(`
  ${"=".repeat(64)}

    ${url}

  ${"=".repeat(64)}

  Send that link to whoever is uploading. They will be asked for ${
    mode === "passphrase" ? "the passphrase" : `a ${loadConfigDomain()} Google account`
  }.

  This link lives as long as this window does. Close it, or let this PC
  sleep, and the link stops working — which is the point. A new one is
  handed out every time, so send the current link, not an old one.

  Press Ctrl+C to close the tunnel.
`);

      // Take the tunnel down with the tool. This matters more than it looks:
      // cloudflared forwards to a PORT, not to this process, so a stray one
      // left running would happily expose whatever binds that port next.
      //
      // Every exit path we can actually observe is covered. A hard kill
      // (taskkill /F, pulling the power) cannot be — no handler runs. If you
      // suspect that happened, check for a leftover:
      //   Get-Process cloudflared
      let closed = false;
      const shutDown = (code = 0) => {
        if (closed) return;
        closed = true;
        child.kill();
        process.exit(code);
      };
      process.on("SIGINT", () => shutDown(0));
      process.on("SIGTERM", () => shutDown(0));
      process.on("SIGHUP", () => shutDown(0));
      process.on("exit", () => child.kill());
      process.on("uncaughtException", (error) => {
        console.error(`\n  The tool crashed, so the tunnel is closing too:\n  ${error.message}\n`);
        shutDown(1);
      });

      // If cloudflared dies on its own, the link is gone — say so rather than
      // sitting there looking like it still works.
      child.on("exit", () => {
        console.log("\n  The tunnel closed. The link no longer works.\n");
        process.exit(1);
      });

      await new Promise(() => {});
    },
  },

  "imports": {
    summary: "List every import batch, newest first. Use the batch id to undo one.",
    async run() {
      const rows = [
        ...registry.readHistory({ action: "import.committed" }),
        ...registry.readHistory({ action: "tablet.claimed" }),
      ]
        .filter((e) => e.batchId)
        .sort((a, b) => (a.at < b.at ? 1 : -1));

      if (!rows.length) return console.log("No imports yet.");
      for (const e of rows) {
        console.log(`
  ${e.at.slice(0, 16).replace("T", " ")}  ${e.showId} / ${e.source}`);
        console.log(`    ${e.file || "(claimed from form)"} — ${num(e.created ?? e.contacts)} created, ${num(e.updated ?? 0)} updated`);
        console.log(`    ${e.batchId}`);
      }
      console.log("\n  Undo one with:  tsf imports reverse --batch <id>\n");
    },
  },

  "imports reverse": {
    summary: "Undo an import — un-stamps the show. Does not delete contacts.",
    options: { batch: { type: "string" }, commit: { type: "boolean", default: false } },
    async run({ values }) {
      require_(values, ["batch"]);
      const { reverseBatch } = await import("../src/reverse.js");
      const { summary } = await reverseBatch(values.batch, { commit: values.commit });

      console.log(`
  ${summary.file} → ${summary.showName} (${summary.source})`);
      console.log(`    imported          ${summary.importedAt.slice(0, 16).replace("T", " ")}`);
      console.log(`    contacts found    ${num(summary.found)}`);
      console.log(`    will un-stamp     ${num(summary.willUpdate)}`);
      console.log(`\n  ${summary.caveat}`);

      if (summary.testMode) {
        console.log(
          "\n  TEST MODE — nothing was changed.\n" +
            `  ${num(summary.wouldHaveWritten)} contact(s) would have been un-stamped.\n`
        );
      } else if (!summary.committed) {
        console.log("\n  Nothing was changed. Re-run with --commit.\n");
      } else {
        console.log("\n  Done. Refresh your audiences: tsf audience refresh --all\n");
        writeReport();
      }
    },
  },

  "doctor": {
    summary: "Check the setup — where the registry is, and whether credentials work.",
    async run() {
      const { PATHS, loadConfig } = await import("../src/config.js");
      const config = loadConfig();
      const { DATA_DIR_IS_SET } = await import("../src/config.js");
      const shared = DATA_DIR_IS_SET;

      console.log(`
  Registry   ${PATHS.data}`);
      if (shared) {
        console.log(`             from TSF_DATA_DIR — shared, and backed up if you push it`);
      } else {
        console.log(`             ! TSF_DATA_DIR is not set, so this is the repo's own ./data`);
        console.log(`             ! That folder is gitignored here, because this repo is public.`);
        console.log(`             ! Anything you do is invisible to everyone else and not backed up.`);
        console.log(`             ! Fix: clone tradeshow-funnel-data and point TSF_DATA_DIR at it.`);
      }

      const shows = registry.loadShows();
      const auds = registry.listAudiences();
      console.log(`             ${shows.length} show(s), ${auds.length} audience(s)`);

      console.log(`
  HubSpot    ${config.hubspot.refreshToken ? "refresh token present" : config.hubspot.accessToken ? "access token only (expires in 30 min)" : "! no credentials"}`);
      try {
        const props = await hubspot.get("/crm/v3/properties/contacts");
        const have = new Set((props?.results || []).map((p) => p.name));
        const { PROPERTIES } = await import("../src/setup.js");
        const missing = PROPERTIES.filter((p) => !have.has(p.name));
        console.log(missing.length
          ? `             ! ${missing.length} property missing — run: tsf setup --commit`
          : `             all ${PROPERTIES.length} ts_* properties present`);
      } catch (error) {
        console.log(`             ! ${error.message.slice(0, 90)}`);
      }

      console.log(`
  Meta       ${config.meta.accessToken && config.meta.adAccountId ? "credentials present" : "not set — show reports will have no paid social section"}`);
      const g = config.google;
      if (g.clientId && g.developerToken && g.customerId) {
        const { API_VERSION } = await import("../src/google.js");
        console.log(`  Google Ads customer ${g.customerId}, API ${API_VERSION}`);
        try {
          const { campaigns } = await import("../src/google.js");
          const rows = await campaigns({ since: "2026-01-01", until: "2026-12-31" });
          console.log(`             ${rows.length} campaign(s) readable`);
        } catch (error) {
          console.log(`             ! ${error.message.slice(0, 110)}`);
        }
      } else {
        console.log(`  Google Ads not set — show reports will have no paid search section`);
      }
      console.log("");
      if (!config.anthropic.apiKey) {
        console.log("  Claude     no key — columns are matched by name only, which still works");
        console.log("             Add ANTHROPIC_API_KEY to .env to turn it on. Only column names");
        console.log("             and masked value shapes are sent; contacts never leave.");
      } else {
        // Presence proves nothing. A revoked, mistyped or wrong-account key
        // looks identical until someone uploads a file and the read silently
        // falls back to name matching. So actually call the API.
        //
        // Listing models is free and checks both things that can be wrong:
        // whether the key is accepted, and whether the configured model is
        // one this account can reach.
        try {
          const { default: Anthropic } = await import("@anthropic-ai/sdk");
          const client = new Anthropic({
            apiKey: config.anthropic.apiKey,
            baseURL: config.anthropic.baseUrl,
          });
          const models = await client.models.list({ limit: 100 });
          const available = (models?.data || []).map((m) => m.id);
          const wanted = config.anthropic.model;

          if (available.includes(wanted)) {
            console.log(`  Claude     working — ${wanted}`);
            console.log("             Uploaded files get read and explained in plain English.");
          } else {
            console.log(`  Claude     ! key works, but this account cannot reach ${wanted}`);
            console.log(`             Available: ${available.slice(0, 4).join(", ")}${available.length > 4 ? "…" : ""}`);
            console.log("             Set TSF_ANTHROPIC_MODEL in .env to one of those.");
          }
        } catch (error) {
          const status = error?.status;
          const hint =
            status === 401
              ? "the key was rejected — check for a typo or a revoked key"
              : status === 403
                ? "the key is valid but not permitted to do this"
                : status === 429
                  ? "rate limited or out of credit"
                  : error.message;
          console.log(`  Claude     ! key is set but not usable: ${hint}`);
          console.log("             Uploads still work; columns are matched by name only.");
        }
      }

      const { authMode } = await import("../src/auth.js");
      const gate = {
        google: `Google, restricted to ${config.auth.allowedDomain}`,
        passphrase: "shared passphrase — fine for a tunnel, see docs/SHARING.md",
        none: "none — local use only, which is the default",
      }[authMode()];
      console.log(
        config.testMode
          ? "  Test mode  ON — reads are real, every write is refused"
          : "  Test mode  off — writes go to the live HubSpot portal"
      );
      console.log(`  Sign-in    ${gate}`);

      const { findCloudflared } = await import("../src/tunnel.js");
      const cf = findCloudflared();
      console.log(`  Tunnel     ${
        cf.ok
          ? `cloudflared ready — run: tsf tunnel`
          : "cloudflared not installed, so `tsf tunnel` cannot share a link yet"
      }`);
      console.log("");
    },
  },

  "publish": {
    summary: "Build the encrypted page the team can open. Nothing is uploaded — you place the file.",
    options: {
      passphrase: { type: "string" },
      out: { type: "string" },
      force: { type: "boolean", default: false },
      deploy: { type: "boolean", default: false },
    },
    async run({ values }) {
      // No require_ here — the passphrase may come from .env instead, and
      // publish() gives a better message than a generic missing-flag error.
      const { publish } = await import("../src/publish.js");

      const result = publish({
        passphrase: values.passphrase,
        outFile: values.out,
        force: values.force,
      });

      console.log(`
  Wrote ${path.relative(process.cwd(), result.file)}`);
      console.log(`    ${(result.bytes / 1024).toFixed(0)} KB · ${result.shows} show(s) · ${result.audiences} audience(s)`);
      console.log(`    Counts and spend only — no contact details are in it.`);

      for (const warning of result.warnings) console.log(`
  ! ${warning}`);

      if (!values.deploy) {
        console.log(`
  Not deployed. Add --deploy to push it live, or host the file yourself.
`);
        return;
      }

      const { deploy } = await import("../src/publish.js");
      const outcome = deploy(result.file);

      if (!outcome.pushed) {
        console.log(`
  ${outcome.reason}
`);
        return;
      }

      // Work out the Pages URL from the remote, rather than hardcoding it.
      const { execFileSync } = await import("node:child_process");
      const remote = execFileSync("git", ["remote", "get-url", "origin"], { encoding: "utf8" }).trim();
      const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
      const url = match
        ? `https://${match[1].toLowerCase()}.github.io/${match[2]}/`
        : "(check the repo's Pages settings)";

      console.log(`
  Pushed to the ${outcome.branch} branch.`);
      console.log(`  Live at ${url}`);
      console.log(`  Give it a minute the first time — Pages has to build.
`);
      console.log(`  Share the link and the passphrase separately.
`);
    },
  },

  "show meta-names": {
    summary: "The Meta campaign and ad set names to use for a show, tagged so the report finds them.",
    options: { id: { type: "string" }, brand: { type: "string" } },
    async run({ values }) {
      require_(values, ["id", "brand"]);
      const { suggestedNames } = await import("../src/metaNaming.js");
      const { CAMPAIGN_TYPES, availableFor } = await import("../src/campaigns.js");

      const show = registry.loadShows().find((s) => s.id === values.id);
      if (!show) throw new Error(`No show "${values.id}".`);
      const brand = brands.requireBrand(values.brand);
      const usable = availableFor(show).filter((t) => t.available && t.kind === "geo");

      console.log(`
  Paste these into Meta. Everything before the bracket is yours;`);
      console.log(`  the tool only reads the [tsf:...] part.
`);
      for (const line of suggestedNames(show, brand, usable)) {
        console.log(`  ${line.what}`);
        console.log(`    ${line.name}
`);
      }
      console.log(`  Any ad set carrying the tag counts towards this show's report,`);
      console.log(`  whatever else is in the name.
`);
    },
  },

  "export show": {
    summary: "Export a show report — contacts, email, paid social, ad images.",
    options: {
      id: { type: "string" },
      "no-images": { type: "boolean", default: false },
      out: { type: "string" },
    },
    async run({ values }) {
      require_(values, ["id"]);
      const reporting = await import("../src/reporting.js");

      console.log(`
  Gathering ${values.id}…`);
      const { report, directory, images } = await reporting.exportShowReport(values.id, {
        withImages: !values["no-images"],
        outDir: values.out,
      });

      const captured = report.intake.totals.created + report.intake.totals.updated;
      console.log(`
  ${report.show.name}`);
      console.log(`    contacts captured   ${num(captured)}`);
      console.log(`    audiences           ${num(report.audiences.length)}`);
      console.log(`    marketing emails    ${num(report.email.emails.length)}`);
      console.log(`    meta ads            ${num(report.paid.ads.length)}`);
      if (report.paid.totals) {
        console.log(`    spend               $${report.paid.totals.spend.toFixed(2)}`);
      }
      console.log(`    creative saved      ${num(images.length)}`);

      for (const problem of report.problems) console.log(`
  ! ${problem}`);

      console.log(`
  Written to ${path.relative(process.cwd(), directory)}`);
      console.log(`    report.md    the readable one, for management`);
      console.log(`    report.json  the same data, for anything else`);
      if (images.length) console.log(`    creatives/   ${images.length} ad image(s)`);
      console.log("");
    },
  },

  "mcp": {
    summary: "Run the MCP server so Claude can answer questions about the registry.",
    async run() {
      const { startMcpServer } = await import("../src/mcp.js");
      startMcpServer();
      // Held open by stdin; Claude closes it when it is done.
      await new Promise(() => {});
    },
  },

  "tablet claim": {
    summary: "Pull booth tablet sign-ups for a show, by its linked form and dates.",
    options: {
      brand: { type: "string" },
      show: { type: "string" },
      buffer: { type: "string" },
      commit: { type: "boolean", default: false },
      "consent-text": { type: "string", default: "" },
    },
    async run({ values }) {
      require_(values, ["brand", "show"]);
      const tablet = await import("../src/tablet.js");
      const show = registry.loadShows().find((s) => s.id === values.show);
      if (!show) throw new Error(`No show "${values.show}".`);

      const result = await tablet.claimTabletContacts({
        brand: values.brand,
        show,
        bufferDays: values.buffer ? Number(values.buffer) : undefined,
        commit: values.commit,
        consentTextId: values["consent-text"],
      });

      const s = result.summary;
      console.log(`\n  ${s.showName} — booth tablet`);
      console.log(`  window              ${s.window.from.slice(0, 10)} → ${s.window.to.slice(0, 10)}  (±${s.window.bufferDays}d)`);
      for (const form of s.perForm) {
        console.log(`  form ${form.formId}`);
        console.log(`    ${num(form.inRange)} of ${num(form.seen)} submissions fall inside the window`);
      }
      console.log(`  contacts            ${num(s.contacts)}`);
      console.log(`  merged              ${num(s.mergedWithinBatch)}`);
      console.log(`  rejected            ${num(s.rejected)}`);
      console.log(`  outside the window  ${num(s.submissionsOutsideWindow)}  (left alone)`);

      if (!values.commit) {
        console.log("\nNothing was written. Re-run with --commit.\n");
      } else {
        console.log("\nClaimed. Refresh your audiences: tsf audience refresh --all\n");
        writeReport();
      }
    },
  },

  "campaign types": {
    summary: "List the campaign recipes you can build for a show.",
    async run() {
      const { CAMPAIGN_TYPES } = await import("../src/campaigns.js");
      for (const type of CAMPAIGN_TYPES) {
        console.log(`\n  ${type.id}  [${type.kind}]${type.needsVenue ? "  (needs a venue)" : ""}`);
        console.log(`    ${type.name}`);
        console.log(`    ${type.summary}`);
        console.log(`    Creates: ${type.creates}`);
      }
      console.log("");
    },
  },

  "campaign create": {
    summary: "Build campaign audiences for a show. --types a,b or --all.",
    options: {
      brand: { type: "string" },
      show: { type: "string" },
      types: { type: "string", default: "" },
      all: { type: "boolean", default: false },
      commit: { type: "boolean", default: false },
    },
    async run({ values }) {
      require_(values, ["brand", "show"]);
      const campaigns = await import("../src/campaigns.js");
      const show = registry.loadShows().find((s) => s.id === values.show);
      if (!show) throw new Error(`No show "${values.show}".`);

      const available = campaigns.availableFor(show);
      const typeIds = values.all
        ? available.filter((t) => t.available).map((t) => t.id)
        : splitCsv(values.types);

      if (!typeIds.length) {
        throw new Error("Pick types with --types, or use --all. See: tsf campaign types");
      }

      const result = await campaigns.createCampaigns({
        brand: values.brand,
        show,
        typeIds,
        commit: values.commit,
      });

      for (const entry of result.created) {
        const audience = entry.audience;
        const geo = audience.spec || audience.definition?.geo;
        console.log(`  ${values.commit ? "created" : "would create"}  ${entry.typeName}`);
        console.log(`    ${audience.id}`);
        if (geo) console.log(`    ${geo.window.runStart} → ${geo.window.runEnd}  rings: ${geo.rings.map((r) => r.name).join(", ")}`);
      }
      for (const entry of result.skipped) {
        console.log(`  skipped   ${entry.typeId} — ${entry.reason}`);
      }
      if (!values.commit) console.log("\nNothing was created. Re-run with --commit.");
      else writeReport();
    },
  },

  "brands": {
    summary: "List the brands and their HubSpot business units.",
    async run() {
      for (const brand of brands.loadBrands()) {
        console.log(
          `  ${brand.id.padEnd(6)} ${brand.name.padEnd(26)} ` +
            `BU ${brand.hubspotBusinessUnitId || "(not set)"}`
        );
      }
      console.log("\nEdit data/brands.json to add a brand or fill in a business unit id.");
    },
  },

  "show add": {
    summary: "Register a trade show.",
    options: {
      id: { type: "string" },
      name: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      city: { type: "string", default: "" },
      brands: { type: "string", default: "" },
    },
    async run({ values }) {
      require_(values, ["name", "start", "end"]);
      const id = values.id || registry.slugify(values.name);
      // Which brands exhibit here. Both by default — most shows carry both booths.
      const showBrands = values.brands
        ? splitCsv(values.brands).map((b) => brands.requireBrand(b).id)
        : brands.loadBrands().map((b) => b.id);
      const show = registry.addShow({
        id,
        name: values.name,
        startDate: values.start,
        endDate: values.end,
        city: values.city,
        brands: showBrands,
      });
      console.log(`Added show "${show.name}" as \`${show.id}\`.`);
      writeReport();
    },
  },

  "show list": {
    summary: "List registered shows.",
    async run() {
      const shows = registry.loadShows();
      if (!shows.length) return console.log("No shows yet. Add one with `tsf show add`.");
      for (const show of shows) {
        console.log(
          `  ${show.id.padEnd(24)} ${show.name}  (${show.startDate} → ${show.endDate})` +
            (show.formIds?.length ? `  forms: ${show.formIds.join(", ")}` : "")
        );
      }
    },
  },

  "show link-form": {
    summary: "Attach a HubSpot form ID to a show, so tablet sign-ups can be traced.",
    options: { show: { type: "string" }, form: { type: "string" } },
    async run({ values }) {
      require_(values, ["show", "form"]);
      const shows = registry.loadShows();
      const show = shows.find((s) => s.id === values.show);
      if (!show) throw new Error(`No show "${values.show}".`);
      if (!show.formIds.includes(values.form)) show.formIds.push(values.form);
      registry.saveShows(shows);
      console.log(`Linked form ${values.form} to ${show.name}.`);
      writeReport();
    },
  },

  "show research": {
    summary: "Look up a show's venue and coordinates, so you can geo-target it.",
    options: {
      id: { type: "string" },
      venue: { type: "string" },
      lat: { type: "string" },
      lng: { type: "string" },
    },
    async run({ values }) {
      require_(values, ["id"]);
      const shows = registry.loadShows();
      const show = shows.find((s) => s.id === values.id);
      if (!show) throw new Error(`No show "${values.id}".`);

      let venue;
      if (values.lat && values.lng) {
        // Manual override, for when the geocoder cannot find a venue.
        venue = {
          name: values.venue || show.name,
          lat: Number(values.lat),
          lng: Number(values.lng),
          displayName: "",
        };
      } else {
        const query = values.venue || `${show.name} ${show.city || ""}`.trim();
        console.log(`Looking up "${query}" …`);
        const hit = await geo.geocode(query);
        if (!hit) {
          throw new Error(
            `Could not find "${query}". Try a fuller name (e.g. "Las Vegas Convention Center, Las Vegas NV"),\n` +
              `or pass coordinates directly: --lat 36.1316 --lng -115.1520`
          );
        }
        venue = { name: values.venue || query, ...hit };
      }

      registry.setShowVenue(show.id, venue);
      console.log(`\n  ${venue.name}`);
      if (venue.displayName) console.log(`  ${venue.displayName}`);
      console.log(`  ${venue.lat}, ${venue.lng}\n`);

      const spec = geo.buildGeoSpec({ ...show, venue });
      console.log(geo.formatGeoSpec(spec));
      console.log(`\nCreate the geo audience with:`);
      console.log(`  tsf audience create --type geo --show ${show.id} --commit`);
      writeReport();
    },
  },

  "show geo": {
    summary: "Print the geo-targeting spec for a show without creating anything.",
    options: {
      id: { type: "string" },
      "lead-days": { type: "string" },
      "lag-days": { type: "string" },
    },
    async run({ values }) {
      require_(values, ["id"]);
      const show = registry.loadShows().find((s) => s.id === values.id);
      if (!show) throw new Error(`No show "${values.id}".`);
      const spec = geo.buildGeoSpec(show, {
        leadDays: values["lead-days"] ? Number(values["lead-days"]) : undefined,
        lagDays: values["lag-days"] ? Number(values["lag-days"]) : undefined,
      });
      console.log(geo.formatGeoSpec(spec));
    },
  },

  "import": {
    summary: "Read a CSV, merge it, and preview. Add --commit to actually write.",
    options: {
      file: { type: "string" },
      brand: { type: "string" },
      show: { type: "string" },
      source: { type: "string" },
      commit: { type: "boolean", default: false },
      profile: { type: "string" },
      "save-profile": { type: "string" },
      "consent-text": { type: "string", default: "" },
    },
    async run({ values }) {
      require_(values, ["file", "brand", "show", "source"]);
      const mappings = ingest.loadMappings();
      const saved = values.profile ? mappings[values.profile] : undefined;
      if (values.profile && !saved) {
        console.log(`(no saved profile "${values.profile}" yet — guessing columns)`);
      }

      const result = await ingest.ingestFile({
        file: values.file,
        brand: values.brand,
        showId: values.show,
        source: values.source,
        mapping: saved,
        commit: values.commit,
        consentTextId: values["consent-text"],
      });

      console.log("\nColumn mapping used:");
      for (const [field, header] of Object.entries(result.mapping)) {
        console.log(`  ${field.padEnd(14)} <- "${header}"`);
      }

      const s = result.summary;
      console.log("\n" + (s.committed ? "Committed" : "Dry-run preview") + ":");
      console.log(`  brand               ${brands.brandLabel(s.brand)}`);
      console.log(`  rows read           ${num(s.rowsRead)}`);
      console.log(`  contacts to write   ${num(s.contacts)}`);
      console.log(`    · created         ${num(s.created)}`);
      console.log(`    · updated         ${num(s.updated)}`);
      console.log(`  merged within file  ${num(s.mergedWithinFile)}`);
      console.log(`  needs review        ${num(s.needsReview)}`);
      console.log(`  rejected            ${num(s.rejected)}`);

      if (result.rejects.length) {
        const file = ingest.writeRejects(values.file, result.rejects);
        console.log(`\n  Rejected rows written to ${path.basename(file)}`);
        for (const reject of result.rejects.slice(0, 5)) {
          console.log(`    row ${reject.rowNumber}: ${reject.reason}`);
        }
        if (result.rejects.length > 5) console.log(`    … and ${result.rejects.length - 5} more`);
      }

      if (result.review.length) {
        console.log(`\n  ${result.review.length} possible duplicate(s) need a human:`);
        for (const item of result.review.slice(0, 5)) {
          console.log(`    ${item.contact.email || item.contact.phone} — ${item.reason}`);
        }
      }

      if (values["save-profile"]) {
        ingest.saveMapping(values["save-profile"], result.mapping);
        console.log(`\n  Saved column mapping as profile "${values["save-profile"]}".`);
      }

      if (s.testMode) {
        console.log(
          "\n  TEST MODE — this was a full dry run.\n" +
            `  ${num(s.wouldHaveWritten)} contact(s) would have been written to HubSpot.\n` +
            "  Every number above is real. Nothing was sent.\n\n" +
            "  Set TSF_TEST_MODE=false in .env when you are ready to commit."
        );
      } else if (!s.committed) {
        console.log("\nNothing was written. Re-run with --commit when the preview looks right.");
      } else {
        console.log("\nCommitted. Refresh your audiences next: tsf audience refresh --all");
        writeReport();
      }
    },
  },

  "audience create": {
    summary:
      "Create an audience. --type list (people you collected), geo (the show " +
      "venue and dates), or both.",
    options: {
      type: { type: "string", default: "list" }, // list | geo | both
      brand: { type: "string" },
      name: { type: "string" },
      purpose: { type: "string", default: "" },
      show: { type: "string" },                  // required for geo
      shows: { type: "string", default: "" },    // for list audiences
      sources: { type: "string", default: "" },
      "lead-days": { type: "string" },
      "lag-days": { type: "string" },
      commit: { type: "boolean", default: false },
    },
    async run({ values }) {
      const type = values.type;
      if (!["list", "geo", "both"].includes(type)) {
        throw new Error(`--type must be list, geo, or both (got "${type}").`);
      }
      // Fail before touching HubSpot if the brand is missing or wrong.
      const brand = brands.requireBrand(values.brand);

      // With --type both, one half already existing should not stop the other.
      // Only a genuine failure of the half you asked for is an error.
      const tolerate = type === "both";

      // ---- geo ------------------------------------------------------------
      if (type === "geo" || type === "both") {
        require_(values, ["show"]);
        const show = registry.loadShows().find((s) => s.id === values.show);
        if (!show) throw new Error(`No show "${values.show}".`);

        try {
          const result = await audiences.createGeoAudience({
          brand: brand.id,
          show,
          name: type === "both" ? `${show.name} — Geo` : values.name,
          purpose: values.purpose,
          leadDays: values["lead-days"] ? Number(values["lead-days"]) : undefined,
          lagDays: values["lag-days"] ? Number(values["lag-days"]) : undefined,
          dryRun: !values.commit,
        });

        if (result.dryRun) {
          console.log(`Would create geo audience \`${result.id}\`:\n`);
          console.log(geo.formatGeoSpec(result.spec));
          console.log("\nNothing was created. Re-run with --commit.\n");
        } else {
          const spec = result.definition.geo;
          console.log(`Created geo audience \`${result.id}\`.`);
          console.log(`  ${spec.venue.name} — ${spec.window.runStart} → ${spec.window.runEnd} (${spec.window.totalDays} days)`);
          console.log(`  Set it up with: tsf audience show --id ${result.id}\n`);
        }
        } catch (error) {
          if (!tolerate || !/already exists/.test(error.message)) throw error;
          console.log(`Geo audience already exists — leaving it alone.`);
        }
      }

      // ---- list -----------------------------------------------------------
      if (type === "list" || type === "both") {
        const shows = values.shows ? splitCsv(values.shows) : (values.show ? [values.show] : []);
        const sources = splitCsv(values.sources);
        const name = type === "both"
          ? `${(registry.loadShows().find((s) => s.id === values.show)?.name) || values.show} — Contacts`
          : values.name;
        if (!name) throw new Error("Missing required option: --name");

        const result = await audiences.createAudience({
          brand: brand.id,
          name,
          purpose: values.purpose,
          shows,
          sources,
          dryRun: !values.commit,
        });

        if (result.dryRun) {
          console.log(`Would create list audience \`${result.id}\`:`);
          console.log(`  name     ${name}`);
          console.log(`  shows    ${shows.join(", ") || "(any)"}`);
          console.log(`  sources  ${sources.join(", ") || "(any)"}`);
          console.log("\nNothing was created. Re-run with --commit.");
        } else {
          const size = result.sizeHistory.at(-1)?.size ?? 0;
          console.log(`Created list audience \`${result.id}\` (HubSpot list ${result.hubspotListId}), size ${num(size)}.`);
          console.log("A new dynamic list can read 0 until HubSpot evaluates it —");
          console.log(`run \`tsf audience refresh --id ${result.id}\` in a few minutes.`);
        }
      }

      if (values.commit) writeReport();
    },
  },

  "audience list": {
    summary: "Show every audience and its current size. --brand to scope.",
    options: { brand: { type: "string" } },
    async run({ values }) {
      const brand = values.brand ? brands.requireBrand(values.brand).id : null;
      const all = registry.listAudiences({ brand });
      if (!all.length) return console.log("No audiences yet. Create one with `tsf audience create`.");
      for (const audience of all) {
        const latest = audience.sizeHistory.at(-1);
        const mark = audience.status === "active" ? " " : "×";
        const type = (audience.type || "list").padEnd(4);
        const brandTag = brands.brandLabel(audience.brand).padEnd(4);
        const size = audience.type === "geo"
          ? (audience.definition.geo?.window?.totalDays ?? "?") + "d"
          : num(latest?.size);
        console.log(
          `${mark} ${brandTag} ${type} ${audience.id.padEnd(30)} ${String(size).padStart(9)}  ` +
            `${audience.destinations.map((d) => d.platform).join(",") || "—"}`
        );
      }
    },
  },

  "audience show": {
    summary: "Everything we know about one audience.",
    options: { id: { type: "string" } },
    async run({ values }) {
      require_(values, ["id"]);
      const audience = registry.loadAudience(values.id);
      if (!audience) throw new Error(`No audience "${values.id}".`);

      console.log(`${audience.name}  [${audience.status}]`);
      console.log(`  purpose      ${audience.purpose || "(not recorded)"}`);
      console.log(`  created      ${audience.createdAt.slice(0, 10)} by ${audience.createdBy}`);
      console.log(`  brand        ${brands.brandLabel(audience.brand)}`);
      console.log(`  type         ${audience.type || "list"}`);
      console.log(`  hubspot list ${audience.hubspotListId ?? "(none)"}`);
      console.log(`  shows        ${audience.shows.join(", ") || "—"}`);
      console.log(`  sources      ${audience.sources.join(", ") || "—"}`);

      // A geo audience has no members and no size — its spec IS its detail.
      // Platform floors do not apply, so the readiness check below is skipped.
      if (audience.type === "geo") {
        console.log("");
        console.log(geo.formatGeoSpec(audience.definition.geo));
        printRecentHistory(audience);
        return;
      }

      console.log("\n  size history");
      for (const point of audience.sizeHistory) {
        console.log(`    ${point.at.slice(0, 10)}  ${String(num(point.size)).padStart(9)}  ${point.note || ""}`);
      }

      if (audience.destinations.length) {
        console.log("\n  destinations");
        for (const d of audience.destinations) {
          console.log(`    ${d.platform.padEnd(14)} ${d.status.padEnd(9)} ${d.notes || ""}`);
        }
      }

      const readiness = audiences.checkReadiness(audience);
      console.log(`\n  readiness (assuming ${Math.round(readiness.matchRateUsed * 100)}% match rate)`);
      for (const finding of readiness.findings) {
        console.log(`    ${finding.level.padEnd(8)} ${finding.platform.padEnd(14)} ${finding.message}`);
      }

      printRecentHistory(audience);
    },
  },

  "audience refresh": {
    summary: "Re-read sizes from HubSpot and log them.",
    options: {
      id: { type: "string" },
      all: { type: "boolean", default: false },
      brand: { type: "string" },
      note: { type: "string", default: "" },
    },
    async run({ values }) {
      if (values.all) {
        const scope = values.brand ? brands.requireBrand(values.brand).id : null;
        const results = await audiences.refreshAll(values.note || "bulk refresh", { brand: scope });
        for (const result of results) {
          if (result.error) console.log(`  ! ${result.id}: ${result.error}`);
          else console.log(`  ${result.id.padEnd(34)} ${num(result.sizeHistory.at(-1)?.size)}`);
        }
      } else {
        require_(values, ["id"]);
        const audience = await audiences.refreshAudience(values.id, values.note);
        console.log(`${audience.id} → ${num(audience.sizeHistory.at(-1)?.size)}`);
      }
      writeReport();
    },
  },

  "audience export": {
    summary: "Write an audience as a CSV formatted for one ad platform.",
    options: {
      id: { type: "string" },
      platform: { type: "string" },
      hash: { type: "boolean", default: false },
      "include-opted-out": { type: "boolean", default: false },
      out: { type: "string", default: "" },
      "dry-run": { type: "boolean", default: false },
    },
    async run({ values }) {
      const { PLATFORMS } = await import("../src/adPlatforms.js");

      // Listing the platforms beats an error message nobody can act on.
      if (!values.platform || !PLATFORMS[values.platform]) {
        console.log("\n  Which platform? One of:\n");
        for (const [id, platform] of Object.entries(PLATFORMS)) {
          console.log(`    ${id.padEnd(12)} ${platform.label}`);
        }
        console.log("\n  tsf audience export --id <audience> --platform meta\n");
        process.exitCode = 1;
        return;
      }
      require_(values, ["id"]);

      const { exportAudience } = await import("../src/exportAudience.js");
      const { summary } = await exportAudience({
        audienceId: values.id,
        platform: values.platform,
        hash: values.hash,
        includeOptedOut: values["include-opted-out"],
        outDir: values.out || undefined,
        write: !values["dry-run"],
        onProgress: (progress) => {
          // Every 1,000, not every page — a 13,000-member list would otherwise
          // print 137 lines into any terminal that does not honour a carriage
          // return, which is most of the places this output gets pasted.
          if (progress.stage === "members" && progress.count && progress.count % 1000 === 0) {
            process.stdout.write(`\r  reading members… ${num(progress.count)}`);
          }
          if (progress.stage === "details") {
            process.stdout.write(`\r  reading ${num(progress.total)} contacts…        \n`);
          }
        },
      });

      console.log(`
  ${summary.audienceName}  (${summary.brandName})
  ${summary.platformLabel}${summary.hashed ? ", SHA-256 hashed" : ", plain text"}
`);
      console.log(`    in HubSpot        ${num(summary.inHubSpot)}`);
      for (const [reason, count] of Object.entries(summary.excluded)) {
        console.log(`      - ${num(count).padStart(6)}  ${reason}`);
      }
      console.log(`    in the file       ${num(summary.rows)}`);
      console.log(`      with email      ${num(summary.withEmail)}`);
      console.log(`      with phone      ${num(summary.withPhone)}`);

      // The number that decides whether the upload does anything at all.
      if (!summary.clearsMinimum) {
        console.log(`
  !  ${num(summary.rows)} rows is below this platform\u2019s minimum of ${num(summary.minRows)}.
     The upload will be accepted and the audience will not deliver. Pool more
     shows into this audience, or target the show venue by geography instead.`);
      } else if (!summary.clearsRecommended) {
        console.log(`
  Note: above the ${num(summary.minRows)} minimum but below the ${num(summary.recommendedRows)} this
        platform suggests. Expect thin delivery.`);
      }

      if (summary.headersUnverified) {
        console.log(`
  !  This platform does not publish its column headers. Download the template
     from its own interface and check the header row before uploading.`);
      }

      console.log("");
      for (const note of summary.notes) console.log(`  \u00b7 ${note}`);

      console.log(
        summary.file
          ? `\n  Written to ${summary.file}\n`
          : "\n  Dry run — nothing written.\n"
      );
      if (summary.file) writeReport();
    },
  },

  "audience destination": {
    summary: "Record where an audience is being used (google-ads, meta, tiktok, linkedin, hubspot-email).",
    options: {
      id: { type: "string" },
      platform: { type: "string" },
      status: { type: "string", default: "live" },
      "external-id": { type: "string", default: "" },
      notes: { type: "string", default: "" },
    },
    async run({ values }) {
      require_(values, ["id", "platform"]);
      const audience = registry.loadAudience(values.id);
      if (!audience) throw new Error(`No audience "${values.id}".`);
      registry.setDestination(audience, {
        platform: values.platform,
        status: values.status,
        externalId: values["external-id"] || null,
        notes: values.notes,
      });
      console.log(`${audience.id}: ${values.platform} is now ${values.status}.`);
      writeReport();
    },
  },

  "audience note": {
    summary: "Attach a note to an audience so the reason is not lost.",
    options: { id: { type: "string" }, text: { type: "string" } },
    async run({ values }) {
      require_(values, ["id", "text"]);
      const audience = registry.loadAudience(values.id);
      if (!audience) throw new Error(`No audience "${values.id}".`);
      registry.addNote(audience, values.text);
      console.log("Noted.");
      writeReport();
    },
  },

  "audience retire": {
    summary: "Mark an audience as no longer in use. Nothing is deleted.",
    options: { id: { type: "string" }, reason: { type: "string", default: "" } },
    async run({ values }) {
      require_(values, ["id"]);
      const audience = registry.loadAudience(values.id);
      if (!audience) throw new Error(`No audience "${values.id}".`);
      registry.retireAudience(audience, values.reason);
      console.log(`${audience.id} retired.`);
      writeReport();
    },
  },

  "history": {
    summary: "Print the activity log, newest first.",
    options: {
      action: { type: "string" },
      id: { type: "string" },
      brand: { type: "string" },
      since: { type: "string" },
      limit: { type: "string", default: "40" },
    },
    async run({ values }) {
      const entries = registry.readHistory({
        action: values.action,
        audienceId: values.id,
        brand: values.brand ? brands.requireBrand(values.brand).id : undefined,
        since: values.since,
        limit: Number(values.limit),
      });
      if (!entries.length) return console.log("Nothing logged yet.");
      for (const entry of entries) {
        console.log(
          `${entry.at.slice(0, 16).replace("T", " ")}  ${String(entry.action).padEnd(28)} ` +
            `${entry.audienceName || entry.showName || entry.file || ""}` +
            `${entry.testMode ? "   [TEST]" : ""}`
        );
      }
    },
  },

  "report": {
    summary: "Regenerate AUDIENCES.md from the registry.",
    async run() {
      const file = writeReport();
      console.log(`Wrote ${path.relative(process.cwd(), file)}`);
    },
  },

  "discover forms": {
    summary: "List HubSpot forms and recent submissions, to find where tablet sign-ups land.",
    options: { match: { type: "string", default: "" }, submissions: { type: "boolean", default: false } },
    async run({ values }) {
      const forms = await hubspot.listForms();
      const filtered = values.match
        ? forms.filter((form) => form.name.toLowerCase().includes(values.match.toLowerCase()))
        : forms;

      console.log(`${filtered.length} of ${forms.length} forms\n`);
      for (const form of filtered) {
        console.log(`${form.name}`);
        console.log(`  id ${form.id}   created ${(form.createdAt || "").slice(0, 10)}`);

        const fields = [];
        for (const group of form.fieldGroups || []) {
          for (const field of group.fields || []) fields.push(field.name);
        }
        if (fields.length) console.log(`  fields: ${fields.join(", ")}`);

        if (values.submissions) {
          const submissions = await hubspot.getFormSubmissions(form.id, 3);
          console.log(`  ${submissions.length} recent submission(s)`);
          for (const submission of submissions) {
            console.log(`    ${new Date(submission.submittedAt).toISOString().slice(0, 10)}`);
          }
        }
        console.log("");
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function splitCsv(value) {
  return String(value || "").split(",").map((part) => part.trim()).filter(Boolean);
}

/** Prints the last few log entries for one audience. */
function printRecentHistory(audience, limit = 10) {
  const events = registry.readHistory({ audienceId: audience.id, limit });
  if (!events.length) return;
  console.log("\n  recent history");
  for (const event of events) {
    console.log(`    ${event.at.slice(0, 16).replace("T", " ")}  ${event.action}`);
  }
}

/**
 * Lets a negative number be a value rather than a flag.
 *
 * Every longitude in the US is negative, so `--lng -115.15` is a thing people
 * will type, and parseArgs reads the value as another option. Rewriting it to
 * `--lng=-115.15` before parsing is less surprising than an error telling
 * someone to punctuate differently.
 */
function joinNegativeNumbers(args) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const current = args[i];
    const next = args[i + 1];
    if (current.startsWith("--") && !current.includes("=") && /^-\d/.test(next || "")) {
      out.push(`${current}=${next}`);
      i++;
    } else {
      out.push(current);
    }
  }
  return out;
}

/** Throws a readable error when a required flag is missing. */
function require_(values, names) {
  const missing = names.filter((name) => !values[name]);
  if (missing.length) {
    throw new Error(`Missing required option(s): ${missing.map((n) => "--" + n).join(", ")}`);
  }
}

function printHelp() {
  console.log("tsf — trade show funnel\n");
  console.log("Usage: tsf <command> [options]\n");
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  for (const [name, command] of Object.entries(COMMANDS)) {
    console.log(`  ${name.padEnd(width + 2)}${command.summary}`);
  }
  console.log("\nStart here:");
  console.log("  tsf setup --commit");
  console.log("  tsf show add --name \"SEMA 2026\" --start 2026-11-03 --end 2026-11-06");
  console.log("  tsf import --file roster.csv --show sema-2026 --source roster_pre");
  console.log("  tsf audience create --name \"SEMA 2026 — All\" --shows sema-2026 --commit");
  console.log("  tsf report\n");
}

async function main() {
  ensureDataDirs();
  let argv = process.argv.slice(2);

  // `--test` is global rather than per-command, and is stripped before the
  // command parses its own options. Set on process.env so it reaches
  // loadConfig() the same way the .env setting does — one code path, not two.
  if (argv.includes("--test")) {
    argv = argv.filter((argument) => argument !== "--test");
    process.env.TSF_TEST_MODE = "true";
  }

  const { loadConfig } = await import("../src/config.js");
  if (loadConfig().testMode) {
    console.log(
      "\n  TEST MODE — reads are real, writes are refused." +
        "\n  Nothing can reach HubSpot, and nothing can be published.\n"
    );
  }

  if (!argv.length || argv[0] === "help" || argv[0] === "--help" || argv[0] === "-h") {
    printHelp();
    return;
  }

  // Commands are one or two words. Try the longer match first.
  const twoWord = argv.slice(0, 2).join(" ");
  const name = COMMANDS[twoWord] ? twoWord : argv[0];
  const command = COMMANDS[name];

  if (!command) {
    console.error(`Unknown command "${argv.join(" ")}".\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const rest = argv.slice(name.split(" ").length);
  const { values, positionals } = parseArgs({
    args: joinNegativeNumbers(rest),
    options: command.options || {},
    allowPositionals: true,
  });

  await command.run({ values, positionals });
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exitCode = 1;
});

/** The domain Google sign-in is restricted to, for the tunnel banner. */
function loadConfigDomain() {
  return process.env.TSF_ALLOWED_DOMAIN || "r1concepts.com";
}
