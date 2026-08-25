// config.js — where everything lives, and how we read credentials.
//
// EDIT THIS FILE IF: you move the data folder, or you keep credentials
// somewhere other than a .env file in the project root.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root — one level up from src/. */
export const ROOT = path.resolve(here, "..");

/**
 * Where the registry lives.
 *
 * This repo is PUBLIC, so the registry is not in it. It lives in the private
 * repo tradeshow-funnel-data, and TSF_DATA_DIR points at your clone of that.
 *
 * Falling back to ./data keeps a fresh checkout working, but that folder is
 * gitignored here — anything written to it is invisible to everyone else and
 * is not backed up. `tsf doctor` says so out loud.
 */
// Read the .env file here as well as the real environment. The README tells
// people to put TSF_DATA_DIR in .env, and reading only process.env would mean
// that silently did nothing — falling back to a gitignored ./data while
// appearing to work, which is the exact failure this whole split is meant to
// avoid.
const DATA_DIR_SETTING =
  process.env.TSF_DATA_DIR || readEnvFile(path.join(ROOT, ".env")).TSF_DATA_DIR || "";

/** True when the registry is somewhere shared, rather than the throwaway default. */
export const DATA_DIR_IS_SET = Boolean(DATA_DIR_SETTING);

const DATA_DIR = DATA_DIR_SETTING ? path.resolve(DATA_DIR_SETTING) : path.join(ROOT, "data");

/** Every path the tool reads or writes. Nothing else should build paths by hand. */
export const PATHS = {
  data: DATA_DIR,
  audiences: path.join(DATA_DIR, "audiences"),
  history: path.join(DATA_DIR, "history"),
  shows: path.join(DATA_DIR, "shows.json"),
  imports: path.join(DATA_DIR, "imports.json"),
  // The report follows the data, so it lands in the private repo alongside it.
  report: DATA_DIR_IS_SET ? path.join(DATA_DIR, "AUDIENCES.md") : path.join(ROOT, "AUDIENCES.md"),
};

/**
 * Reads a KEY=VALUE file into a plain object. Blank lines and # comments are
 * skipped. This is deliberately tiny so there is no dotenv dependency to learn.
 *
 * Declared as a function so it can be called above, before its definition.
 */
function readEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_]+)=(.*)$/.exec(trimmed);
    if (match && match[2]) out[match[1]] = match[2].trim();
  }
  return out;
}

/**
 * Credentials, in priority order:
 *   1. real environment variables (best for CI or a shared machine)
 *   2. .env in the project root
 *   3. the shared credentials file Ben already uses for the other tools
 *
 * The third one is a convenience so this repo works on Ben's machine with no
 * setup. On anyone else's machine, copy .env.example to .env and fill it in.
 */
const SHARED_CREDENTIALS = "C:/Users/benwe/Claude Code/api_credentials.env";

export function loadConfig() {
  const fromProjectEnv = readEnvFile(path.join(ROOT, ".env"));
  const fromSharedFile = readEnvFile(SHARED_CREDENTIALS);
  const merged = { ...fromSharedFile, ...fromProjectEnv, ...process.env };

  return {
    hubspot: {
      accessToken: merged.HUBSPOT_ACCESS_TOKEN || "",
      clientId: merged.HUBSPOT_CLIENT_ID || "",
      clientSecret: merged.HUBSPOT_CLIENT_SECRET || "",
      refreshToken: merged.HUBSPOT_REFRESH_TOKEN || "",
    },
    // Read-only, for the show report. Absent just means the report has no
    // paid social section in it.
    meta: {
      accessToken: merged.META_ACCESS_TOKEN || "",
      adAccountId: merged.META_AD_ACCOUNT_ID || "",
    },

    // Google sign-in. Absent = running locally with no login; see src/auth.js.
    auth: {
      googleClientId: merged.TSF_GOOGLE_CLIENT_ID || "",
      googleClientSecret: merged.TSF_GOOGLE_CLIENT_SECRET || "",
      allowedDomain: merged.TSF_ALLOWED_DOMAIN || "r1concepts.com",
      publicUrl: (merged.TSF_PUBLIC_URL || "http://localhost:4477").replace(/\/+$/, ""),
      // Sessions do not survive a restart without this set, which is fine
      // locally and not fine on a deployed server.
      sessionSecret: merged.TSF_SESSION_SECRET || randomSecret(),
    },

    // Where to listen. 127.0.0.1 keeps it off the network; a deploy needs
    // 0.0.0.0, which src/auth.js will refuse without sign-in configured.
    server: {
      port: Number(merged.PORT || merged.TSF_PORT || 4477),
      host: merged.TSF_HOST || "127.0.0.1",
    },

    // Stamped onto every history entry so we can tell who ran what. When people
    // are signed in, the signed-in email wins over this.
    actor: merged.TSF_ACTOR || merged.USERNAME || merged.USER || "unknown",
  };
}

/** A throwaway secret, so local runs work with no setup. */
let cachedSecret = null;
function randomSecret() {
  if (!cachedSecret) cachedSecret = crypto.randomBytes(32).toString("hex");
  return cachedSecret;
}

/** Creates the data folders on first run so nothing has to exist up front. */
export function ensureDataDirs() {
  for (const dir of [PATHS.data, PATHS.audiences, PATHS.history]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
