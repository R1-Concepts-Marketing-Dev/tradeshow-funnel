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
const MAPPING_TOOL = {
  name: "report_mapping",
  description: "Report which spreadsheet column holds which contact field.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      mapping: {
        type: "object",
        additionalProperties: false,
        description:
          "Our field name -> the exact column header it comes from. Omit a field entirely if no column holds it. Never invent a header.",
        properties: Object.fromEntries(FIELDS.map((f) => [f, { type: "string" }])),
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
          "Two or three plain sentences for someone who does not know what a column mapping is. Say what you found and what you are ignoring. No jargon.",
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
- A column can be used once. If two columns could be email, pick the one more
  likely to be a work address, and warn about the other.
- Never map a column that is an opt-out, consent, subscription or bounce flag to
  a contact field. Those are the file's own metadata, not the person's details.
- A column that is mostly empty is usually not the field it is named after. Say so.
- If nothing looks like an email or a phone, say the file may not be a contact
  list, set confidence low, and explain what you think it is instead.

Write the summary for a marketer, not an engineer. "Found 2,847 people, using
'Badge Email' for email and 'Cell' for phone" — not "mapped email->Badge Email".`;

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

  // Never trust a header that is not actually in the file.
  const known = new Set(table.headers);
  const mapping = {};
  for (const [field, header] of Object.entries(call.input.mapping || {})) {
    if (known.has(header)) mapping[field] = header;
  }

  const splitFullName =
    call.input.splitFullName && known.has(call.input.splitFullName)
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
