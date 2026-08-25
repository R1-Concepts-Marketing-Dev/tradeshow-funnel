// config.js — where everything lives, and how we read credentials.
//
// EDIT THIS FILE IF: you move the data folder, or you keep credentials
// somewhere other than a .env file in the project root.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Project root — one level up from src/. */
export const ROOT = path.resolve(here, "..");

/** Every path the tool reads or writes. Nothing else should build paths by hand. */
export const PATHS = {
  data: path.join(ROOT, "data"),
  audiences: path.join(ROOT, "data", "audiences"),
  history: path.join(ROOT, "data", "history"),
  shows: path.join(ROOT, "data", "shows.json"),
  imports: path.join(ROOT, "data", "imports.json"),
  report: path.join(ROOT, "AUDIENCES.md"),
};

/**
 * Reads a KEY=VALUE file into a plain object. Blank lines and # comments are
 * skipped. This is deliberately tiny so there is no dotenv dependency to learn.
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
    // Stamped onto every history entry so we can tell who ran what.
    actor: merged.TSF_ACTOR || merged.USERNAME || merged.USER || "unknown",
  };
}

/** Creates the data folders on first run so nothing has to exist up front. */
export function ensureDataDirs() {
  for (const dir of [PATHS.data, PATHS.audiences, PATHS.history]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
