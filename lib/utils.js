import crypto from "crypto";

// ---- Crockford Base32 (for reaction hash) ----
const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

export function encodeCrockfordBase32(bytes) {
  let bits = 0n;
  for (const byte of bytes) {
    bits = (bits << 8n) | BigInt(byte);
  }
  let result = "";
  for (let shift = 35; shift >= 0; shift -= 5) {
    const index = Number((bits >> BigInt(shift)) & 0x1fn);
    result += CROCKFORD_ALPHABET[index];
  }
  return result;
}

export function generateMeshHash(text, senderTimestamp) {
  const textBytes = Buffer.from(text, "utf8");
  const tsBytes = Buffer.alloc(4);
  tsBytes.writeUInt32LE(senderTimestamp);
  const combined = Buffer.concat([textBytes, tsBytes]);
  const digest = crypto.createHash("sha256").update(combined).digest();
  return encodeCrockfordBase32(digest.subarray(0, 5));
}

// ---- Regex helpers ----
export function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---- Text helpers ----
export function normalizeForMesh(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// MeshCore limits text by UTF-8 bytes, not characters: emoji are 4 bytes, accents 2.
export function utf8Len(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

/** Truncate to at most maxBytes of UTF-8 without splitting a character. */
export function truncateUtf8(text, maxBytes) {
  const s = String(text ?? "");
  if (utf8Len(s) <= maxBytes) return s;
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = utf8Len(ch);
    if (used + b > maxBytes) break;
    out += ch;
    used += b;
  }
  return out;
}

/**
 * Split a string into chunks of at most maxBytes UTF-8 bytes, trying to break on
 * whitespace. Falls back to hard splits (between characters) if a single "word"
 * exceeds the limit.
 */
export function splitByMaxLen(text, maxBytes) {
  maxBytes = Number(maxBytes);
  if (!(maxBytes >= 4)) maxBytes = 160; // NaN/garbage would never make progress
  const out = [];
  let rest = String(text ?? "");

  while (rest.length > 0) {
    if (utf8Len(rest) <= maxBytes) {
      out.push(rest);
      break;
    }

    const head = truncateUtf8(rest, maxBytes);
    let breakAt = Math.max(head.lastIndexOf(" "), head.lastIndexOf("\n"), head.lastIndexOf("\t"));
    if (breakAt < Math.floor(head.length * 0.4)) breakAt = head.length;

    out.push(rest.slice(0, breakAt).trimEnd());
    rest = rest.slice(breakAt).replace(/^\s+/, "");
  }

  return out.filter(x => x.length > 0);
}
