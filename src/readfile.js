// readfile.js — getting rows out of whatever the organizer actually sent.
//
// Real exports are not clean CSV. They are .xlsx with the company logo merged
// across the first three rows, a "Report generated 14/10/2026" line, a blank
// row, and THEN the headers. Or a workbook with four sheets where only one
// holds the attendees.
//
// This module deals with that so the rest of the pipeline never has to.
//
// EDIT THIS FILE IF: a format defeats the header detection. Prefer adding a
// hint to HEADER_HINTS over adding logic.

import fs from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";
import { parse as parseCsvText } from "csv-parse/sync";

/** How far down to look for the header row before giving up. */
const MAX_HEADER_SCAN = 25;

/**
 * Words that make a cell look like a column header rather than data. Used for
 * scoring only — a file whose headers are all unusual still works, it just
 * relies on the shape heuristics instead.
 */
const HEADER_HINTS = [
  "email", "e-mail", "mail", "first", "last", "name", "surname", "company",
  "organization", "organisation", "business", "shop", "title", "job", "role",
  "phone", "mobile", "cell", "tel", "city", "state", "province", "country",
  "zip", "postal", "address", "badge", "attendee", "registrant", "type",
  "status", "id", "website", "url", "date", "registered",
];

const looksLikeEmail = (value) => /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(String(value || "").trim());

/**
 * Scores a row on how much it looks like a header.
 *
 * The signals that matter: cells are short, non-numeric, mostly unique, none
 * of them are email addresses (a header row never contains a real email), and
 * some of them read like column names.
 */
function scoreAsHeader(cells) {
  const filled = cells.filter((cell) => String(cell ?? "").trim() !== "");
  if (filled.length < 2) return -1;

  let score = filled.length;
  let emails = 0;
  let numeric = 0;
  let long = 0;
  let hinted = 0;

  for (const cell of filled) {
    const text = String(cell).trim();
    const lower = text.toLowerCase();
    if (looksLikeEmail(text)) emails++;
    if (text !== "" && !Number.isNaN(Number(text))) numeric++;
    if (text.length > 40) long++;
    if (HEADER_HINTS.some((hint) => lower.includes(hint))) hinted++;
  }

  // A row containing an actual email address is data, not a header.
  if (emails > 0) return -1;

  const unique = new Set(filled.map((c) => String(c).trim().toLowerCase())).size;

  score += hinted * 4;
  score += unique === filled.length ? 3 : 0;
  score -= numeric * 2;
  score -= long * 3;
  return score;
}

/** Turns a sheet's raw rows into { headerIndex, headers, rows }. */
function extractTable(matrix) {
  let bestIndex = -1;
  let bestScore = 0;

  const limit = Math.min(matrix.length, MAX_HEADER_SCAN);
  for (let i = 0; i < limit; i++) {
    const score = scoreAsHeader(matrix[i] || []);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  // Nothing looked like a header — treat row 0 as one and let the operator fix
  // the mapping by hand rather than silently dropping the file.
  if (bestIndex === -1) bestIndex = 0;

  const rawHeaders = (matrix[bestIndex] || []).map((cell, column) => {
    const text = String(cell ?? "").trim();
    return text || `Column ${column + 1}`;
  });

  // Duplicate header names are common ("Email", "Email") and would silently
  // overwrite each other, so make them unique.
  const seen = new Map();
  const headers = rawHeaders.map((name) => {
    const count = seen.get(name) || 0;
    seen.set(name, count + 1);
    return count === 0 ? name : `${name} (${count + 1})`;
  });

  const rows = [];
  for (let i = bestIndex + 1; i < matrix.length; i++) {
    const cells = matrix[i] || [];
    if (cells.every((cell) => String(cell ?? "").trim() === "")) continue; // blank row
    const row = {};
    headers.forEach((header, column) => {
      row[header] = cells[column] === undefined || cells[column] === null ? "" : String(cells[column]).trim();
    });
    rows.push(row);
  }

  return { headerIndex: bestIndex, headers, rows };
}

/** How promising a sheet is: an email column and plenty of rows. */
function scoreSheet(table) {
  if (!table.rows.length) return -1;
  const hasEmailColumn = table.headers.some((h) => /e-?mail/i.test(h));
  const emailValues = table.rows
    .slice(0, 40)
    .filter((row) => Object.values(row).some((value) => looksLikeEmail(value))).length;
  return table.rows.length + (hasEmailColumn ? 500 : 0) + emailValues * 10;
}

/**
 * Reads a spreadsheet or CSV into rows.
 *
 * @param {Buffer|string} data   file contents
 * @param {string} filename      used only to pick a parser and to report back
 * @returns {{ headers, rows, headerIndex, sheetName, sheets, notes }}
 */
export function readTable(data, filename = "upload.csv") {
  const extension = path.extname(filename).toLowerCase();
  const notes = [];

  // --- plain CSV / TSV -----------------------------------------------------
  if (extension === ".csv" || extension === ".tsv" || extension === ".txt") {
    const text = (Buffer.isBuffer(data) ? data.toString("utf8") : String(data)).replace(/^﻿/, "");
    const matrix = parseCsvText(text, {
      columns: false,
      skip_empty_lines: false,
      relax_column_count: true,
      relax_quotes: true,
      delimiter: extension === ".tsv" ? "\t" : ",",
    });
    const table = extractTable(matrix);
    if (table.headerIndex > 0) {
      notes.push(`Skipped ${table.headerIndex} row(s) above the header.`);
    }
    return { ...table, sheetName: null, sheets: [], notes };
  }

  // --- workbook ------------------------------------------------------------
  const workbook = XLSX.read(data, { type: Buffer.isBuffer(data) ? "buffer" : "binary", cellDates: false });
  const sheets = workbook.SheetNames;

  let best = null;
  let bestName = null;
  let bestScore = -Infinity;

  for (const name of sheets) {
    const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
      header: 1,
      blankrows: true,
      defval: "",
      raw: false, // strings, so a phone number keeps its leading zero
    });
    const table = extractTable(matrix);
    const score = scoreSheet(table);
    if (score > bestScore) {
      bestScore = score;
      best = table;
      bestName = name;
    }
  }

  if (!best) return { headers: [], rows: [], headerIndex: 0, sheetName: null, sheets, notes };

  if (sheets.length > 1) {
    notes.push(`Workbook has ${sheets.length} sheets — read "${bestName}" (the one with contacts in it).`);
  }
  if (best.headerIndex > 0) {
    notes.push(`Skipped ${best.headerIndex} row(s) above the header.`);
  }

  return { ...best, sheetName: bestName, sheets, notes };
}

/** Convenience for the CLI, which has a path rather than bytes. */
export function readTableFile(file) {
  return readTable(fs.readFileSync(file), path.basename(file));
}

/** What we can read. Used by the UI's file picker and for a clear error. */
export const SUPPORTED_EXTENSIONS = [".csv", ".tsv", ".txt", ".xlsx", ".xlsm", ".xls"];

export function isSupported(filename) {
  return SUPPORTED_EXTENSIONS.includes(path.extname(filename).toLowerCase());
}
