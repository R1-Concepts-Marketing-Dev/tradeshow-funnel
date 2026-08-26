// normalize.js — cleaning raw spreadsheet values into something matchable.
//
// Everything here is pure: same input, same output, no network, no files.
// That makes it the easiest file in the repo to test and to change safely.
//
// EDIT THIS FILE IF: an organizer sends a format we mangle, or you want to
// treat a new kind of address as a role inbox.

/**
 * Addresses that belong to a company rather than a person. These match badly
 * on ad platforms and should never go into a nurture, so we drop them at the
 * door and report them as rejects.
 */
export const ROLE_INBOX_PREFIXES = [
  "info", "sales", "support", "admin", "office", "contact", "hello",
  "help", "billing", "accounting", "ap", "ar", "orders", "service",
  "noreply", "no-reply", "donotreply", "webmaster", "postmaster",
];

/** Lowercase, trimmed, whitespace stripped. Returns "" if it is not an email. */
export function normalizeEmail(raw) {
  if (!raw) return "";
  const value = String(raw).trim().toLowerCase().replace(/\s+/g, "");
  // Deliberately loose: we are cleaning, not validating RFC 5322.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(value)) return "";
  return value;
}

export function isRoleInbox(email) {
  const localPart = email.split("@")[0] || "";
  return ROLE_INBOX_PREFIXES.includes(localPart);
}

/**
 * Turns a phone number into E.164 (+15551234567), which is the format both
 * Google and Meta expect. Anything we cannot confidently convert returns "" —
 * a wrong number is worse than no number, because it lowers match rate.
 *
 * @param {string} raw
 * @param {string} defaultCountryCode digits only, no plus. US by default.
 */
export function normalizePhone(raw, defaultCountryCode = "1") {
  if (!raw) return "";
  let digits = String(raw).replace(/[^\d+]/g, "");

  if (digits.startsWith("+")) {
    digits = digits.slice(1).replace(/\D/g, "");
  } else {
    digits = digits.replace(/\D/g, "");
    // A bare 10-digit number is a domestic number; prefix the country code.
    if (digits.length === 10) digits = defaultCountryCode + digits;
    // 11 digits starting with 1 is already US with country code.
  }

  // E.164 allows 8–15 digits. Outside that we do not trust it.
  if (digits.length < 8 || digits.length > 15) return "";
  return "+" + digits;
}

/** "  jOHN   o'BRIEN " -> "John O'Brien". Handles hyphens and apostrophes. */
export function normalizeName(raw) {
  if (!raw) return "";
  return String(raw)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase()
    // Capitalise after a start, a space, an apostrophe, a hyphen — and after a
    // period, so initials survive. Without the period, a real attendee named
    // "J.M. Short" was written into HubSpot as "J.m. Short", which is how his
    // name would then have appeared in every email we sent him.
    .replace(/(^|[\s'\-.])([a-z])/g, (_, boundary, letter) => boundary + letter.toUpperCase());
}

/** Trims and collapses whitespace. Used for company, title, city and so on. */
export function normalizeText(raw) {
  if (!raw) return "";
  return String(raw).trim().replace(/\s+/g, " ");
}

/**
 * Pulls the domain out of an email or a website. Used as the company key in
 * the name+company match pass, because company *names* are typed a dozen ways
 * ("Joe's Auto", "Joes Auto LLC") but the domain is stable.
 */
export function companyDomain(emailOrUrl) {
  if (!emailOrUrl) return "";
  const value = String(emailOrUrl).trim().toLowerCase();
  const fromEmail = value.includes("@") ? value.split("@")[1] : value;
  const host = fromEmail
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split("/")[0]
    .trim();

  // Free mail hosts are not company identity — two people at gmail.com are
  // not colleagues, so returning the domain here would cause false merges.
  const FREE_MAIL = new Set([
    "gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "aol.com",
    "icloud.com", "live.com", "msn.com", "comcast.net", "att.net",
    "verizon.net", "sbcglobal.net", "me.com", "protonmail.com", "mac.com",
  ]);
  if (FREE_MAIL.has(host)) return "";
  return host;
}

/**
 * A postal code, tidied but not reinterpreted.
 *
 * Deliberately does NOT strip to five digits — that is a US assumption, and a
 * Canadian or UK code would be destroyed by it. Each ad platform wants a
 * different shape, so trimming happens at export time (src/adPlatforms.js)
 * where we know which platform is asking.
 *
 * Leading zeros survive because src/readfile.js reads sheets with raw:false.
 * "01234" here means Massachusetts, not the number 1234.
 */
export function normalizePostalCode(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * Normalises one raw spreadsheet row into the shape the rest of the tool uses.
 *
 * @param {object} row     raw values, already mapped to our field names
 * @returns {{ok: boolean, reason?: string, contact?: object}}
 */
export function normalizeRow(row) {
  const email = normalizeEmail(row.email);
  const phone = normalizePhone(row.phone);

  if (!email && !phone) {
    return { ok: false, reason: "no usable email or phone" };
  }
  if (email && isRoleInbox(email)) {
    return { ok: false, reason: `role inbox (${email})` };
  }

  const firstName = normalizeName(row.firstName);
  const lastName = normalizeName(row.lastName);
  const company = normalizeText(row.company);

  return {
    ok: true,
    contact: {
      email,
      phone,
      firstName,
      lastName,
      company,
      companyDomain: companyDomain(row.website || email),
      jobTitle: normalizeText(row.jobTitle),
      city: normalizeText(row.city),
      zip: normalizePostalCode(row.zip),
      state: normalizeText(row.state),
      country: normalizeText(row.country),
      // Anything the organizer sent that we do not have a home for. Kept so a
      // person can see it in the preview and decide whether to map it later.
      extra: row.extra || {},
    },
  };
}
