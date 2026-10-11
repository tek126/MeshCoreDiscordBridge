import crypto from "crypto";

// MeshCore flood scopes (regions). A scoped flood carries a 2-byte transport code
// derived from the region's key, and repeaters only forward it if they have that
// region configured. Public region keys are the first 16 bytes of SHA-256("#name").

export const UNSCOPED = "*";
const MAX_SCOPE_NAME_LEN = 30; // firmware region names are char[31]

/** Strip a leading "#" and surrounding whitespace. Returns "" for non-strings. */
export function normalizeScopeName(name) {
  if (typeof name !== "string") return "";
  const s = name.trim();
  return s.startsWith("#") ? s.slice(1).trim() : s;
}

/** 16-byte transport key for a public (hashtag) region name. */
export function scopeKeyForName(name) {
  const n = normalizeScopeName(name);
  return crypto.createHash("sha256").update("#" + n, "utf8").digest().subarray(0, 16);
}

/** Returns an error string if the configured scope value is unusable, else null. */
export function validateScopeValue(value) {
  if (value === UNSCOPED) return null;
  if (typeof value !== "string") return "must be a region name string";
  const n = normalizeScopeName(value);
  if (!n) return "is empty";
  if (n.startsWith("$")) return "is a private region ($), which needs a key the bridge doesn't have";
  if (Buffer.byteLength(n, "utf8") > MAX_SCOPE_NAME_LEN) return `is longer than ${MAX_SCOPE_NAME_LEN} bytes`;
  return null;
}

/**
 * Resolve MESH_CHANNEL_SCOPES into a Map of mesh channel index -> scope value
 * ("*" or a normalized region name). Keys may be mesh channel indexes or Discord
 * channel IDs (looked up in DISCORD_TO_MESH_ROUTES). Invalid entries are skipped
 * and reported in `warnings`.
 */
export function resolveChannelScopes(scopes, discordToMesh = {}) {
  const byIdx = new Map();
  const warnings = [];
  if (!scopes || typeof scopes !== "object" || Array.isArray(scopes)) return { byIdx, warnings };

  const fromDiscord = new Map(); // filled second so an explicit mesh index wins
  for (const [key, value] of Object.entries(scopes)) {
    const err = validateScopeValue(value);
    if (err) {
      warnings.push(`MESH_CHANNEL_SCOPES["${key}"] ${err}; ignoring`);
      continue;
    }
    const scope = value === UNSCOPED ? UNSCOPED : normalizeScopeName(value);
    if (/^\d{1,3}$/.test(key)) {
      byIdx.set(Number(key), scope);
    } else if (/^\d{15,22}$/.test(key) && discordToMesh[key] !== undefined) {
      fromDiscord.set(Number(discordToMesh[key]), { key, scope });
    } else {
      warnings.push(`MESH_CHANNEL_SCOPES["${key}"] is not a mesh channel index or a routed Discord channel ID; ignoring`);
    }
  }
  for (const [idx, { key, scope }] of fromDiscord) {
    if (byIdx.has(idx)) {
      if (byIdx.get(idx) !== scope) {
        warnings.push(`MESH_CHANNEL_SCOPES["${key}"] conflicts with the entry for mesh channel ${idx}; using "${byIdx.get(idx)}"`);
      }
      continue;
    }
    byIdx.set(idx, scope);
  }
  return { byIdx, warnings };
}
