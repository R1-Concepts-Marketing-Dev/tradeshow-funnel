// auth.js — Google sign-in, restricted to one Workspace domain.
//
// Two modes, and the tool picks between them so you cannot get it wrong:
//
//   LOCAL   Bound to 127.0.0.1 with no Google credentials configured. No login.
//           Only the person at that keyboard can reach it, which is the same
//           protection a desktop app has.
//
//   SHARED  Anything else. Login is REQUIRED, and the server refuses to bind to
//           a public interface without it — see assertSafeToBind(). This tool
//           holds customer contact data and a HubSpot token with write access,
//           and the moment it has a URL, "nobody knows the address" stops being
//           a security control.
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

/** True when Google credentials are present, i.e. login is possible. */
export function isAuthConfigured() {
  const { auth } = loadConfig();
  return Boolean(auth.googleClientId && auth.googleClientSecret);
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
      `Either run it locally (the default), or set these and try again:\n` +
      `  TSF_GOOGLE_CLIENT_ID\n  TSF_GOOGLE_CLIENT_SECRET\n  TSF_ALLOWED_DOMAIN\n` +
      `  TSF_SESSION_SECRET\n  TSF_PUBLIC_URL\n\n` +
      `See docs/DEPLOYING.md.`
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
  if (!isAuthConfigured()) return { email: "local", name: "Local user", local: true };

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
    response.end(loginPage({ publicUrl: auth.publicUrl, domain: auth.allowedDomain }));
  }
  return null;
}

/** The sign-in screen. Deliberately plain — it is a door, not a room. */
function loginPage({ error = null, domain = "" } = {}) {
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
</style></head>
<body>
  <div class="card">
    <div class="glyph">TS</div>
    <h1>Trade Show Funnel</h1>
    <p>${error ? "" : `Sign in with your ${escapeHtml(domain)} account.`}</p>
    ${error ? `<div class="err">${escapeHtml(error)}</div>` : ""}
    <a class="btn" href="/auth/login">Sign in with Google</a>
  </div>
</body></html>`;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}
