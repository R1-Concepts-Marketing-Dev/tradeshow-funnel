// markdown.js — small helpers for building the report tables.
//
// EDIT THIS FILE IF: a report table renders wrong because of a character in
// someone's campaign or list name.

/**
 * Escapes a value so it is safe inside a markdown table cell.
 *
 * This exists because of a real bug: the Meta naming convention here is
 * pipe-delimited — "AD | General | Video" — and an unescaped name silently
 * shatters a six-column table into eight columns. Newlines do the same thing
 * vertically. Everything that comes from Meta or HubSpot goes through this.
 */
export function cell(value) {
  return String(value ?? "—")
    .split("|")
    .join("\\|")
    // Any run of whitespace, newlines included, becomes a single space —
    // otherwise a CRLF leaves a double gap in the middle of a cell.
    .replace(/\s+/g, " ")
    .trim();
}

/** Thousands separators, and an em dash rather than a bare 0 for "unknown". */
export function num(value) {
  return value === null || value === undefined ? "—" : Number(value).toLocaleString("en-US");
}

/** Currency, always to two places so columns line up. */
export function money(value) {
  return value === null || value === undefined
    ? "—"
    : "$" +
        Number(value).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
}

/** A percentage of a total, or an em dash when the total is zero. */
export function pct(part, whole) {
  return whole ? ((part / whole) * 100).toFixed(1) + "%" : "—";
}

/** Just the date out of an ISO timestamp. */
export function day(iso) {
  return String(iso || "").slice(0, 10);
}
