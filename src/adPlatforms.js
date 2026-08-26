// adPlatforms.js — turning contacts into a file each ad platform will accept.
//
// Every platform wants the same handful of facts and disagrees about all of it:
// what the column is called, whether names are hashed, whether the country is
// "US" or "us", whether a ZIP keeps its last four digits. Get one wrong and the
// upload does not fail — it succeeds and matches almost nobody, which is worse.
//
// So the rules live here as DATA, one entry per platform, verified against each
// platform's own documentation on 2026-08-26 (sources in docs/AD-PLATFORMS.md).
// Adding a platform should mean adding an entry, not writing code.
//
// PLAIN TEXT OR HASHED?
//
// Every one of these platforms will hash the file for you, in your browser,
// before anything is sent. Plain text is therefore the DEFAULT here, because it
// lets the platform apply its own normalisation and gives the best match rate —
// our normalisation bugs cannot cost you matches if we do not do the hashing.
//
// Pass `hash: true` when the file has to leave your machine (emailed to an
// agency, dropped in shared storage). It is SHA-256, hex, lowercase, which is
// what all four accept.
//
// EDIT THIS FILE IF: a platform changes its format, or you add a new one.

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Field-level normalisation
//
// These run BEFORE hashing, which is the whole point — a hash of "Bob@X.com "
// and a hash of "bob@x.com" have nothing to do with each other.
// ---------------------------------------------------------------------------

const text = (value) => String(value ?? "").trim();

/** Lowercased, trimmed. */
export function plainEmail(value) {
  return text(value).toLowerCase();
}

/**
 * Google additionally ignores dots before the @ on Gmail addresses, because
 * bob.smith@gmail.com and bobsmith@gmail.com are the same mailbox.
 */
export function googleEmail(value) {
  const email = plainEmail(value);
  const at = email.lastIndexOf("@");
  if (at === -1) return email;

  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain === "gmail.com" || domain === "googlemail.com") {
    return `${local.replace(/\./g, "")}@${domain}`;
  }
  return email;
}

/**
 * E.164: a plus, a country code, digits. Everything wants this.
 *
 * Returns "" rather than a guess when the number cannot be made sense of. An
 * unmatchable row is a wasted row; a wrongly-guessed one is a stranger being
 * shown your ads.
 */
export function e164(value) {
  const raw = text(value);
  if (!raw) return "";

  const digits = raw.replace(/\D/g, "");
  if (!digits) return "";

  // Already international.
  if (raw.startsWith("+")) return digits.length >= 8 ? `+${digits}` : "";

  // North American, with or without the country code.
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;

  // Anything else is ambiguous without knowing the country, so say nothing.
  return "";
}

/** Lowercase letters only. Meta is explicit that punctuation hurts matching. */
export function metaName(value) {
  return text(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining accents: José -> jose
    .replace(/[^a-z]/g, "");
}

/** Trimmed and lowercased, but otherwise left alone. */
export function plainName(value) {
  return text(value).toLowerCase();
}

/**
 * ISO 3166-1 alpha-2. Accepts the handful of spellings rosters actually use.
 *
 * Keys are written WITHOUT periods, because countryCode strips them before
 * looking up — "U.S.A." and "USA" have to land on the same entry.
 */
const COUNTRY_ALIASES = {
  "united states": "US",
  "united states of america": "US",
  usa: "US",
  us: "US",
  america: "US",
  canada: "CA",
  ca: "CA",
  mexico: "MX",
  mx: "MX",
  "united kingdom": "GB",
  uk: "GB",
  gb: "GB",
};

export function countryCode(value) {
  // Periods out, whitespace collapsed. Stripping only a TRAILING period missed
  // "U.S.A." and silently produced an empty country column — which costs match
  // rate on Google, where country is one of the fields it matches in the clear.
  const raw = text(value)
    .toLowerCase()
    .replace(/\./g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!raw) return "";
  if (COUNTRY_ALIASES[raw]) return COUNTRY_ALIASES[raw];

  // Already a two-letter code we do not have an alias for. Anything longer is
  // something we do not understand, and a wrong country is worse than none.
  return /^[a-z]{2}$/.test(raw) ? raw.toUpperCase() : "";
}

/**
 * Postal code, trimmed to what the platform wants.
 *
 * `us5` keeps the first five digits of a US ZIP and drops the +4, which is what
 * Google and Meta both match on. Non-US codes are passed through, because
 * truncating a Canadian "K1A 0B1" to five characters produces nonsense.
 *
 * IT ALSO PUTS BACK LEADING ZEROS
 *
 * A US ZIP is always exactly five digits, so a stored "8052" is not a ZIP —
 * it is 08052 with the zero eaten by a spreadsheet somewhere upstream. This is
 * not hypothetical: 14% of the ZIPs in R1's own HubSpot are missing one,
 * which is 14% of that column matching nobody.
 *
 * Padding is safe precisely because the length is fixed. Never do this to a
 * non-US code, where length carries no such guarantee.
 */
export function postalCode(value, { style = "as-is", country = "" } = {}) {
  const raw = text(value).toUpperCase().replace(/\s+/g, " ");
  if (!raw) return "";
  if (style !== "us5") return raw;

  const isUS = !country || country === "US";
  if (!isUS) return raw;

  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;
  if (digits.length >= 5) return digits.slice(0, 5);

  // Only digits, and fewer than five of them. Restore the zeros.
  return /^\d+$/.test(raw) ? digits.padStart(5, "0") : raw;
}

/** Two-letter US state, lowercased. Meta asks for the ANSI abbreviation. */
const STATE_ABBREVIATIONS = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca",
  colorado: "co", connecticut: "ct", delaware: "de", florida: "fl", georgia: "ga",
  hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia",
  kansas: "ks", kentucky: "ky", louisiana: "la", maine: "me", maryland: "md",
  massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv",
  "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
  "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok",
  oregon: "or", pennsylvania: "pa", "rhode island": "ri", "south carolina": "sc",
  "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi",
  wyoming: "wy", "district of columbia": "dc",
};

export function stateCode(value) {
  const raw = text(value).toLowerCase().replace(/\./g, "");
  if (!raw) return "";
  if (STATE_ABBREVIATIONS[raw]) return STATE_ABBREVIATIONS[raw];
  return /^[a-z]{2}$/.test(raw) ? raw : "";
}

/** Lowercase letters only, no spaces. Meta's rule for city. */
export function metaCity(value) {
  return text(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z]/g, "");
}

/** SHA-256, hex, lowercase. Accepted by all four platforms. */
export function sha256(value) {
  const input = text(value);
  if (!input) return "";
  return crypto.createHash("sha256").update(input, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// The platforms
//
// `columns` is the file, in order. Each has:
//   header    the exact text in row 1
//   from      which normalised field it reads
//   hash      whether it is hashed when hashing is on
// ---------------------------------------------------------------------------

export const PLATFORMS = {
  "google-ads": {
    label: "Google Ads — Customer Match",
    // Google is explicit that these English headers are the ones it reads.
    columns: [
      { header: "Email", from: "googleEmail", hash: true },
      { header: "Phone", from: "phone", hash: true },
      { header: "First Name", from: "firstNamePlain", hash: true },
      { header: "Last Name", from: "lastNamePlain", hash: true },
      { header: "Country", from: "country", hash: false },
      { header: "Zip", from: "zipUS5", hash: false },
    ],
    // A row has to carry at least one of these or it can never match.
    identifiers: ["googleEmail", "phone"],
    minRows: 100,
    recommendedRows: 5000,
    notes: [
      "Country and Zip are never hashed, even in a hashed file — Google matches on them as-is.",
      "Gmail addresses have dots removed before the @, which is Google's own rule.",
      "Upload under Audience manager → Your data segments → Customer list.",
    ],
  },

  meta: {
    label: "Meta — Custom Audience (customer list)",
    columns: [
      { header: "email", from: "plainEmail", hash: true },
      { header: "phone", from: "phone", hash: true },
      { header: "fn", from: "firstNameMeta", hash: true },
      { header: "ln", from: "lastNameMeta", hash: true },
      { header: "ct", from: "cityMeta", hash: true },
      { header: "st", from: "state", hash: true },
      { header: "zip", from: "zipUS5", hash: true },
      { header: "country", from: "countryLower", hash: true },
    ],
    identifiers: ["plainEmail", "phone"],
    minRows: 1000,
    recommendedRows: 10000,
    notes: [
      "Meta hashes every column including city, state, zip and country.",
      "Names are stripped to a-z — Meta says punctuation lowers match rate.",
      "Country is lowercase here, unlike Google. That is Meta's spec, not a typo.",
      "Upload under Audiences → Create audience → Custom audience → Customer list.",
    ],
  },

  tiktok: {
    label: "TikTok — Custom Audience (customer file)",
    // TikTok reads one identifier per file and is happiest with just that.
    columns: [
      { header: "Email", from: "plainEmail", hash: true },
      { header: "Phone", from: "phone", hash: true },
    ],
    identifiers: ["plainEmail", "phone"],
    minRows: 1000,
    recommendedRows: 10000,
    notes: [
      "TikTok needs at least 1,000 rows before it will build the audience at all.",
      "It accepts raw or SHA-256 values and hashes raw ones for you.",
      "Matching takes 24–48 hours, so upload before you need the campaign live.",
    ],
  },

  linkedin: {
    label: "LinkedIn — Contact targeting list",
    columns: [
      { header: "email", from: "plainEmail", hash: true },
      { header: "firstname", from: "firstNamePlain", hash: false },
      { header: "lastname", from: "lastNamePlain", hash: false },
      { header: "companyname", from: "company", hash: false },
      { header: "jobtitle", from: "jobTitle", hash: false },
      { header: "country", from: "country", hash: false },
    ],
    identifiers: ["plainEmail"],
    minRows: 300,
    recommendedRows: 10000,
    // One sentence per entry — each one is rendered as its own bullet.
    notes: [
      "LinkedIn does not publish its template headers and rejects a file whose headers it does not recognise. Download the template from Campaign Manager and check the header row against this file before uploading.",
      "300 matched members minimum, and LinkedIn suggests 10,000 emails to reach it.",
      "Email is the only identifier LinkedIn matches on here, so phone-only contacts are left out.",
    ],
    // Said out loud wherever this platform is used, because it is the one
    // format here that is inferred rather than documented.
    headersUnverified: true,
  },
};

export const PLATFORM_IDS = Object.keys(PLATFORMS);

// ---------------------------------------------------------------------------
// Building the file
// ---------------------------------------------------------------------------

/**
 * Applies every normalisation once, so each contact is prepared a single time
 * regardless of how many columns read from it.
 */
export function prepare(contact) {
  const country = countryCode(contact.country);
  return {
    plainEmail: plainEmail(contact.email),
    googleEmail: googleEmail(contact.email),
    phone: e164(contact.phone),
    firstNamePlain: plainName(contact.firstName),
    lastNamePlain: plainName(contact.lastName),
    firstNameMeta: metaName(contact.firstName),
    lastNameMeta: metaName(contact.lastName),
    cityMeta: metaCity(contact.city),
    state: stateCode(contact.state),
    country,
    countryLower: country.toLowerCase(),
    zipUS5: postalCode(contact.zip, { style: "us5", country }),
    company: text(contact.company),
    jobTitle: text(contact.jobTitle),
  };
}

/**
 * Turns contacts into the rows of one platform's file.
 *
 * @param {object[]} contacts   internal shape: email, phone, firstName, …
 * @param {string} platformId
 * @param {object} options
 * @param {boolean} options.hash  SHA-256 the hashable columns
 * @returns {{headers: string[], rows: string[][], skipped: object[], platform: object}}
 */
export function buildRows(contacts, platformId, { hash = false } = {}) {
  const platform = PLATFORMS[platformId];
  if (!platform) {
    throw new Error(
      `"${platformId}" is not a platform I know. Try one of: ${PLATFORM_IDS.join(", ")}.`
    );
  }

  const headers = platform.columns.map((column) => column.header);
  const rows = [];
  const skipped = [];
  const seen = new Set();

  for (const contact of contacts) {
    const ready = prepare(contact);

    // No identifier means the row can never match anyone. Carrying it would
    // only make the file look bigger than the audience really is.
    const identifier = platform.identifiers.map((field) => ready[field]).find(Boolean);
    if (!identifier) {
      skipped.push({ contact, reason: `no ${platform.identifiers.join(" or ")} this platform can use` });
      continue;
    }

    // The same person can reach us through two shows. One row each.
    if (seen.has(identifier)) {
      skipped.push({ contact, reason: "already in this file" });
      continue;
    }
    seen.add(identifier);

    rows.push(
      platform.columns.map((column) => {
        const value = ready[column.from] || "";
        if (!value) return "";
        return hash && column.hash ? sha256(value) : value;
      })
    );
  }

  return { headers, rows, skipped, platform };
}

/**
 * CSV text, RFC 4180.
 *
 * Quotes anything containing a comma, quote or newline. A shop called
 * `Bob's Brakes, Inc.` is not hypothetical — it is most of the company column.
 */
export function toCsv(headers, rows) {
  const cell = (value) => {
    const string = String(value ?? "");
    return /[",\r\n]/.test(string) ? `"${string.replace(/"/g, '""')}"` : string;
  };
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}

/**
 * How this file will land: whether it clears the platform's floor, and what
 * share of rows carry each identifier.
 */
export function describeFile({ rows, platform, hash }) {
  const emailIndex = platform.columns.findIndex((c) => /email/i.test(c.header));
  const phoneIndex = platform.columns.findIndex((c) => /phone/i.test(c.header));
  const count = (index) => (index === -1 ? 0 : rows.filter((row) => row[index]).length);

  return {
    rows: rows.length,
    withEmail: count(emailIndex),
    withPhone: count(phoneIndex),
    hashed: hash,
    minRows: platform.minRows,
    recommendedRows: platform.recommendedRows,
    clearsMinimum: rows.length >= platform.minRows,
    clearsRecommended: rows.length >= platform.recommendedRows,
  };
}
