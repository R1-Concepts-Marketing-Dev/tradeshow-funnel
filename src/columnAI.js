// columnAI.js — letting Claude work out which column is which.
//
// The rule-based guesser in src/ingest.js handles headers it has seen before.
// It cannot split a single "Attendee Name" column into first and last, tell a
// work email from a personal one, notice that a file is an exhibitor list
// rather than an attendee list, or explain any of that to the person uploading.
//
// This does. The point is that nobody has to know what a column mapping is:
// they drop a file and read a sentence about what was found.
//
// PRIVACY — READ THIS BEFORE CHANGING IT
//
// No contact data is sent to the API. For each column we send the header, how
// full it is, how varied it is, and what the values LOOK like — "94% are 10-11
// digits", "98% contain an @ and a dot" — plus heavily masked examples
// (j***@b***.com). Claude maps just as well from the shape as from the values,
// and nobody's email leaves the building to do it.
//
// If you ever find yourself wanting to send raw values "just to improve
// accuracy", measure first. It has not been necessary.
//
// EDIT THIS FILE IF: you want Claude to spot something it currently does not.
// Add it to the tool schema and say so in the prompt.

import Anthropic from "@anthropic-ai/sdk";
import { loadConfig } from "./config.js";
import { COLUMN_GUESSES } from "./ingest.js";

/** Nothing to send to, so callers fall back to the rule-based guesser. */
export function isAvailable() {
  const { anthropic } = loadConfig();
  return Boolean(anthropic.apiKey);
}

// ---------------------------------------------------------------------------
// Describing a column without exposing it
// ---------------------------------------------------------------------------

const PATTERNS = {
  email: (v) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(v),
  phoneish: (v) => v.replace(/\D/g, "").length >= 7 && v.replace(/\D/g, "").length <= 15,
  numeric: (v) => v !== "" && !Number.isNaN(Number(v)),
  url: (v) => /^https?:\/\//i.test(v) || /^www\./i.test(v),
  date: (v) => !Number.isNaN(Date.parse(v)) && /\d{4}|\/|-/.test(v),
  twoWords: (v) => /^[A-Za-z][\w'’-]*\s+[A-Za-z][\w'’-]*$/.test(v),
  oneWord: (v) => /^[A-Za-z][\w'’-]*$/.test(v),
  yesNo: (v) => /^(y|n|yes|no|true|false|0|1)$/i.test(v),
};

/** Masks a value down to its shape. Nothing identifying survives this. */
export function mask(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";

  if (PATTERNS.email(text)) {
    const [local, domain] = text.split("@");
    const [host, ...rest] = domain.split(".");
    return `${local[0]}***@${host[0]}***.${rest.join(".")}`;
  }
  if (PATTERNS.phoneish(text)) {
    const digits = text.replace(/\D/g, "");
    return `${"#".repeat(Math.max(0, digits.length - 2))}${digits.slice(-2)}`;
  }
  if (PATTERNS.url(text)) return "https://***";

  // Anything else: keep first letter of each word, and the length.
  return text
    .split(/\s+/)
    .slice(0, 4)
    .map((word) => (word.length > 1 ? `${word[0]}${"*".repeat(Math.min(word.length - 1, 4))}` : word))
    .join(" ");
}

/**
 * Turns a table into a description Claude can map from.
 *
 * @param {string[]} headers
 * @param {object[]} rows
 * @param {number} sampleSize how many rows to look at
 */
export function profileColumns(headers, rows, sampleSize = 200) {
  const sample = rows.slice(0, sampleSize);

  return headers.map((header) => {
    const values = sample.map((row) => String(row[header] ?? "").trim());
    const filled = values.filter(Boolean);
    const pct = (n) => (filled.length ? Math.round((n / filled.length) * 100) : 0);

    const looks = {};
    for (const [name, test] of Object.entries(PATTERNS)) {
      const hits = pct(filled.filter(test).length);
      if (hits >= 10) looks[name] = hits;
    }

    return {
      header,
      filledPercent: values.length ? Math.round((filled.length / values.length) * 100) : 0,
      distinctPercent: filled.length
        ? Math.round((new Set(filled.map((v) => v.toLowerCase())).size / filled.length) * 100)
        : 0,
      averageLength: filled.length
        ? Math.round(filled.reduce((n, v) => n + v.length, 0) / filled.length)
        : 0,
      looksLike: looks,
      // Masked, and only three of them.
      examples: filled.slice(0, 3).map(mask),
    };
  });
}

// ---------------------------------------------------------------------------
// Asking Claude
// ---------------------------------------------------------------------------

const FIELDS = Object.keys(COLUMN_GUESSES);

/**
 * A strict tool rather than free text, so the answer is always the right
 * shape and never needs parsing out of prose.
 */
/**
 * A strict tool rather than free text, so the answer is always the right
 * shape and never needs parsing out of prose.
 *
 * WHY mapping IS AN ARRAY AND NOT AN OBJECT
 *
 * It was an object — one optional property per field — and under strict mode
 * that quietly wrecked the whole response. The model could not cleanly express
 * "this field has no column", so it returned a sparse mapping (missing an
 * obviously phone-shaped column) AND the literal word "placeholder" as the
 * summary. Nothing errored; the answer was just bad.
 *
 * As a list of {field, header} pairs, "omit it" is simply "do not add an
 * entry", which the schema expresses naturally. Same model, same prompt,
 * correct mapping and a real summary. Do not change this back.
 */
const MAPPING_TOOL = {
  name: "report_mapping",
  description: "Report which spreadsheet column holds which contact field.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mapping: {
        type: "array",
        description:
          "One entry per column you can confidently place. Leave a field out entirely if no column holds it. Never invent a header.",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            field: { type: "string", enum: FIELDS },
            header: { type: "string", description: "The exact header text from the file." },
          },
          required: ["field", "header"],
        },
      },
      splitFullName: {
        type: ["string", "null"],
        description:
          "If one column holds a whole name and there are no separate first/last columns, the exact header of that column. Otherwise null.",
      },
      fileLooksLike: {
        type: "string",
        enum: ["attendee list", "exhibitor list", "badge scan export", "tablet or form export", "something else"],
        description: "Your best read of what this file actually is.",
      },
      summary: {
        type: "string",
        description:
          "Two or three real sentences about THIS file, for someone who does not know what a column mapping is. How many people, which column you used for email and phone, what you ignored. Never filler.",
      },
      warnings: {
        type: "array",
        description: "Anything the person should check before importing. Empty if nothing.",
        items: { type: "string" },
      },
      confidence: {
        type: "string",
        enum: ["high", "medium", "low"],
        description: "Low if the columns are ambiguous or this may not be a contact list at all.",
      },
    },
    required: ["mapping", "splitFullName", "fileLooksLike", "summary", "warnings", "confidence"],
  },
};

const SYSTEM = `You map spreadsheet columns onto contact fields for a trade show lead importer.

You are given, for each column: its header, how full it is, how varied the values
are, what the values look like as patterns, and a few MASKED examples. You never
see real contact data — do not ask for it, and do not assume a column is unusable
just because its examples are masked.

Rules:
- Only ever name a header that appears in the input. Never invent one.
- Map EVERY column you can confidently place. A phone-shaped column is the
  phone; leaving it out costs match rate on every ad platform later.
- A column can be used once. If two columns could be email, pick the one more
  likely to be a work address, and warn about the other.
- Never map a column that is an opt-out, consent, subscription or bounce flag to
  a contact field. Those are the file's own metadata, not the person's details.
- A column that is mostly empty is usually not the field it is named after. Say so.
- If nothing looks like an email or a phone, say the file may not be a contact
  list, set confidence low, and explain what you think it is instead.

WHAT THE TOOL ALREADY HANDLES — never tell anyone to do these by hand:
- Phone numbers are converted to E.164 (+1...) automatically at export.
- Emails are lowercased and trimmed; Gmail dots are handled for Google.
- Country and state spellings are turned into codes; US ZIPs get their leading
  zeros restored.
- A single full-name column is split into first and last.
- Opted-out, hard-bounced and role inboxes are excluded from ad uploads.
Warn only about things a PERSON has to decide or fix.

The summary is read by a marketer who has never mapped a column. Write real
sentences about THIS file — "Found 2,847 people, using 'Badge Email' for email
and 'Cell' for phone" — not "mapped email->Badge Email", and never filler.`;

/**
 * Turns Claude's list of {field, header} pairs into the mapping object the rest
 * of the tool uses, discarding anything that cannot be true.
 *
 * This is the safety net, and it matters more than it looks. A header that is
 * not in the file would silently map a field to nothing — an import with no
 * email addresses that looks completely normal until the audience comes out
 * empty. That exact failure is why the rule-based guesser has a second pass.
 *
 * Rules, in order: the header must really exist, one column can only feed one
 * field, and the first claim on a field wins.
 *
 * @param {Array<{field: string, header: string}>} pairs
 * @param {string[]} headers  the headers actually in the file
 */
export function toMapping(pairs, headers) {
  const known = new Set(headers);
  const taken = new Set();
  const mapping = {};

  for (const entry of pairs || []) {
    const field = entry?.field;
    const header = entry?.header;
    if (!field || !header) continue;
    if (!known.has(header) || taken.has(header) || mapping[field]) continue;
    mapping[field] = header;
    taken.add(header);
  }

  return mapping;
}

/**
 * Asks Claude to map the columns.
 *
 * @param {object} table  from src/readfile.js — { headers, rows, sheetName, notes }
 * @param {object} options
 * @returns {Promise<object|null>} null when no API key is configured
 */
export async function suggestMapping(table, { filename = "upload.csv" } = {}) {
  const { anthropic } = loadConfig();
  if (!anthropic.apiKey) return null;

  const client = new Anthropic({ apiKey: anthropic.apiKey, baseURL: anthropic.baseUrl });
  const profile = profileColumns(table.headers, table.rows);

  const brief = [
    `File: ${filename}`,
    table.sheetName ? `Sheet read: ${table.sheetName}` : null,
    // Worth saying out loud: a workbook with four tabs where we read one is a
    // real way to import a third of a roster and never notice.
    (table.sheets || []).length > 1
      ? `Other sheets in this workbook, NOT read: ${(table.sheets || [])
          .filter((sheet) => sheet !== table.sheetName)
          .join(", ")}`
      : null,
    ...(table.notes || []),
    `Rows: ${table.rows.length}`,
    "",
    "Columns:",
    ...profile.map((c) => {
      const looks = Object.entries(c.looksLike)
        .map(([k, v]) => `${v}% ${k}`)
        .join(", ") || "no clear pattern";
      return (
        `- "${c.header}" — ${c.filledPercent}% filled, ${c.distinctPercent}% distinct, ` +
        `avg ${c.averageLength} chars, ${looks}. Masked examples: ${c.examples.join(" | ") || "(all empty)"}`
      );
    }),
    "",
    `Fields available: ${FIELDS.join(", ")}`,
  ]
    .filter(Boolean)
    .join("\n");

  const response = await client.messages.create({
    model: anthropic.model,
    max_tokens: 4000,
    system: SYSTEM,
    tools: [MAPPING_TOOL],
    tool_choice: { type: "tool", name: "report_mapping" },
    messages: [{ role: "user", content: brief }],
  });

  const call = response.content.find((block) => block.type === "tool_use");
  if (!call) return null;

  const mapping = toMapping(call.input.mapping, table.headers);

  // Same rule as the mapping: a header Claude names has to actually be in the
  // file. This is checked separately because splitFullName is not part of the
  // mapping list.
  const splitFullName = table.headers.includes(call.input.splitFullName)
    ? call.input.splitFullName
    : null;

  return {
    mapping,
    splitFullName,
    fileLooksLike: call.input.fileLooksLike,
    summary: call.input.summary,
    warnings: call.input.warnings || [],
    confidence: call.input.confidence,
    model: anthropic.model,
    usage: {
      input: response.usage?.input_tokens ?? null,
      output: response.usage?.output_tokens ?? null,
    },
  };
}
