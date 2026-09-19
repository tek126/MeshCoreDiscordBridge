import fs from "fs";
import path from "path";
import log from "./logger.js";

const CONFIG_PATH = './config.json';

const REQUIRED_KEYS = [
  { key: "CLIENT_ID", type: "string" },
  { key: "DISCORD_TOKEN", type: "string" },
  { key: "DISCORD_CHANNEL_ID", type: "string" },
];

const VALIDATED_KEYS = [
  { key: "GUILD_IDS", type: "array", itemType: "string" },
  { key: "SERIAL_PORT", type: "string" },
  { key: "identifier", type: "string" },
  { key: "DISCORD_ROUTES", type: "object" },
  { key: "DISCORD_TO_MESH_ROUTES", type: "object" },
  { key: "DISCORD_ALWAYS_FORWARD_CHANNEL_IDS", type: "array" },
  { key: "BRIDGE_ADMIN_ROLE_IDS", type: "array" },
  { key: "BRIDGE_PREFIXES", type: "array" },
  { key: "FLOOD_PROTECT", type: "object" },
  { key: "MESH_MAXLEN", type: "number" },
  { key: "MESH_CHUNK_DELAY_MS", type: "number" },
  { key: "EMERGENCY_MESH_CHANNEL_IDX", type: "number", nullable: true },
  { key: "EMERGENCY_COOLDOWN_MINUTES", type: "number" },
  { key: "EMERGENCY_REMINDER_MINUTES", type: "number" },
  { key: "CONTACT_PRUNE_INTERVAL_MINUTES", type: "number" },
  { key: "CONTACT_PRUNE_STALE_HOURS", type: "number" },
  { key: "CONTACT_PRUNE_THRESHOLD", type: "number" },
  { key: "SUBSCRIBABLE_CHANNELS", type: "array" },
  { key: "BLOCKED_MESH_USERS", type: "array" },
  { key: "SCHEDULED_MESSAGES", type: "array" },
  { key: "DEBUG", type: "boolean" },
  { key: "WELCOME_ENABLED", type: "boolean" },
];

/**
 * Validate a config object. Returns an array of warning strings.
 * Throws on missing required keys.
 */
export function validateConfig(config) {
  const errors = [];
  const warnings = [];

  // Check required keys
  for (const { key, type } of REQUIRED_KEYS) {
    if (config[key] === undefined || config[key] === null || config[key] === "") {
      errors.push(`Missing required config key: ${key}`);
    } else if (typeof config[key] !== type) {
      errors.push(`${key} must be a ${type}, got ${typeof config[key]}`);
    }
  }

  // GUILD_IDS is required and must be a non-empty array (or GUILD_ID must exist)
  if (!Array.isArray(config.GUILD_IDS) || config.GUILD_IDS.length === 0) {
    if (!config.GUILD_ID) {
      errors.push("GUILD_IDS must be a non-empty array (or set GUILD_ID)");
    }
  }

  if (errors.length > 0) {
    throw new Error("Config validation failed:\n  " + errors.join("\n  "));
  }

  // Check optional keys for correct types
  for (const { key, type, nullable } of VALIDATED_KEYS) {
    const val = config[key];
    if (val === undefined || val === null) continue;
    if (type === "array" && !Array.isArray(val)) {
      warnings.push(`${key} should be an array, got ${typeof val}`);
    } else if (type === "object" && (typeof val !== "object" || Array.isArray(val))) {
      warnings.push(`${key} should be an object, got ${Array.isArray(val) ? "array" : typeof val}`);
    } else if (type === "number" && typeof val !== "number") {
      warnings.push(`${key} should be a number, got ${typeof val}`);
    } else if (type === "boolean" && typeof val !== "boolean") {
      warnings.push(`${key} should be a boolean, got ${typeof val}`);
    } else if (type === "string" && typeof val !== "string") {
      warnings.push(`${key} should be a string, got ${typeof val}`);
    }
  }

  return warnings;
}

/**
 * Load config from disk with validation.
 */
export function loadConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, "utf8");
  const config = JSON.parse(raw);
  const warnings = validateConfig(config);
  for (const w of warnings) {
    log.warn("Config:", w);
  }
  return config;
}

/**
 * Save config atomically: write to temp file, then rename.
 */
export function saveConfigAtomic(config) {
  const tmpPath = CONFIG_PATH + ".tmp";
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(config, null, 2));
    fs.renameSync(tmpPath, CONFIG_PATH);
  } catch (e) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch {}
    throw e;
  }
}
