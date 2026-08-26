// tunnel.js — puts the tool on a URL, from your own machine, for nothing.
//
// WHAT THIS IS
//
// `cloudflared` makes an OUTBOUND connection to Cloudflare and asks them to
// forward a public hostname back down it. No inbound ports, no firewall
// changes, no host to pay for. While it runs, colleagues can open a link and
// use the tool; when you close it or your PC sleeps, the link dies.
//
// THE THING TO UNDERSTAND BEFORE USING IT
//
// A tunnel forwards to 127.0.0.1, so the server still thinks it is local. The
// bind-time guard in src/auth.js cannot see the difference. That is why this
// command REFUSES to open anything until a gate is configured, and why gate()
// independently rejects remote requests. Two checks, because getting this
// wrong publishes a HubSpot write token to the internet.
//
// FREE TUNNELS GET A NEW HOSTNAME EVERY TIME
//
// Which is why TSF_ACCESS_PASSPHRASE exists. Google will only redirect to URLs
// registered ahead of time, so Google sign-in cannot work behind a URL that
// changes on every restart. If you want a permanent address and proper
// per-person sign-in, see docs/SHARING.md — it needs a hostname you control.
//
// EDIT THIS FILE IF: you move to a named tunnel, or swap cloudflared for
// something else. The rest of the tool does not know this file exists.

import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import * as auth from "./auth.js";

/** A trycloudflare hostname, as it appears in cloudflared's output. */
const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Where winget and Homebrew put cloudflared.
 *
 * Needed because Windows does not refresh PATH in terminals that are already
 * open. Someone runs `winget install`, watches it succeed, runs `tsf tunnel` in
 * the same window, and is told cloudflared is not installed. Checking the known
 * locations turns that into a non-event.
 */
const KNOWN_LOCATIONS = [
  "C:/Program Files (x86)/cloudflared/cloudflared.exe",
  "C:/Program Files/cloudflared/cloudflared.exe",
  "/opt/homebrew/bin/cloudflared",
  "/usr/local/bin/cloudflared",
];

/**
 * Is cloudflared installed and runnable, and what do we call it?
 *
 * @returns {{ok: boolean, command?: string, version?: string}}
 */
export function findCloudflared() {
  // No shell: passing args through a shell on Windows concatenates them
  // unescaped, which Node now warns about.
  const tryCommand = (command) => {
    try {
      const probe = spawnSync(command, ["--version"], { encoding: "utf8" });
      if (probe.status === 0) return { ok: true, command, version: (probe.stdout || "").trim() };
    } catch {
      // Not there. Fall through to the next candidate.
    }
    return null;
  };

  return (
    tryCommand("cloudflared") ||
    KNOWN_LOCATIONS.filter((location) => fs.existsSync(location)).map(tryCommand).find(Boolean) ||
    { ok: false }
  );
}

/**
 * Checks everything that should be true before a URL is handed out.
 *
 * Two lists, because they mean different things. A **blocker** would put
 * contact data on the internet, so nothing opens until it is fixed. A
 * **warning** is a nuisance you should know about — refusing over one would
 * just teach people to work around the check.
 *
 * @returns {{blockers: string[], warnings: string[]}}
 */
export function preflight() {
  const config = loadConfig();
  const blockers = [];
  const warnings = [];

  if (!auth.isAuthConfigured()) {
    blockers.push(
      "No gate is configured, so anyone with the link could import contacts and\n" +
        "    read your HubSpot data. Set one in .env and try again:\n\n" +
        "      TSF_ACCESS_PASSPHRASE=some-phrase-you-share\n\n" +
        "    Or configure Google sign-in if this tool has a permanent hostname —\n" +
        "    see docs/SHARING.md."
    );
  }

  if (!findCloudflared().ok) {
    blockers.push(
      "cloudflared is not installed. On Windows:\n\n" +
        "      winget install --id Cloudflare.cloudflared\n\n" +
        "    Then open a new terminal so the PATH updates."
    );
  }

  // Everyone gets signed out on restart. Irritating, not unsafe.
  if (auth.isAuthConfigured() && !config.auth.sessionSecretPinned) {
    warnings.push(
      "TSF_SESSION_SECRET is not set, so everyone will be signed out whenever\n" +
        "    you restart. Put any long random string in .env to stop that."
    );
  }

  return { blockers, warnings };
}

/**
 * Opens a quick tunnel to a local port and resolves with the public URL.
 *
 * @param {object} options
 * @param {number} options.port          the local port the tool is serving on
 * @param {function} options.onLine      called with each line cloudflared prints
 * @param {number} options.timeoutMs     how long to wait for a URL
 * @returns {Promise<{url: string, child: object}>}
 */
export function openQuickTunnel({ port, onLine = () => {}, timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    // The same binary preflight found, which may be a full path when PATH has
    // not caught up with the install yet.
    const found = findCloudflared();
    const command = found.command || "cloudflared";

    const child = spawn(command, [
      "tunnel",
      "--no-autoupdate",
      "--url",
      `http://localhost:${port}`,
    ]);

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error("cloudflared did not produce a URL within 45 seconds."));
    }, timeoutMs);

    // cloudflared writes its banner to stderr, including the URL. Watch both
    // streams rather than guessing which one it will be this version.
    const watch = (chunk) => {
      const text = String(chunk);
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());

      const match = text.match(URL_PATTERN);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ url: match[0], child });
      }
    };

    child.stdout.on("data", watch);
    child.stderr.on("data", watch);

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Could not start cloudflared: ${error.message}`));
    });

    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`cloudflared exited with code ${code} before giving a URL.`));
    });
  });
}
