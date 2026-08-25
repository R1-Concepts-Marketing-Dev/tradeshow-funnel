// mcp.js — lets Claude answer questions about the audience registry.
//
// Run with `tsf mcp`. It speaks the Model Context Protocol over stdin/stdout,
// which is how Claude Desktop and Claude Code load external tools. Anyone who
// adds it to their Claude config can then ask "what audiences do we have for
// DFC" or "how big was the SEMA list in November" and get a real answer off
// the registry rather than a guess.
//
// Read-only, deliberately. Everything here reads files; nothing writes to
// HubSpot or to the registry. A question should never change anything, and
// making that structurally true is better than remembering to be careful.
//
// No dependencies — MCP over stdio is newline-delimited JSON-RPC, which Node
// can do unaided.
//
// EDIT THIS FILE IF: you want Claude to be able to answer something it
// currently cannot. Add a tool to TOOLS; keep it read-only.

import readline from "node:readline";
import * as registry from "./registry.js";
import * as audiences from "./audiences.js";
import * as brands from "./brands.js";

const PROTOCOL_VERSION = "2024-11-05";

const num = (value) =>
  value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US");
const day = (iso) => (iso || "").slice(0, 10);

// ---------------------------------------------------------------------------
// Tools
//
// Each returns markdown, not JSON. Claude answers better from prose than from
// a blob, and a person reading the raw tool output can follow it too.
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_audiences",
    description:
      "Every trade show audience: brand, type, current size, where it is used, " +
      "and whether it clears the ad platform minimums. Start here for 'what " +
      "audiences do we have'.",
    inputSchema: {
      type: "object",
      properties: {
        brand: { type: "string", description: "Optional. 'r1' or 'dfc'. Omit for both, listed separately." },
        includeRetired: { type: "boolean", description: "Default false." },
      },
    },
    run({ brand, includeRetired = false }) {
      const list = registry
        .listAudiences({ brand: brand || null })
        .filter((a) => includeRetired || a.status === "active");

      if (!list.length) return "No audiences match that.";

      const byBrand = {};
      for (const audience of list) (byBrand[audience.brand] ||= []).push(audience);

      const out = [];
      for (const [brandId, group] of Object.entries(byBrand)) {
        const info = brands.resolveBrand(brandId);
        out.push(`## ${info?.name || brandId}\n`);
        out.push("| Audience | Type | Shows | Size | Used | Last checked |");
        out.push("| --- | --- | --- | ---: | --- | --- |");
        for (const a of group) {
          const latest = a.sizeHistory.at(-1);
          const isGeo = a.type === "geo";
          const spec = a.definition?.geo;
          out.push(
            `| ${a.name}${a.status !== "active" ? " *(retired)*" : ""} (\`${a.id}\`) ` +
              `| ${isGeo ? "geo" : "list"} ` +
              `| ${a.shows.join(", ") || "—"} ` +
              `| ${isGeo ? `${spec?.window?.totalDays ?? "?"} days at the venue` : num(latest?.size)} ` +
              `| ${a.destinations.map((d) => `${d.platform} (${d.status})`).join(", ") || "not recorded"} ` +
              `| ${isGeo ? "n/a" : day(latest?.at) || "never"} |`
          );
        }
        out.push("");
      }

      out.push(
        "_Sizes are as of the last refresh, not live. Never add two audiences " +
          "together — they overlap, because the same person attends more than one show._"
      );
      return out.join("\n");
    },
  },

  {
    name: "get_audience",
    description:
      "Everything about one audience: why it exists, its full size history over " +
      "time, where it is used, and a readiness check against each ad platform's " +
      "minimum. Use for 'how big is X' or 'did X grow'.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The audience id, e.g. dfc-sema-2026-contacts." } },
      required: ["id"],
    },
    run({ id }) {
      const a = registry.loadAudience(id);
      if (!a) {
        const known = registry.listAudiences().map((x) => x.id).join(", ");
        return `No audience "${id}". Known: ${known || "none yet"}.`;
      }

      const out = [`# ${a.name}\n`];
      out.push(`- **Brand:** ${brands.resolveBrand(a.brand)?.name || a.brand}`);
      out.push(`- **Type:** ${a.type === "geo" ? "geo — a place and a date window, no contact data" : "list — contacts we hold"}`);
      out.push(`- **Status:** ${a.status}`);
      out.push(`- **Why it exists:** ${a.purpose || "not recorded"}`);
      out.push(`- **Shows:** ${a.shows.join(", ") || "—"}`);
      out.push(`- **Created:** ${day(a.createdAt)} by ${a.createdBy}\n`);

      if (a.type === "geo") {
        const spec = a.definition?.geo;
        if (spec) {
          out.push(`**Venue:** ${spec.venue.name} (${spec.venue.lat}, ${spec.venue.lng})`);
          out.push(
            `**Runs:** ${spec.window.runStart} → ${spec.window.runEnd} ` +
              `(${spec.window.totalDays} days; the show itself is ${spec.window.showStart} → ${spec.window.showEnd})`
          );
          out.push(`**Rings:** ${spec.rings.map((r) => `${r.name} ${r.radiusMiles}mi`).join(", ")}\n`);
          out.push(`> ${spec.presenceSetting}\n`);
        }
        out.push("_A geo audience has no size and no platform minimum. 'How big is it' does not apply._");
      } else {
        out.push(`**HubSpot list:** ${a.hubspotListId ?? "none"}`);
        out.push(`**Sources:** ${a.sources.join(", ") || "any"}\n`);

        if (a.sizeHistory.length) {
          out.push("**Size over time**\n");
          out.push("| Date | Size | Change | Note |");
          out.push("| --- | ---: | ---: | --- |");
          a.sizeHistory.forEach((point, i) => {
            const prev = i > 0 ? a.sizeHistory[i - 1].size : null;
            const delta = prev === null ? "—" : (point.size - prev >= 0 ? "+" : "") + num(point.size - prev);
            out.push(`| ${day(point.at)} | ${num(point.size)} | ${delta} | ${point.note || ""} |`);
          });
          out.push("");
        } else {
          out.push("_Never measured. Someone needs to run `tsf audience refresh`._\n");
        }

        try {
          const readiness = audiences.checkReadiness(a);
          out.push(
            `**Platform readiness** — assuming a ${Math.round(readiness.matchRateUsed * 100)}% match rate, ` +
              `about ${num(readiness.estimatedMatched)} matched users.\n`
          );
          for (const f of readiness.findings) out.push(`- **${f.platform}** — ${f.message}`);
          out.push("");
        } catch {
          /* readiness is a nicety, never a reason to fail the answer */
        }
      }

      if (a.destinations.length) {
        out.push("**Where it is used**\n");
        for (const d of a.destinations) {
          out.push(`- ${d.platform} — *${d.status}*${d.notes ? ` — ${d.notes}` : ""} (updated ${day(d.updatedAt)})`);
        }
        out.push("");
      }

      if (a.notes.length) {
        out.push("**Notes**\n");
        for (const n of a.notes) out.push(`- _${day(n.at)}_ ${n.actor}: ${n.text}`);
      }

      return out.join("\n");
    },
  },

  {
    name: "list_shows",
    description:
      "Every trade show tracked: dates, venue, which brands exhibit, and what " +
      "contact lists have been loaded for it so far.",
    inputSchema: { type: "object", properties: {} },
    run() {
      const shows = registry.loadShows();
      if (!shows.length) return "No shows registered yet.";

      const imports = registry.readHistory({ action: "import.committed" });
      const out = ["| Show | Dates | Venue | Brands | Lists loaded |", "| --- | --- | --- | --- | --- |"];

      for (const show of shows) {
        const mine = imports.filter((e) => e.showId === show.id);
        const bySource = [...new Set(mine.map((e) => e.source))];
        out.push(
          `| ${show.name} (\`${show.id}\`) | ${show.startDate} → ${show.endDate} ` +
            `| ${show.venue ? show.venue.name : "*not researched*"} ` +
            `| ${(show.brands || []).join(", ") || "—"} ` +
            `| ${bySource.join(", ") || "none yet"} |`
        );
      }
      return out.join("\n");
    },
  },

  {
    name: "get_show",
    description:
      "One show in detail: dates, venue coordinates, every list loaded for it " +
      "with counts, and the audiences built from it.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The show id, e.g. sema-2026." } },
      required: ["id"],
    },
    run({ id }) {
      const show = registry.loadShows().find((s) => s.id === id);
      if (!show) {
        const known = registry.loadShows().map((s) => s.id).join(", ");
        return `No show "${id}". Known: ${known || "none yet"}.`;
      }

      const out = [`# ${show.name}\n`];
      out.push(`- **Dates:** ${show.startDate} → ${show.endDate}`);
      out.push(`- **City:** ${show.city || "—"}`);
      out.push(`- **Brands:** ${(show.brands || []).join(", ") || "—"}`);
      out.push(
        `- **Venue:** ${show.venue ? `${show.venue.name} (${show.venue.lat}, ${show.venue.lng})` : "*not researched — geo campaigns cannot be built yet*"}`
      );
      if (show.notes) out.push(`- **Note:** ${show.notes}`);
      out.push("");

      const imports = registry.readHistory({ action: "import.committed" }).filter((e) => e.showId === id);
      const claims = registry.readHistory({ action: "tablet.claimed" }).filter((e) => e.showId === id);

      if (imports.length || claims.length) {
        out.push("**Lists loaded**\n");
        out.push("| When | Source | File | Created | Updated | Rejected |");
        out.push("| --- | --- | --- | ---: | ---: | ---: |");
        for (const e of imports) {
          out.push(
            `| ${day(e.at)} | ${e.source} | ${e.file} | ${num(e.created)} | ${num(e.updated)} | ${num(e.rejected)} |`
          );
        }
        for (const e of claims) {
          out.push(
            `| ${day(e.at)} | booth_tablet | *claimed from form* | ${num(e.contacts)} | — | ${num(e.rejected)} |`
          );
        }
        out.push("");
      } else {
        out.push("_No contact lists loaded for this show yet._\n");
      }

      const built = registry.listAudiences().filter((a) => a.shows.includes(id));
      if (built.length) {
        out.push("**Audiences built from it**\n");
        for (const a of built) {
          const latest = a.sizeHistory.at(-1);
          out.push(
            `- **${a.name}** (\`${a.id}\`) — ${a.brand}, ${a.type}` +
              (a.type === "geo" ? "" : `, ${num(latest?.size)} contacts`)
          );
        }
      } else {
        out.push("_No audiences built from this show yet._");
      }

      return out.join("\n");
    },
  },

  {
    name: "search_history",
    description:
      "The append-only activity log — every import, audience created, size " +
      "measured, and destination recorded. Use for 'what happened in March' or " +
      "'what did we do for AAPEX'.",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Optional, e.g. import.committed, audience.created, audience.refreshed." },
        brand: { type: "string", description: "Optional, 'r1' or 'dfc'." },
        since: { type: "string", description: "Optional ISO date, e.g. 2026-01-01." },
        limit: { type: "number", description: "Default 40." },
      },
    },
    run({ action, brand, since, limit = 40 }) {
      const entries = registry.readHistory({ action, brand, since, limit });
      if (!entries.length) return "Nothing logged that matches.";

      const out = ["| When | Who | What | Detail |", "| --- | --- | --- | --- |"];
      for (const e of entries) {
        let detail = "";
        if (e.action === "import.committed") {
          detail = `${e.file} → ${e.showId} (${e.source}): ${num(e.created)} created, ${num(e.updated)} updated, ${num(e.rejected)} rejected`;
        } else if (e.action === "tablet.claimed") {
          detail = `${e.showName}: ${num(e.contacts)} booth contacts claimed from the form`;
        } else if (e.action === "audience.created") {
          detail = `${e.audienceName}${e.type === "geo" ? " (geo)" : ""}`;
        } else if (e.action === "audience.refreshed") {
          const d = e.delta === null || e.delta === undefined ? "" : ` (${e.delta >= 0 ? "+" : ""}${num(e.delta)})`;
          detail = `${e.audienceName} now ${num(e.size)}${d}`;
        } else if (e.action === "audience.destination_set") {
          detail = `${e.audienceName} → ${e.platform} is ${e.status}`;
        } else if (e.action === "show.created") {
          detail = `${e.showName} (${e.startDate} → ${e.endDate})`;
        } else if (e.action === "note") {
          detail = `${e.audienceName}: ${e.text}`;
        } else {
          detail = JSON.stringify(e).slice(0, 140);
        }
        out.push(`| ${e.at.replace("T", " ").slice(0, 16)} | ${e.actor} | \`${e.action}\` | ${detail} |`);
      }
      return out.join("\n");
    },
  },

  {
    name: "program_summary",
    description:
      "The whole trade show program at a glance, per brand: shows, audiences, " +
      "contacts, and anything that needs attention. Good opening question.",
    inputSchema: { type: "object", properties: {} },
    run() {
      const shows = registry.loadShows();
      const all = registry.listAudiences();
      const out = ["# Trade show program\n"];

      for (const brand of brands.loadBrands()) {
        const mine = all.filter((a) => a.brand === brand.id && a.status === "active");
        const lists = mine.filter((a) => a.type !== "geo");
        const geos = mine.filter((a) => a.type === "geo");
        const blocked = lists.filter((a) => {
          try {
            return audiences.checkReadiness(a).findings.some((f) => f.level === "blocked");
          } catch {
            return false;
          }
        });

        out.push(`## ${brand.name}\n`);
        out.push(`- ${lists.length} contact audience(s), ${geos.length} geo audience(s)`);
        out.push(
          `- Largest: ${
            lists.length
              ? `${lists.reduce((a, b) => ((a.sizeHistory.at(-1)?.size ?? 0) > (b.sizeHistory.at(-1)?.size ?? 0) ? a : b)).name}`
              : "none"
          }`
        );
        if (blocked.length) {
          out.push(`- ⚠ ${blocked.length} below a platform minimum: ${blocked.map((a) => a.id).join(", ")}`);
        }
        out.push("");
      }

      out.push(`**Shows tracked:** ${shows.length}`);
      const noVenue = shows.filter((s) => !s.venue);
      if (noVenue.length) {
        out.push(`**Missing a venue** (cannot be geo-targeted): ${noVenue.map((s) => s.id).join(", ")}`);
      }
      out.push("");
      out.push(
        "_Contact audience sizes are as of the last refresh. Do not sum across " +
          "brands or across audiences — they overlap, and R1 and DFC are kept " +
          "deliberately separate._"
      );
      return out.join("\n");
    },
  },
];

// ---------------------------------------------------------------------------
// JSON-RPC over stdio
// ---------------------------------------------------------------------------

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
}

function respondError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\n");
}

function handle(message) {
  const { id, method, params } = message;

  // Notifications have no id and expect no reply.
  if (id === undefined) return;

  if (method === "initialize") {
    return respond(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "tradeshow-funnel", version: "0.1.0" },
    });
  }

  if (method === "tools/list") {
    return respond(id, {
      tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
    });
  }

  if (method === "tools/call") {
    const tool = TOOLS.find((t) => t.name === params?.name);
    if (!tool) return respondError(id, -32602, `No tool named "${params?.name}".`);

    try {
      const text = tool.run(params.arguments || {});
      return respond(id, { content: [{ type: "text", text }] });
    } catch (error) {
      // Report the failure as tool output rather than a protocol error, so
      // Claude can tell the person what went wrong instead of going silent.
      return respond(id, {
        content: [{ type: "text", text: `That failed: ${error.message}` }],
        isError: true,
      });
    }
  }

  if (method === "ping") return respond(id, {});

  respondError(id, -32601, `Unknown method "${method}".`);
}

export function startMcpServer() {
  // Anything on stdout that is not a protocol message corrupts the stream, so
  // logging has to go to stderr. This is the classic way to break an MCP server.
  const lines = readline.createInterface({ input: process.stdin });

  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      handle(JSON.parse(trimmed));
    } catch (error) {
      process.stderr.write(`tradeshow-funnel mcp: bad message — ${error.message}\n`);
    }
  });

  process.stderr.write("tradeshow-funnel MCP server ready (read-only).\n");
}

export { TOOLS };
