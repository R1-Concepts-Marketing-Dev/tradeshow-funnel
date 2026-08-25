// server.js — the local web UI, started with `tsf ui`.
//
// A plain Node HTTP server: JSON endpoints under /api, static files from ui/.
// No framework, no build step, no bundler. Open ui/app.js in any editor and
// what you see is what runs.
//
// It binds to 127.0.0.1 only. This tool holds contact data and a HubSpot token
// with write access, so it should never be reachable from the network.
//
// EDIT THIS FILE IF: the UI needs data or an action it cannot do yet. Add a
// route to ROUTES and keep the real work in the other src/ modules.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ROOT, loadConfig } from "./config.js";
import * as auth from "./auth.js";
import * as registry from "./registry.js";
import * as audiences from "./audiences.js";
import * as ingest from "./ingest.js";
import * as geo from "./geo.js";
import * as brands from "./brands.js";
import * as campaigns from "./campaigns.js";
import { writeReport } from "./report.js";

const UI_DIR = path.join(ROOT, "ui");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

// ---------------------------------------------------------------------------
// Routes
//
// Each handler takes the parsed JSON body (or query) and returns a plain object
// which is sent as JSON. Throwing produces a 400 with the message, which the UI
// shows to the user verbatim — so make error messages readable.
// ---------------------------------------------------------------------------

const ROUTES = {
  /** Everything the UI needs to render, in one call. The data is small. */
  "GET /api/state": () => ({
    brands: brands.loadBrands(),
    shows: registry.loadShows(),
    audiences: registry.listAudiences().map(withReadiness),
    history: registry.readHistory({ limit: 200 }),
    sources: ingest.SOURCES,
    platforms: Object.keys(audiences.PLATFORM_FLOORS),
    campaignTypes: campaigns.CAMPAIGN_TYPES,
  }),

  /** Who is signed in, for the header. */
  "GET /api/me": (_body, user) => ({ user: user || null }),

  /**
   * Finds a show by name, or creates it. Called from the upload form so a new
   * show never means a trip to another screen and back.
   */
  "POST /api/shows/ensure": (body) => {
    const name = String(body.name || "").trim();
    if (!name) throw new Error("A show name is required.");

    const existing = registry
      .loadShows()
      .find(
        (show) =>
          show.id === registry.slugify(name) ||
          show.name.toLowerCase() === name.toLowerCase()
      );
    if (existing) return { show: existing, created: false };

    if (!body.startDate || !body.endDate) {
      throw new Error(`"${name}" is a new show, so it needs a start and end date.`);
    }

    const showBrands = (body.brands?.length ? body.brands : brands.loadBrands().map((b) => b.id))
      .map((id) => brands.requireBrand(id).id);

    const show = registry.addShow({
      id: registry.slugify(name),
      name,
      startDate: body.startDate,
      endDate: body.endDate,
      city: body.city || "",
      brands: showBrands,
    });
    writeReport();
    return { show, created: true };
  },

  /**
   * Booth tablet sign-ups for a show, found by its linked form(s) and dates.
   * See src/tablet.js for why the form matters as much as the window.
   */
  "POST /api/tablet/claim": async (body) => {
    const { claimTabletContacts } = await import("./tablet.js");
    const show = registry.loadShows().find((entry) => entry.id === body.showId);
    if (!show) throw new Error(`No show "${body.showId}".`);

    const result = await claimTabletContacts({
      brand: body.brand,
      show,
      bufferDays: body.bufferDays === undefined ? undefined : Number(body.bufferDays),
      commit: Boolean(body.commit),
      consentTextId: body.consentTextId || "",
    });

    if (body.commit) writeReport();
    return {
      summary: result.summary,
      rejects: result.rejects.slice(0, 50),
      rejectCount: result.rejects.length,
    };
  },

  /** Builds and writes the show report. Returns where it went. */
  "POST /api/reports/show": async (body) => {
    const reporting = await import("./reporting.js");
    const { report, directory, images } = await reporting.exportShowReport(body.showId, {
      withImages: body.withImages !== false,
    });
    return {
      directory,
      images: images.length,
      summary: {
        show: report.show.name,
        captured: report.intake.totals.created + report.intake.totals.updated,
        audiences: report.audiences.length,
        emails: report.email.emails.length,
        ads: report.paid.ads.length,
        spend: report.paid.totals?.spend ?? 0,
      },
      problems: report.problems,
    };
  },

  /** Which campaign recipes can be built for a show right now. */
  "POST /api/campaigns/available": (body) => {
    const show = registry.loadShows().find((entry) => entry.id === body.showId);
    if (!show) throw new Error(`No show "${body.showId}".`);
    return {
      show,
      types: campaigns.availableFor(show).map((type) => ({
        ...type,
        audienceName: campaigns.audienceNameFor(type, show),
      })),
    };
  },

  /** Builds the selected campaign types. commit:false previews. */
  "POST /api/campaigns": async (body) => {
    const show = registry.loadShows().find((entry) => entry.id === body.showId);
    if (!show) throw new Error(`No show "${body.showId}".`);
    if (!body.typeIds?.length) throw new Error("Pick at least one campaign type.");

    const result = await campaigns.createCampaigns({
      brand: body.brand,
      show,
      typeIds: body.typeIds,
      commit: Boolean(body.commit),
    });
    if (body.commit) writeReport();
    return result;
  },

  /**
   * Inspects one or more uploaded files: finds the header row, picks the right
   * sheet, and guesses the column mapping. Reads only, writes nothing.
   *
   * Files arrive base64-encoded because a spreadsheet is binary and JSON is
   * not — cheaper than adding a multipart parser for two fields.
   */
  "POST /api/upload/inspect": (body) => {
    const files = body.files || [{ filename: body.filename, base64: body.base64 }];

    return {
      fields: Object.keys(ingest.COLUMN_GUESSES),
      files: files.map((file) => {
        const name = file.filename || "upload.csv";
        try {
          const table = ingest.readTable(Buffer.from(file.base64 || "", "base64"), name);
          return {
            filename: name,
            ok: true,
            headers: table.headers,
            rowCount: table.rows.length,
            sheetName: table.sheetName,
            sheets: table.sheets,
            notes: table.notes,
            mapping: ingest.guessMapping(table.headers, file.mapping),
            sample: table.rows.slice(0, 5),
            // A guess at what this file is, from its name. The operator can
            // change it — this only saves a click on the common case.
            guessedSource: guessSource(name),
          };
        } catch (error) {
          return { filename: name, ok: false, error: error.message };
        }
      }),
    };
  },

  /**
   * Runs several files as one batch. Each keeps its own source and mapping;
   * they share a brand and a show.
   */
  "POST /api/import/batch": async (body) => {
    const results = [];

    // The same person turns up in the roster AND the badge scan. Each file is
    // deduped on its own, so without this the preview counts them twice — and
    // a preview whose numbers are wrong is worse than no preview. The commit
    // was always correct (the upsert key collapses them); this makes the
    // number you are shown match what actually happens.
    const seenKeys = new Set();
    let acrossFiles = 0;

    for (const file of body.files || []) {
      try {
        const result = await ingest.ingestFile({
          data: Buffer.from(file.base64 || "", "base64"),
          filename: file.filename,
          brand: body.brand,
          showId: body.showId,
          source: file.source,
          mapping: file.mapping,
          consentTextId: body.consentTextId || "",
          commit: Boolean(body.commit),
        });
        let duplicatesHere = 0;
        for (const entry of result.toWrite) {
          if (seenKeys.has(entry.id)) duplicatesHere++;
          else seenKeys.add(entry.id);
        }
        acrossFiles += duplicatesHere;

        results.push({
          filename: file.filename,
          ok: true,
          summary: { ...result.summary, duplicatesFromEarlierFiles: duplicatesHere },
          rejects: result.rejects.slice(0, 50),
          rejectCount: result.rejects.length,
          review: result.review.slice(0, 20).map((item) => ({
            email: item.contact.email || item.contact.phone,
            reason: item.reason,
          })),
        });
      } catch (error) {
        // One bad file must not stop the rest of the batch.
        results.push({ filename: file.filename, ok: false, error: error.message });
      }
    }

    if (body.commit) writeReport();

    const done = results.filter((r) => r.ok);
    const rawContacts = done.reduce((n, r) => n + r.summary.contacts, 0);

    return {
      results,
      totals: {
        files: results.length,
        failed: results.length - done.length,
        rowsRead: done.reduce((n, r) => n + r.summary.rowsRead, 0),
        // Unique people, not the sum of the per-file counts.
        contacts: seenKeys.size,
        duplicatesAcrossFiles: acrossFiles,
        created: Math.max(0, done.reduce((n, r) => n + r.summary.created, 0) - acrossFiles),
        updated: done.reduce((n, r) => n + r.summary.updated, 0),
        rejected: done.reduce((n, r) => n + r.summary.rejected, 0),
        committed: Boolean(body.commit),
      },
    };
  },

  /** Runs the pipeline. commit:false previews, commit:true writes to HubSpot. */
  "POST /api/import": async (body) => {
    const result = await ingest.ingestFile({
      text: body.text,
      filename: body.filename,
      brand: body.brand,
      showId: body.showId,
      source: body.source,
      mapping: body.mapping,
      consentTextId: body.consentTextId || "",
      commit: Boolean(body.commit),
    });
    if (body.commit) writeReport();
    return {
      summary: result.summary,
      rejects: result.rejects.slice(0, 200),
      rejectCount: result.rejects.length,
      review: result.review.slice(0, 50).map((item) => ({
        email: item.contact.email || item.contact.phone,
        reason: item.reason,
      })),
      mapping: result.mapping,
    };
  },

  "POST /api/shows": (body) => {
    const showBrands = (body.brands?.length ? body.brands : brands.loadBrands().map((b) => b.id))
      .map((id) => brands.requireBrand(id).id);
    const show = registry.addShow({
      id: body.id || registry.slugify(body.name),
      name: body.name,
      startDate: body.startDate,
      endDate: body.endDate,
      city: body.city || "",
      brands: showBrands,
    });
    writeReport();
    return { show };
  },

  /** Geocodes a venue and stores it on the show. */
  "POST /api/shows/research": async (body) => {
    const show = registry.loadShows().find((entry) => entry.id === body.showId);
    if (!show) throw new Error(`No show "${body.showId}".`);

    let venue;
    if (body.lat && body.lng) {
      venue = { name: body.venue || show.name, lat: Number(body.lat), lng: Number(body.lng), displayName: "" };
    } else {
      const query = body.venue || `${show.name} ${show.city || ""}`.trim();
      const hit = await geo.geocode(query);
      if (!hit) {
        throw new Error(
          `Could not find "${query}". Try a fuller name including the city, or enter coordinates directly.`
        );
      }
      venue = { name: body.venue || query, ...hit };
    }

    const updated = registry.setShowVenue(show.id, venue);
    writeReport();
    return { show: updated, spec: geo.buildGeoSpec(updated) };
  },

  /** Previews the geo spec without saving anything. */
  "POST /api/shows/geo-preview": (body) => {
    const show = registry.loadShows().find((entry) => entry.id === body.showId);
    if (!show) throw new Error(`No show "${body.showId}".`);
    return {
      spec: geo.buildGeoSpec(show, {
        leadDays: body.leadDays === undefined ? undefined : Number(body.leadDays),
        lagDays: body.lagDays === undefined ? undefined : Number(body.lagDays),
      }),
    };
  },

  "POST /api/audiences": async (body) => {
    const brand = brands.requireBrand(body.brand);
    const created = [];
    const skipped = [];

    if (body.type === "geo" || body.type === "both") {
      const show = registry.loadShows().find((entry) => entry.id === body.showId);
      if (!show) throw new Error(`No show "${body.showId}".`);
      try {
        created.push(
          await audiences.createGeoAudience({
            brand: brand.id,
            show,
            name: body.type === "both" ? undefined : body.name,
            purpose: body.purpose,
            leadDays: body.leadDays === undefined ? undefined : Number(body.leadDays),
            lagDays: body.lagDays === undefined ? undefined : Number(body.lagDays),
            dryRun: !body.commit,
          })
        );
      } catch (error) {
        if (body.type === "both" && /already exists/.test(error.message)) skipped.push(error.message);
        else throw error;
      }
    }

    if (body.type === "list" || body.type === "both") {
      const show = registry.loadShows().find((entry) => entry.id === body.showId);
      const name =
        body.type === "both" ? `${show?.name || body.showId} — Contacts` : body.name;
      if (!name) throw new Error("An audience name is required.");
      try {
        created.push(
          await audiences.createAudience({
            brand: brand.id,
            name,
            purpose: body.purpose,
            shows: body.showId ? [body.showId] : [],
            sources: body.sources || [],
            dryRun: !body.commit,
          })
        );
      } catch (error) {
        if (body.type === "both" && /already exists/.test(error.message)) skipped.push(error.message);
        else throw error;
      }
    }

    if (body.commit) writeReport();
    return { created, skipped };
  },

  "POST /api/audiences/refresh": async (body) => {
    const result = body.id
      ? [await audiences.refreshAudience(body.id, body.note || "")]
      : await audiences.refreshAll(body.note || "refreshed from UI", {
          brand: body.brand ? brands.requireBrand(body.brand).id : null,
        });
    writeReport();
    return { refreshed: result };
  },

  "POST /api/audiences/destination": (body) => {
    const audience = registry.loadAudience(body.id);
    if (!audience) throw new Error(`No audience "${body.id}".`);
    registry.setDestination(audience, {
      platform: body.platform,
      status: body.status,
      externalId: body.externalId || null,
      notes: body.notes || "",
    });
    writeReport();
    return { audience: registry.loadAudience(body.id) };
  },

  "POST /api/audiences/note": (body) => {
    const audience = registry.loadAudience(body.id);
    if (!audience) throw new Error(`No audience "${body.id}".`);
    registry.addNote(audience, body.text);
    writeReport();
    return { audience: registry.loadAudience(body.id) };
  },

  "POST /api/audiences/retire": (body) => {
    const audience = registry.loadAudience(body.id);
    if (!audience) throw new Error(`No audience "${body.id}".`);
    registry.retireAudience(audience, body.reason || "");
    writeReport();
    return { audience: registry.loadAudience(body.id) };
  },
};

/**
 * Guesses what a file is from its name. Saves a click on the common case and
 * is never trusted — the operator sees and can change it.
 */
function guessSource(filename) {
  const name = filename.toLowerCase();
  if (/badge|scan|retrieval|lead.?retrieval/.test(name)) return "badge_scan";
  if (/tablet|booth|kiosk|signup|sign.?up/.test(name)) return "booth_tablet";
  if (/post|after|final/.test(name)) return "roster_post";
  if (/pre|advance|early|registrant/.test(name)) return "roster_pre";
  return "roster_pre";
}

/** Attaches the platform-floor check so the UI can show it without recomputing. */
function withReadiness(audience) {
  if (audience.type === "geo") return audience;
  try {
    return { ...audience, readiness: audiences.checkReadiness(audience) };
  } catch {
    return audience;
  }
}

// ---------------------------------------------------------------------------
// Plumbing
// ---------------------------------------------------------------------------

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      // A roster of 100k rows is a few MB; 64 MB is a generous ceiling that
      // still stops a runaway upload from exhausting memory.
      if (size > 64 * 1024 * 1024) {
        reject(new Error("Upload too large (over 64 MB)."));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Request body was not valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
  });
  response.end(body);
}

function serveStatic(response, urlPath) {
  const relative = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const file = path.join(UI_DIR, relative);

  // Never serve outside ui/, whatever the URL says.
  if (!file.startsWith(UI_DIR)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    response.writeHead(404).end("Not found");
    return;
  }

  response.writeHead(200, {
    "content-type": MIME[path.extname(file)] || "application/octet-stream",
    "cache-control": "no-store",
  });
  fs.createReadStream(file).pipe(response);
}

export function startServer(options = {}) {
  const config = loadConfig();
  const port = options.port ?? config.server.port;
  const host = options.host ?? config.server.host;

  // Refuses to expose the app to the network without sign-in. See src/auth.js.
  auth.assertSafeToBind(host);

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${request.headers.host || host}`);

    // ---- sign-in routes, which must work before the gate ----
    if (url.pathname === "/auth/login") return auth.startLogin(request, response);
    if (url.pathname === "/auth/callback") return auth.completeLogin(request, response, url);
    if (url.pathname === "/auth/logout") return auth.logout(response);

    // ---- everything else requires a session ----
    const user = auth.gate(request, response, url);
    if (!user) return; // gate already answered

    const key = `${request.method} ${url.pathname}`;
    const handler = ROUTES[key];

    if (!handler) {
      if (request.method === "GET") return serveStatic(response, url.pathname);
      return sendJson(response, 404, { error: `No route for ${key}` });
    }

    try {
      const body = request.method === "GET" ? Object.fromEntries(url.searchParams) : await readBody(request);
      // The signed-in person is who the history log records, not whatever the
      // machine's username happens to be.
      process.env.TSF_ACTOR = user.email;
      sendJson(response, 200, await handler(body, user));
    } catch (error) {
      // The UI shows this text directly, so it needs to read like a sentence.
      sendJson(response, 400, { error: error.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () =>
      resolve({
        server,
        url: `http://${host}:${port}`,
        authed: auth.isAuthConfigured(),
      })
    );
  });
}
