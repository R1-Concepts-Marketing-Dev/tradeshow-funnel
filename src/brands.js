// brands.js — R1 Concepts and Dynamic Friction are separate businesses here.
//
// They share a HubSpot portal but not their audiences. A DFC audience must
// never quietly include R1 contacts, so brand is required on an import and on
// an audience, and there is no "all brands" option when writing — only when
// looking.
//
// The ids and colours match the Paid Media Console (src/data/catalog.ts) on
// purpose, so the two tools read as one suite.
//
// EDIT THIS FILE IF: you add a brand, or you find R1's HubSpot business unit id.

import fs from "node:fs";
import path from "node:path";
import { PATHS, ensureDataDirs } from "./config.js";

const BRANDS_FILE = path.join(PATHS.data, "brands.json");

/**
 * Written to data/brands.json on first run, then editable there.
 *
 * hubspotBusinessUnitId comes from the portal's Business Units. Dynamic
 * Friction is 311464 and Drilled Rotors is 311463 (confirmed via the
 * business_unit_optout_* properties). R1 Concepts is the ROOT business unit
 * and its id could not be read — the API call needs a scope this app does not
 * have. Fill it in when you have it; nothing breaks without it, the tool just
 * cannot stamp the HubSpot "Brands" field for R1.
 */
export const DEFAULT_BRANDS = [
  {
    id: "r1",
    name: "R1 Concepts",
    shortName: "R1",
    accent: "#c8102e",
    accentWash: "#fbe9ec",
    hubspotBusinessUnitId: null,
  },
  {
    id: "dfc",
    name: "Dynamic Friction Company",
    shortName: "DFC",
    accent: "#ef6c1a",
    accentWash: "#fdeee2",
    hubspotBusinessUnitId: "311464",
  },
];

export function loadBrands() {
  ensureDataDirs();
  if (!fs.existsSync(BRANDS_FILE)) {
    fs.writeFileSync(BRANDS_FILE, JSON.stringify(DEFAULT_BRANDS, null, 2) + "\n", "utf8");
  }
  return JSON.parse(fs.readFileSync(BRANDS_FILE, "utf8"));
}

export function saveBrands(brands) {
  ensureDataDirs();
  fs.writeFileSync(BRANDS_FILE, JSON.stringify(brands, null, 2) + "\n", "utf8");
}

/** Accepts an id, a short name, or a full name. Case-insensitive. */
export function resolveBrand(input) {
  if (!input) return null;
  const needle = String(input).trim().toLowerCase();
  return (
    loadBrands().find(
      (brand) =>
        brand.id.toLowerCase() === needle ||
        brand.shortName.toLowerCase() === needle ||
        brand.name.toLowerCase() === needle
    ) || null
  );
}

/**
 * Use when a brand is required. Throws with the valid options rather than
 * letting an unbranded record into the registry.
 */
export function requireBrand(input) {
  const brand = resolveBrand(input);
  if (brand) return brand;
  const options = loadBrands().map((b) => `${b.id} (${b.name})`).join(", ");
  throw new Error(
    input
      ? `Unknown brand "${input}". Valid: ${options}`
      : `A brand is required. Valid: ${options}`
  );
}

/** Short label for tables and logs. Falls back to the raw id if unknown. */
export function brandLabel(brandId) {
  return resolveBrand(brandId)?.shortName || brandId || "—";
}
