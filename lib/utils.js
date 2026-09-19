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

/**
 * Split a string into chunks <= maxLen, trying to break on whitespace.
 * Falls back to hard splits if a single "word" exceeds the limit.
 */
export function splitByMaxLen(text, maxLen) {
  const s = String(text ?? "");
  const out = [];
  let i = 0;

  while (i < s.length) {
    const remaining = s.length - i;
    if (remaining <= maxLen) {
      out.push(s.slice(i));
      break;
    }

    const end = i + maxLen;
    const slice = s.slice(i, end);
    let breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"), slice.lastIndexOf("\t"));

    if (breakAt < Math.floor(maxLen * 0.4)) {
      breakAt = maxLen;
    }

    out.push(s.slice(i, i + breakAt).trimEnd());
    i = i + breakAt;

    while (i < s.length && /\s/.test(s[i])) i++;
  }

  return out.filter(x => x.length > 0);
}
