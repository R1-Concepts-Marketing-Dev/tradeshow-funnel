// reporting.js — one show, everything it produced, in a folder you can send.
//
// Pulls together four things that normally live in four places:
//
//   the registry   what was loaded, what audiences came out of it
//   HubSpot        which marketing emails went to those audiences, and how they did
//   Meta           which ads ran against them, what they cost, what they looked like
//   disk           the creative images, downloaded so the report survives on its own
//
// Everything here is read-only. Nothing is created or changed in HubSpot or
// Meta; the report describes what other people built.
//
// Missing credentials degrade rather than fail — no Meta token means a report
// with no paid social section, not an error. A partial report is useful; a
// crashed one is not.
//
// EDIT THIS FILE IF: management asks for a number that is not in here.

import fs from "node:fs";
import path from "node:path";
import { PATHS, ROOT } from "./config.js";
import * as hubspot from "./hubspot.js";
import * as meta from "./meta.js";
import * as registry from "./registry.js";
import * as brands from "./brands.js";
import { cell, num, money, pct, day } from "./markdown.js";

/**
 * How wide to look around the show for activity.
 *
 * Pre-show promotion starts weeks out and follow-up runs for months, so a
 * window tight to the show dates would miss most of the work.
 */
export const LOOK_BACK_DAYS = 45;
export const LOOK_FORWARD_DAYS = 90;


function shiftDays(isoDate, days) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The HubSpot list name we gave an audience when we created it. */
function listNameFor(audience) {
  const brand = brands.resolveBrand(audience.brand);
  return brand ? `${brand.shortName} · ${audience.name}` : audience.name;
}

// ---------------------------------------------------------------------------
// Gathering
// ---------------------------------------------------------------------------

/**
 * Everything known about one show. Each section reports its own problems
 * rather than throwing, so one dead integration cannot empty the report.
 */
export async function collectShowReport(showId) {
  const show = registry.loadShows().find((s) => s.id === showId);
  if (!show) {
    const known = registry.loadShows().map((s) => s.id).join(", ");
    throw new Error(`No show "${showId}". Known: ${known || "none yet"}.`);
  }

  const window = {
    since: shiftDays(show.startDate, -LOOK_BACK_DAYS),
    until: shiftDays(show.endDate, LOOK_FORWARD_DAYS),
  };

  const audiences = registry
    .listAudiences()
    .filter((a) => a.shows.includes(showId))
    .map((a) => ({ ...a, hubspotListName: listNameFor(a) }));

  const report = {
    show,
    window,
    generatedAt: new Date().toISOString(),
    intake: collectIntake(showId),
    audiences,
    email: { emails: [], totals: null, note: null },
    paid: { adSets: [], ads: [], totals: null, note: null },
    problems: [],
  };

  // ---- email -------------------------------------------------------------
  try {
    report.email = await collectEmail(audiences, window);
  } catch (error) {
    report.email.note = `Could not read marketing emails: ${error.message}`;
    report.problems.push(report.email.note);
  }

  // ---- paid social -------------------------------------------------------
  try {
    report.paid = await collectPaid(show, audiences, window);
  } catch (error) {
    report.paid.note = `Could not read Meta: ${error.message}`;
    report.problems.push(report.paid.note);
  }

  return report;
}

/** What was loaded for this show, per source, out of the history log. */
function collectIntake(showId) {
  const imports = registry.readHistory({ action: "import.committed" }).filter((e) => e.showId === showId);
  const claims = registry.readHistory({ action: "tablet.claimed" }).filter((e) => e.showId === showId);

  const bySource = {};
  for (const entry of imports) {
    const bucket = (bySource[entry.source] ||= { files: 0, created: 0, updated: 0, rejected: 0 });
    bucket.files += 1;
    bucket.created += entry.created || 0;
    bucket.updated += entry.updated || 0;
    bucket.rejected += entry.rejected || 0;
  }
  for (const entry of claims) {
    const bucket = (bySource.booth_tablet ||= { files: 0, created: 0, updated: 0, rejected: 0 });
    bucket.files += 1;
    bucket.created += entry.contacts || 0;
    bucket.rejected += entry.rejected || 0;
  }

  const totals = Object.values(bySource).reduce(
    (acc, b) => ({
      files: acc.files + b.files,
      created: acc.created + b.created,
      updated: acc.updated + b.updated,
      rejected: acc.rejected + b.rejected,
    }),
    { files: 0, created: 0, updated: 0, rejected: 0 }
  );

  return { bySource, totals, events: [...imports, ...claims] };
}

/** Marketing emails that went to this show's lists, with their stats. */
async function collectEmail(audiences, window) {
  const listIds = new Set(
    audiences.filter((a) => a.hubspotListId).map((a) => String(a.hubspotListId))
  );

  if (!listIds.size) {
    return { emails: [], totals: null, note: "No audience here has a HubSpot list, so no email can be attributed to it." };
  }

  const all = await hubspot.listMarketingEmails({ createdAfter: `${window.since}T00:00:00Z` });

  // The join: an email counts for this show if it was sent to one of our lists.
  const mine = all.filter((email) => {
    const to = email.to?.contactLists?.include || [];
    return to.some((id) => listIds.has(String(id)));
  });

  if (!mine.length) {
    return {
      emails: [],
      totals: null,
      note:
        `Looked at ${all.length} marketing email(s) created since ${window.since}. ` +
        `None of them were sent to this show's lists.`,
    };
  }

  const stats = await hubspot.emailStatistics(
    mine.map((e) => e.id),
    { since: `${window.since}T00:00:00Z`, until: `${window.until}T23:59:59Z` }
  );

  const emails = mine.map((email) => ({
    id: email.id,
    name: email.name,
    subject: email.subject || null,
    state: email.state,
    publishedAt: email.publishDate || null,
    toLists: email.to?.contactLists?.include || [],
    stats: stats[email.id] || null,
  }));

  const totals = emails.reduce(
    (acc, e) => ({
      sent: acc.sent + (e.stats?.sent || 0),
      delivered: acc.delivered + (e.stats?.delivered || 0),
      open: acc.open + (e.stats?.open || 0),
      click: acc.click + (e.stats?.click || 0),
      unsubscribed: acc.unsubscribed + (e.stats?.unsubscribed || 0),
      bounce: acc.bounce + (e.stats?.bounce || 0),
    }),
    { sent: 0, delivered: 0, open: 0, click: 0, unsubscribed: 0, bounce: 0 }
  );

  return { emails, totals, note: null };
}

/** Meta ad sets and ads that belong to this show, with spend and creative. */
async function collectPaid(show, audiences, window) {
  const [adSets, allAds] = await Promise.all([meta.listAdSets(), meta.listAds()]);
  const matched = meta.matchAdSets(show, audiences, adSets);

  if (!matched.length) {
    return {
      adSets: [],
      ads: [],
      totals: null,
      note:
        `Looked at ${adSets.length} Meta ad set(s) and could not tie any to this show. ` +
        `Record the Meta ad set or campaign id against an audience (Audiences → the ` +
        `audience → Record destination) and it will be picked up next time.`,
    };
  }

  const matchedIds = new Set(matched.map((m) => m.adSet.id));
  const ads = allAds.filter((ad) => matchedIds.has(ad.adset?.id));

  // Spend, by ad, over the show window.
  const rows = await meta.insights("ad", window);
  const byAdId = new Map(rows.map((row) => [row.ad_id, row]));

  const enrichedAds = ads.map((ad) => {
    const row = byAdId.get(ad.id) || {};
    return {
      id: ad.id,
      name: ad.name,
      status: ad.status,
      adSetId: ad.adset?.id,
      adSetName: ad.adset?.name,
      campaignName: ad.campaign?.name,
      creative: {
        id: ad.creative?.id || null,
        thumbnailUrl: ad.creative?.thumbnail_url || null,
        imageUrl: ad.creative?.image_url || null,
      },
      spend: row.spend ? Number(row.spend) : 0,
      impressions: row.impressions ? Number(row.impressions) : 0,
      clicks: row.clicks ? Number(row.clicks) : 0,
      reach: row.reach ? Number(row.reach) : 0,
      ctr: row.ctr ? Number(row.ctr) : null,
      cpc: row.cpc ? Number(row.cpc) : null,
    };
  });

  const totals = enrichedAds.reduce(
    (acc, ad) => ({
      spend: acc.spend + ad.spend,
      impressions: acc.impressions + ad.impressions,
      clicks: acc.clicks + ad.clicks,
      reach: Math.max(acc.reach, ad.reach), // reach does not sum — people overlap
    }),
    { spend: 0, impressions: 0, clicks: 0, reach: 0 }
  );

  return {
    adSets: matched.map((m) => ({
      id: m.adSet.id,
      name: m.adSet.name,
      status: m.adSet.status,
      campaignName: m.adSet.campaign?.name,
      campaignType: m.campaignType || null,
      matchedVia: m.via,
      matchedBecause: m.detail,
      // Meta returns money in minor units. These run a lifetime budget over a
      // few days, so what is left matters as much as what was spent.
      lifetimeBudget: m.adSet.lifetime_budget ? Number(m.adSet.lifetime_budget) / 100 : null,
      dailyBudget: m.adSet.daily_budget ? Number(m.adSet.daily_budget) / 100 : null,
      budgetRemaining: m.adSet.budget_remaining ? Number(m.adSet.budget_remaining) / 100 : null,
      startTime: m.adSet.start_time || null,
      endTime: m.adSet.end_time || null,
    })),
    ads: enrichedAds,
    totals,
    note: null,
  };
}

// ---------------------------------------------------------------------------
// Exporting
// ---------------------------------------------------------------------------

/**
 * Writes the report to a folder: readable markdown, the raw data, and the ad
 * images downloaded so it can be zipped and sent without anything breaking.
 */
export async function exportShowReport(showId, { withImages = true, outDir } = {}) {
  const report = await collectShowReport(showId);

  const stamp = report.generatedAt.slice(0, 10);
  const directory = outDir || path.join(ROOT, "exports", `${showId}-${stamp}`);
  const creativesDir = path.join(directory, "creatives");
  fs.mkdirSync(directory, { recursive: true });

  // ---- the ad images -----------------------------------------------------
  const images = [];
  if (withImages && report.paid.ads.length) {
    for (const [index, ad] of report.paid.ads.entries()) {
      const url = ad.creative.imageUrl || ad.creative.thumbnailUrl;
      const safe = String(ad.name).replace(/[^a-z0-9]+/gi, "-").toLowerCase().slice(0, 50);
      const file = await meta.downloadCreative(url, creativesDir, `${String(index + 1).padStart(2, "0")}-${safe}`);
      if (file) {
        ad.creative.localFile = `creatives/${file}`;
        images.push(file);
      }

      // The rendered preview is the closest thing Meta offers to a screenshot
      // of the ad as people saw it. It is a link, not an image.
      try {
        ad.creative.previewUrl = await meta.adPreview(ad.id);
      } catch {
        ad.creative.previewUrl = null;
      }
    }
  }

  fs.writeFileSync(path.join(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(directory, "report.md"), renderShowReport(report), "utf8");

  registry.record(registry.ACTIONS.REPORT_EXPORTED, {
    showId,
    showName: report.show.name,
    directory: path.relative(ROOT, directory),
    emails: report.email.emails.length,
    ads: report.paid.ads.length,
    images: images.length,
    spend: report.paid.totals?.spend ?? 0,
  });

  return { report, directory, images };
}

/** The markdown a person actually reads. Written for someone who was not there. */
export function renderShowReport(report) {
  const { show, window, intake, audiences, email, paid } = report;
  const out = [];

  out.push(`# ${show.name}`);
  out.push("");
  out.push(
    `${show.startDate} → ${show.endDate}${show.city ? ` · ${show.city}` : ""}` +
      `${show.venue ? ` · ${show.venue.name}` : ""}`
  );
  out.push("");
  out.push(
    `_Report generated ${day(report.generatedAt)}. Activity counted from ` +
      `${window.since} to ${window.until} — wide enough to catch pre-show promotion ` +
      `and post-show follow-up._`
  );
  out.push("");

  // ---- headline ----------------------------------------------------------
  out.push("## The short version");
  out.push("");
  out.push("| | |");
  out.push("| --- | ---: |");
  out.push(`| Contacts captured | **${num(intake.totals.created + intake.totals.updated)}** |`);
  out.push(`| Audiences built | ${num(audiences.length)} |`);
  if (email.totals) {
    out.push(`| Emails sent | ${num(email.totals.sent)} |`);
    out.push(`| Opens | ${num(email.totals.open)} (${pct(email.totals.open, email.totals.delivered)}) |`);
    out.push(`| Clicks | ${num(email.totals.click)} (${pct(email.totals.click, email.totals.delivered)}) |`);
  }
  if (paid.totals) {
    out.push(`| Paid social spend | **${money(paid.totals.spend)}** |`);
    out.push(`| Impressions | ${num(paid.totals.impressions)} |`);
    out.push(`| Clicks | ${num(paid.totals.clicks)} |`);
    const captured = intake.totals.created + intake.totals.updated;
    if (captured && paid.totals.spend) {
      out.push(`| Cost per contact captured | ${money(paid.totals.spend / captured)} |`);
    }
  }
  out.push("");

  // ---- intake ------------------------------------------------------------
  out.push("## Contacts captured");
  out.push("");
  if (!intake.totals.files) {
    out.push("_No lists have been loaded for this show yet._");
  } else {
    out.push("| Source | Contacts | Files | Rejected |");
    out.push("| --- | ---: | ---: | ---: |");
    for (const [source, bucket] of Object.entries(intake.bySource)) {
      out.push(`| ${cell(source)} | ${num(bucket.created + bucket.updated)} | ${bucket.files} | ${num(bucket.rejected)} |`);
    }
    out.push(
      `| **Total** | **${num(intake.totals.created + intake.totals.updated)}** | ` +
        `**${intake.totals.files}** | **${num(intake.totals.rejected)}** |`
    );
    out.push("");
    out.push(
      "_Rejected rows are almost always role inboxes (`info@`, `sales@`) and rows " +
        "with no usable email or phone. They are excluded on purpose._"
    );
  }
  out.push("");

  // ---- audiences ---------------------------------------------------------
  out.push("## Audiences built");
  out.push("");
  if (!audiences.length) {
    out.push("_None yet._");
  } else {
    out.push("| Audience | Brand | Type | Size | Used on |");
    out.push("| --- | --- | --- | ---: | --- |");
    for (const a of audiences) {
      const latest = a.sizeHistory.at(-1);
      const isGeo = a.type === "geo";
      const spec = a.definition?.geo;
      out.push(
        `| ${cell(a.name)} | ${cell(a.brand)} | ${isGeo ? "geo" : "list"} ` +
          `| ${isGeo ? `${spec?.window?.totalDays ?? "?"} days at the venue` : num(latest?.size)} ` +
          `| ${cell(a.destinations.map((d) => d.platform).join(", ") || "not recorded")} |`
      );
    }
  }
  out.push("");

  // ---- email -------------------------------------------------------------
  out.push("## Email");
  out.push("");
  if (email.note) {
    out.push(`_${email.note}_`);
  } else {
    out.push("| Email | Sent | Delivered | Opens | Clicks | Unsubs |");
    out.push("| --- | ---: | ---: | ---: | ---: | ---: |");
    for (const e of email.emails) {
      const s = e.stats || {};
      out.push(
        `| ${cell(e.name)}${e.publishedAt ? ` <br>${day(e.publishedAt)}` : ""} ` +
          `| ${num(s.sent)} | ${num(s.delivered)} ` +
          `| ${num(s.open)} (${pct(s.open, s.delivered)}) ` +
          `| ${num(s.click)} (${pct(s.click, s.delivered)}) | ${num(s.unsubscribed)} |`
      );
    }
    if (email.totals) {
      out.push(
        `| **Total** | **${num(email.totals.sent)}** | **${num(email.totals.delivered)}** ` +
          `| **${num(email.totals.open)}** | **${num(email.totals.click)}** | **${num(email.totals.unsubscribed)}** |`
      );
    }
  }
  out.push("");

  // ---- paid --------------------------------------------------------------
  out.push("## Paid social");
  out.push("");
  if (paid.note) {
    out.push(`_${paid.note}_`);
  } else {
    out.push("**Ad sets counted for this show**");
    out.push("");
    const anyBudget = paid.adSets.some((set) => set.lifetimeBudget || set.dailyBudget);
    out.push(anyBudget
      ? "| Ad set | Runs | Budget | Left | Matched because |"
      : "| Ad set | Campaign | Matched because |");
    out.push(anyBudget ? "| --- | --- | ---: | ---: | --- |" : "| --- | --- | --- |");

    for (const set of paid.adSets) {
      if (!anyBudget) {
        out.push(`| ${cell(set.name)} | ${cell(set.campaignName)} | ${cell(set.matchedBecause)} |`);
        continue;
      }
      const runs = set.startTime
        ? `${day(set.startTime)}${set.endTime ? ` to ${day(set.endTime)}` : ""}`
        : "—";
      const budget = set.lifetimeBudget
        ? `${money(set.lifetimeBudget)} lifetime`
        : set.dailyBudget
          ? `${money(set.dailyBudget)}/day`
          : "—";
      out.push(
        `| ${cell(set.name)} | ${runs} | ${budget} ` +
          `| ${set.budgetRemaining === null ? "—" : money(set.budgetRemaining)} | ${cell(set.matchedBecause)} |`
      );
    }
    out.push("");
    const untagged = paid.adSets.filter((set) => set.matchedVia !== "tag");
    if (untagged.length) {
      out.push(
        `> ${untagged.length} of these matched without a tag. Putting ` +
          "`[tsf:" + show.id + "]` in the campaign or ad set name makes it exact — " +
          "run `tsf show meta-names --id " + show.id + "` for the names to use."
      );
      out.push("");
    }
    if (paid.adSets.some((set) => set.matchedVia === "geo" || set.matchedVia === "name")) {
      out.push(
        "> Some of these were matched on the city or on a name, which is a guess. " +
          "Recording the Meta ad set id against the audience makes it certain."
      );
      out.push("");
    }

    out.push("**Ads**");
    out.push("");
    out.push("| Ad | Status | Spend | Impressions | Clicks | CTR |");
    out.push("| --- | --- | ---: | ---: | ---: | ---: |");
    for (const ad of paid.ads) {
      out.push(
        `| ${cell(ad.name)} | ${ad.status} | ${money(ad.spend)} | ${num(ad.impressions)} ` +
          `| ${num(ad.clicks)} | ${ad.ctr === null ? "—" : ad.ctr.toFixed(2) + "%"} |`
      );
    }
    if (paid.totals) {
      out.push(
        `| **Total** | | **${money(paid.totals.spend)}** | **${num(paid.totals.impressions)}** ` +
          `| **${num(paid.totals.clicks)}** | |`
      );
    }
    out.push("");
    out.push(`_Reach was ${num(paid.totals?.reach)} at most. Reach is not summed across ads — the same people see more than one._`);
    out.push("");

    // ---- creative ------------------------------------------------------
    const withArt = paid.ads.filter((ad) => ad.creative.localFile || ad.creative.previewUrl);
    if (withArt.length) {
      out.push("## The ads themselves");
      out.push("");
      for (const ad of withArt) {
        out.push(`### ${ad.name}`);
        out.push("");
        out.push(`${ad.adSetName || ""}${ad.campaignName ? ` · ${ad.campaignName}` : ""} · ${money(ad.spend)} spent`);
        out.push("");
        if (ad.creative.localFile) out.push(`![${ad.name}](${ad.creative.localFile})`);
        if (ad.creative.previewUrl) {
          out.push("");
          out.push(`[See it rendered as people saw it](${ad.creative.previewUrl})`);
        }
        out.push("");
      }
    }
  }

  if (report.problems.length) {
    out.push("## Gaps in this report");
    out.push("");
    for (const problem of report.problems) out.push(`- ${problem}`);
    out.push("");
  }

  return out.join("\n");
}
