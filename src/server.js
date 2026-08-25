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

import { ROOT } from "./config.js";
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

  /** Parses an uploaded CSV and guesses the column mapping. No writes. */
  "POST /api/upload/inspect": (body) => {
    const { headers, rows } = ingest.parseCsv(body.text || "");
    return {
      filename: body.filename || "upload.csv",
      headers,
      rowCount: rows.length,
      mapping: ingest.guessMapping(headers, body.mapping),
      sample: rows.slice(0, 5),
      fields: Object.keys(ingest.COLUMN_GUESSES),
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

export function startServer({ port = 4477, host = "127.0.0.1" } = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, `http://${host}`);
    const key = `${request.method} ${url.pathname}`;
    const handler = ROUTES[key];

    if (!handler) {
      if (request.method === "GET") return serveStatic(response, url.pathname);
      return sendJson(response, 404, { error: `No route for ${key}` });
    }

    try {
      const body = request.method === "GET" ? Object.fromEntries(url.searchParams) : await readBody(request);
      sendJson(response, 200, await handler(body));
    } catch (error) {
      // The UI shows this text directly, so it needs to read like a sentence.
      sendJson(response, 400, { error: error.message });
    }
  });

  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${port}` }));
  });
}
