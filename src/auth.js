// auth.js — who is allowed in.
//
// Three modes, and the tool picks between them so you cannot get it wrong:
//
//   LOCAL       Bound to 127.0.0.1 with no gate configured. No login. Only the
//               person at that keyboard can reach it, which is the same
//               protection a desktop app has.
//
//   GOOGLE      TSF_GOOGLE_CLIENT_ID is set. Sign in with a Workspace account
//               on TSF_ALLOWED_DOMAIN. The best option, and the one to use
//               whenever the tool has a stable hostname.
//
//   PASSPHRASE  TSF_ACCESS_PASSPHRASE is set. One shared phrase, typed once,
//               remembered for 12 hours.
//
//               This exists for tunnels. A free Cloudflare quick tunnel hands
//               out a new hostname every restart, and Google will only redirect
//               to URLs registered in advance — so Google sign-in cannot work
//               behind a URL that changes. A passphrase can.
//
//               It is weaker than Google: one secret, shared, with no record of
//               who used it. Prefer Google wherever the URL holds still, and
//               see docs/SHARING.md for how to get a permanent hostname.
//
// TWO GUARDS, NOT ONE
//
// assertSafeToBind() refuses to listen on a public interface without a gate.
// That is not enough on its own: a tunnel (Cloudflare, ngrok, Tailscale) makes
// an OUTBOUND connection and forwards to 127.0.0.1, so the bind stays local and
// the check never fires while the whole internet can reach the tool. So
// gate() also inspects each request and refuses remote ones when no gate is
// configured — see looksRemote(). Removing either one exposes contact data and
// a HubSpot token with write access.
//
// No dependencies: Google's OAuth flow is a couple of HTTPS calls, and Node has
// the crypto needed to sign a session cookie.
//
// EDIT THIS FILE IF: you need a second allowed domain, or a different session
// lifetime. Adding a whole second identity provider probably wants its own file.

import crypto from "node:crypto";
import { loadConfig } from "./config.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

const SESSION_COOKIE = "tsf_session";
const STATE_COOKIE = "tsf_oauth_state";
const SESSION_HOURS = 12;

/** True when Google sign-in is possible. */
export function isGoogleConfigured() {
  const { auth } = loadConfig();
  return Boolean(auth.googleClientId && auth.googleClientSecret);
}

/** True when a shared passphrase is set. */
export function isPassphraseConfigured() {
  return Boolean(loadConfig().auth.accessPassphrase);
}

/** True when SOMETHING guards the door. */
export function isAuthConfigured() {
  return isGoogleConfigured() || isPassphraseConfigured();
}

/** Which gate is in force, for anything that needs to say so out loud. */
export function authMode() {
  if (isGoogleConfigured()) return "google";
  if (isPassphraseConfigured()) return "passphrase";
  return "none";
}

/**
 * Does this request look like it came from somewhere other than this machine?
 *
 * Two signals, either of which is enough:
 *
 *   1. The Host header names something that is not localhost. A tunnel
 *      forwards the hostname the visitor typed, so a request for
 *      "quiet-fox-1234.trycloudflare.com" is visibly not local.
 *
 *   2. A proxy header is present. Cloudflare adds cf-connecting-ip; most
 *      other proxies add x-forwarded-for. Nothing on your own machine does.
 *
 * A determined person could forge their way past this — `cloudflared` will
 * rewrite the Host header if you ask it to. That is fine: this guard exists to
 * stop an ACCIDENT, which is what actually happens. Someone tunnels the tool to
 * show a colleague, forgets it has no login, and walks away. Deliberately
 * disabling a safety check is a different problem from tripping over one.
 */
export function looksRemote(request) {
  const headers = request.headers || {};
  if (headers["cf-connecting-ip"] || headers["x-forwarded-for"] || headers["x-forwarded-host"]) {
    return true;
  }

  const host = hostname(headers.host);
  if (!host) return false;
  return !(host === "localhost" || host === "127.0.0.1" || host === "::1");
}

/**
 * The hostname out of a Host header, without its port.
 *
 * Splitting on ":" is not enough: an IPv6 address is full of colons, and it
 * arrives bracketed as "[::1]:4477". Getting this wrong made the tool treat its
 * own loopback requests as remote and refuse them.
 */
function hostname(header) {
  const value = String(header || "").trim().toLowerCase();
  if (!value) return "";

  // Bracketed IPv6, with or without a port: [::1] or [::1]:4477
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? value.slice(1) : value.slice(1, close);
  }

  // More than one colon and no brackets means a bare IPv6 address, which has
  // no port to strip.
  if (value.indexOf(":") !== value.lastIndexOf(":")) return value;

  return value.split(":")[0];
}

/**
 * Refuses to start a server that would be reachable from the network without
 * a login. This is the guard that stops a deploy from quietly exposing
 * everyone's contact data.
 */
export function assertSafeToBind(host) {
  const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (isLocal || isAuthConfigured()) return;

  throw new Error(
    `Refusing to bind to ${host} without sign-in configured.\n\n` +
      `This app holds contact data and a HubSpot token that can write to your portal.\n` +
      `Binding to anything other than localhost makes it reachable from the network.\n\n` +
      `Either run it locally (the default), or configure a gate and try again.\n\n` +
      `  Google sign-in, best when the URL holds still:\n` +
      `    TSF_GOOGLE_CLIENT_ID  TSF_GOOGLE_CLIENT_SECRET  TSF_ALLOWED_DOMAIN\n` +
      `    TSF_SESSION_SECRET    TSF_PUBLIC_URL\n\n` +
      `  Shared passphrase, for a tunnel whose URL changes:\n` +
      `    TSF_ACCESS_PASSPHRASE\n\n` +
      `See docs/SHARING.md.`
  );
}

// ---------------------------------------------------------------------------
// Session cookie — payload.signature, signed with HMAC-SHA256
// ---------------------------------------------------------------------------

const b64url = (buffer) => Buffer.from(buffer).toString("base64url");

function sign(value, secret) {
  return crypto.createHmac("sha256", secret).update(value).digest("base64url");
}

function makeToken(payload, secret) {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
}

function readToken(token, secret) {
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");

  // Constant-time compare, so a wrong signature cannot be guessed by timing.
  const expected = sign(body, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(request) {
  const header = request.headers.cookie || "";
  const out = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function cookieHeader(name, value, { maxAgeSeconds, secure }) {
  const bits = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) bits.push("Secure");
  return bits.join("; ");
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/** Who is signed in, or null. */
export function currentUser(request) {
  const { auth } = loadConfig();
  if (!isAuthConfigured()) return { email: "local", name: "Local user", local: true };
  const token = parseCookies(request)[SESSION_COOKIE];
  return readToken(token, auth.sessionSecret);
}

/**
 * Checks the shared passphrase and, if it matches, issues the same session
 * cookie the Google flow issues.
 *
 * Compared in constant time so the phrase cannot be guessed a character at a
 * time by watching how long the answer takes.
 */
export function submitPassphrase(request, response, attempt) {
  const { auth } = loadConfig();
  const secure = auth.publicUrl.startsWith("https://") || looksRemote(request);

  const a = Buffer.from(String(attempt ?? ""));
  const b = Buffer.from(auth.accessPassphrase);
  const ok = a.length === b.length && crypto.timingSafeEqual(a, b);

  if (!ok) {
    response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
    response.end(
      loginPage({
        mode: "passphrase",
        error: "That is not the passphrase. Ask whoever sent you the link.",
      })
    );
    return;
  }

  // There is no identity behind a shared phrase, so the history log says so
  // rather than inventing a name. Anyone who needs attribution wants Google.
  const session = makeToken(
    {
      email: "shared-link",
      name: "Shared link",
      viaPassphrase: true,
      exp: Date.now() + SESSION_HOURS * 3600 * 1000,
    },
    auth.sessionSecret
  );

  response.writeHead(302, {
    location: "/",
    "set-cookie": cookieHeader(SESSION_COOKIE, session, {
      maxAgeSeconds: SESSION_HOURS * 3600,
      secure,
    }),
  });
  response.end();
}

/** Sends the browser to Google. */
export function startLogin(request, response) {
  const { auth } = loadConfig();
  const state = crypto.randomBytes(16).toString("base64url");
  const secure = auth.publicUrl.startsWith("https://");

  const params = new URLSearchParams({
    client_id: auth.googleClientId,
    redirect_uri: `${auth.publicUrl}/auth/callback`,
    response_type: "code",
    scope: "openid email profile",
    state,
    // Ask Google to show only accounts on our domain. It is a hint, not a
    // guarantee — the real check is on the hd claim after the exchange.
    hd: auth.allowedDomain,
    prompt: "select_account",
  });

  response.writeHead(302, {
    location: `${GOOGLE_AUTH}?${params}`,
    "set-cookie": cookieHeader(STATE_COOKIE, state, { maxAgeSeconds: 600, secure }),
  });
  response.end();
}

/**
 * Handles Google's redirect back. Verifies the state, swaps the code for
 * tokens, and checks the account is on the allowed domain.
 */
export async function completeLogin(request, response, url) {
  const { auth } = loadConfig();
  const secure = auth.publicUrl.startsWith("https://");
  const fail = (message) => {
    response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
    response.end(loginPage({ error: message, publicUrl: auth.publicUrl }));
  };

  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = parseCookies(request)[STATE_COOKIE];

  if (!code) return fail("Google did not send a sign-in code. Try again.");
  if (!state || state !== expectedState) {
    return fail("That sign-in link expired or was tampered with. Start again.");
  }

  const tokenResponse = await fetch(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: auth.googleClientId,
      client_secret: auth.googleClientSecret,
      redirect_uri: `${auth.publicUrl}/auth/callback`,
      grant_type: "authorization_code",
    }),
  });

  const tokens = await tokenResponse.json();
  if (!tokens.id_token) {
    return fail(`Google rejected the sign-in: ${tokens.error_description || tokens.error || "unknown error"}`);
  }

  // The id_token came straight from Google over HTTPS on a server-to-server
  // call authenticated with our client secret, so the payload can be trusted
  // without re-verifying the signature. Google documents this exception.
  const claims = JSON.parse(
    Buffer.from(tokens.id_token.split(".")[1], "base64url").toString("utf8")
  );

  // The actual access decision. `hd` is the Workspace domain of the account.
  const domain = claims.hd || String(claims.email || "").split("@")[1];
  if (!claims.email_verified || domain !== auth.allowedDomain) {
    return fail(
      `${claims.email || "That account"} is not on ${auth.allowedDomain}, so it cannot use this tool.`
    );
  }

  const session = makeToken(
    {
      email: claims.email,
      name: claims.name || claims.email,
      picture: claims.picture || null,
      exp: Date.now() + SESSION_HOURS * 3600 * 1000,
    },
    auth.sessionSecret
  );

  response.writeHead(302, {
    location: "/",
    "set-cookie": [
      cookieHeader(SESSION_COOKIE, session, { maxAgeSeconds: SESSION_HOURS * 3600, secure }),
      cookieHeader(STATE_COOKIE, "", { maxAgeSeconds: 0, secure }),
    ],
  });
  response.end();
}

export function logout(response) {
  const { auth } = loadConfig();
  const secure = auth.publicUrl.startsWith("https://");
  response.writeHead(302, {
    location: "/",
    "set-cookie": cookieHeader(SESSION_COOKIE, "", { maxAgeSeconds: 0, secure }),
  });
  response.end();
}

/**
 * Gate for every other request. Returns the user, or handles the response
 * itself and returns null — in which case the caller should stop.
 */
export function gate(request, response, url) {
  if (!isAuthConfigured()) {
    // No gate configured. Fine at your own keyboard; never fine for a request
    // that arrived over a tunnel. See looksRemote().
    if (looksRemote(request)) {
      response.writeHead(403, { "content-type": "text/html; charset=utf-8" });
      response.end(noGatePage());
      return null;
    }
    return { email: "local", name: "Local user", local: true };
  }

  const user = currentUser(request);
  if (user) return user;

  // An API call gets JSON so the UI can show something useful; a page gets the
  // sign-in screen.
  if (url.pathname.startsWith("/api/")) {
    response.writeHead(401, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ error: "Your session expired. Reload the page to sign in again." }));
  } else {
    const { auth } = loadConfig();
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      loginPage({ mode: authMode(), publicUrl: auth.publicUrl, domain: auth.allowedDomain })
    );
  }
  return null;
}

/**
 * Shown when the tool is reachable from outside with no gate on it. Refusing is
 * the whole point, so this page explains the fix rather than just saying no.
 */
function noGatePage() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Not open to the internet</title>
<style>
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#eceff3;
         color:#1b232d; font:15px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  @media (prefers-color-scheme: dark) { body { background:#0f141a; color:#e2e8ee; } }
  .card { background:#fff; border:1px solid #e3e7ec; border-radius:10px; padding:32px;
          width:min(520px,calc(100vw - 32px)); }
  @media (prefers-color-scheme: dark) { .card { background:#171e26; border-color:#29323c; } }
  h1 { font-size:19px; margin:0 0 10px; }
  code { font:13px ui-monospace,monospace; background:#f0f3f6; padding:2px 5px; border-radius:4px; }
  @media (prefers-color-scheme: dark) { code { background:#0f141a; } }
</style></head>
<body><div class="card">
  <h1>This tool is not open to the internet</h1>
  <p>It reached you over a tunnel, but no sign-in is configured. It holds contact
     data and a HubSpot token that can write to the portal, so it stops here.</p>
  <p>Whoever started the tunnel needs to set <code>TSF_ACCESS_PASSPHRASE</code>
     (or Google sign-in) and restart it. <code>tsf tunnel</code> does this check
     before it opens anything.</p>
</div></body></html>`;
}

/** The sign-in screen. Deliberately plain — it is a door, not a room. */
function loginPage({ error = null, domain = "", mode = "google" } = {}) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Sign in — Trade Show Funnel</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #eceff3; color: #1b232d;
    font: 15px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark) { body { background: #0f141a; color: #e2e8ee; } }
  .card {
    background: #fff; border: 1px solid #e3e7ec; border-radius: 10px;
    padding: 34px 32px; width: min(400px, calc(100vw - 32px)); text-align: center;
    box-shadow: 0 1px 2px rgba(16,23,31,.06), 0 8px 28px rgba(16,23,31,.08);
  }
  @media (prefers-color-scheme: dark) { .card { background: #171e26; border-color: #29323c; } }
  .glyph {
    width: 40px; height: 40px; border-radius: 9px; background: #0f766e; color: #fff;
    display: grid; place-items: center; margin: 0 auto 16px;
    font: 700 14px ui-monospace, monospace;
  }
  h1 { font-size: 19px; margin: 0 0 6px; letter-spacing: -.02em; }
  p { color: #5c6673; font-size: 13.5px; margin: 0 0 22px; }
  @media (prefers-color-scheme: dark) { p { color: #9aa5b1; } }
  a.btn {
    display: inline-block; background: #0f766e; color: #fff; text-decoration: none;
    padding: 11px 22px; border-radius: 6px; font-weight: 600; font-size: 14px;
  }
  .err {
    background: #f7e7e5; color: #c0463c; border-radius: 6px;
    padding: 11px 14px; font-size: 13px; margin: 0 0 20px; text-align: left;
  }
  @media (prefers-color-scheme: dark) { .err { background: #2a1a18; color: #e86f5b; } }
  .pass { display: flex; gap: 8px; }
  .pass input {
    flex: 1; min-width: 0; padding: 11px 12px; font-size: 14px; font-family: inherit;
    border: 1px solid #d2dae2; border-radius: 6px; background: #fff; color: inherit;
  }
  @media (prefers-color-scheme: dark) { .pass input { background: #0f141a; border-color: #39434e; } }
  .pass button { border: 0; cursor: pointer; font-family: inherit; }
</style></head>
<body>
  <div class="card">
    <div class="glyph">TS</div>
    <h1>Trade Show Funnel</h1>
    <p>${
      error
        ? ""
        : mode === "passphrase"
          ? "Enter the passphrase you were sent."
          : `Sign in with your ${escapeHtml(domain)} account.`
    }</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    ${
      mode === "passphrase"
        ? `<form method="POST" action="/auth/passphrase" class="pass">
             <input type="password" name="passphrase" placeholder="Passphrase"
                    autocomplete="current-password" autofocus required>
             <button class="btn" type="submit">Open</button>
           </form>`
        : `<a class="btn" href="/auth/login">Sign in with Google</a>`
    }
  </div>
</body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
