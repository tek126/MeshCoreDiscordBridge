import { NodeJSSerialConnection, Constants } from "@liamcottle/meshcore.js";
import {
  REST,
  Routes,
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  MessageFlags,
  Partials
} from "discord.js";
import fs from "fs";
import crypto from "crypto";

let config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const connection = new NodeJSSerialConnection(config.SERIAL_PORT || "/dev/ttyUSB0");

// PocketMesh reacts look like: "😀@[Some User]xp8q7fcc"
const POCKETMESH_REACT_RE =
  /^\s*(?:.*?:\s*)?(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)@\[[^\]]*\]\s*[a-z0-9]{8}\s*$/iu;

function isPocketMeshReact(text) {
  if (!text) return false;
  // Normalize CRLF so ]\r\nhash still matches
  return POCKETMESH_REACT_RE.test(String(text).replace(/\r\n/g, "\n"));
}

// ---- MeshCore reaction hash (Crockford Base32 of SHA-256) ----
const CROCKFORD_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";

function encodeCrockfordBase32(bytes) {
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

function generateMeshHash(text, senderTimestamp) {
  const textBytes = Buffer.from(text, "utf8");
  const tsBytes = Buffer.alloc(4);
  tsBytes.writeUInt32LE(senderTimestamp);
  const combined = Buffer.concat([textBytes, tsBytes]);
  const digest = crypto.createHash("sha256").update(combined).digest();
  return encodeCrockfordBase32(digest.subarray(0, 5));
}

// ---- Message history for reaction matching (persisted to disk) ----
// Maps mesh hash -> { discordMessageId, discordChannelId, meshText, senderTimestamp, meshChannelIdx }
const HISTORY_FILE = './message_history.json';
const HISTORY_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

let messageHistory = new Map();

// Load history from disk on startup, pruning expired entries
try {
  const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  const now = Date.now();
  let pruned = 0;
  for (const [hash, entry] of data) {
    if (entry.trackedAt && (now - entry.trackedAt) > HISTORY_MAX_AGE_MS) {
      pruned++;
    } else {
      messageHistory.set(hash, entry);
    }
  }
  console.log(`Loaded ${messageHistory.size} messages from history${pruned ? ` (pruned ${pruned} expired)` : ""}.`);
} catch (e) {
  // File doesn't exist yet or is invalid — start fresh
}

let historySaveTimer = null;
function scheduleSaveHistory() {
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    // Prune expired entries before saving
    const now = Date.now();
    for (const [hash, entry] of messageHistory) {
      if (entry.trackedAt && (now - entry.trackedAt) > HISTORY_MAX_AGE_MS) {
        messageHistory.delete(hash);
      }
    }
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify([...messageHistory]));
    } catch (e) {
      console.error("Failed to save message history:", e);
    }
  }, 5000);
}

function trackMessage(hash, entry) {
  entry.trackedAt = Date.now();
  messageHistory.set(hash, entry);
  scheduleSaveHistory();
}

// Reverse lookup: Discord message ID -> hash
function findHashByDiscordMessageId(discordMessageId) {
  for (const [hash, entry] of messageHistory) {
    if (entry.discordMessageId === discordMessageId) return { hash, entry };
  }
  return null;
}

// Parse a PocketMesh reaction message
// Format: "SenderName: emoji@[TargetName]\nhash" or "emoji@[TargetName]\nhash"
const REACT_PARSE_RE = /^(?:.*?:\s*)?(\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)@\[([^\]]*)\]\s*([a-z0-9]{8})\s*$/isu;

function parseMeshReaction(text) {
  const normalized = String(text).replace(/\r\n/g, "\n");
  const match = normalized.match(REACT_PARSE_RE);
  if (!match) return null;
  return { emoji: match[1], targetName: match[2], hash: match[3] };
}

// ---- Message deduplication ----
const DEDUP_WINDOW_MS = 30_000; // ignore duplicates within 30 seconds
const recentMessages = new Map(); // "channelIdx:body" -> timestamp

function isDuplicate(channelIdx, body) {
  const key = `${channelIdx}:${body}`;
  const now = Date.now();
  const prev = recentMessages.get(key);
  if (prev && (now - prev) < DEDUP_WINDOW_MS) {
    return true;
  }
  recentMessages.set(key, now);
  // Prune old entries periodically
  if (recentMessages.size > 500) {
    for (const [k, t] of recentMessages) {
      if (now - t > DEDUP_WINDOW_MS) recentMessages.delete(k);
    }
  }
  return false;
}

// ---- Discord webhook cache for mesh->discord messages ----
const webhookCache = new Map(); // channelId -> WebhookClient

async function getOrCreateWebhook(channel) {
  const cached = webhookCache.get(channel.id);
  if (cached) return cached;

  try {
    // Look for an existing webhook created by us
    const hooks = await channel.fetchWebhooks();
    let hook = hooks.find(h => h.owner?.id === bot.user.id && h.name === "MeshCore Bridge");

    if (!hook) {
      hook = await channel.createWebhook({ name: "MeshCore Bridge", reason: "MeshCore bridge message forwarding" });
    }

    webhookCache.set(channel.id, hook);
    return hook;
  } catch (e) {
    console.error(`Failed to get/create webhook for channel ${channel.id}:`, e);
    return null;
  }
}

// ---- Path discovery (command 0x34, response 0x8D) ----
const PATH_DISCOVERY_CMD = 0x34;
const PATH_DISCOVERY_RESPONSE = 0x8D;

async function discoverPath(publicKey, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const pubKeyPrefix = publicKey.subarray(0, 6);
    let timer = null;
    let sentReceived = false;

    const onRx = (frame) => {
      const code = frame[0];

      // The device sends a Sent response (0x06) first, then the discovery response (0x8D) later
      if (code === 0x06 && !sentReceived) {
        sentReceived = true;
        if (config.DEBUG) console.debug(`[debug] Path discovery: got Sent acknowledgment`);
        return;
      }

      // Log any unusual response codes during discovery for debugging
      if (config.DEBUG && sentReceived && code !== PATH_DISCOVERY_RESPONSE && code !== 0x83) {
        console.debug(`[debug] Path discovery: saw frame code=0x${code.toString(16)} len=${frame.length}`);
      }

      if (code !== PATH_DISCOVERY_RESPONSE) return;
      if (config.DEBUG) console.debug(`[debug] Received path discovery response, frame length=${frame.length}`);

      // Response format: [0x8D, reserved:1, pubkey_prefix:6, out_path_len:1, ...]
      if (frame.length < 9) return;
      const responsePubKey = frame.subarray(2, 8);
      let match = true;
      for (let i = 0; i < 6; i++) {
        if (responsePubKey[i] !== pubKeyPrefix[i]) { match = false; break; }
      }
      if (!match) {
        if (config.DEBUG) console.debug(`[debug] Path discovery response pubkey mismatch, ignoring`);
        return;
      }

      clearTimeout(timer);
      connection.off("rx", onRx);

      const pathLenByte = frame[8];
      const hopCount = pathLenByte & 0x3F;
      if (config.DEBUG) console.debug(`[debug] Path discovered: ${hopCount} hops`);
      resolve({ hopCount, pathLenByte });
    };

    connection.on("rx", onRx);

    // Send path discovery command: [0x34, 0x00, <32-byte pubkey>]
    const cmdBuf = new Uint8Array(2 + publicKey.length);
    cmdBuf[0] = PATH_DISCOVERY_CMD;
    cmdBuf[1] = 0x00;
    cmdBuf.set(publicKey, 2);

    connection.sendToRadioFrame(cmdBuf).catch((e) => {
      connection.off("rx", onRx);
      clearTimeout(timer);
      reject(e);
    });

    timer = setTimeout(() => {
      connection.off("rx", onRx);
      if (config.DEBUG) console.debug(`[debug] Path discovery timed out (sentReceived=${sentReceived})`);
      resolve(null);
    }, timeoutMs);
  });
}

// ---- Bridge prefix stripping ----
function getBridgePrefixRegexes() {
  const prefixes = config.BRIDGE_PREFIXES || [];
  return prefixes.map(p => new RegExp(`^${p}:\\s*`));
}

function stripBridgePrefixes(text) {
  let result = text;
  for (const re of getBridgePrefixRegexes()) {
    result = result.replace(re, "");
  }
  return result;
}

const MESH_MAXLEN = Number(config.MESH_MAXLEN ?? 160);
const MESH_CHUNK_DELAY_MS = Number(config.MESH_CHUNK_DELAY_MS ?? 1500);

function getAlwaysForwardChannelIds() {
  // New key: DISCORD_ALWAYS_FORWARD_CHANNEL_IDS (array or string)
  const v = config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS ?? config.DISCORD_ALWAYS_FORWARD_CHANNEL_ID;

  if (!v) return new Set();

  if (Array.isArray(v)) return new Set(v.map(x => String(x)));
  return new Set([String(v)]);
}


// ---- ImgBB image upload ----
const IMGBB_API_KEY = config.IMGBB_API_KEY || "";

const IMAGE_CONTENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
]);

function isImageAttachment(att) {
  if (att.contentType && IMAGE_CONTENT_TYPES.has(att.contentType)) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.name || "");
}

async function uploadToImgBB(imageUrl) {
  if (!IMGBB_API_KEY) {
    console.error("IMGBB_API_KEY not configured; cannot upload image.");
    return null;
  }

  try {
    const form = new URLSearchParams();
    form.set("image", imageUrl);

    const res = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      console.error(`ImgBB upload failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    return data?.data?.url || null;
  } catch (e) {
    console.error("ImgBB upload error:", e);
    return null;
  }
}

// ---- URL shortening via TinyURL (free, no API key) ----
async function shortenUrl(url) {
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
      console.error(`TinyURL shortening failed: ${res.status} ${res.statusText}`);
      return url;
    }
    const short = (await res.text()).trim();
    return short || url;
  } catch (e) {
    console.error("TinyURL shortening error:", e);
    return url;
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
function normalizeForMesh(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[\n\t]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}
// ---- Mesh send serialization queue ----
let meshSendChain = Promise.resolve();

function enqueueMeshSend(taskFn) {
  meshSendChain = meshSendChain
    .then(taskFn)
    .catch((e) => console.error("Mesh send task error:", e));
  return meshSendChain;
}

/**
 * Split a string into chunks <= maxLen, trying to break on whitespace.
 * Falls back to hard splits if a single "word" exceeds the limit.
 */
function splitByMaxLen(text, maxLen) {
  const s = String(text ?? "");
  const out = [];
  let i = 0;

  while (i < s.length) {
    const remaining = s.length - i;
    if (remaining <= maxLen) {
      out.push(s.slice(i));
      break;
    }

    // Candidate slice
    const end = i + maxLen;

    // Try to find last whitespace within the slice (avoid tiny chunks)
    const slice = s.slice(i, end);
    let breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"), slice.lastIndexOf("\t"));

    // If no whitespace (or whitespace too early), hard split
    if (breakAt < Math.floor(maxLen * 0.4)) {
      breakAt = maxLen;
    }

    out.push(s.slice(i, i + breakAt).trimEnd());
    i = i + breakAt;

    // Skip leading whitespace at next chunk
    while (i < s.length && /\s/.test(s[i])) i++;
  }

  return out.filter(x => x.length > 0);
}

/**
 * Chunk + send a message to meshcore with "n/N" suffix and delay between chunks.
 * - If message fits in one chunk, sends once with NO suffix.
 * - All mesh sends are serialized via enqueueMeshSend() to prevent interleaving.
 */
async function sendMeshChunked(channelIdx, fullText, onSent = null) {
  const base = normalizeForMesh(fullText);
  if (!base) return;

  return enqueueMeshSend(async () => {
    // If it fits as-is, send once with no suffix.
    if (base.length <= MESH_MAXLEN) {
      if (config.DEBUG) {
        console.debug(`[debug] mesh send (single) ch=${channelIdx} len=${base.length}: "${base}"`);
      }
      const ts = Math.floor(Date.now() / 1000);
      await connection.sendChannelTextMessage(channelIdx, base);
      if (onSent) onSent(base, ts);
      return;
    }

    // Otherwise chunk and add "n/N" suffixes.
    const suffixReserve = 6; // safe for up to " 99/99"
    const maxPayload = Math.max(1, MESH_MAXLEN - suffixReserve);
    let chunks = splitByMaxLen(base, maxPayload);

    // Recompute reserve based on actual total (handles " 100/100" etc.)
    const total = chunks.length;
    const suffixLen = (` ${total}/${total}`).length;
    const maxPayload2 = Math.max(1, MESH_MAXLEN - suffixLen);
    if (maxPayload2 !== maxPayload) {
      chunks = splitByMaxLen(base, maxPayload2);
    }

    const total2 = chunks.length;

    if (config.DEBUG) {
      console.debug(`[debug] mesh send (chunked) ch=${channelIdx} parts=${total2} maxLen=${MESH_MAXLEN} delayMs=${MESH_CHUNK_DELAY_MS}`);
    }

    for (let idx = 0; idx < total2; idx++) {
      const partNum = idx + 1;
      const suffix = ` ${partNum}/${total2}`;
      let payload = chunks[idx];

      // Final guard: ensure payload+suffix fits
      const allowed = MESH_MAXLEN - suffix.length;
      if (payload.length > allowed) payload = payload.slice(0, allowed);

      const out = payload + suffix;

      try {
        if (config.DEBUG) {
          console.debug(`[debug] mesh chunk ${partNum}/${total2} ch=${channelIdx} len=${out.length}: "${out}"`);
        }
        await connection.sendChannelTextMessage(channelIdx, out);
      } catch (e) {
        console.error(`Mesh chunk send failed ${partNum}/${total2} ch=${channelIdx}:`, e);
      }

      if (idx !== total2 - 1) {
        await sleep(MESH_CHUNK_DELAY_MS);
      }
    }
  });
}

/** =========================
 * Bridge mode state + auth
 * ========================= */
const bridgeState = {
  paused: false,
  pausedBy: null,
  pausedAt: null,
};

function isBridgePaused() {
  return bridgeState.paused === true;
}

function setBridgePaused(paused, actorTag = null) {
  bridgeState.paused = !!paused;
  bridgeState.pausedBy = paused ? actorTag : null;
  bridgeState.pausedAt = paused ? new Date().toISOString() : null;
}

function isBridgeAdminMember(member) {
  if (!member) return false;

  // Permission fallback: allow Manage Guild or Administrator
  const perms = member.permissions;
  if (perms?.has?.("Administrator") || perms?.has?.("ManageGuild")) return true;

  // Role allowlist
  const allowed = config.BRIDGE_ADMIN_ROLE_IDS || [];
  if (!Array.isArray(allowed) || allowed.length === 0) return false;

  return member.roles?.cache?.some?.(r => allowed.includes(r.id)) === true;
}

/** =========================
 * Flood protection (Discord -> Mesh)
 * ========================= */
const floodCfg = config.FLOOD_PROTECT || {};
const FLOOD_WINDOW_MS = Math.max(1, Number(floodCfg.WINDOW_SECONDS ?? 15)) * 1000;
const FLOOD_MAX = Math.max(1, Number(floodCfg.MAX_MESSAGES_PER_WINDOW ?? 6));
const FLOOD_COOLDOWN_MS = Math.max(1, Number(floodCfg.COOLDOWN_SECONDS ?? 60)) * 1000;
const FLOOD_WARN = floodCfg.WARN_IN_CHANNEL !== false;

// Per-Discord-channel tracking
const floodState = new Map(); // channelId -> { times: number[], cooldownUntil: number, warnedUntil: number }

function _getFloodRecord(channelId) {
  const key = String(channelId);
  let rec = floodState.get(key);
  if (!rec) {
    rec = { times: [], cooldownUntil: 0, warnedUntil: 0 };
    floodState.set(key, rec);
  }
  return rec;
}

/**
 * Returns true if we should allow forwarding this Discord channel's messages to Meshcore.
 * If false, we're currently rate-limited (cooldown).
 */
async function floodAllowDiscordToMesh(messageLike) {
  const channelId = String(messageLike?.channel?.id ?? "");
  if (!channelId) return true;

  const now = Date.now();
  const rec = _getFloodRecord(channelId);

  // In cooldown?
  if (rec.cooldownUntil > now) {
    if (config.DEBUG) {
      console.debug(`[debug] Flood protect: dropping discord->mesh from ${channelId} (cooldown ${Math.ceil((rec.cooldownUntil - now) / 1000)}s)`);
    }
    return false;
  }

  // Sliding window prune
  const cutoff = now - FLOOD_WINDOW_MS;
  rec.times = rec.times.filter(t => t >= cutoff);

  // Record this message
  rec.times.push(now);

  // If exceeded, start cooldown
  if (rec.times.length > FLOOD_MAX) {
    rec.cooldownUntil = now + FLOOD_COOLDOWN_MS;
    rec.times = []; // reset window for after cooldown

    if (config.DEBUG) {
      console.debug(`[debug] Flood protect: ENTER cooldown for ${channelId} (${FLOOD_COOLDOWN_MS / 1000}s)`);
    }

    // Optional: warn once per cooldown period
    if (FLOOD_WARN && rec.warnedUntil <= now) {
      rec.warnedUntil = rec.cooldownUntil;
      try {
        if (messageLike?.channel?.send) {
          await messageLike.channel.send(
            `⚠️ Bridge flood protection: pausing forwarding to Meshcore for ${Math.ceil(FLOOD_COOLDOWN_MS / 1000)}s (too many messages).`
          );
        }
      } catch (e) {
        console.error("Flood protect: failed to post warning in channel:", e);
      }
    }

    return false;
  }

  return true;
}

/** =========================
 * Emergency channel handling
 * ========================= */
const emergencyState = {
  active: false,
  lastAlertAt: 0,
  reminderTimer: null,
};

const EMERGENCY_COOLDOWN_MS = Math.max(1, Number(config.EMERGENCY_COOLDOWN_MINUTES ?? 30)) * 60 * 1000;
const EMERGENCY_REMINDER_MS = Math.max(1, Number(config.EMERGENCY_REMINDER_MINUTES ?? 5)) * 60 * 1000;

function isEmergencyMeshChannel(channelIdx) {
  const idx = config.EMERGENCY_MESH_CHANNEL_IDX;
  if (idx === undefined || idx === null) return false;
  return Number(channelIdx) === Number(idx);
}

function getEmergencyDiscordChannelId() {
  return config.EMERGENCY_DISCORD_CHANNEL_ID || null;
}

function cancelEmergencyReminder() {
  if (emergencyState.reminderTimer) {
    clearTimeout(emergencyState.reminderTimer);
    emergencyState.reminderTimer = null;
  }
}

function scheduleEmergencyReminder(discordChannelId) {
  cancelEmergencyReminder();
  emergencyState.reminderTimer = setTimeout(async () => {
    emergencyState.reminderTimer = null;
    try {
      const dest = await bot.channels.fetch(discordChannelId);
      if (dest?.isTextBased()) {
        await dest.send("🚨 No response yet — emergency message still awaiting reply @everyone");
      }
    } catch (e) {
      console.error("Emergency reminder error:", e);
    }
  }, EMERGENCY_REMINDER_MS);
}

/** =========================
 * Mesh user block system
 * ========================= */
// blockState tracks per-user daily warning and appeal status
// key = lowercase sender name, value = { lastWarned: timestamp, lastAppeal: timestamp }
const blockState = new Map();

function getBlockList() {
  return config.BLOCKED_MESH_USERS || [];
}

function isUserBlocked(senderName) {
  const list = getBlockList();
  const nameLower = senderName.toLowerCase();
  return list.some(entry => {
    const entryName = typeof entry === "string" ? entry : entry.name;
    if (entryName?.toLowerCase() !== nameLower) return false;
    // Check if vote-block has expired
    if (entry.expiresAt && Date.now() > entry.expiresAt) return false;
    return true;
  });
}

function addBlockedUser(name, pubKeyHex = null, opts = {}) {
  if (!config.BLOCKED_MESH_USERS) config.BLOCKED_MESH_USERS = [];
  // Don't add duplicates
  if (isUserBlocked(name)) return false;
  const entry = { name };
  if (pubKeyHex) entry.pubKey = pubKeyHex;
  if (opts.type) entry.type = opts.type; // "admin" or "vote"
  if (opts.expiresAt) entry.expiresAt = opts.expiresAt;
  if (opts.voteCount !== undefined) entry.voteCount = opts.voteCount;
  config.BLOCKED_MESH_USERS.push(entry);
  saveConfig();
  return true;
}

function removeBlockedUser(name) {
  if (!config.BLOCKED_MESH_USERS) return false;
  const nameLower = name.toLowerCase();
  const before = config.BLOCKED_MESH_USERS.length;
  config.BLOCKED_MESH_USERS = config.BLOCKED_MESH_USERS.filter(entry => {
    const entryName = typeof entry === "string" ? entry : entry.name;
    return entryName?.toLowerCase() !== nameLower;
  });
  if (config.BLOCKED_MESH_USERS.length < before) {
    saveConfig();
    return true;
  }
  return false;
}

function saveConfig() {
  try {
    fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("Failed to save config:", e);
  }
}

function getBlockState(senderName) {
  const key = senderName.toLowerCase();
  let state = blockState.get(key);
  if (!state) {
    state = { lastWarned: 0, lastAppeal: 0 };
    blockState.set(key, state);
  }
  return state;
}

/** =========================
 * Vote-block system
 * ========================= */
const VOTE_DURATION_MS = 15 * 60 * 1000; // 15 minutes
const VOTE_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const VOTE_MIN_YES = 3;
const VOTE_PERCENT = 0.10; // 10%
const VOTE_BLOCK_DAYS = [4, 8, 0]; // escalation: 4 days, 8 days, permanent (0 = permanent)
const VOTE_VETO_EMOJI = "❌";

// Active votes: Map<messageId, { username, reason, channelId, guildId, timer, initiator }>
const activeVotes = new Map();
// Cooldowns: Map<lowercase username, timestamp of last vote attempt>
const voteCooldowns = new Map();

function getVoteBlockCount(username) {
  // Count how many times this user has been vote-blocked before (from config)
  const history = config.VOTE_BLOCK_HISTORY || {};
  return history[username.toLowerCase()] || 0;
}

function recordVoteBlock(username) {
  if (!config.VOTE_BLOCK_HISTORY) config.VOTE_BLOCK_HISTORY = {};
  const key = username.toLowerCase();
  config.VOTE_BLOCK_HISTORY[key] = (config.VOTE_BLOCK_HISTORY[key] || 0) + 1;
  saveConfig();
}

function getVoteBlockDuration(username) {
  const count = getVoteBlockCount(username);
  const idx = Math.min(count, VOTE_BLOCK_DAYS.length - 1);
  return VOTE_BLOCK_DAYS[idx]; // days, 0 = permanent
}

// Check for expired vote-blocks periodically and notify
function startBlockExpiryChecker() {
  setInterval(async () => {
    if (!config.BLOCKED_MESH_USERS) return;
    const now = Date.now();
    const expired = [];
    config.BLOCKED_MESH_USERS = config.BLOCKED_MESH_USERS.filter(entry => {
      if (entry.expiresAt && now > entry.expiresAt) {
        expired.push(entry);
        return false;
      }
      return true;
    });
    if (expired.length > 0) {
      saveConfig();
      for (const entry of expired) {
        // Notify on mesh
        try {
          await enqueueMeshSend(() =>
            connection.sendChannelTextMessage(0,
              `${entry.name}: Your block has expired. Please follow community guidelines.`)
          );
        } catch (e) {
          console.error("Block expiry mesh notify error:", e);
        }
        // Notify on Discord
        const announceId = config.NODE_ANNOUNCE_CHANNEL_ID || config.DISCORD_CHANNEL_ID;
        if (announceId) {
          try {
            const dest = await bot.channels.fetch(announceId);
            if (dest?.isTextBased()) {
              await dest.send(`Vote-block expired for **${entry.name}**. They can now send messages again.`);
            }
          } catch (e) {
            console.error("Block expiry Discord notify error:", e);
          }
        }
      }
    }
  }, 60_000); // Check every minute
}

function isSameDay(ts1, ts2) {
  const d1 = new Date(ts1);
  const d2 = new Date(ts2);
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

// Make sure we can read message content
const commands = [
  new SlashCommandBuilder()
    .setName("meshhelp")
    .setDescription("Show available mesh bridge commands"),

  new SlashCommandBuilder()
    .setName("advert")
    .setDescription("Send a flood advert"),

  new SlashCommandBuilder()
    .setName("send")
    .setDescription("Send a message to mesh")
    .addStringOption(opt =>
      opt.setName("message")
        .setDescription("Message to send")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("nodes")
    .setDescription("Show known mesh nodes"),

  new SlashCommandBuilder()
    .setName("repeater")
    .setDescription("Show repeater stats")
    .addStringOption(opt =>
      opt.setName("name")
        .setDescription("Repeater name")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("subscribe-setup")
    .setDescription("Post the channel subscription message (admin only)"),

  new SlashCommandBuilder()
    .setName("subscribe-refresh")
    .setDescription("Update the subscription message and sync new channels (admin only)"),

  new SlashCommandBuilder()
    .setName("block")
    .setDescription("Block a mesh user from being forwarded to Discord (admin)")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("Mesh username to block")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("unblock")
    .setDescription("Unblock a mesh user (admin)")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("Mesh username to unblock")
        .setRequired(true)
    ),

  new SlashCommandBuilder()
    .setName("blocklist")
    .setDescription("Show blocked mesh users"),

  new SlashCommandBuilder()
    .setName("voteblock")
    .setDescription("Start a vote to block a mesh user")
    .addStringOption(opt =>
      opt.setName("username")
        .setDescription("Mesh username to vote-block")
        .setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName("reason")
        .setDescription("Reason for the block")
        .setRequired(true)
    ),

  // Bridge mode controls
  new SlashCommandBuilder()
    .setName("bridge")
    .setDescription("Control bridge forwarding mode")
    .addSubcommand(sc =>
      sc.setName("status").setDescription("Show current bridge status")
    )
    .addSubcommand(sc =>
      sc.setName("pause").setDescription("Pause forwarding (mesh <-> discord)")
    )
    .addSubcommand(sc =>
      sc.setName("resume").setDescription("Resume forwarding (mesh <-> discord)")
    )
    .addSubcommand(sc =>
      sc.setName("reload").setDescription("Reload config.json without restarting")
    ),
].map(c => c.toJSON());

const rest = new REST({ version: "10" }).setToken(config.DISCORD_TOKEN);

const guildIds = Array.isArray(config.GUILD_IDS)
  ? config.GUILD_IDS
  : (config.GUILD_ID ? [config.GUILD_ID] : []);

if (guildIds.length === 0) {
  throw new Error("No guild IDs configured. Set GUILD_IDS (preferred) or GUILD_ID in config.json");
}

for (const guildId of guildIds) {
  await rest.put(
    Routes.applicationGuildCommands(config.CLIENT_ID, guildId),
    { body: commands }
  );
  console.log(`Registered commands for guild ${guildId}`);
}

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
  ],
  partials: [Partials.Message, Partials.Reaction],
});

let discordChannel;

// ---- Serial connection with auto-reconnect ----
const RECONNECT_DELAY_MS = 5000;
let meshConnected = false;

console.log("Connecting to meshcore device...");
connection.on("connected", async () => {
  console.log("Connected to meshcore!");
  meshConnected = true;

  // Seed known nodes so we don't announce existing contacts on restart
  try {
    const contacts = await connection.getContacts();
    for (const c of contacts) {
      if (c.advName) knownNodes.add(c.advName);
    }
    console.log(`Loaded ${knownNodes.size} known nodes.`);
  } catch (e) {
    console.error("Failed to load initial contacts:", e);
  }
});

connection.on("disconnected", async () => {
  console.error("Meshcore device disconnected!");
  meshConnected = false;
  scheduleReconnect();
});

connection.on("error", (e) => {
  console.error("Meshcore connection error:", e);
  meshConnected = false;
  scheduleReconnect();
});

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  console.log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connection.connect();
    } catch (e) {
      console.error("Reconnect failed:", e);
      scheduleReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

// ---- Node join announcements ----
const knownNodes = new Set();

connection.on(Constants.PushCodes.Advert, async (contact) => {
  try {
    const name = contact?.advName;
    if (!name || knownNodes.has(name)) return;
    knownNodes.add(name);

    const typeLabels = { 0: "Unknown", 1: "Chat", 2: "Repeater", 3: "Room" };
    const type = typeLabels[contact.type] ?? "Unknown";
    const announceChannelId = config.NODE_ANNOUNCE_CHANNEL_ID || config.DISCORD_CHANNEL_ID;
    if (!announceChannelId) return;

    const dest = await bot.channels.fetch(announceChannelId);
    if (dest?.isTextBased()) {
      await dest.send(`New mesh node discovered: **${name}** (${type})`);
    }
  } catch (e) {
    console.error("Node announce error:", e);
  }
});

connection.on(Constants.PushCodes.NewAdvert, async (contact) => {
  try {
    const name = contact?.advName;
    if (!name || knownNodes.has(name)) return;
    knownNodes.add(name);

    const typeLabels = { 0: "Unknown", 1: "Chat", 2: "Repeater", 3: "Room" };
    const type = typeLabels[contact.type] ?? "Unknown";
    const announceChannelId = config.NODE_ANNOUNCE_CHANNEL_ID || config.DISCORD_CHANNEL_ID;
    if (!announceChannelId) return;

    const dest = await bot.channels.fetch(announceChannelId);
    if (dest?.isTextBased()) {
      await dest.send(`New mesh node discovered: **${name}** (${type})`);
    }
  } catch (e) {
    console.error("Node announce error:", e);
  }
});

// ---- RX frame buffer for packet path decoding ----
const rxFrameBuffer = []; // { timestamp, hopCount, prefixes, snr, rssi }
const RX_FRAME_MAX_AGE_MS = 10_000; // discard frames older than 10s
const RX_FRAME_MAX_BUFFER = 50;

// Cache contacts for prefix lookup, with disk backup
const CONTACTS_BACKUP_FILE = './contacts_backup.json';
let contactsCache = [];
let contactsCacheTime = 0;
const CONTACTS_CACHE_TTL = 60_000; // refresh every 60s

// Load backup contacts on startup
let contactsBackup = new Map(); // pubKeyHex -> { name, type, pubKeyHex }
try {
  const data = JSON.parse(fs.readFileSync(CONTACTS_BACKUP_FILE, 'utf8'));
  for (const entry of data) {
    contactsBackup.set(entry.pubKeyHex, entry);
  }
  console.log(`Loaded ${contactsBackup.size} contacts from backup.`);
} catch {
  // No backup yet
}

function saveContactsBackup(contacts) {
  for (const c of contacts) {
    if (!c.publicKey || !c.advName) continue;
    const pubKeyHex = Buffer.from(c.publicKey).toString("hex");
    contactsBackup.set(pubKeyHex, {
      name: c.advName,
      type: c.type,
      pubKeyHex,
    });
  }
  try {
    fs.writeFileSync(CONTACTS_BACKUP_FILE, JSON.stringify([...contactsBackup.values()]));
  } catch (e) {
    console.error("Failed to save contacts backup:", e);
  }
}

async function getContactsCached() {
  const now = Date.now();
  if (now - contactsCacheTime > CONTACTS_CACHE_TTL || contactsCache.length === 0) {
    try {
      contactsCache = await connection.getContacts();
      contactsCacheTime = now;
      saveContactsBackup(contactsCache);
    } catch (e) {
      console.error("Failed to refresh contacts cache:", e);
    }
  }
  return contactsCache;
}

function resolvePrefix(contacts, prefixBytes) {
  const prefixHex = Buffer.from(prefixBytes).toString("hex").toUpperCase();
  const prefixLen = prefixHex.length; // 2, 4, or 6 hex chars

  // Try live contacts first
  const matches = [];
  for (const c of contacts) {
    if (!c.publicKey) continue;
    const contactHex = Buffer.from(c.publicKey).toString("hex").slice(0, prefixLen).toUpperCase();
    if (contactHex === prefixHex && c.advName) matches.push(c.advName);
  }
  if (matches.length === 1) return `[${prefixHex}] ${matches[0]}`;
  if (matches.length > 1) return `[${prefixHex}] ?`;

  // Fall back to backup contacts
  const backupMatches = [];
  for (const entry of contactsBackup.values()) {
    const backupHex = entry.pubKeyHex.slice(0, prefixLen).toUpperCase();
    if (backupHex === prefixHex && entry.name) backupMatches.push(entry.name);
  }
  if (backupMatches.length === 1) return `[${prefixHex}] ${backupMatches[0]}`;
  if (backupMatches.length > 1) return `[${prefixHex}] ?`;

  return `[${prefixHex}]`;
}

connection.on(Constants.PushCodes.LogRxData, (data) => {
  try {
    const raw = data.raw;
    if (!raw || raw.length < 2) return;

    const pathByte = raw[1];
    const hopCount = pathByte & 0x3F;
    const hashMode = (pathByte >> 6) & 0x03;
    // Hash mode: 0 = 1-byte prefixes, 1 = 2-byte, 2 = 3-byte
    const prefixSize = hashMode + 1;

    // Extract prefixes based on hash mode
    const prefixes = [];
    for (let i = 0; i < hopCount && (2 + (i + 1) * prefixSize) <= raw.length; i++) {
      const offset = 2 + i * prefixSize;
      prefixes.push(raw.slice(offset, offset + prefixSize));
    }

    const frame = {
      timestamp: Date.now(),
      hopCount,
      hashMode,
      prefixSize,
      prefixes,
      snr: data.lastSnr,
      rssi: data.lastRssi,
    };

    rxFrameBuffer.push(frame);

    // Prune old/excess frames
    const cutoff = Date.now() - RX_FRAME_MAX_AGE_MS;
    while (rxFrameBuffer.length > 0 && (rxFrameBuffer[0].timestamp < cutoff || rxFrameBuffer.length > RX_FRAME_MAX_BUFFER)) {
      rxFrameBuffer.shift();
    }

    if (config.DEBUG) {
      const prefixHexes = prefixes.map(p => Buffer.from(p).toString("hex").toUpperCase());
      console.debug(`[debug] RX frame: pathByte=0x${raw[1].toString(16)} hashMode=${hashMode} ${hopCount} hops, prefixes=[${prefixHexes.join(", ")}], snr=${data.lastSnr}, rssi=${data.lastRssi}`);
    }
  } catch (e) {
    console.error("RX frame parse error:", e);
  }
});

function findMatchingRxFrame(channelMessage) {
  const pathByte = channelMessage.pathLen;
  const msgHopCount = pathByte & 0x3F;
  const msgHashMode = (pathByte >> 6) & 0x03;

  // Find the most recent frame matching hop count and hash mode
  for (let i = rxFrameBuffer.length - 1; i >= 0; i--) {
    const frame = rxFrameBuffer[i];
    if (frame.hopCount === msgHopCount && frame.hashMode === msgHashMode) {
      // Remove it so it's not matched again
      rxFrameBuffer.splice(i, 1);
      return frame;
    }
  }
  return null;
}

async function buildPathString(channelMessage) {
  const hopCount = channelMessage.pathLen & 0x3F;

  if (channelMessage.pathLen === 0xFF || hopCount === 0) {
    return "-# Direct";
  }

  const frame = findMatchingRxFrame(channelMessage);
  if (!frame || frame.prefixes.length === 0) {
    return `-# ${hopCount} hop${hopCount !== 1 ? "s" : ""}`;
  }

  const contacts = await getContactsCached();
  const names = frame.prefixes.map(p => resolvePrefix(contacts, p));

  return `-# ${hopCount} hop${hopCount !== 1 ? "s" : ""}: ${names.join(" → ")}`;
}

connection.on(Constants.PushCodes.MsgWaiting, async () => {
  try {
    const waitingMessages = await connection.getWaitingMessages();
    console.log(`You have ${waitingMessages.length} waiting messages.`);
    for (const msg of waitingMessages) {
      console.log("Received message:", msg);
      if (msg.channelMessage) await onMeshChannelMessageReceived(msg.channelMessage);
    }
  } catch (e) {
    console.log(e);
  }
});

function getMeshChannelForDiscordChannel(discordChannelId) {
  const map = config.DISCORD_TO_MESH_ROUTES || {};
  const idx = map[String(discordChannelId)];
  if (idx === undefined || idx === null) return null;
  const n = Number(idx);
  return Number.isFinite(n) ? n : null;
}

async function onMeshChannelMessageReceived(channelMessage) {
  // Bridge pause gate: Mesh -> Discord
  if (isBridgePaused()) {
    if (config.DEBUG) console.debug("[debug] Bridge paused; dropping mesh->discord message");
    return;
  }

  const text = channelMessage?.text ?? "";
  const channelIdx = channelMessage?.channelIdx;

  // Handle PocketMesh emoji reactions — apply to matching Discord message
  if (isPocketMeshReact(text)) {
    const parsed = parseMeshReaction(text);
    if (!parsed) {
      if (config.DEBUG) console.debug(`[debug] Could not parse PocketMesh react: "${text}"`);
      return;
    }

    const entry = messageHistory.get(parsed.hash);
    if (!entry) {
      if (config.DEBUG) console.debug(`[debug] No matching message for react hash ${parsed.hash}`);
      return;
    }

    try {
      const channel = await bot.channels.fetch(entry.discordChannelId);
      const msg = await channel.messages.fetch(entry.discordMessageId);
      await msg.react(parsed.emoji);
      if (config.DEBUG) console.debug(`[debug] Applied react ${parsed.emoji} to Discord message ${entry.discordMessageId}`);
    } catch (e) {
      console.error(`Failed to apply mesh react to Discord message:`, e);
    }
    return;
  }

  // #meshmonday special-case (optional: keep as you had it)
  const meshMonday = bot.channels.cache.get(config.DISCORD_CHANNEL_ID_MESHMONDAY);
  if (text.includes("#meshmonday")) {
    if (meshMonday) meshMonday.send(text).catch(console.error);
  }

  // Language warning back to mesh + echo to routed Discord channel
  if (text.toLowerCase().includes("fuck")) {
    const idx = Number(channelMessage?.channelIdx ?? 0);

    // Serialize this mesh send so it doesn't interleave with chunked sends
    await enqueueMeshSend(() => connection.sendChannelTextMessage(idx, "Language!!!"));

    // Echo admonishment to the same Discord route
    const routeChannelIdForAdmonish = config.DISCORD_ROUTES?.[String(idx)] ?? config.DISCORD_CHANNEL_ID;
    if (routeChannelIdForAdmonish) {
      try {
        const dest = await bot.channels.fetch(routeChannelIdForAdmonish);
        if (dest?.isTextBased()) {
          await dest.send("Language!!!");
        }
      } catch (e) {
        console.error(`Failed to echo Language!!! to Discord for mesh channelIdx=${idx}:`, e);
      }
    }
  }

  // Block system — check if sender is blocked
  const senderColonIdx = text.indexOf(": ");
  const meshSenderName = senderColonIdx > 0 && senderColonIdx < 30
    ? text.slice(0, senderColonIdx).trim()
    : null;

  // Also check after bridge prefix stripping
  const strippedText = stripBridgePrefixes(text);
  const strippedColonIdx = strippedText.indexOf(": ");
  const strippedSenderName = strippedColonIdx > 0 && strippedColonIdx < 30
    ? strippedText.slice(0, strippedColonIdx).trim()
    : null;

  const senderToCheck = strippedSenderName || meshSenderName;

  if (senderToCheck && isUserBlocked(senderToCheck)) {
    const now = Date.now();
    const state = getBlockState(senderToCheck);
    const msgBody = strippedColonIdx > 0 ? strippedText.slice(strippedColonIdx + 2).trim() : text.trim();

    // Check for appeal
    if (msgBody.toLowerCase() === "appeal") {
      if (!isSameDay(state.lastAppeal, now)) {
        state.lastAppeal = now;
        // Forward the appeal to the routed Discord channel
        const routeChannelId = config.DISCORD_ROUTES?.[String(channelIdx)] ?? config.DISCORD_CHANNEL_ID;
        if (routeChannelId) {
          try {
            const dest = await bot.channels.fetch(routeChannelId);
            if (dest?.isTextBased()) {
              await dest.send(`**[APPEAL from ${senderToCheck}]:** User is requesting to be unblocked.`);
            }
          } catch (e) {
            console.error("Appeal forward error:", e);
          }
        }
        await enqueueMeshSend(() =>
          connection.sendChannelTextMessage(channelIdx, "Your appeal has been forwarded.")
        );
      } else {
        await enqueueMeshSend(() =>
          connection.sendChannelTextMessage(channelIdx, "You have already submitted an appeal today.")
        );
      }
      return;
    }

    // Daily warning
    if (!isSameDay(state.lastWarned, now)) {
      state.lastWarned = now;
      await enqueueMeshSend(() =>
        connection.sendChannelTextMessage(channelIdx,
          "You are blocked from Discord. Reply \"appeal\" once daily to request an unblock.")
      );
    }

    if (config.DEBUG) console.debug(`[debug] Blocked message from ${senderToCheck}`);
    return;
  }

  // Emergency channel handling
  if (isEmergencyMeshChannel(channelIdx)) {
    const emergencyChannelId = getEmergencyDiscordChannelId();
    if (emergencyChannelId) {
      try {
        const dest = await bot.channels.fetch(emergencyChannelId);
        if (dest?.isTextBased()) {
          const now = Date.now();
          const isNewEmergency = !emergencyState.active || (now - emergencyState.lastAlertAt) > EMERGENCY_COOLDOWN_MS;

          if (isNewEmergency) {
            // First message — send alert, forward message, reply to mesh
            emergencyState.active = true;
            emergencyState.lastAlertAt = now;

            await dest.send("🚨 **Emergency Message Incoming** @everyone");

            // Forward the message via webhook
            let cleaned = stripBridgePrefixes(text);
            const colonIdx = cleaned.indexOf(": ");
            let senderName, meshBody;
            if (colonIdx > 0 && colonIdx < 30) {
              senderName = cleaned.slice(0, colonIdx).trim();
              meshBody = cleaned.slice(colonIdx + 2).trim();
            } else {
              senderName = "Mesh";
              meshBody = cleaned;
            }

            const webhook = await getOrCreateWebhook(dest);
            if (webhook) {
              const avatarURL = `https://api.dicebear.com/9.x/identicon/png?seed=${encodeURIComponent(senderName)}&size=128`;
              await webhook.send({ content: meshBody, username: senderName, avatarURL });
            } else {
              await dest.send(`**${senderName}:** ${meshBody}`);
            }

            // Reply to mesh
            await enqueueMeshSend(() =>
              connection.sendChannelTextMessage(channelIdx,
                "Your message has been forwarded to Discord. Stand by for a reply. This channel is for emergency use only.")
            );

            // Start reminder timer
            scheduleEmergencyReminder(emergencyChannelId);
          } else {
            // Subsequent message — just forward, no ping or reply
            let cleaned = stripBridgePrefixes(text);
            const colonIdx = cleaned.indexOf(": ");
            let senderName, meshBody;
            if (colonIdx > 0 && colonIdx < 30) {
              senderName = cleaned.slice(0, colonIdx).trim();
              meshBody = cleaned.slice(colonIdx + 2).trim();
            } else {
              senderName = "Mesh";
              meshBody = cleaned;
            }

            const webhook = await getOrCreateWebhook(dest);
            if (webhook) {
              const avatarURL = `https://api.dicebear.com/9.x/identicon/png?seed=${encodeURIComponent(senderName)}&size=128`;
              await webhook.send({ content: meshBody, username: senderName, avatarURL });
            } else {
              await dest.send(`**${senderName}:** ${meshBody}`);
            }
          }
        }
      } catch (e) {
        console.error("Emergency channel error:", e);
      }
      return; // Don't process through normal routing
    }
  }

  // Route by Meshcore channel index
  const explicitRoute = config.DISCORD_ROUTES?.[String(channelIdx)];
  const routeChannelId = explicitRoute ?? config.DISCORD_CHANNEL_ID;
  if (!routeChannelId) return;
  const isUnmappedChannel = !explicitRoute;

  try {
    const dest = await bot.channels.fetch(routeChannelId);
    if (!dest || !dest.isTextBased()) {
      console.error(`Route target not text-based: mesh channelIdx=${channelIdx} -> ${routeChannelId}`);
      return;
    }

    // Strip known bridge prefixes
    let cleaned = stripBridgePrefixes(text);

    // Deduplication: skip if we've seen this message body recently on this channel
    if (isDuplicate(channelIdx, cleaned)) {
      if (config.DEBUG) console.debug(`[debug] Dedup: skipping duplicate message on ch=${channelIdx}: "${cleaned}"`);
      return;
    }

    const colonIdx = cleaned.indexOf(": ");
    let senderName, meshBody;
    if (colonIdx > 0 && colonIdx < 30) {
      senderName = cleaned.slice(0, colonIdx).trim();
      meshBody = cleaned.slice(colonIdx + 2).trim();
    } else {
      senderName = "Mesh";
      meshBody = cleaned;
    }

    // Flag unmapped channels so it's clear the message came from an unexpected source
    let channelTag = "";
    if (isUnmappedChannel) {
      try {
        const chInfo = await connection.getChannel(channelIdx);
        const chName = chInfo?.name || `ch ${channelIdx}`;
        channelTag = `[${chName}] `;
      } catch {
        channelTag = `[Mesh ch ${channelIdx}] `;
      }
    }

    // Build packet path string
    const pathStr = await buildPathString(channelMessage);

    // Send via webhook so the sender name appears as the message author
    let sentMsg;
    const webhook = await getOrCreateWebhook(dest);
    if (webhook) {
      const avatarURL = `https://api.dicebear.com/9.x/identicon/png?seed=${encodeURIComponent(senderName)}&size=128`;
      sentMsg = await webhook.send({ content: `${channelTag}${meshBody}\n${pathStr}`, username: senderName, avatarURL });
    } else {
      // Fallback to bot message if webhook fails
      sentMsg = await dest.send(`${channelTag}**${senderName}:** ${meshBody}\n${pathStr}`);
    }

    // Track message for reaction matching
    // Hash the body without sender name (for reactions from the sender's own device)
    const entry = {
      discordMessageId: sentMsg.id,
      discordChannelId: routeChannelId,
      meshText: cleaned,
      senderTimestamp: channelMessage.senderTimestamp,
      meshChannelIdx: channelIdx,
    };
    const hashBody = generateMeshHash(meshBody, channelMessage.senderTimestamp);
    trackMessage(hashBody, entry);
    if (config.DEBUG) console.debug(`[debug] Tracked message hash=${hashBody} discordId=${sentMsg.id}`);

    // Also hash the full cleaned text (for reactions from other clients who see "SenderName: body")
    if (cleaned !== meshBody) {
      const hashFull = generateMeshHash(cleaned, channelMessage.senderTimestamp);
      trackMessage(hashFull, entry);
      if (config.DEBUG) console.debug(`[debug] Tracked alt hash=${hashFull} discordId=${sentMsg.id}`);
    }
  } catch (e) {
    console.error(`Failed to route mesh channelIdx=${channelIdx} to ${routeChannelId}:`, e);
  }
}

// Replace slash commands with prefix commands
bot.once("ready", async () => {
  console.log(`Logged in as ${bot.user.tag}!`);
  console.log('Listening for commands: !advert, !send <message>');
  discordChannel = await bot.channels.fetch(config.DISCORD_CHANNEL_ID);
  startBlockExpiryChecker();
});

async function handleAdvert(reply) {
  if (isBridgePaused()) {
    await reply("Bridge is paused; not sending advert to mesh.");
    return;
  }
  await connection.sendFloodAdvert();
  await reply("Sending Flood Advert!");
}

async function handleSend(text, authorName, reply, meshChannelIdx = 0, discordMsgId = null, discordChannelId = null) {
  if (!text) {
    await reply("Message required");
    return;
  }

  // Bridge pause gate: Discord -> Mesh
  if (isBridgePaused()) {
    await reply("Bridge is paused; not sending to mesh.");
    return;
  }

  const meshText = `${authorName} [D]: ${text}`;
  await sendMeshChunked(meshChannelIdx, meshText, (sentText, ts) => {
    if (discordMsgId) {
      const hash = generateMeshHash(sentText, ts);
      trackMessage(hash, {
        discordMessageId: discordMsgId,
        discordChannelId: discordChannelId,
        meshText: sentText,
        senderTimestamp: ts,
        meshChannelIdx: meshChannelIdx,
        outgoing: true,
      });
      if (config.DEBUG) console.debug(`[debug] Tracked outgoing hash=${hash} discordId=${discordMsgId}`);
    }
  });
  await reply(`Sent to mesh channel ${meshChannelIdx}: ${text}`);
}

bot.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === "meshhelp") {
      const help = [
        "**MeshCore Bridge Commands**",
        "",
        "`/send <message>` — Send a message to the mesh network",
        "`/advert` — Send a flood advert to discover nodes",
        "`/nodes` — List all known mesh nodes",
        "`/repeater <name>` — Show repeater stats (discovers path if needed)",
        "`/bridge status` — Show bridge status",
        "`/bridge pause` — Pause message forwarding (admin)",
        "`/bridge resume` — Resume message forwarding (admin)",
        "`/bridge reload` — Reload config without restarting (admin)",
        "`/subscribe-setup` — Post channel subscription message (admin)",
        "`/subscribe-refresh` — Update subscription message with new channels (admin)",
        "`/block <username>` — Block a mesh user from Discord forwarding (admin)",
        "`/unblock <username>` — Unblock a mesh user (admin)",
        "`/blocklist` — Show blocked mesh users",
        "`/voteblock <username> <reason>` — Start a community vote to block a mesh user",
        "",
        "Messages in forwarding channels are automatically relayed to mesh.",
        "Reactions on bridged messages are mirrored to/from mesh.",
        "Images are uploaded and sent as links.",
      ];
      await interaction.reply({ content: help.join("\n"), flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "subscribe-setup") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!isBridgeAdminMember(interaction.member)) {
        await interaction.editReply("Not authorized.");
        return;
      }

      const subscribableChannels = config.SUBSCRIBABLE_CHANNELS || [];
      if (subscribableChannels.length === 0) {
        await interaction.editReply("No subscribable channels configured.");
        return;
      }

      const guild = interaction.guild;

      try {
        // Create roles and set channel permissions for each subscribable channel
        const roleMap = []; // { name, emoji, role, discordChannelId }
        for (const ch of subscribableChannels) {
          const roleName = `Mesh: ${ch.name}`;

          // Find or create role
          let role = guild.roles.cache.find(r => r.name === roleName);
          if (!role) {
            role = await guild.roles.create({
              name: roleName,
              reason: "MeshCore channel subscription",
            });
          }

          // Set channel permissions — hide from @everyone, show for role
          const discordChannel = await bot.channels.fetch(ch.discordChannelId).catch(() => null);
          if (discordChannel) {
            await discordChannel.permissionOverwrites.edit(guild.id, {
              ViewChannel: false,
            }).catch(e => console.error(`Failed to set @everyone perms for ${ch.name}:`, e));

            await discordChannel.permissionOverwrites.edit(role.id, {
              ViewChannel: true,
            }).catch(e => console.error(`Failed to set role perms for ${ch.name}:`, e));

            // Make sure the bot can still see and post in the channel
            await discordChannel.permissionOverwrites.edit(bot.user.id, {
              ViewChannel: true,
              SendMessages: true,
              ManageWebhooks: true,
            }).catch(e => console.error(`Failed to set bot perms for ${ch.name}:`, e));
          }

          roleMap.push({ name: ch.name, emoji: ch.emoji, role, discordChannelId: ch.discordChannelId });
        }

        // Build and post the subscription message
        const lines = [
          "**Mesh Channel Subscriptions**",
          "",
          "React to join/leave channels:",
          "",
        ];
        for (const entry of roleMap) {
          lines.push(`${entry.emoji}  \`${entry.name}\``);
        }
        lines.push("", "_Remove your reaction to unsubscribe._");

        const subscribeChannelId = config.SUBSCRIBE_CHANNEL_ID;
        if (!subscribeChannelId) {
          await interaction.editReply("SUBSCRIBE_CHANNEL_ID not configured.");
          return;
        }

        const subChannel = await bot.channels.fetch(subscribeChannelId);
        const subMsg = await subChannel.send(lines.join("\n"));

        // Add reactions in order
        for (const entry of roleMap) {
          await subMsg.react(entry.emoji);
        }

        // Save the message ID to config for persistence
        config.SUBSCRIBE_MESSAGE_ID = subMsg.id;

        // Save role mapping to config
        config._SUBSCRIBE_ROLE_MAP = roleMap.map(e => ({
          emoji: e.emoji,
          roleId: e.role.id,
          name: e.name,
        }));

        // Persist to config file
        try {
          fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        } catch (e) {
          console.error("Failed to save config:", e);
        }

        await interaction.editReply(`Subscription message posted! (${roleMap.length} channels configured)`);
      } catch (e) {
        console.error("Subscribe setup error:", e);
        await interaction.editReply(`Setup failed: ${e.message}`);
      }
      return;
    }

    if (interaction.commandName === "subscribe-refresh") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!isBridgeAdminMember(interaction.member)) {
        await interaction.editReply("Not authorized.");
        return;
      }

      const subscribeChannelId = config.SUBSCRIBE_CHANNEL_ID;
      const subscribeMessageId = config.SUBSCRIBE_MESSAGE_ID;

      if (!subscribeChannelId || !subscribeMessageId) {
        await interaction.editReply("No subscription message found. Run `/subscribe-setup` first.");
        return;
      }

      const subscribableChannels = config.SUBSCRIBABLE_CHANNELS || [];
      const guild = interaction.guild;

      try {
        const subChannel = await bot.channels.fetch(subscribeChannelId);
        const subMsg = await subChannel.messages.fetch(subscribeMessageId);

        // Ensure roles exist for any new channels and build updated role map
        const roleMap = [];
        for (const ch of subscribableChannels) {
          const roleName = `Mesh: ${ch.name}`;
          let role = guild.roles.cache.find(r => r.name === roleName);
          if (!role) {
            role = await guild.roles.create({
              name: roleName,
              reason: "MeshCore channel subscription",
            });
          }

          // Set channel permissions
          const discordChannel = await bot.channels.fetch(ch.discordChannelId).catch(() => null);
          if (discordChannel) {
            await discordChannel.permissionOverwrites.edit(guild.id, {
              ViewChannel: false,
            }).catch(e => console.error(`Failed to set @everyone perms for ${ch.name}:`, e));

            await discordChannel.permissionOverwrites.edit(role.id, {
              ViewChannel: true,
            }).catch(e => console.error(`Failed to set role perms for ${ch.name}:`, e));

            await discordChannel.permissionOverwrites.edit(bot.user.id, {
              ViewChannel: true,
              SendMessages: true,
              ManageWebhooks: true,
            }).catch(e => console.error(`Failed to set bot perms for ${ch.name}:`, e));
          }

          roleMap.push({ emoji: ch.emoji, roleId: role.id, name: ch.name });
        }

        // Update the message text
        const lines = [
          "**Mesh Channel Subscriptions**",
          "",
          "React to join/leave channels:",
          "",
        ];
        for (const entry of roleMap) {
          lines.push(`${entry.emoji}  \`${entry.name}\``);
        }
        lines.push("", "_Remove your reaction to unsubscribe._");

        await subMsg.edit(lines.join("\n"));

        // Add any missing reactions (preserves existing ones)
        const existingReactions = subMsg.reactions.cache;
        for (const entry of roleMap) {
          const hasReaction = existingReactions.some(r => r.emoji.name === entry.emoji);
          if (!hasReaction) {
            await subMsg.react(entry.emoji);
          }
        }

        // Save updated role map
        config._SUBSCRIBE_ROLE_MAP = roleMap;
        try {
          fs.writeFileSync('./config.json', JSON.stringify(config, null, 2));
        } catch (e) {
          console.error("Failed to save config:", e);
        }

        await interaction.editReply(`Subscription message updated! (${roleMap.length} channels)`);
      } catch (e) {
        console.error("Subscribe refresh error:", e);
        await interaction.editReply(`Refresh failed: ${e.message}`);
      }
      return;
    }

    // /bridge mode commands
    if (interaction.commandName === "bridge") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!isBridgeAdminMember(interaction.member)) {
        await interaction.editReply("Not authorized.");
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "status") {
        if (!isBridgePaused()) {
          await interaction.editReply("Bridge status: **RUNNING**");
        } else {
          const by = bridgeState.pausedBy ? ` by **${bridgeState.pausedBy}**` : "";
          const at = bridgeState.pausedAt ? ` at **${bridgeState.pausedAt}**` : "";
          await interaction.editReply(`Bridge status: **PAUSED**${by}${at}`);
        }
        return;
      }

      if (sub === "pause") {
        setBridgePaused(true, interaction.user?.tag || interaction.user?.username || "unknown");
        await interaction.editReply("Bridge paused. Forwarding is stopped.");
        return;
      }

      if (sub === "resume") {
        setBridgePaused(false);
        await interaction.editReply("Bridge resumed. Forwarding is active.");
        return;
      }

      if (sub === "reload") {
        try {
          config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
          webhookCache.clear();
          await interaction.editReply("Config reloaded successfully.");
        } catch (e) {
          console.error("Config reload error:", e);
          await interaction.editReply(`Config reload failed: ${e.message}`);
        }
        return;
      }

      // Should never reach here
      await interaction.editReply("Unknown subcommand.");
      return;
    }

    if (interaction.commandName === "nodes") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      try {
        const contacts = await connection.getContacts();
        if (!contacts || contacts.length === 0) {
          await interaction.editReply("No nodes found.");
          return;
        }

        const typeLabels = { 0: "Unknown", 1: "Chat", 2: "Repeater", 3: "Room" };

        const lines = contacts.map(c => {
          const name = c.advName || "(unnamed)";
          const type = typeLabels[c.type] ?? "Unknown";
          const hops = c.outPathLen === 0xFF ? "direct" : `${c.outPathLen} hop${c.outPathLen !== 1 ? "s" : ""}`;
          const lastSeen = c.lastAdvert
            ? `<t:${c.lastAdvert}:R>`
            : "never";
          return `**${name}** — ${type}, ${hops}, seen ${lastSeen}`;
        });

        // Discord message limit is 2000 chars, truncate if needed
        let reply = `**Mesh Nodes (${contacts.length}):**\n` + lines.join("\n");
        if (reply.length > 2000) {
          reply = reply.slice(0, 1997) + "...";
        }

        await interaction.editReply(reply);
      } catch (e) {
        console.error("Error fetching nodes:", e);
        await interaction.editReply("Failed to fetch nodes from mesh device.");
      }
      return;
    }

    if (interaction.commandName === "repeater") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const name = interaction.options.getString("name");
      try {
        const contacts = await connection.getContacts();
        const contact = contacts.find(c => c.advName === name);
        if (!contact) {
          // Show close matches to help with typos
          const close = contacts
            .filter(c => c.advName?.toLowerCase().includes(name.toLowerCase()))
            .map(c => c.advName);
          const hint = close.length > 0 ? ` Did you mean: ${close.join(", ")}?` : "";
          await interaction.editReply(`No node found with name "${name}".${hint}`);
          return;
        }

        if (contact.type !== 2) {
          await interaction.editReply(`**${name}** is not a repeater (type: ${["Unknown","Chat","Repeater","Room"][contact.type] ?? "Unknown"}).`);
          return;
        }

        const nodeTypeLabels = { 0: "Unknown", 1: "Chat", 2: "Repeater", 3: "Room" };
        const type = nodeTypeLabels[contact.type] ?? "Unknown";
        const hops = (contact.outPathLen < 0 || contact.outPathLen === 0xFF)
          ? "no path"
          : contact.outPathLen === 0 ? "direct" : `${contact.outPathLen} hop${contact.outPathLen !== 1 ? "s" : ""}`;
        const lastSeen = contact.lastAdvert
          ? `<t:${contact.lastAdvert}:R>`
          : "never";

        const lines = [
          `**${name}** (${type})`,
          `Path: ${hops}`,
          `Last seen: ${lastSeen}`,
        ];

        // Try to get live stats if we have a path
        if (contact.outPathLen >= 0 && contact.outPathLen !== 0xFF) {
          try {
            if (config.DEBUG) console.debug(`[debug] Requesting live status from "${name}" pathLen=${contact.outPathLen}`);
            const status = await enqueueMeshSend(() => connection.getStatus(contact.publicKey, 15000));
            if (status) {
              const battery = status.batt_milli_volts ? `${(status.batt_milli_volts / 1000).toFixed(2)}V` : "N/A";
              const uptime = status.total_up_time_secs ? `${Math.floor(status.total_up_time_secs / 3600)}h ${Math.floor((status.total_up_time_secs % 3600) / 60)}m` : "N/A";
              const airtime = status.total_air_time_secs ? `${Math.floor(status.total_air_time_secs / 3600)}h ${Math.floor((status.total_air_time_secs % 3600) / 60)}m` : "N/A";
              const lastSnr = status.last_snr != null ? `${status.last_snr} dB` : "N/A";
              const lastRssi = status.last_rssi != null ? `${status.last_rssi} dBm` : "N/A";

              lines.push(
                `Battery: ${battery}`,
                `Uptime: ${uptime}`,
                `Air time: ${airtime}`,
                `TX queue: ${status.curr_tx_queue_len ?? "?"} | Free: ${status.curr_free_queue_len ?? "?"}`,
                `Last SNR: ${lastSnr} | RSSI: ${lastRssi}`,
                `Packets — Sent: ${status.n_packets_sent ?? "?"} | Recv: ${status.n_packets_recv ?? "?"}`,
                `Flood — Sent: ${status.n_sent_flood ?? "?"} | Recv: ${status.n_recv_flood ?? "?"}`,
                `Direct — Sent: ${status.n_sent_direct ?? "?"} | Recv: ${status.n_recv_direct ?? "?"}`,
                `Duplicates — Direct: ${status.n_direct_dups ?? "?"} | Flood: ${status.n_flood_dups ?? "?"}`,
                `Queue full events: ${status.n_full_events ?? "?"}`,
              );
            } else {
              lines.push("_(Live stats unavailable — no response)_");
            }
          } catch (e) {
            lines.push("_(Live stats unavailable — request timed out)_");
          }
        } else {
          lines.push("_(Live stats unavailable — no path to node)_");
        }

        await interaction.editReply(lines.join("\n"));
      } catch (e) {
        console.error("Error fetching repeater status:", e);
        if (e === "timeout") {
          await interaction.editReply(`Timed out waiting for **${name}** to respond — it may be out of range or too many hops away.`);
        } else {
          await interaction.editReply(`Failed to get status for "${name}".`);
        }
      }
      return;
    }

    if (interaction.commandName === "block") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!isBridgeAdminMember(interaction.member)) {
        await interaction.editReply("Not authorized.");
        return;
      }
      const username = interaction.options.getString("username");

      // Try to find the contact to get their public key
      let pubKeyHex = null;
      try {
        const contact = await connection.findContactByName(username);
        if (contact?.publicKey) {
          pubKeyHex = Buffer.from(contact.publicKey).toString("hex");
        }
      } catch {}

      if (addBlockedUser(username, pubKeyHex)) {
        // Send warning to mesh on public channel
        await enqueueMeshSend(() =>
          connection.sendChannelTextMessage(0,
            `${username}: You have been blocked from Discord. Reply "appeal" once daily to request an unblock.`)
        );
        await interaction.editReply(`Blocked **${username}**${pubKeyHex ? ` (key: ${pubKeyHex.slice(0, 12)}...)` : ""}. Their messages will no longer be forwarded to Discord. Warning sent to mesh.`);
      } else {
        await interaction.editReply(`**${username}** is already blocked.`);
      }
      return;
    }

    if (interaction.commandName === "unblock") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!isBridgeAdminMember(interaction.member)) {
        await interaction.editReply("Not authorized.");
        return;
      }
      const username = interaction.options.getString("username");
      if (removeBlockedUser(username)) {
        await interaction.editReply(`Unblocked **${username}**.`);
      } else {
        await interaction.editReply(`**${username}** is not on the block list.`);
      }
      return;
    }

    if (interaction.commandName === "blocklist") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const list = getBlockList();
      if (list.length === 0) {
        await interaction.editReply("No blocked users.");
      } else {
        const now = Date.now();
        const lines = list.map(entry => {
          const name = typeof entry === "string" ? entry : entry.name;
          const key = entry.pubKey ? ` (${entry.pubKey.slice(0, 12)}...)` : "";
          const type = entry.type === "vote" ? " [vote]" : " [admin]";
          let expiry = "";
          if (entry.expiresAt) {
            if (now > entry.expiresAt) {
              expiry = " — *expired*";
            } else {
              expiry = ` — expires <t:${Math.floor(entry.expiresAt / 1000)}:R>`;
            }
          }
          return `- **${name}**${key}${type}${expiry}`;
        });
        await interaction.editReply(`**Blocked Users (${list.length}):**\n${lines.join("\n")}`);
      }
      return;
    }

    if (interaction.commandName === "voteblock") {
      const username = interaction.options.getString("username");
      const reason = interaction.options.getString("reason");

      // Check if already blocked
      if (isUserBlocked(username)) {
        await interaction.reply({ content: `**${username}** is already blocked.`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Check cooldown
      const cooldownKey = username.toLowerCase();
      const lastVote = voteCooldowns.get(cooldownKey) || 0;
      if (Date.now() - lastVote < VOTE_COOLDOWN_MS) {
        const remaining = Math.ceil((VOTE_COOLDOWN_MS - (Date.now() - lastVote)) / 60000);
        await interaction.reply({ content: `A vote for **${username}** was attempted recently. Try again in ${remaining} minutes.`, flags: MessageFlags.Ephemeral });
        return;
      }

      // Check if there's already an active vote for this user
      for (const vote of activeVotes.values()) {
        if (vote.username.toLowerCase() === cooldownKey) {
          await interaction.reply({ content: `A vote for **${username}** is already in progress.`, flags: MessageFlags.Ephemeral });
          return;
        }
      }

      // Get online member count for threshold
      const guild = interaction.guild;
      const onlineMembers = guild.members.cache.filter(m => !m.user.bot && m.presence?.status && m.presence.status !== "offline").size;
      const threshold = Math.max(VOTE_MIN_YES, Math.ceil(onlineMembers * VOTE_PERCENT));

      // Escalation info
      const blockDays = getVoteBlockDuration(username);
      const durationText = blockDays === 0 ? "permanently" : `for ${blockDays} days`;
      const priorBlocks = getVoteBlockCount(username);
      const escalationNote = priorBlocks > 0 ? ` (prior blocks: ${priorBlocks})` : "";

      // Post vote message
      const voteMsg = await interaction.channel.send(
        `**Vote to block \`${username}\` ${durationText}${escalationNote}**\n` +
        `Reason: ${reason}\n` +
        `Initiated by: ${interaction.user.username}\n\n` +
        `React 👍 to vote yes, 👎 to vote no.\n` +
        `Admins: react ${VOTE_VETO_EMOJI} to veto.\n` +
        `Needs **${threshold}** yes votes. Closes <t:${Math.floor((Date.now() + VOTE_DURATION_MS) / 1000)}:R>.`
      );

      await voteMsg.react("👍");
      await voteMsg.react("👎");
      await voteMsg.react(VOTE_VETO_EMOJI);

      voteCooldowns.set(cooldownKey, Date.now());

      // Set timer to resolve the vote
      const timer = setTimeout(async () => {
        activeVotes.delete(voteMsg.id);
        try {
          // Refetch message to get updated reactions
          const msg = await interaction.channel.messages.fetch(voteMsg.id);

          // Check for admin veto
          const vetoReaction = msg.reactions.cache.find(r => r.emoji.name === VOTE_VETO_EMOJI);
          if (vetoReaction && vetoReaction.count > 1) { // >1 because bot reacted
            // Check if any reactor is an admin
            const vetoUsers = await vetoReaction.users.fetch();
            const vetoed = vetoUsers.some(u => {
              if (u.bot) return false;
              const member = guild.members.cache.get(u.id);
              return member && isBridgeAdminMember(member);
            });
            if (vetoed) {
              await msg.reply(`Vote to block **${username}** was **vetoed** by an admin.`);
              return;
            }
          }

          // Count yes votes (subtract 1 for bot's reaction)
          const yesReaction = msg.reactions.cache.find(r => r.emoji.name === "👍");
          const yesCount = yesReaction ? yesReaction.count - 1 : 0;

          if (yesCount >= threshold) {
            // Vote passed
            const blockDays = getVoteBlockDuration(username);
            const expiresAt = blockDays > 0 ? Date.now() + (blockDays * 24 * 60 * 60 * 1000) : null;

            let pubKeyHex = null;
            try {
              const contact = await connection.findContactByName(username);
              if (contact?.publicKey) pubKeyHex = Buffer.from(contact.publicKey).toString("hex");
            } catch {}

            addBlockedUser(username, pubKeyHex, { type: "vote", expiresAt, voteCount: yesCount });
            recordVoteBlock(username);

            const durationText = blockDays === 0 ? "permanently" : `for ${blockDays} days`;
            await msg.reply(`Vote passed (**${yesCount}**/${threshold}). **${username}** has been blocked ${durationText}.`);

            // Warn on mesh
            await enqueueMeshSend(() =>
              connection.sendChannelTextMessage(0,
                `${username}: You have been vote-blocked ${durationText}. Reply "appeal" once daily to request an unblock.`)
            );
          } else {
            await msg.reply(`Vote failed (**${yesCount}**/${threshold} needed). **${username}** will not be blocked.`);
          }
        } catch (e) {
          console.error("Vote resolution error:", e);
        }
      }, VOTE_DURATION_MS);

      activeVotes.set(voteMsg.id, {
        username,
        reason,
        channelId: interaction.channel.id,
        guildId: guild.id,
        timer,
        initiator: interaction.user.username,
      });

      await interaction.reply({ content: `Vote to block **${username}** started!`, flags: MessageFlags.Ephemeral });
      return;
    }

    if (interaction.commandName === "advert") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await handleAdvert((msg) => interaction.editReply(msg));
    }

    if (interaction.commandName === "send") {
      const text = interaction.options.getString("message");
      const name =
        interaction.member?.nickname ||
        interaction.user.username;

      // keep ephemeral confirmation to the user
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // flood protection for /send too
      if (interaction.channel) {
        const messageLike = { channel: interaction.channel };
        if (!(await floodAllowDiscordToMesh(messageLike))) {
          await interaction.editReply("Flood protection active; try again in a bit.");
          return;
        }
      }

      // Determine route FIRST
    const meshIdx = getMeshChannelForDiscordChannel(interaction.channelId);
    if (meshIdx === null) {
      // Not mapped => don't echo, just tell the user (ephemeral)
      await interaction.editReply("This channel is not mapped to a mesh channel.");
      return;
    }

    // Mapped => optionally echo in-channel, then forward to mesh
    const echoMsg = await interaction.channel.send(`${name}: ${text}`);
      // send to mesh + confirm back to the user
      await handleSend(text, name, (msg) => interaction.editReply(msg), meshIdx, echoMsg.id, interaction.channelId);
      return;
    }


  } catch (e) {
    console.error("interactionCreate error:", e);

    // Try to respond if possible, but don't crash
    if (interaction.isRepliable()) {
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply("Something went wrong handling that command.");
        } else {
          await interaction.reply({ content: "Something went wrong handling that command.", flags: MessageFlags.Ephemeral });
        }
      } catch (_) { }
    }
  }
});

bot.on("messageCreate", async (message) => {
  try {
    // ignore bots and DMs
    if (message.author.bot) return;
    if (!message.guild) return;

    // Emergency channel reply detection — cancel reminder if someone responds
    const emergencyChannelId = getEmergencyDiscordChannelId();
    if (emergencyChannelId && String(message.channel.id) === String(emergencyChannelId) && emergencyState.active) {
      cancelEmergencyReminder();
      if (config.DEBUG) console.debug("[debug] Emergency reminder cancelled — Discord reply received");
    }

    // Always-forward mode for one specific Discord channel
    const alwaysForwardIds = getAlwaysForwardChannelIds();
    if (alwaysForwardIds.has(String(message.channel.id))) {
      // Bridge pause gate: Discord -> Mesh
      if (isBridgePaused()) {
        if (config.DEBUG) console.debug("[debug] Bridge paused; dropping discord->mesh always-forward message");
        return;
      }

      // Flood protection gate
      if (!(await floodAllowDiscordToMesh(message))) return;

      const meshIdx = getMeshChannelForDiscordChannel(message.channel.id);
      if (meshIdx === null) {
        if (config.DEBUG) console.debug(`[debug] Always-forward channel not mapped: ${message.channel.id}`);
        return;
      }

      const name = message.member?.nickname || message.author.username;

      // Optional: don't forward commands typed in that channel (keeps it cleaner)
      if (message.content.startsWith(config.identifier)) return;

      // Handle attachments: images go to ImgBB, other files get a name + shortened link
      const allAtts = [...message.attachments.values()];
      const imageAtts = allAtts.filter(isImageAttachment);
      const fileAtts = allAtts.filter(a => !isImageAttachment(a));

      const attachmentLines = [];

      for (const att of imageAtts) {
        const link = await uploadToImgBB(att.url);
        if (link) attachmentLines.push(link);
      }

      for (const att of fileAtts) {
        const size = att.size;
        const sizeStr = size < 1024 ? `${size}B`
          : size < 1048576 ? `${(size / 1024).toFixed(1)}KB`
          : `${(size / 1048576).toFixed(1)}MB`;
        const ext = (att.name?.split('.').pop() || 'file').toUpperCase();
        const short = await shortenUrl(att.url);
        attachmentLines.push(`[${ext}, ${sizeStr}] ${short}`);
      }

      const content = (message.content || "").trim();
      const hasText = content.length > 0;
      const hasAttachments = attachmentLines.length > 0;

      // Skip if nothing to forward
      if (!hasText && !hasAttachments) return;

      // Build message parts and send, tracking for reaction matching
      const trackOutgoing = (sentText, ts) => {
        const hash = generateMeshHash(sentText, ts);
        trackMessage(hash, {
          discordMessageId: message.id,
          discordChannelId: message.channel.id,
          meshText: sentText,
          senderTimestamp: ts,
          meshChannelIdx: meshIdx,
          outgoing: true,
        });
        if (config.DEBUG) console.debug(`[debug] Tracked outgoing hash=${hash} discordId=${message.id}`);
      };

      if (hasText) {
        await sendMeshChunked(meshIdx, `${name} [D]: ${content}`, trackOutgoing);
      }
      for (const line of attachmentLines) {
        await sendMeshChunked(meshIdx, `${name} [D]: ${line}`, trackOutgoing);
      }
      return;
    }

    // only handle messages starting with prefix
    if (!message.content.startsWith(config.identifier)) return;

    const args = message.content
      .slice(config.identifier.length)
      .trim()
      .split(/\s+/);

    const command = args.shift()?.toLowerCase();

    if (command === 'advert') {
      await handleAdvert((msg) => message.channel.send(msg));
    } else if (command === 'send') {
      // Flood protection gate for prefix send
      if (!(await floodAllowDiscordToMesh(message))) return;

      const text = args.join(" ");
      const name = message.member?.nickname || message.author.username;
      const meshIdx = getMeshChannelForDiscordChannel(message.channel.id);
      if (meshIdx === null) {
        await message.channel.send("This channel is not mapped to a mesh channel.");
        return;
      }

      await handleSend(text, name, (msg) => message.channel.send(msg), meshIdx, message.id, message.channel.id);
    }
  } catch (e) {
    console.error("Error handling messageCreate:", e);
  }
});

// ---- Reaction mirroring: Discord -> Mesh ----
// ---- Subscription role helper ----
function findSubscribeRoleForEmoji(emojiName) {
  const roleMap = config._SUBSCRIBE_ROLE_MAP || [];
  return roleMap.find(e => e.emoji === emojiName);
}

bot.on("messageReactionAdd", async (reaction, user) => {
  try {
    // Ignore bot reactions
    if (user.bot) return;

    // Fetch partial reaction/message if needed
    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    const message = reaction.message;
    if (!message.guild) return;

    // Subscription role handling
    if (config.SUBSCRIBE_MESSAGE_ID && message.id === config.SUBSCRIBE_MESSAGE_ID) {
      const entry = findSubscribeRoleForEmoji(reaction.emoji.name);
      if (entry) {
        try {
          const member = await message.guild.members.fetch(user.id);
          await member.roles.add(entry.roleId);
          if (config.DEBUG) console.debug(`[debug] Subscribed ${user.username} to ${entry.name}`);
        } catch (e) {
          console.error(`Failed to add subscribe role:`, e);
        }
      }
      return;
    }

    // Only mirror reactions in channels mapped to mesh
    const meshIdx = getMeshChannelForDiscordChannel(message.channel.id);
    if (meshIdx === null) return;

    if (isBridgePaused()) return;

    const emoji = reaction.emoji.name || "?";

    // Look up the original mesh message by Discord message ID
    const lookup = findHashByDiscordMessageId(message.id);
    if (lookup) {
      // Extract the target sender name
      // For incoming mesh messages, the target is the mesh sender (before ": ")
      // For outgoing Discord messages, the target is our bridge's mesh node name
      let targetName;
      if (lookup.entry.outgoing) {
        targetName = config.MESH_NODE_NAME || "Unknown";
      } else {
        const meshText = lookup.entry.meshText;
        const colonIdx = meshText.indexOf(": ");
        targetName = colonIdx > 0 ? meshText.slice(0, colonIdx).trim() : "Unknown";
      }

      const reactPayload = `${emoji}@[${targetName}]\n${lookup.hash}`;
      if (config.DEBUG) console.debug(`[debug] Sending react to mesh ch=${meshIdx}: ${JSON.stringify(reactPayload)}`);
      await enqueueMeshSend(() =>
        connection.sendChannelTextMessage(meshIdx, reactPayload)
      );
    } else {
      // Reacting to a Discord-native message — send without hash (best effort)
      let targetName = message.member?.nickname || message.author?.username || "Unknown";
      await enqueueMeshSend(() =>
        connection.sendChannelTextMessage(meshIdx, `${emoji}@[${targetName}]`)
      );
    }
  } catch (e) {
    console.error("Error handling reaction:", e);
  }
});

// ---- Subscription role removal on reaction remove ----
bot.on("messageReactionRemove", async (reaction, user) => {
  try {
    if (user.bot) return;

    if (reaction.partial) {
      try { await reaction.fetch(); } catch { return; }
    }
    if (reaction.message.partial) {
      try { await reaction.message.fetch(); } catch { return; }
    }

    if (!config.SUBSCRIBE_MESSAGE_ID || reaction.message.id !== config.SUBSCRIBE_MESSAGE_ID) return;

    const entry = findSubscribeRoleForEmoji(reaction.emoji.name);
    if (entry) {
      try {
        const member = await reaction.message.guild.members.fetch(user.id);
        await member.roles.remove(entry.roleId);
        if (config.DEBUG) console.debug(`[debug] Unsubscribed ${user.username} from ${entry.name}`);
      } catch (e) {
        console.error(`Failed to remove subscribe role:`, e);
      }
    }
  } catch (e) {
    console.error("Error handling reaction remove:", e);
  }
});

await connection.connect();
bot.login(config.DISCORD_TOKEN);
