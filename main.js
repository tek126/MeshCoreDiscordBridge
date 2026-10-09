import { NodeJSSerialConnection, Constants } from "@liamcottle/meshcore.js";
import {
  REST,
  Routes,
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  MessageFlags,
  Partials,
  PermissionFlagsBits
} from "discord.js";
import fs from "fs";
import log from "./lib/logger.js";
import { loadConfig, saveConfigAtomic, validateConfig } from "./lib/config.js";
import { escapeRegex, normalizeForMesh, sleep, splitByMaxLen, generateMeshHash, utf8Len, truncateUtf8 } from "./lib/utils.js";
import {
  isPocketMeshReact, parseMeshReaction, trackMessage, findHashByDiscordMessageId,
  getMessageHistory, isDuplicate, flushHistory, clearHistorySaveTimer, HISTORY_MAX_AGE_MS,
} from "./lib/reactions.js";
import { createWebServer } from "./lib/web/server.js";

process.on("unhandledRejection", (reason, promise) => {
  log.error("Unhandled promise rejection:", reason);
});

let config = loadConfig();
log.setDebug(!!config.DEBUG);
const connection = new NodeJSSerialConnection(config.SERIAL_PORT || "/dev/ttyUSB0");

// meshcore.js misparses TraceData pushes that use multi-byte path hashes and throws,
// which floods the error log with "Failed to process frame". The bridge doesn't use
// trace data, so drop malformed ones quietly.
const origOnTraceDataPush = connection.onTraceDataPush.bind(connection);
connection.onTraceDataPush = (bufferReader) => {
  try {
    origOnTraceDataPush(bufferReader);
  } catch (e) {
    log.debug(`Dropped malformed TraceData push: ${e.message}`);
  }
};

// Pace all outgoing mesh transmissions, whichever code path sends them. Packets sent
// back to back (e.g. a message followed by its attachment link) can reach a repeater
// while it is still busy with the previous one and get dropped.
// The library waits forever for the radio's Ok/Err reply, so a reply lost to a USB
// glitch or radio reset would stall every later send; give up after a timeout instead.
function getMeshMinSendGapMs() { return Math.max(0, Number(config.MESH_MIN_SEND_GAP_MS ?? 5000)); }
const MESH_SEND_TIMEOUT_MS = 20_000;
let meshPaceChain = Promise.resolve();
let lastMeshSendAt = 0;
// Epoch seconds the library stamped on the most recent channel/DM send. Read it right
// after awaiting the send; reaction hashes must use this exact second.
let lastMeshSendTs = 0;
for (const method of ["sendChannelTextMessage", "sendTextMessage", "sendFloodAdvert"]) {
  const original = connection[method].bind(connection);
  connection[method] = (...args) => {
    const run = meshPaceChain.then(async () => {
      const wait = lastMeshSendAt + getMeshMinSendGapMs() - Date.now();
      if (wait > 0) {
        log.debug(`Pacing mesh ${method}: waiting ${wait}ms`);
        await sleep(wait);
      }
      let timer;
      try {
        lastMeshSendTs = Math.floor(Date.now() / 1000); // same tick the library stamps the packet
        return await Promise.race([
          original(...args),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error(`mesh ${method} timed out`)), MESH_SEND_TIMEOUT_MS);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        lastMeshSendAt = Date.now();
      }
    });
    meshPaceChain = run.catch(() => {});
    return run;
  };
}

// Concurrent getContacts() calls share the library's Contact/EndOfContacts listeners,
// so a call that starts mid-dump gets only the tail of the list, and none of them time
// out. Share one in-flight dump between all callers.
const CONTACTS_TIMEOUT_MS = 30_000;
let contactsInFlight = null;
{
  const original = connection.getContacts.bind(connection);
  connection.getContacts = () => {
    if (!contactsInFlight) {
      let timer;
      contactsInFlight = Promise.race([
        original(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("getContacts timed out")), CONTACTS_TIMEOUT_MS);
        }),
      ]).finally(() => {
        clearTimeout(timer);
        contactsInFlight = null;
      });
    }
    return contactsInFlight;
  };
}

function withTimeout(promise, ms, what) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ---- Discord webhook cache for mesh->discord messages ----
// Caches the lookup promise, so concurrent messages for a new channel share one
// fetch/create instead of each creating a webhook.
const webhookCache = new Map(); // channelId -> Promise<Webhook|null>

function getOrCreateWebhook(channel) {
  const cached = webhookCache.get(channel.id);
  if (cached) return cached;

  const lookup = (async () => {
    try {
      // Look for an existing webhook created by us
      const hooks = await channel.fetchWebhooks();
      let hook = hooks.find(h => h.owner?.id === bot.user.id && h.name === "MeshCore Bridge");

      if (!hook) {
        hook = await channel.createWebhook({ name: "MeshCore Bridge", reason: "MeshCore bridge message forwarding" });
      }
      return hook;
    } catch (e) {
      log.error(`Failed to get/create webhook for channel ${channel.id}:`, e);
      webhookCache.delete(channel.id); // retry on the next message
      return null;
    }
  })();
  webhookCache.set(channel.id, lookup);
  return lookup;
}

// Discord rejects webhook usernames that contain "discord" or "clyde", are empty, or are
// exactly "everyone"/"here", which fails the whole post.
function sanitizeWebhookUsername(name) {
  let n = String(name || "").replace(/discord/gi, "Disc0rd").replace(/clyde/gi, "Clyd3").trim().slice(0, 80);
  if (!n || /^(everyone|here)$/i.test(n)) n = "Mesh";
  return n;
}

// Post a mesh message as its sender via webhook, falling back to a plain bot message
// if the webhook is unavailable or the send fails, so the message is never lost.
async function postMeshToDiscord(dest, senderName, body, { prefix = "", suffix = "" } = {}) {
  const webhook = await getOrCreateWebhook(dest);
  if (webhook) {
    try {
      const avatarURL = `https://api.dicebear.com/9.x/identicon/png?seed=${encodeURIComponent(senderName)}&size=128`;
      return await webhook.send({ content: `${prefix}${body}${suffix}`, username: sanitizeWebhookUsername(senderName), avatarURL });
    } catch (e) {
      if (e.code === 10015) webhookCache.delete(dest.id); // webhook was deleted; recreate next time
      log.error(`Webhook send failed for channel ${dest.id}, falling back to bot message:`, e);
    }
  }
  return dest.send(`${prefix}**${senderName}:** ${body}${suffix}`);
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
        log.debug(`Path discovery: got Sent acknowledgment`);
        return;
      }

      // Log any unusual response codes during discovery for debugging
      if (config.DEBUG && sentReceived && code !== PATH_DISCOVERY_RESPONSE && code !== 0x83) {
        log.debug(`Path discovery: saw frame code=0x${code.toString(16)} len=${frame.length}`);
      }

      if (code !== PATH_DISCOVERY_RESPONSE) return;
      log.debug(`Received path discovery response, frame length=${frame.length}`);

      // Response format: [0x8D, reserved:1, pubkey_prefix:6, out_path_len:1, ...]
      if (frame.length < 9) return;
      const responsePubKey = frame.subarray(2, 8);
      let match = true;
      for (let i = 0; i < 6; i++) {
        if (responsePubKey[i] !== pubKeyPrefix[i]) { match = false; break; }
      }
      if (!match) {
        log.debug(`Path discovery response pubkey mismatch, ignoring`);
        return;
      }

      clearTimeout(timer);
      connection.off("rx", onRx);

      const pathLenByte = frame[8];
      const hopCount = pathLenByte & 0x3F;
      log.debug(`Path discovered: ${hopCount} hops`);
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
      log.debug(`Path discovery timed out (sentReceived=${sentReceived})`);
      resolve(null);
    }, timeoutMs);
  });
}

// ---- Bridge prefix stripping ----
function getBridgePrefixRegexes() {
  const prefixes = config.BRIDGE_PREFIXES || [];
  return prefixes.map(p => new RegExp(`^${escapeRegex(p)}:\\s*`));
}

function stripBridgePrefixes(text) {
  let result = text;
  for (const re of getBridgePrefixRegexes()) {
    result = result.replace(re, "");
  }
  return result;
}

// Firmware caps text at 160 UTF-8 bytes. For channel messages that includes the
// "<node name>: " prefix it adds, so the usable budget depends on our node's name.
const MESH_TEXT_MAX_BYTES = 160;
let meshSelfName = config.MESH_NODE_NAME || "";
function getConfiguredMaxLen() { return Number(config.MESH_MAXLEN) || MESH_TEXT_MAX_BYTES; }
function getMeshMaxLen() {
  const budget = MESH_TEXT_MAX_BYTES - utf8Len(meshSelfName) - 2;
  return Math.max(20, Math.min(getConfiguredMaxLen(), budget));
}
function getMeshDmMaxLen() { return Math.min(getConfiguredMaxLen(), MESH_TEXT_MAX_BYTES); }
function getMeshChunkDelayMs() { return Number(config.MESH_CHUNK_DELAY_MS ?? 2500); }

function getAlwaysForwardChannelIds() {
  // New key: DISCORD_ALWAYS_FORWARD_CHANNEL_IDS (array or string)
  const v = config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS ?? config.DISCORD_ALWAYS_FORWARD_CHANNEL_ID;

  if (!v) return new Set();

  if (Array.isArray(v)) return new Set(v.map(x => String(x)));
  return new Set([String(v)]);
}


// ---- ImgBB image upload ----
function getImgbbApiKey() { return config.IMGBB_API_KEY || ""; }

const IMAGE_CONTENT_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp",
]);

function isImageAttachment(att) {
  if (att.contentType && IMAGE_CONTENT_TYPES.has(att.contentType)) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(att.name || "");
}

async function uploadToImgBB(imageUrl) {
  if (!getImgbbApiKey()) {
    log.error("getImgbbApiKey() not configured; cannot upload image.");
    return null;
  }

  try {
    const form = new URLSearchParams();
    form.set("image", imageUrl);

    const res = await fetch(`https://api.imgbb.com/1/upload?key=${getImgbbApiKey()}`, {
      method: "POST",
      body: form,
    });

    if (!res.ok) {
      log.error(`ImgBB upload failed: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    return data?.data?.url || null;
  } catch (e) {
    log.error("ImgBB upload error:", e);
    return null;
  }
}

const MAX_ATTACHMENT_LINKS = 2;

// ---- Self-hosted file upload (e.g. unym.pics), used for images and other files ----
// The service takes raw bytes with a Bearer token and returns {"url"}. Discord CDN links
// are signed and expire, so the bridge downloads the attachment and re-uploads it.
function getFileHostUrl() { return String(config.FILE_HOST_URL || "").replace(/\/+$/, ""); }
function getFileHostToken() { return config.FILE_HOST_TOKEN || ""; }
const FILE_HOST_MAX_BYTES = 100 * 1024 * 1024;
const FILE_HOST_TIMEOUT_MS = 5 * 60 * 1000;

async function uploadToFileHost(att) {
  if (!getFileHostUrl() || !getFileHostToken()) return null;
  if (att.size > FILE_HOST_MAX_BYTES) {
    log.warn(`Attachment ${att.name} is ${att.size} bytes, over the file host limit; not uploading.`);
    return null;
  }

  try {
    const signal = AbortSignal.timeout(FILE_HOST_TIMEOUT_MS);
    const src = await fetch(att.url, { signal });
    if (!src.ok || !src.body) {
      log.error(`Failed to download Discord attachment ${att.name}: ${src.status} ${src.statusText}`);
      return null;
    }

    const res = await fetch(`${getFileHostUrl()}/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${getFileHostToken()}`,
        "Content-Type": att.contentType || "application/octet-stream",
        "X-Filename": String(att.name || "file").replace(/[^\x20-\x7e]/g, "_"),
      },
      body: src.body,
      duplex: "half",
      signal,
    });

    if (!res.ok) {
      log.error(`File host upload failed for ${att.name}: ${res.status} ${await res.text().catch(() => "")}`);
      return null;
    }

    const data = await res.json();
    return data?.url || null;
  } catch (e) {
    log.error(`File host upload error for ${att.name}:`, e);
    return null;
  }
}

// ---- URL shortening via TinyURL (free, no API key) ----
async function shortenUrl(url) {
  try {
    const res = await fetch(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
      log.error(`TinyURL shortening failed: ${res.status} ${res.statusText}`);
      return url;
    }
    const short = (await res.text()).trim();
    return short || url;
  } catch (e) {
    log.error("TinyURL shortening error:", e);
    return url;
  }
}

async function resolveMentions(text, guild) {
  let result = text;

  // User mentions: <@123456> or <@!123456>
  const userMentions = result.match(/<@!?(\d+)>/g) || [];
  for (const mention of userMentions) {
    const id = mention.match(/\d+/)[0];
    try {
      const member = await guild.members.fetch(id);
      const displayName = member.nickname || member.user.username;
      result = result.replaceAll(mention, `@${displayName}`);
    } catch {
      result = result.replaceAll(mention, "@unknown");
    }
  }

  // Role mentions: <@&123456>
  const roleMentions = result.match(/<@&(\d+)>/g) || [];
  for (const mention of roleMentions) {
    const id = mention.match(/\d+/)[0];
    const role = guild.roles.cache.get(id);
    result = result.replaceAll(mention, role ? `@${role.name}` : "@unknown-role");
  }

  // Channel mentions: <#123456>
  const channelMentions = result.match(/<#(\d+)>/g) || [];
  for (const mention of channelMentions) {
    const id = mention.match(/\d+/)[0];
    const channel = guild.channels.cache.get(id);
    result = result.replaceAll(mention, channel ? `#${channel.name}` : "#unknown-channel");
  }

  return result;
}

// ---- Mesh send serialization queue ----
let meshSendChain = Promise.resolve();

// Serialized mesh send queue. Resolves to { ok, value } and never rejects, so callers
// can report failures without a throw escaping into message handlers. The queue is
// capped (pacing drains at most one send per gap, so a backlog only makes messages
// arrive minutes late), and pausing the bridge drops whatever is still queued.
const MESH_QUEUE_MAX = 20;
let meshQueueDepth = 0;
let meshQueueEpoch = 0;
function enqueueMeshSend(taskFn, { force = false } = {}) {
  if (!force && meshQueueDepth >= MESH_QUEUE_MAX) {
    log.warn(`Mesh send queue full (${meshQueueDepth}); dropping send`);
    return Promise.resolve({ ok: false, error: new Error("mesh send queue full") });
  }
  meshQueueDepth++;
  const epoch = meshQueueEpoch;
  const run = meshSendChain
    .then(() => {
      if (epoch !== meshQueueEpoch && !force) throw new Error("dropped: bridge was paused");
      return taskFn();
    })
    .then(
      (value) => ({ ok: true, value }),
      (error) => {
        if (epoch !== meshQueueEpoch && !force) log.info("Dropped queued mesh send (bridge paused)");
        else log.error("Mesh send task error:", error);
        return { ok: false, error };
      },
    )
    .finally(() => { meshQueueDepth--; });
  meshSendChain = run;
  return run;
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
    if (utf8Len(base) <= getMeshMaxLen()) {
      log.debug(`mesh send (single) ch=${channelIdx} bytes=${utf8Len(base)}: "${base}"`);
      await connection.sendChannelTextMessage(channelIdx, base);
      const ts = lastMeshSendTs; // the second the library stamped on this packet
      if (onSent) onSent(base, ts);
      return;
    }

    // Otherwise chunk and add "n/N" suffixes.
    const suffixReserve = 6; // safe for up to " 99/99"
    const maxPayload = Math.max(1, getMeshMaxLen() - suffixReserve);
    let chunks = splitByMaxLen(base, maxPayload);

    // Recompute reserve based on actual total (handles " 100/100" etc.)
    const total = chunks.length;
    const suffixLen = (` ${total}/${total}`).length;
    const maxPayload2 = Math.max(1, getMeshMaxLen() - suffixLen);
    if (maxPayload2 !== maxPayload) {
      chunks = splitByMaxLen(base, maxPayload2);
    }

    const total2 = chunks.length;

    log.debug(`mesh send (chunked) ch=${channelIdx} parts=${total2} maxBytes=${getMeshMaxLen()} delayMs=${getMeshChunkDelayMs()}`);

    let failed = 0;
    for (let idx = 0; idx < total2; idx++) {
      const partNum = idx + 1;
      const suffix = ` ${partNum}/${total2}`;
      // Final guard: ensure payload+suffix fits
      const payload = truncateUtf8(chunks[idx], getMeshMaxLen() - suffix.length);
      const out = payload + suffix;

      try {
        log.debug(`mesh chunk ${partNum}/${total2} ch=${channelIdx} bytes=${utf8Len(out)}: "${out}"`);
        await connection.sendChannelTextMessage(channelIdx, out);
      } catch (e) {
        failed++;
        log.error(`Mesh chunk send failed ${partNum}/${total2} ch=${channelIdx}:`, e);
      }

      if (idx !== total2 - 1) {
        await sleep(getMeshChunkDelayMs());
      }
    }
    if (failed) throw new Error(`${failed}/${total2} mesh chunks failed`);
  });
}

/**
 * Chunk + send a DM to a mesh contact with "n/N" suffix and delay between chunks.
 */
async function sendDMChunked(publicKey, fullText) {
  const base = normalizeForMesh(fullText);
  if (!base) return;

  return enqueueMeshSend(async () => {
    if (utf8Len(base) <= getMeshDmMaxLen()) {
      log.debug(`DM send (single) bytes=${utf8Len(base)}: "${base}"`);
      await connection.sendTextMessage(publicKey, base);
      return;
    }

    const suffixReserve = 6;
    const maxPayload = Math.max(1, getMeshDmMaxLen() - suffixReserve);
    let chunks = splitByMaxLen(base, maxPayload);

    const total = chunks.length;
    const suffixLen = (` ${total}/${total}`).length;
    const maxPayload2 = Math.max(1, getMeshDmMaxLen() - suffixLen);
    if (maxPayload2 !== maxPayload) {
      chunks = splitByMaxLen(base, maxPayload2);
    }

    const total2 = chunks.length;
    log.debug(`DM send (chunked) parts=${total2}`);

    let failed = 0;
    for (let idx = 0; idx < total2; idx++) {
      const partNum = idx + 1;
      const suffix = ` ${partNum}/${total2}`;
      const payload = truncateUtf8(chunks[idx], getMeshDmMaxLen() - suffix.length);

      try {
        await connection.sendTextMessage(publicKey, payload + suffix);
      } catch (e) {
        failed++;
        log.error(`DM chunk send failed ${partNum}/${total2}:`, e);
      }

      if (idx !== total2 - 1) await sleep(getMeshChunkDelayMs());
    }
    if (failed) throw new Error(`${failed}/${total2} DM chunks failed`);
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

// Pause is saved to disk so a crash or reboot during an incident doesn't quietly
// resume forwarding.
const BRIDGE_STATE_FILE = "./bridge_state.json";
try {
  Object.assign(bridgeState, JSON.parse(fs.readFileSync(BRIDGE_STATE_FILE, "utf8")));
  if (bridgeState.paused) log.warn(`Bridge is PAUSED (by ${bridgeState.pausedBy ?? "unknown"} at ${bridgeState.pausedAt}); use /bridge resume`);
} catch {
  // No saved state
}

const metrics = {
  startedAt: Date.now(),
  meshToDiscord: 0,
  discordToMesh: 0,
  reactionsApplied: 0,
  errors: 0,
  lastMeshMessage: null,
  lastDiscordForward: null,
};

function isBridgePaused() {
  return bridgeState.paused === true;
}

function setBridgePaused(paused, actorTag = null) {
  if (paused && !bridgeState.paused) meshQueueEpoch++; // drop sends already queued
  bridgeState.paused = !!paused;
  bridgeState.pausedBy = paused ? actorTag : null;
  bridgeState.pausedAt = paused ? new Date().toISOString() : null;
  try {
    fs.writeFileSync(BRIDGE_STATE_FILE, JSON.stringify(bridgeState));
  } catch (e) {
    log.error("Failed to save bridge pause state:", e);
  }
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
function getFloodConfig() {
  const f = config.FLOOD_PROTECT || {};
  return {
    windowMs: Math.max(1, Number(f.WINDOW_SECONDS ?? 15)) * 1000,
    max: Math.max(1, Number(f.MAX_MESSAGES_PER_WINDOW ?? 6)),
    cooldownMs: Math.max(1, Number(f.COOLDOWN_SECONDS ?? 60)) * 1000,
    warn: f.WARN_IN_CHANNEL !== false,
  };
}

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
async function floodAllowDiscordToMesh(messageLike, cost = 1) {
  const channelId = String(messageLike?.channel?.id ?? "");
  if (!channelId) return true;

  const now = Date.now();
  const rec = _getFloodRecord(channelId);

  // In cooldown?
  if (rec.cooldownUntil > now) {
    log.debug(`Flood protect: dropping discord->mesh from ${channelId} (cooldown ${Math.ceil((rec.cooldownUntil - now) / 1000)}s)`);
    return false;
  }

  const flood = getFloodConfig();

  // Sliding window prune
  const cutoff = now - flood.windowMs;
  rec.times = rec.times.filter(t => t >= cutoff);

  // Record this message, one entry per mesh packet it will produce
  for (let i = 0; i < Math.max(1, cost); i++) rec.times.push(now);

  // If exceeded, start cooldown
  if (rec.times.length > flood.max) {
    rec.cooldownUntil = now + flood.cooldownMs;
    rec.times = []; // reset window for after cooldown

    log.debug(`Flood protect: ENTER cooldown for ${channelId} (${flood.cooldownMs / 1000}s)`);

    // Optional: warn once per cooldown period
    if (flood.warn && rec.warnedUntil <= now) {
      rec.warnedUntil = rec.cooldownUntil;
      try {
        if (messageLike?.channel?.send) {
          await messageLike.channel.send(
            `⚠️ Bridge flood protection: pausing forwarding to Meshcore for ${Math.ceil(flood.cooldownMs / 1000)}s (too many messages).`
          );
        }
      } catch (e) {
        log.error("Flood protect: failed to post warning in channel:", e);
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

function getEmergencyCooldownMs() { return Math.max(1, Number(config.EMERGENCY_COOLDOWN_MINUTES ?? 30)) * 60 * 1000; }
function getEmergencyReminderMs() { return Math.max(1, Number(config.EMERGENCY_REMINDER_MINUTES ?? 5)) * 60 * 1000; }

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
        await dest.send({ content: "🚨 No response yet - emergency message still awaiting reply @everyone", allowedMentions: { parse: ["everyone"] } });
      }
    } catch (e) {
      log.error("Emergency reminder error:", e);
    }
  }, getEmergencyReminderMs());
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
    saveConfigAtomic(config);
  } catch (e) {
    log.error("Failed to save config:", e);
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
          log.error("Block expiry mesh notify error:", e);
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
            log.error("Block expiry Discord notify error:", e);
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

/** =========================
 * Welcome DM for new mesh users
 * ========================= */
const WELCOME_FILE = './welcomed_users.json';
let welcomedUsers = new Set();
const channelWelcomedUsers = new Set(); // tracks who got the channel welcome (in-memory only)

try {
  const data = JSON.parse(fs.readFileSync(WELCOME_FILE, 'utf8'));
  welcomedUsers = new Set(data);
  log.info(`Loaded ${welcomedUsers.size} welcomed users.`);
} catch {
  // No file yet
}

function saveWelcomedUsers() {
  try {
    fs.writeFileSync(WELCOME_FILE, JSON.stringify([...welcomedUsers]));
  } catch (e) {
    log.error("Failed to save welcomed users:", e);
  }
}

async function sendWelcomeDM(name, publicKey) {
  if (config.WELCOME_ENABLED === false) return;
  if (welcomedUsers.has(name.toLowerCase())) return;
  welcomedUsers.add(name.toLowerCase());
  saveWelcomedUsers();

  try {
    await sendDMChunked(publicKey, config.WELCOME_DM_MESSAGE || "Welcome! Send an advert for more info.");
    log.debug(`Sent welcome DM to "${name}"`);
  } catch (e) {
    log.error(`Failed to send welcome DM to "${name}":`, e);
  }
}

/** =========================
 * Scheduled messages
 * ========================= */
const activeScheduleTimers = new Map(); // id -> timer

function getSchedules() {
  return config.SCHEDULED_MESSAGES || [];
}

const SCHEDULE_MIN_INTERVAL_MS = 15 * 60 * 1000;
const SCHEDULE_MAX_INTERVAL_MS = 576 * 60 * 60 * 1000; // 24 days

function parseCronSchedule(cronStr) {
  // Supports: "daily HH:MM", "weekly DAY HH:MM", "every Nh" / "every Nm"
  const s = cronStr.trim().toLowerCase();

  const validTime = (h, m) => h <= 23 && m <= 59;

  const dailyMatch = s.match(/^daily\s+(\d{1,2}):(\d{2})$/);
  if (dailyMatch) {
    const hour = parseInt(dailyMatch[1]), minute = parseInt(dailyMatch[2]);
    return validTime(hour, minute) ? { type: "daily", hour, minute } : null;
  }

  const weeklyMatch = s.match(/^weekly\s+(mon|tue|wed|thu|fri|sat|sun)\s+(\d{1,2}):(\d{2})$/);
  if (weeklyMatch) {
    const days = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
    const hour = parseInt(weeklyMatch[2]), minute = parseInt(weeklyMatch[3]);
    return validTime(hour, minute) ? { type: "weekly", day: days[weeklyMatch[1]], hour, minute } : null;
  }

  const everyMatch = s.match(/^every\s+(\d+)\s*(h|m)$/);
  if (everyMatch) {
    const val = parseInt(everyMatch[1]);
    const ms = everyMatch[2] === "h" ? val * 3600000 : val * 60000;
    // A 0 interval would re-fire immediately forever, and setTimeout silently turns
    // anything over ~24.8 days into 1ms.
    if (ms < SCHEDULE_MIN_INTERVAL_MS || ms > SCHEDULE_MAX_INTERVAL_MS) return null;
    return { type: "interval", intervalMs: ms };
  }

  return null;
}

function msUntilNext(schedule) {
  const now = new Date();

  if (schedule.type === "daily") {
    const target = new Date(now);
    target.setHours(schedule.hour, schedule.minute, 0, 0);
    if (target <= now) target.setDate(target.getDate() + 1);
    return target - now;
  }

  if (schedule.type === "weekly") {
    const target = new Date(now);
    target.setHours(schedule.hour, schedule.minute, 0, 0);
    const currentDay = target.getDay();
    let daysUntil = schedule.day - currentDay;
    if (daysUntil < 0 || (daysUntil === 0 && target <= now)) daysUntil += 7;
    target.setDate(target.getDate() + daysUntil);
    return target - now;
  }

  if (schedule.type === "interval") {
    return schedule.intervalMs;
  }

  return null;
}

async function executeSchedule(entry) {
  try {
    const target = entry.target || "";

    // Send to mesh channel (and auto-send to mapped Discord channel)
    if (target.startsWith("mesh:") || /^\d+$/.test(target)) {
      const meshIdx = parseInt(target.replace("mesh:", ""));
      if (Number.isFinite(meshIdx)) {
        await sendMeshChunked(meshIdx, entry.message);
        // Auto-send to mapped Discord channel
        const discordId = config.DISCORD_ROUTES?.[String(meshIdx)];
        if (discordId) {
          try {
            const dest = await bot.channels.fetch(discordId);
            if (dest?.isTextBased()) await dest.send(entry.message);
          } catch (e) {
            log.error(`Schedule Discord auto-send error for ch ${meshIdx}:`, e);
          }
        }
      }
    }
    // Send to Discord channel only
    else if (target.startsWith("discord:")) {
      const channelId = target.replace("discord:", "");
      const dest = await bot.channels.fetch(channelId);
      if (dest?.isTextBased()) {
        await dest.send(entry.message);
      }
    }
    // Send to both mesh and Discord (explicit)
    else if (target.startsWith("both:")) {
      const parts = target.replace("both:", "").split(",");
      const meshIdx = parseInt(parts[0]);
      const discordId = parts[1];
      if (Number.isFinite(meshIdx)) {
        await sendMeshChunked(meshIdx, entry.message);
      }
      if (discordId) {
        const dest = await bot.channels.fetch(discordId);
        if (dest?.isTextBased()) {
          await dest.send(entry.message);
        }
      }
    }

    log.debug(`Executed schedule "${entry.id}": "${entry.message.slice(0, 50)}"`);
  } catch (e) {
    log.error(`Schedule execution error for "${entry.id}":`, e);
  }
}

function startSchedule(entry) {
  const parsed = parseCronSchedule(entry.cron);
  if (!parsed) {
    log.error(`Invalid schedule "${entry.id}": "${entry.cron}"`);
    return;
  }

  // clearTimeout can't stop a run that has already started, so a run in progress during
  // /schedule remove or a reload re-arms only if its timer is still the current one.
  function scheduleNext() {
    const delay = msUntilNext(parsed);
    if (delay === null) return;

    const timer = setTimeout(async () => {
      await executeSchedule(entry);
      if (activeScheduleTimers.get(entry.id) === timer) scheduleNext();
    }, delay);

    activeScheduleTimers.set(entry.id, timer);
  }

  scheduleNext();
  log.debug(`Started schedule "${entry.id}": ${entry.cron}`);
}

function stopAllSchedules() {
  for (const timer of activeScheduleTimers.values()) {
    clearTimeout(timer);
  }
  activeScheduleTimers.clear();
}

function startAllSchedules() {
  stopAllSchedules();
  for (const entry of getSchedules()) {
    startSchedule(entry);
  }
  log.info(`Started ${getSchedules().length} scheduled messages.`);
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
    .setName("prune")
    .setDescription("Remove stale contacts from the radio to free slots (admin only)"),

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
    .setName("schedule")
    .setDescription("Manage scheduled messages")
    .addSubcommand(sc =>
      sc.setName("add").setDescription("Add a scheduled message (admin)")
        .addStringOption(opt => opt.setName("target").setDescription("Target: mesh channel # (e.g. 0), discord:channelId, or both:meshIdx,discordId").setRequired(true))
        .addStringOption(opt => opt.setName("cron").setDescription("Schedule: 'daily HH:MM', 'weekly mon HH:MM', 'every Nh'").setRequired(true))
        .addStringOption(opt => opt.setName("message").setDescription("Message to send").setRequired(true))
    )
    .addSubcommand(sc =>
      sc.setName("list").setDescription("List scheduled messages")
    )
    .addSubcommand(sc =>
      sc.setName("remove").setDescription("Remove a scheduled message (admin)")
        .addStringOption(opt => opt.setName("id").setDescription("Schedule ID to remove").setRequired(true))
    ),

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
  try {
    await rest.put(
      Routes.applicationGuildCommands(config.CLIENT_ID, guildId),
      { body: commands }
    );
    log.info(`Registered commands for guild ${guildId}`);
  } catch (e) {
    log.error(`Failed to register commands for guild ${guildId}:`, e.message);
    process.exit(1);
  }
}

const bot = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.Channel, Partials.User, Partials.GuildMember],
  // Text from the mesh and from Discord users is relayed verbatim; never let it ping
  // @everyone, roles or users. The emergency alerts opt in to @everyone explicitly.
  allowedMentions: { parse: [], repliedUser: true },
});

// ---- Serial connection with auto-reconnect and health check ----
const RECONNECT_DELAY_MS = 5000;
const HEALTH_CHECK_INTERVAL_MS = 60_000; // check every 60s
const HEALTH_CHECK_TIMEOUT_MS = 15_000;  // 15s timeout per check
let meshConnected = false;
let healthCheckTimer = null;
let healthCheckFailures = 0;
const HEALTH_CHECK_MAX_FAILURES = 3;

function startHealthCheck() {
  if (healthCheckTimer) return;
  healthCheckTimer = setInterval(async () => {
    if (!meshConnected) return;
    try {
      // A cheap round trip; a full contact dump every minute saturated the serial link
      await withTimeout(connection.getBatteryVoltage(), HEALTH_CHECK_TIMEOUT_MS, "battery query");
      healthCheckFailures = 0;
    } catch (e) {
      healthCheckFailures++;
      log.warn(`Health check failed (${healthCheckFailures}/${HEALTH_CHECK_MAX_FAILURES}): ${e.message}`);
      if (healthCheckFailures >= HEALTH_CHECK_MAX_FAILURES) {
        log.error("Mesh device unresponsive — forcing reconnect");
        meshConnected = false;
        healthCheckFailures = 0;
        // Notify Discord
        const alertChannelId = config.NODE_ANNOUNCE_CHANNEL_ID || config.DISCORD_CHANNEL_ID;
        if (alertChannelId) {
          try {
            const dest = await bot.channels.fetch(alertChannelId);
            if (dest?.isTextBased()) {
              await dest.send("Mesh device unresponsive — attempting reconnect.");
            }
          } catch {}
        }
        scheduleReconnect();
      }
    }
  }, HEALTH_CHECK_INTERVAL_MS);
}

function stopHealthCheck() {
  if (healthCheckTimer) { clearInterval(healthCheckTimer); healthCheckTimer = null; }
  healthCheckFailures = 0;
}

log.info("Connecting to meshcore device...");
connection.on("connected", async () => {
  log.info("Connected to meshcore!");
  meshConnected = true;

  // The channel-text byte budget depends on our node name (firmware prepends it)
  try {
    const self = await connection.getSelfInfo(5000);
    if (self?.name) meshSelfName = self.name;
    log.info(`Mesh node name "${meshSelfName}": channel text budget ${getMeshMaxLen()} bytes`);
  } catch (e) {
    log.warn(`Could not read node name from radio; using MESH_NODE_NAME: ${e?.message ?? e}`);
  }

  // Seed known nodes so we don't announce existing contacts on restart
  try {
    const contacts = await connection.getContacts();
    for (const c of contacts) {
      if (c.advName) knownNodes.add(c.advName);
    }
    saveContactsBackup(contacts);
    log.info(`Loaded ${knownNodes.size} known nodes, backed up ${contacts.length} contacts.`);
  } catch (e) {
    log.error("Failed to load initial contacts:", e);
  }

  startContactPruning();
  startHealthCheck();

  // The radio only pushes MsgWaiting when a new message arrives, so fetch anything
  // that queued up while we were disconnected.
  drainMeshMessages();
});

connection.on("disconnected", async () => {
  log.error("Meshcore device disconnected!");
  meshConnected = false;
  stopHealthCheck();
  scheduleReconnect();
});

connection.on("error", (e) => {
  log.error("Meshcore connection error:", e);
  meshConnected = false;
  stopHealthCheck();
  scheduleReconnect();
});

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  log.info(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s...`);
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    try {
      await connectMesh();
    } catch (e) {
      log.error("Reconnect failed:", e);
      scheduleReconnect();
    }
  }, RECONNECT_DELAY_MS);
}

// connect() replaces connection.serialPort without closing the old one, and it never
// reports a failed open (serialport only logs it). So detach and close any old port
// first, then retry if "connected" hasn't fired within CONNECT_VERIFY_MS.
const CONNECT_VERIFY_MS = 10_000;
let connectVerifyTimer = null;
async function connectMesh() {
  const old = connection.serialPort;
  if (old) {
    old.removeAllListeners();
    old.on("error", () => {});
    if (old.isOpen) old.close(() => {});
  }
  connection.readBuffer = []; // drop any partial frame from the old port

  clearTimeout(connectVerifyTimer);
  connectVerifyTimer = setTimeout(() => {
    if (!meshConnected) {
      log.error(`Mesh device on ${config.SERIAL_PORT || "/dev/ttyUSB0"} did not connect`);
      scheduleReconnect();
    }
  }, CONNECT_VERIFY_MS);

  await connection.connect();
}

// ---- Node join announcements (persisted to disk) ----
const KNOWN_NODES_FILE = './known_nodes.json';
let knownNodes = new Set();

try {
  const data = JSON.parse(fs.readFileSync(KNOWN_NODES_FILE, 'utf8'));
  knownNodes = new Set(data);
  log.info(`Loaded ${knownNodes.size} known nodes from disk.`);
} catch {
  // No file yet
}

function saveKnownNodes() {
  try {
    fs.writeFileSync(KNOWN_NODES_FILE, JSON.stringify([...knownNodes]));
  } catch (e) {
    log.error("Failed to save known nodes:", e);
  }
}

async function handleNewAdvert(contact) {
  // Grab the advert's RX frame before any await lets newer frames arrive
  const advertFrame = latestRxFrameOfType(PAYLOAD_TYPE_ADVERT);
  try {
    let name = contact?.advName;
    let type = contact?.type;

    // Advert push (0x80) only has publicKey — look up the contact for name/type/path
    let pathLen = contact?.outPathLen;
    if (!name && contact?.publicKey) {
      try {
        // Check the cached contact list first; only new nodes need a fresh dump
        const keyHex = Buffer.from(contact.publicKey).toString("hex");
        const found = contactsCache.find(c => c.publicKey && Buffer.from(c.publicKey).toString("hex") === keyHex)
          || await connection.findContactByPublicKeyPrefix(contact.publicKey.subarray(0, 6));
        if (found) {
          name = found.advName;
          type = found.type;
          pathLen = found.outPathLen;
        }
      } catch {}
    }

    log.debug(`Advert received: name="${name}" type=${type} pathLen=${pathLen} hasKey=${!!contact?.publicKey}`);
    if (!name) return;

    // Directly add to contacts backup so path resolution works even if the
    // device's contact slots are full and it didn't store this node
    if (contact.publicKey && name) {
      const pubKeyHex = Buffer.from(contact.publicKey).toString("hex");
      const existing = contactsBackup.get(pubKeyHex);
      if (!existing || existing.name !== name) {
        contactsBackup.set(pubKeyHex, { name, type: type ?? 0, pubKeyHex });
        try {
          fs.writeFileSync(CONTACTS_BACKUP_FILE, JSON.stringify([...contactsBackup.values()]));
        } catch (e) {
          log.error("Failed to save contacts backup from advert:", e);
        }
      }
    }

    // Welcome DM for new Chat nodes — skip if path has too many unknown repeaters
    if (type === 1 && contact.publicKey) {
      // Hops from the advert as received; the contact's stored out-path is usually
      // unknown for a brand-new node, which made this check never run.
      const hops = advertFrame?.hopCount ?? 0;
      const maxUnknownRepeaters = Number(config.WELCOME_MAX_UNKNOWN_REPEATERS ?? 1);

      if (hops > 0 && hasUnknownPath(maxUnknownRepeaters, advertFrame)) {
        log.debug(`Skipping welcome DM for "${name}" — path has too many unknown repeaters (max ${maxUnknownRepeaters})`);
      } else {
        sendWelcomeDM(name, contact.publicKey);
      }
    }

    // (No forced contact refresh here: the backup was updated above, and the cache
    // refreshes on its own TTL. Two full dumps per advert saturated the serial link.)

    if (knownNodes.has(name)) return;
    knownNodes.add(name);
    saveKnownNodes();

    const typeLabels = { 0: "Unknown", 1: "Chat", 2: "Repeater", 3: "Room" };
    const typeLabel = typeLabels[type] ?? "Unknown";
    const announceChannelId = config.NODE_ANNOUNCE_CHANNEL_ID || config.DISCORD_CHANNEL_ID;
    if (!announceChannelId) return;

    const dest = await bot.channels.fetch(announceChannelId);
    if (dest?.isTextBased()) {
      await dest.send(`New mesh node discovered: **${name}** (${typeLabel})`);
    }
  } catch (e) {
    log.error("Node announce error:", e);
  }
}

/**
 * Resolve a prefix to all matching contacts from cache + backup.
 * Returns array of { name, type, hops } for each match.
 */
function resolveAllMatches(prefixHex) {
  const prefixLen = prefixHex.length;
  const matches = [];
  const seen = new Set();

  for (const c of contactsCache) {
    if (!c.publicKey) continue;
    const cHex = Buffer.from(c.publicKey).toString("hex").slice(0, prefixLen).toUpperCase();
    if (cHex === prefixHex) {
      const key = Buffer.from(c.publicKey).toString("hex");
      if (!seen.has(key)) {
        seen.add(key);
        const hops = (c.outPathLen != null && c.outPathLen >= 0 && c.outPathLen !== 0xFF) ? (c.outPathLen & 0x3F) : null;
        matches.push({ name: c.advName, type: c.type, hops });
      }
    }
  }

  for (const entry of contactsBackup.values()) {
    const bHex = entry.pubKeyHex.slice(0, prefixLen).toUpperCase();
    if (bHex === prefixHex && !seen.has(entry.pubKeyHex)) {
      seen.add(entry.pubKeyHex);
      matches.push({ name: entry.name, type: entry.type, hops: null });
    }
  }

  return matches;
}

/**
 * Check an RX frame (the one that carried the message or advert) for path plausibility.
 * Returns true (= skip welcome) if the path doesn't look local:
 *  - Too many prefixes with no known match at all
 *  - Intermediate hops that only match non-repeater nodes (type != 2)
 *  - Hop distances that aren't in increasing order (closer repeaters should come first)
 */
function hasUnknownPath(maxUnknown, frame) {
  if (!frame?.prefixes || frame.prefixes.length === 0) return false;

  let unknownCount = 0;
  let badHopOrder = 0;
  let nonRepeaterHops = 0;
  let prevMinHops = -1;

  const debugParts = [];

  for (const prefix of frame.prefixes) {
    const prefixHex = Buffer.from(prefix).toString("hex").toUpperCase();
    const matches = resolveAllMatches(prefixHex);

    if (matches.length === 0) {
      unknownCount++;
      prevMinHops = -1;
      if (config.DEBUG) debugParts.push(`[${prefixHex}] unknown`);
      continue;
    }

    // Check if any match is a repeater
    const repeaterMatches = matches.filter(m => m.type === 2);
    if (repeaterMatches.length === 0) {
      nonRepeaterHops++;
      if (config.DEBUG) debugParts.push(`[${prefixHex}] no repeater match (${matches.map(m => m.name).join(",")})`);
    } else if (config.DEBUG) {
      debugParts.push(`[${prefixHex}] ${repeaterMatches.map(m => `${m.name}(${m.hops ?? "?"}h)`).join(",")}`);
    }

    // Check hop ordering — repeaters closer to us should appear first in the path
    if (repeaterMatches.length > 0) {
      const knownHops = repeaterMatches.filter(m => m.hops != null).map(m => m.hops);
      if (knownHops.length > 0) {
        const minHops = Math.min(...knownHops);
        if (prevMinHops >= 0 && minHops < prevMinHops) {
          badHopOrder++;
        }
        prevMinHops = minHops;
      }
    }
  }

  const totalSuspicious = unknownCount + nonRepeaterHops + badHopOrder;

  log.debug(`Path check: unknown=${unknownCount} nonRepeater=${nonRepeaterHops} badOrder=${badHopOrder} total=${totalSuspicious}/${frame.prefixes.length} hashMode=${frame.hashMode} | ${debugParts.join(" → ")}`);

  return totalSuspicious > maxUnknown;
}

connection.on(Constants.PushCodes.Advert, handleNewAdvert);
connection.on(Constants.PushCodes.NewAdvert, handleNewAdvert);

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
  log.info(`Loaded ${contactsBackup.size} contacts from backup.`);
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
    log.error("Failed to save contacts backup:", e);
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
      log.error("Failed to refresh contacts cache:", e);
    }
  }
  return contactsCache;
}

// ---- Contact pruning: remove stale contacts from the radio to free slots ----
function getPruneIntervalMs() { return Number(config.CONTACT_PRUNE_INTERVAL_MINUTES ?? 60) * 60 * 1000; }
function getPruneStaleAgeMs() { return Number(config.CONTACT_PRUNE_STALE_HOURS ?? 48) * 60 * 60 * 1000; }
function getPruneMaxContacts() { return Number(config.CONTACT_PRUNE_THRESHOLD ?? 200); }

let pruneTimer = null;

// Contacts eligible for pruning: not Chat nodes, and not heard for the stale period.
// Age is by lastMod (when our radio last heard the node, on the radio's clock);
// lastAdvert is the node's own clock, often unset or wrong on repeaters.
async function getStaleContacts(contacts) {
  let now;
  try {
    now = (await withTimeout(connection.getDeviceTime(), 10_000, "device time")).epochSecs;
  } catch {}
  if (!now) now = Math.max(0, ...contacts.map(c => c.lastMod || 0));
  const staleAgeSec = Math.floor(getPruneStaleAgeMs() / 1000);
  return contacts.filter(c => c.publicKey && c.type !== 1 && c.lastMod && (now - c.lastMod) >= staleAgeSec);
}

// Remove contacts from the radio; returns how many removals actually succeeded.
async function removeContacts(list) {
  let removed = 0;
  for (const c of list) {
    try {
      // A local radio command, not a transmission: no pacing or send queue
      await withTimeout(connection.removeContact(c.publicKey), 10_000, "removeContact");
      removed++;
      log.debug(`Pruned stale contact: "${c.advName}" type=${c.type}`);
    } catch (e) {
      log.error(`Failed to prune contact "${c.advName}":`, e?.message ?? e);
    }
  }
  return removed;
}

async function pruneStaleContacts() {
  if (!meshConnected) return;
  try {
    const contacts = await connection.getContacts();
    if (contacts.length <= getPruneMaxContacts()) {
      log.debug(`Contact prune: ${contacts.length} contacts, below threshold ${getPruneMaxContacts()} — skipping`);
      return;
    }

    // Save all contacts to backup before pruning
    saveContactsBackup(contacts);

    const stale = await getStaleContacts(contacts);
    const pruned = await removeContacts(stale);

    if (pruned > 0) {
      log.info(`Contact prune: removed ${pruned} stale contacts (were ${contacts.length}, now ~${contacts.length - pruned})`);
      // Force cache refresh after pruning
      contactsCacheTime = 0;
    }
  } catch (e) {
    log.error("Contact prune error:", e);
  }
}

function startContactPruning() {
  if (pruneTimer) return;
  // Run first prune shortly after startup, then on interval
  setTimeout(() => pruneStaleContacts(), 30_000);
  pruneTimer = setInterval(pruneStaleContacts, getPruneIntervalMs());
  log.info(`Contact pruning enabled: threshold=${getPruneMaxContacts()}, stale=${getPruneStaleAgeMs() / 3600000}h, interval=${getPruneIntervalMs() / 60000}min`);
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

    // Header: bits 0-1 route type, bits 2-5 payload type. Transport-flood (0) and
    // transport-direct (3) routes carry 4 bytes of transport codes before the path.
    const routeType = raw[0] & 0x03;
    const payloadType = (raw[0] >> 2) & 0x0F;
    const pathOffset = (routeType === 0 || routeType === 3) ? 5 : 1;
    if (raw.length <= pathOffset) return;

    const pathByte = raw[pathOffset];
    const hopCount = pathByte & 0x3F;
    const hashMode = (pathByte >> 6) & 0x03;
    if (hashMode === 3) return; // reserved
    // Hash mode: 0 = 1-byte prefixes, 1 = 2-byte, 2 = 3-byte
    const prefixSize = hashMode + 1;

    // Extract prefixes based on hash mode
    const prefixes = [];
    const pathStart = pathOffset + 1;
    for (let i = 0; i < hopCount && (pathStart + (i + 1) * prefixSize) <= raw.length; i++) {
      const offset = pathStart + i * prefixSize;
      prefixes.push(raw.slice(offset, offset + prefixSize));
    }

    const frame = {
      timestamp: Date.now(),
      payloadType,
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

    const prefixHexes = prefixes.map(p => Buffer.from(p).toString("hex").toUpperCase());
    log.debug(`RX frame: type=${payloadType} pathByte=0x${pathByte.toString(16)} hashMode=${hashMode} ${hopCount} hops, prefixes=[${prefixHexes.join(", ")}], snr=${data.lastSnr}, rssi=${data.lastRssi}`);
  } catch (e) {
    log.error("RX frame parse error:", e);
  }
});

const PAYLOAD_TYPE_ADVERT = 0x04;
const PAYLOAD_TYPE_GRP_TXT = 0x05;

function findMatchingRxFrame(channelMessage, { consume = true } = {}) {
  const pathByte = channelMessage.pathLen;
  const msgHopCount = pathByte & 0x3F;
  const msgHashMode = (pathByte >> 6) & 0x03;

  // Find the most recent channel-text frame matching hop count and hash mode
  for (let i = rxFrameBuffer.length - 1; i >= 0; i--) {
    const frame = rxFrameBuffer[i];
    if (frame.payloadType === PAYLOAD_TYPE_GRP_TXT && frame.hopCount === msgHopCount && frame.hashMode === msgHashMode) {
      if (consume) rxFrameBuffer.splice(i, 1); // so it's not matched again
      return frame;
    }
  }
  return null;
}

function latestRxFrameOfType(payloadType) {
  for (let i = rxFrameBuffer.length - 1; i >= 0; i--) {
    if (rxFrameBuffer[i].payloadType === payloadType) return rxFrameBuffer[i];
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

// ---- Mesh DM forwarding ----
// Track forwarded DM message IDs -> mesh sender name for replies
const dmSenderMap = new Map(); // discordMessageId -> { name, publicKey }

async function onMeshContactMessageReceived(contactMessage) {
  const dmForwardUserId = config.DM_FORWARD_DISCORD_USER_ID;
  if (!dmForwardUserId) return;

  const text = contactMessage?.text ?? "";
  if (!text) return;

  // Resolve sender name (and full key, for replies) from pubKeyPrefix
  let senderName = "Unknown";
  let senderKey = null;
  try {
    const contacts = await getContactsCached();
    const prefixHex = Buffer.from(contactMessage.pubKeyPrefix).toString("hex");
    for (const c of contacts) {
      if (!c.publicKey) continue;
      const contactHex = Buffer.from(c.publicKey).toString("hex").slice(0, prefixHex.length);
      if (contactHex === prefixHex) {
        senderName = c.advName || senderName;
        senderKey = c.publicKey;
        break;
      }
    }
  } catch {}

  try {
    const user = await bot.users.fetch(dmForwardUserId);
    const sentMsg = await user.send(`**Mesh DM from ${senderName}:** ${text}\n-# Reply to this message to respond.`);
    dmSenderMap.set(sentMsg.id, { name: senderName, publicKey: senderKey });
    // Keep map from growing unbounded
    if (dmSenderMap.size > 100) {
      const oldest = dmSenderMap.keys().next().value;
      dmSenderMap.delete(oldest);
    }
    log.debug(`Forwarded mesh DM from "${senderName}" to Discord user ${dmForwardUserId}`);
  } catch (e) {
    log.error("Failed to forward mesh DM to Discord:", e);
  }
}

// The radio pushes MsgWaiting for every queued message. Overlapping syncs share the
// library's listeners and would each receive (and handle) the same messages, so run one
// sync at a time and loop again if more arrived meanwhile.
let meshSyncRunning = false;
let meshSyncPending = false;
async function drainMeshMessages() {
  if (meshSyncRunning) {
    meshSyncPending = true;
    return;
  }
  meshSyncRunning = true;
  try {
    do {
      meshSyncPending = false;
      const waitingMessages = await withTimeout(connection.getWaitingMessages(), 60_000, "message sync");
      if (waitingMessages.length) log.info(`You have ${waitingMessages.length} waiting messages.`);
      for (const msg of waitingMessages) {
        log.info("Received message:", msg);
        try {
          if (msg.channelMessage) await onMeshChannelMessageReceived(msg.channelMessage);
          if (msg.contactMessage) await onMeshContactMessageReceived(msg.contactMessage);
        } catch (e) {
          log.error("Error handling mesh message:", e);
        }
      }
    } while (meshSyncPending);
  } catch (e) {
    log.error("Mesh message sync failed:", e);
  } finally {
    meshSyncRunning = false;
  }
}
connection.on(Constants.PushCodes.MsgWaiting, drainMeshMessages);

function getMeshChannelForDiscordChannel(discordChannelId) {
  const map = config.DISCORD_TO_MESH_ROUTES || {};
  const idx = map[String(discordChannelId)];
  if (idx === undefined || idx === null) return null;
  const n = Number(idx);
  return Number.isFinite(n) ? n : null;
}

function splitMeshSender(text) {
  const cleaned = stripBridgePrefixes(text);
  const colonIdx = cleaned.indexOf(": ");
  if (colonIdx > 0 && colonIdx < 30) {
    return { senderName: cleaned.slice(0, colonIdx).trim(), meshBody: cleaned.slice(colonIdx + 2).trim() };
  }
  return { senderName: "Mesh", meshBody: cleaned };
}

const LANG_FILTER_REPLY_COOLDOWN_MS = 60_000;
const langFilterLastReply = new Map(); // mesh channelIdx -> ms

async function handleEmergencyMessage(text, channelIdx) {
  const emergencyChannelId = getEmergencyDiscordChannelId();
  try {
    const dest = await bot.channels.fetch(emergencyChannelId);
    if (!dest?.isTextBased()) {
      log.error(`Emergency Discord channel ${emergencyChannelId} is not a text channel`);
      return;
    }
    const now = Date.now();
    const isNewEmergency = !emergencyState.active || (now - emergencyState.lastAlertAt) > getEmergencyCooldownMs();
    const { senderName, meshBody } = splitMeshSender(text);

    if (isNewEmergency) {
      // First message: alert, forward the message, reply to mesh, start the reminder
      emergencyState.active = true;
      emergencyState.lastAlertAt = now;
      await dest.send({ content: "🚨 **Emergency Message Incoming** @everyone", allowedMentions: { parse: ["everyone"] } });
      await postMeshToDiscord(dest, senderName, meshBody);
      scheduleEmergencyReminder(emergencyChannelId);
      await enqueueMeshSend(() =>
        connection.sendChannelTextMessage(channelIdx,
          "Your message has been forwarded to Discord. Stand by for a reply. This channel is for emergency use only."),
        { force: true },
      );
    } else {
      // Subsequent message: just forward, no ping or reply
      await postMeshToDiscord(dest, senderName, meshBody);
    }
  } catch (e) {
    log.error("Emergency channel error:", e);
  }
}

async function onMeshChannelMessageReceived(channelMessage) {
  const text = channelMessage?.text ?? "";
  const channelIdx = channelMessage?.channelIdx;

  // Emergency channel handling comes first: pause, block list and language filter must
  // never stop an emergency from reaching Discord.
  if (isEmergencyMeshChannel(channelIdx) && getEmergencyDiscordChannelId() && !isPocketMeshReact(text)) {
    await handleEmergencyMessage(text, channelIdx);
    return; // Don't process through normal routing
  }

  // Bridge pause gate: Mesh -> Discord
  if (isBridgePaused()) {
    log.debug("[debug] Bridge paused; dropping mesh->discord message");
    return;
  }

  // Handle PocketMesh emoji reactions — apply to matching Discord message
  if (isPocketMeshReact(text)) {
    const parsed = parseMeshReaction(text);
    if (!parsed) {
      log.debug(`Could not parse PocketMesh react: "${text}"`);
      return;
    }

    const entry = getMessageHistory().get(parsed.hash);
    if (!entry) {
      log.debug(`No matching message for react hash ${parsed.hash}`);
      return;
    }

    try {
      const channel = await bot.channels.fetch(entry.discordChannelId);
      const msg = await channel.messages.fetch(entry.discordMessageId);
      try {
        await msg.react(parsed.emoji);
      } catch (e) {
        // Mesh clients often append U+FE0F to emoji Discord only knows without it (e.g. 👍️, ☕️)
        const stripped = parsed.emoji.replace(/\uFE0F/g, "");
        if (e.code !== 10014 || stripped === parsed.emoji) throw e;
        await msg.react(stripped);
      }
      metrics.reactionsApplied++;
      log.debug(`Applied react ${parsed.emoji} to Discord message ${entry.discordMessageId}`);
    } catch (e) {
      metrics.errors++;
      log.error(`Failed to apply mesh react to Discord message:`, e);
    }
    return;
  }

  // #meshmonday special-case (optional: keep as you had it)
  const meshMonday = bot.channels.cache.get(config.DISCORD_CHANNEL_ID_MESHMONDAY);
  if (text.includes("#meshmonday")) {
    if (meshMonday) meshMonday.send(text).catch(log.error);
  }

  // Language warning back to mesh + echo to routed Discord channel (configurable)
  const langFilter = config.LANGUAGE_FILTER;
  if (langFilter && langFilter.ENABLED !== false && Array.isArray(langFilter.WORDS) && langFilter.WORDS.length > 0) {
    // Whole-word match ("class" must not trigger on "ass"), and at most one reply per
    // channel per minute so repeating a word can't make the bridge spam the mesh.
    const triggered = langFilter.WORDS.some(w => w &&
      new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegex(String(w))}(?![\\p{L}\\p{N}])`, "iu").test(text));
    const idxKey = String(channelMessage?.channelIdx ?? 0);
    const lastReply = langFilterLastReply.get(idxKey) || 0;
    if (triggered && Date.now() - lastReply < LANG_FILTER_REPLY_COOLDOWN_MS) {
      log.debug(`Language filter triggered on ch=${idxKey}; reply suppressed (cooldown)`);
    } else if (triggered) {
      langFilterLastReply.set(idxKey, Date.now());
      const response = langFilter.RESPONSE || "Language!!!";
      const idx = Number(channelMessage?.channelIdx ?? 0);

      await enqueueMeshSend(() => connection.sendChannelTextMessage(idx, response));

      const routeChannelIdForAdmonish = config.DISCORD_ROUTES?.[String(idx)] ?? config.DISCORD_CHANNEL_ID;
      if (routeChannelIdForAdmonish) {
        try {
          const dest = await bot.channels.fetch(routeChannelIdForAdmonish);
          if (dest?.isTextBased()) {
            await dest.send(response);
          }
        } catch (e) {
          log.error(`Failed to echo language filter response to Discord for mesh channelIdx=${idx}:`, e);
        }
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
            log.error("Appeal forward error:", e);
          }
        }
        await enqueueMeshSend(() =>
          connection.sendChannelTextMessage(channelIdx, "Your appeal has been forwarded.")
        );
      } else if (!isSameDay(state.lastAppealNotice, now)) {
        state.lastAppealNotice = now; // tell them once; further "appeal"s get no reply
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

    log.debug(`Blocked message from ${senderToCheck}`);
    return;
  }

  // Welcome new users on Public channel with a channel message
  const msgHopCount = (channelMessage.pathLen & 0x3F);
  const maxUnknownRepeaters = Number(config.WELCOME_MAX_UNKNOWN_REPEATERS ?? 1);
  if (config.WELCOME_ENABLED !== false && channelIdx === 0 && senderToCheck && !isUserBlocked(senderToCheck)
      && !welcomedUsers.has(senderToCheck.toLowerCase())
      && !channelWelcomedUsers.has(senderToCheck.toLowerCase())) {
    if (msgHopCount > 0 && hasUnknownPath(maxUnknownRepeaters, findMatchingRxFrame(channelMessage, { consume: false }))) {
      log.debug(`Skipping welcome for "${senderToCheck}" — path has too many unknown repeaters (max ${maxUnknownRepeaters})`);
    } else {
      channelWelcomedUsers.add(senderToCheck.toLowerCase());
      await enqueueMeshSend(async () => {
        await sleep(3000);
        await connection.sendChannelTextMessage(0, (config.WELCOME_CHANNEL_MESSAGE || "Welcome, {name}! Send an advert for more info.").replace("{name}", senderToCheck));
      });
      log.debug(`Sent channel welcome for "${senderToCheck}" (${msgHopCount} hops)`);
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
      log.error(`Route target not text-based: mesh channelIdx=${channelIdx} -> ${routeChannelId}`);
      return;
    }

    // Strip known bridge prefixes
    let cleaned = stripBridgePrefixes(text);
    const wasBridgePrefixed = cleaned !== text;

    // Deduplication: skip if we've seen this message body recently on this channel
    if (isDuplicate(channelIdx, cleaned)) {
      log.debug(`Dedup: skipping duplicate message on ch=${channelIdx}: "${cleaned}"`);
      return;
    }

    let senderName, meshBody;
    if (wasBridgePrefixed && !cleaned.includes(" [D]: ")) {
      // Bridge's own message (not a relayed Discord user) — use the bridge name as sender
      // Extract bridge name from original text
      const bridgeColonIdx = text.indexOf(": ");
      senderName = bridgeColonIdx > 0 ? text.slice(0, bridgeColonIdx).trim() : "Mesh";
      meshBody = cleaned;
    } else {
      const colonIdx = cleaned.indexOf(": ");
      if (colonIdx > 0 && colonIdx < 30) {
        senderName = cleaned.slice(0, colonIdx).trim();
        meshBody = cleaned.slice(colonIdx + 2).trim();
      } else {
        senderName = "Mesh";
        meshBody = cleaned;
      }
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
    const sentMsg = await postMeshToDiscord(dest, senderName, meshBody, { prefix: channelTag, suffix: `\n${pathStr}` });

    // Track message for reaction matching
    // Hash the body without sender name (for reactions from the sender's own device)
    const entry = {
      discordMessageId: sentMsg.id,
      discordChannelId: routeChannelId,
      meshText: cleaned,
      senderTimestamp: channelMessage.senderTimestamp,
      meshChannelIdx: channelIdx,
    };
    metrics.meshToDiscord++;
    metrics.lastMeshMessage = Date.now();
    const hashBody = generateMeshHash(meshBody, channelMessage.senderTimestamp);
    trackMessage(hashBody, entry);
    log.debug(`Tracked message hash=${hashBody} discordId=${sentMsg.id}`);

    // Also hash the full cleaned text (for reactions from other clients who see "SenderName: body")
    if (cleaned !== meshBody) {
      const hashFull = generateMeshHash(cleaned, channelMessage.senderTimestamp);
      trackMessage(hashFull, entry);
      log.debug(`Tracked alt hash=${hashFull} discordId=${sentMsg.id}`);
    }
  } catch (e) {
    log.error(`Failed to route mesh channelIdx=${channelIdx} to ${routeChannelId}:`, e);
  }
}

// Replace slash commands with prefix commands
bot.once("ready", async () => {
  log.info(`Logged in as ${bot.user.tag}!`);
  log.info('Listening for commands.');
  startBlockExpiryChecker();
  startAllSchedules();

  // Sync channel visibility: subscribable channels are hidden, all others are visible
  try {
    const subscribableIds = new Set((config.SUBSCRIBABLE_CHANNELS || []).map(ch => ch.discordChannelId));
    const skipIds = new Set((config.VISIBILITY_SYNC_SKIP_CHANNEL_IDS || []).map(String));
    const allRoutedIds = new Set(Object.values(config.DISCORD_ROUTES || {}));

    for (const guildId of guildIds) {
      const guild = await bot.guilds.fetch(guildId).catch(() => null);
      if (!guild) continue;

      for (const channelId of allRoutedIds) {
        const channel = await bot.channels.fetch(channelId).catch(() => null);
        if (!channel || channel.guildId !== guildId) continue;

        if (subscribableIds.has(channelId) || skipIds.has(channelId)) continue;

        // Not subscribable: clear only a ViewChannel deny on @everyone, keep any other overwrites
        const everyone = channel.permissionOverwrites?.cache.get(guild.id);
        if (!everyone?.deny.has(PermissionFlagsBits.ViewChannel)) continue;
        try {
          await channel.permissionOverwrites.edit(guild.id, { ViewChannel: null });
          log.info(`Made #${channel.name} visible to @everyone (not a subscribable channel)`);
        } catch (e) {
          log.error(`Failed to update visibility for #${channel.name}:`, e);
        }
      }
    }
  } catch (e) {
    log.error("Channel visibility sync error:", e);
  }
});

// A flood advert is repeated by every repeater on the mesh, so limit how often
// non-admins can trigger one.
const ADVERT_COOLDOWN_MS = 15 * 60 * 1000;
let lastAdvertAt = 0;
async function handleAdvert(reply, member) {
  if (isBridgePaused()) {
    await reply("Bridge is paused; not sending advert to mesh.");
    return;
  }
  const waitMs = lastAdvertAt + ADVERT_COOLDOWN_MS - Date.now();
  if (waitMs > 0 && !isBridgeAdminMember(member)) {
    await reply(`An advert was sent recently; try again in ${Math.ceil(waitMs / 60000)} min.`);
    return;
  }
  lastAdvertAt = Date.now();
  try {
    await connection.sendFloodAdvert();
    await reply("Sending Flood Advert!");
  } catch (e) {
    log.error("Flood advert failed:", e);
    await reply("Failed to send flood advert.");
  }
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

  const prefix = `${authorName} [D]: `;
  const normalizedText = normalizeForMesh(`${prefix}${text}`);
  let meshText = normalizedText;
  let wasTruncated = false;

  if (utf8Len(normalizedText) > getMeshMaxLen()) {
    meshText = truncateUtf8(normalizedText, getMeshMaxLen() - 3) + "\u2026"; // ellipsis is 3 bytes
    wasTruncated = true;
  }

  const result = await enqueueMeshSend(async () => {
    await connection.sendChannelTextMessage(meshChannelIdx, meshText);
    const ts = lastMeshSendTs; // the second the library stamped on this packet
    metrics.discordToMesh++;
    metrics.lastDiscordForward = Date.now();
    if (discordMsgId) {
      const hash = generateMeshHash(meshText, ts);
      trackMessage(hash, {
        discordMessageId: discordMsgId,
        discordChannelId: discordChannelId,
        meshText: meshText,
        senderTimestamp: ts,
        meshChannelIdx: meshChannelIdx,
        outgoing: true,
      });
      log.debug(`Tracked outgoing hash=${hash} discordId=${discordMsgId}`);
    }
  });

  if (!result.ok) {
    await reply(`Failed to send to mesh channel ${meshChannelIdx}: ${result.error?.message ?? "radio error"}`);
  } else if (wasTruncated) {
    await reply(`Message truncated to ${getMeshMaxLen()} bytes for mesh (was ${utf8Len(normalizedText)}). Sent to channel ${meshChannelIdx}.`);
  } else {
    await reply(`Sent to mesh channel ${meshChannelIdx}: ${text}`);
  }
}

const REPEATER_COOLDOWN_MS = 60_000;
const repeaterLastUse = new Map(); // Discord user id -> ms

// Hide a subscribable channel from @everyone and show it to its role. @everyone is
// denied last, and only once the role has access, so a failure partway can't leave
// the channel invisible to everyone.
async function restrictChannelToRole(discordChannel, guild, role, label) {
  try {
    // Make sure the bot can still see and post in the channel
    await discordChannel.permissionOverwrites.edit(bot.user.id, {
      ViewChannel: true,
      SendMessages: true,
      ManageWebhooks: true,
    });
  } catch (e) {
    log.error(`Failed to set bot perms for ${label}:`, e);
  }
  try {
    await discordChannel.permissionOverwrites.edit(role.id, { ViewChannel: true });
  } catch (e) {
    log.error(`Failed to set role perms for ${label}; leaving it visible to @everyone:`, e);
    return false;
  }
  try {
    await discordChannel.permissionOverwrites.edit(guild.id, { ViewChannel: false });
  } catch (e) {
    log.error(`Failed to set @everyone perms for ${label}:`, e);
    return false;
  }
  return true;
}

// Discord rejects messages over 2000 characters; cut long replies (block lists,
// schedule lists, node lists) instead of failing the whole command.
function fitDiscord(text) {
  return text.length <= 2000 ? text : text.slice(0, 1985) + "\n...(truncated)";
}

bot.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isChatInputCommand()) return;

    for (const method of ["reply", "editReply"]) {
      const original = interaction[method].bind(interaction);
      interaction[method] = (opts) => original(
        typeof opts === "string" ? fitDiscord(opts)
          : (typeof opts?.content === "string" ? { ...opts, content: fitDiscord(opts.content) } : opts));
    }

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
        "`/schedule add <target> <cron> <message>` — Schedule a message (admin)",
        "`/schedule list` — List scheduled messages",
        "`/schedule remove <id>` — Remove a schedule (admin)",
        "`/prune` — Remove stale contacts from the radio to free slots (admin)",
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

      // Check where the message will go before changing any permissions, so a bad
      // config can't hide channels with no subscription message to react to.
      const subscribeChannelId = config.SUBSCRIBE_CHANNEL_ID;
      const subChannel = subscribeChannelId ? await bot.channels.fetch(subscribeChannelId).catch(() => null) : null;
      if (!subChannel?.isTextBased()) {
        await interaction.editReply("SUBSCRIBE_CHANNEL_ID is not set or isn't a text channel the bot can see.");
        return;
      }

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
          if (discordChannel?.guildId === guild.id) {
            await restrictChannelToRole(discordChannel, guild, role, ch.name);
          } else if (discordChannel) {
            log.warn(`Skipping ${ch.name}: it belongs to a different server than this command`);
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
          log.error("Failed to save config:", e);
        }

        await interaction.editReply(`Subscription message posted! (${roleMap.length} channels configured)`);
      } catch (e) {
        log.error("Subscribe setup error:", e);
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
          if (discordChannel?.guildId === guild.id) {
            await restrictChannelToRole(discordChannel, guild, role, ch.name);
          } else if (discordChannel) {
            log.warn(`Skipping ${ch.name}: it belongs to a different server than this command`);
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
          log.error("Failed to save config:", e);
        }

        await interaction.editReply(`Subscription message updated! (${roleMap.length} channels)`);
      } catch (e) {
        log.error("Subscribe refresh error:", e);
        await interaction.editReply(`Refresh failed: ${e.message}`);
      }
      return;
    }

    // /bridge mode commands
    if (interaction.commandName === "bridge") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const sub = interaction.options.getSubcommand();

      if (sub === "status") {
        const uptimeSec = Math.floor((Date.now() - metrics.startedAt) / 1000);
        const h = Math.floor(uptimeSec / 3600);
        const m = Math.floor((uptimeSec % 3600) / 60);
        const upStr = h > 0 ? `${h}h ${m}m` : `${m}m`;

        const statusLine = isBridgePaused()
          ? `**PAUSED**${bridgeState.pausedBy ? ` by ${bridgeState.pausedBy}` : ""}${bridgeState.pausedAt ? ` at ${bridgeState.pausedAt}` : ""}`
          : "**RUNNING**";

        const lastMesh = metrics.lastMeshMessage ? `<t:${Math.floor(metrics.lastMeshMessage / 1000)}:R>` : "none";
        const lastFwd = metrics.lastDiscordForward ? `<t:${Math.floor(metrics.lastDiscordForward / 1000)}:R>` : "none";

        const lines = [
          `Status: ${statusLine}`,
          `Uptime: ${upStr}`,
          `Mesh connected: ${meshConnected ? "yes" : "no"}`,
          `Known nodes: ${knownNodes.size}`,
          `Messages mesh->discord: ${metrics.meshToDiscord}`,
          `Messages discord->mesh: ${metrics.discordToMesh}`,
          `Reactions applied: ${metrics.reactionsApplied}`,
          `Errors: ${metrics.errors}`,
          `Last mesh message: ${lastMesh}`,
          `Last discord forward: ${lastFwd}`,
        ];

        await interaction.editReply(lines.join("\n"));
        return;
      }

      if (!isBridgeAdminMember(interaction.member)) {
        await interaction.editReply("Not authorized.");
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
          config = loadConfig();
          log.setDebug(!!config.DEBUG);
          webhookCache.clear();
          startAllSchedules();
          await interaction.editReply("Config reloaded successfully.");
        } catch (e) {
          log.error("Config reload error:", e);
          await interaction.editReply(`Config reload failed: ${e.message}`);
        }
        return;
      }

      // Should never reach here
      await interaction.editReply("Unknown subcommand.");
      return;
    }

    if (interaction.commandName === "prune") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      if (!isBridgeAdminMember(interaction.member)) {
        await interaction.editReply("Not authorized.");
        return;
      }
      try {
        const contacts = await connection.getContacts();
        saveContactsBackup(contacts);
        const stale = await getStaleContacts(contacts);
        if (stale.length === 0) {
          await interaction.editReply(`No stale contacts to prune (${contacts.length} total, stale threshold: ${getPruneStaleAgeMs() / 3600000}h).`);
          return;
        }
        const pruned = await removeContacts(stale);
        contactsCacheTime = 0;
        await interaction.editReply(`Pruned ${pruned} stale contacts (were ${contacts.length}, now ~${contacts.length - pruned}). Backup preserved on server.`);
      } catch (e) {
        log.error("Prune command error:", e);
        await interaction.editReply("Failed to prune contacts.");
      }
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
          const hopCount = c.outPathLen & 0x3F;
          const hops = (c.outPathLen === 0xFF || c.outPathLen < 0) ? "no path"
            : hopCount === 0 ? "direct"
            : `${hopCount} hop${hopCount !== 1 ? "s" : ""}`;
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
        log.error("Error fetching nodes:", e);
        await interaction.editReply("Failed to fetch nodes from mesh device.");
      }
      return;
    }

    if (interaction.commandName === "repeater") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      // Each live-status request is a mesh transmission and holds the send queue
      const lastUse = repeaterLastUse.get(interaction.user.id) || 0;
      if (Date.now() - lastUse < REPEATER_COOLDOWN_MS && !isBridgeAdminMember(interaction.member)) {
        await interaction.editReply(`Please wait ${Math.ceil((lastUse + REPEATER_COOLDOWN_MS - Date.now()) / 1000)}s before requesting another repeater status.`);
        return;
      }
      repeaterLastUse.set(interaction.user.id, Date.now());

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
        const hopCount = contact.outPathLen & 0x3F;
        const hops = (contact.outPathLen < 0 || contact.outPathLen === 0xFF)
          ? "no path"
          : hopCount === 0 ? "direct" : `${hopCount} hop${hopCount !== 1 ? "s" : ""}`;
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
            log.debug(`Requesting live status from "${name}" pathLen=${contact.outPathLen}`);
            // The library only starts its timeout after the radio's Sent reply, so cap
            // the whole request; it holds the shared send queue while it waits.
            const res = await enqueueMeshSend(() => Promise.race([
              connection.getStatus(contact.publicKey, 15000),
              sleep(30_000).then(() => { throw new Error("timeout"); }),
            ]));
            const status = res.ok ? res.value : null;
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
        log.error("Error fetching repeater status:", e);
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
        let warning = "Bridge is paused, so no warning was sent to mesh.";
        if (!isBridgePaused()) {
          const result = await enqueueMeshSend(() =>
            connection.sendChannelTextMessage(0,
              `${username}: You have been blocked from Discord. Reply "appeal" once daily to request an unblock.`)
          );
          warning = result.ok ? "Warning sent to mesh." : "The mesh warning failed to send.";
        }
        await interaction.editReply(`Blocked **${username}**${pubKeyHex ? ` (key: ${pubKeyHex.slice(0, 12)}...)` : ""}. Their messages will no longer be forwarded to Discord. ${warning}`);
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

    if (interaction.commandName === "schedule") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!isBridgeAdminMember(interaction.member)) {
        await interaction.editReply("Not authorized.");
        return;
      }

      const sub = interaction.options.getSubcommand();

      if (sub === "list") {
        const schedules = getSchedules();
        if (schedules.length === 0) {
          await interaction.editReply("No scheduled messages.");
        } else {
          const lines = schedules.map(s =>
            `- **${s.id}** — target: \`${s.target}\`, schedule: \`${s.cron}\`\n  Message: "${s.message.slice(0, 80)}${s.message.length > 80 ? "..." : ""}"`
          );
          await interaction.editReply(`**Scheduled Messages (${schedules.length}):**\n${lines.join("\n")}`);
        }
        return;
      }

      if (sub === "add") {
        const target = interaction.options.getString("target");
        const cron = interaction.options.getString("cron");
        const message = interaction.options.getString("message");

        // Validate cron
        const parsed = parseCronSchedule(cron);
        if (!parsed) {
          await interaction.editReply("Invalid schedule. Use: `daily HH:MM`, `weekly mon HH:MM`, or `every Nh`/`every Nm` (intervals between 15m and 576h).");
          return;
        }

        // Generate ID
        const id = `sched_${Date.now().toString(36)}`;
        const entry = { id, target, cron, message };

        if (!config.SCHEDULED_MESSAGES) config.SCHEDULED_MESSAGES = [];
        config.SCHEDULED_MESSAGES.push(entry);
        saveConfig();

        // Start the schedule immediately
        startSchedule(entry);

        let nextMs = msUntilNext(parsed);
        let nextText = "";
        if (nextMs) {
          const nextDate = new Date(Date.now() + nextMs);
          nextText = ` Next run: <t:${Math.floor(nextDate.getTime() / 1000)}:R>`;
        }

        await interaction.editReply(`Schedule **${id}** created!${nextText}\nTarget: \`${target}\`, Schedule: \`${cron}\`\nMessage: "${message}"`);
        return;
      }

      if (sub === "remove") {
        const id = interaction.options.getString("id");
        if (!config.SCHEDULED_MESSAGES) {
          await interaction.editReply("No scheduled messages.");
          return;
        }

        const before = config.SCHEDULED_MESSAGES.length;
        config.SCHEDULED_MESSAGES = config.SCHEDULED_MESSAGES.filter(s => s.id !== id);
        if (config.SCHEDULED_MESSAGES.length < before) {
          saveConfig();
          // Stop the timer
          const timer = activeScheduleTimers.get(id);
          if (timer) {
            clearTimeout(timer);
            activeScheduleTimers.delete(id);
          }
          await interaction.editReply(`Schedule **${id}** removed.`);
        } else {
          await interaction.editReply(`Schedule **${id}** not found.`);
        }
        return;
      }

      return;
    }

    if (interaction.commandName === "voteblock") {
      // Defer first: posting the vote and adding three reactions can exceed 3 seconds
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const username = interaction.options.getString("username");
      const reason = interaction.options.getString("reason");

      // Check if already blocked
      if (isUserBlocked(username)) {
        await interaction.editReply(`**${username}** is already blocked.`);
        return;
      }

      // Check cooldown
      const cooldownKey = username.toLowerCase();
      const lastVote = voteCooldowns.get(cooldownKey) || 0;
      if (Date.now() - lastVote < VOTE_COOLDOWN_MS) {
        const remaining = Math.ceil((VOTE_COOLDOWN_MS - (Date.now() - lastVote)) / 60000);
        await interaction.editReply(`A vote for **${username}** was attempted recently. Try again in ${remaining} minutes.`);
        return;
      }

      // Check if there's already an active vote for this user
      for (const vote of activeVotes.values()) {
        if (vote.username.toLowerCase() === cooldownKey) {
          await interaction.editReply(`A vote for **${username}** is already in progress.`);
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

      // Reserve the vote before any await so a simultaneous /voteblock for the same
      // name sees it, and start the cooldown now.
      const placeholderKey = `pending:${cooldownKey}`;
      activeVotes.set(placeholderKey, { username });
      voteCooldowns.set(cooldownKey, Date.now());

      // Post vote message
      let voteMsg;
      try {
        voteMsg = await interaction.channel.send(
          `**Vote to block \`${username}\` ${durationText}${escalationNote}**\n` +
          `Reason: ${reason}\n` +
          `Initiated by: ${interaction.user.username}\n\n` +
          `React 👍 to vote yes, 👎 to vote no.\n` +
          `Admins: react ${VOTE_VETO_EMOJI} to veto.\n` +
          `Needs **${threshold}** yes votes and more yes than no. Closes <t:${Math.floor((Date.now() + VOTE_DURATION_MS) / 1000)}:R>.`
        );
      } catch (e) {
        activeVotes.delete(placeholderKey);
        log.error("Failed to post vote message:", e);
        await interaction.editReply("Couldn't post the vote message in this channel.");
        return;
      }
      for (const emoji of ["👍", "👎", VOTE_VETO_EMOJI]) {
        await voteMsg.react(emoji).catch(e => log.error(`Failed to add ${emoji} to vote message:`, e));
      }

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

          // Count real voters only: no bots, and anyone who voted both ways counts for
          // neither side. Passes with enough yes votes AND more yes than no.
          const voters = async (emoji) => {
            const r = msg.reactions.cache.find(x => x.emoji.name === emoji);
            if (!r) return new Set();
            const users = await r.users.fetch();
            return new Set(users.filter(u => !u.bot).map(u => u.id));
          };
          const yesIds = await voters("👍");
          const noIds = await voters("👎");
          for (const id of [...yesIds]) {
            if (noIds.has(id)) { yesIds.delete(id); noIds.delete(id); }
          }
          const yesCount = yesIds.size;
          const noCount = noIds.size;

          if (yesCount >= threshold && yesCount > noCount) {
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
            await msg.reply(`Vote passed (**${yesCount}** yes, ${noCount} no; ${threshold} needed). **${username}** has been blocked ${durationText}.`);

            // Warn on mesh
            if (!isBridgePaused()) await enqueueMeshSend(() =>
              connection.sendChannelTextMessage(0,
                `${username}: You have been vote-blocked ${durationText}. Reply "appeal" once daily to request an unblock.`)
            );
          } else {
            const why = yesCount < threshold ? `${threshold} yes votes needed` : "not more yes than no";
            await msg.reply(`Vote failed (**${yesCount}** yes, ${noCount} no; ${why}). **${username}** will not be blocked.`);
          }
        } catch (e) {
          log.error("Vote resolution error:", e);
        }
      }, VOTE_DURATION_MS);

      activeVotes.delete(placeholderKey);
      activeVotes.set(voteMsg.id, {
        username,
        reason,
        channelId: interaction.channel.id,
        guildId: guild.id,
        timer,
        initiator: interaction.user.username,
      });

      await interaction.editReply(`Vote to block **${username}** started!`);
      return;
    }

    if (interaction.commandName === "advert") {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await handleAdvert((msg) => interaction.editReply(msg), interaction.member);
    }

    if (interaction.commandName === "send") {
      let text = interaction.options.getString("message");
      if (interaction.guild) text = await resolveMentions(text, interaction.guild);
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
    log.error("interactionCreate error:", e);

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
    // ignore bots
    if (message.author.bot) return;

    // Handle DM replies to mesh DM forwards
    if (!message.guild) {
      const dmForwardUserId = config.DM_FORWARD_DISCORD_USER_ID;
      if (dmForwardUserId && message.author.id === dmForwardUserId && message.reference?.messageId) {
        const sender = dmSenderMap.get(message.reference.messageId);
        if (sender) {
          const senderName = sender.name;
          try {
            // Use the key captured when the DM arrived; names aren't unique on the mesh
            const publicKey = sender.publicKey
              || (await connection.findContactByName(senderName))?.publicKey;
            const replyText = message.content.trim();
            if (isBridgePaused()) {
              await message.reply("Bridge is paused; reply not sent to mesh.");
            } else if (!publicKey) {
              await message.reply(`Could not find mesh contact "${senderName}".`);
            } else if (replyText) {
              const result = await sendDMChunked(publicKey, replyText);
              if (result?.ok) {
                await message.react("✅");
                log.debug(`Sent DM reply to mesh user "${senderName}"`);
              } else {
                await message.reply(`Failed to send reply to mesh: ${result?.error?.message ?? "radio error"}`);
              }
            }
          } catch (e) {
            log.error("DM reply error:", e);
            await message.reply("Failed to send reply to mesh.").catch(() => {});
          }
        }
      }
      return;
    }

    // Emergency channel reply detection — cancel reminder if someone responds
    const emergencyChannelId = getEmergencyDiscordChannelId();
    if (emergencyChannelId && String(message.channel.id) === String(emergencyChannelId) && emergencyState.active) {
      cancelEmergencyReminder();
      log.debug("[debug] Emergency reminder cancelled — Discord reply received");
    }

    // Always-forward mode for one specific Discord channel
    const alwaysForwardIds = getAlwaysForwardChannelIds();
    if (alwaysForwardIds.has(String(message.channel.id))) {
      // Bridge pause gate: Discord -> Mesh
      if (isBridgePaused()) {
        log.debug("[debug] Bridge paused; dropping discord->mesh always-forward message");
        return;
      }

      // Flood protection gate: one slot per mesh packet (text + up to 2 attachment links)
      const packetCost = (message.content?.trim() || message.reference?.messageId ? 1 : 0)
        + Math.min(message.attachments.size, MAX_ATTACHMENT_LINKS);
      if (!(await floodAllowDiscordToMesh(message, packetCost))) return;

      const meshIdx = getMeshChannelForDiscordChannel(message.channel.id);
      if (meshIdx === null) {
        log.debug(`Always-forward channel not mapped: ${message.channel.id}`);
        return;
      }

      const name = message.member?.nickname || message.author.username;

      // Optional: don't forward commands typed in that channel (keeps it cleaner)
      if (config.identifier && message.content.startsWith(config.identifier)) return;

      // Handle attachments: uploaded to the file host if configured, otherwise images go to
      // ImgBB and other files get a TinyURL to the Discord CDN link
      // Only the first MAX_ATTACHMENT_LINKS get links; each is its own mesh packet.
      const allAtts = [...message.attachments.values()];
      const linkedAtts = allAtts.slice(0, MAX_ATTACHMENT_LINKS);
      const extraAtts = allAtts.length - linkedAtts.length;
      const imageAtts = linkedAtts.filter(isImageAttachment);
      const fileAtts = linkedAtts.filter(a => !isImageAttachment(a));

      const attachmentLines = [];

      for (const att of imageAtts) {
        let link = await uploadToFileHost(att);
        if (!link && getImgbbApiKey()) link = await uploadToImgBB(att.url);
        if (link) attachmentLines.push(link);
      }

      for (const att of fileAtts) {
        const size = att.size;
        const sizeStr = size < 1024 ? `${size}B`
          : size < 1048576 ? `${(size / 1024).toFixed(1)}KB`
          : `${(size / 1048576).toFixed(1)}MB`;
        const ext = (att.name?.split('.').pop() || 'file').toUpperCase();
        const link = (await uploadToFileHost(att)) || (await shortenUrl(att.url));
        attachmentLines.push(`[${ext}, ${sizeStr}] ${link}`);
      }

      if (extraAtts > 0 && attachmentLines.length > 0) {
        attachmentLines[attachmentLines.length - 1] += ` (+${extraAtts} more in Discord)`;
      }

      let content = (message.content || "").trim();
      if (content) content = await resolveMentions(content, message.guild);

      // Build reply context if this is a reply to another message
      let replyContext = "";
      if (message.reference?.messageId) {
        try {
          const refMsg = await message.channel.messages.fetch(message.reference.messageId);
          if (refMsg) {
            // Webhook messages use the mesh sender name as username
            const refAuthor = refMsg.webhookId
              ? (refMsg.author?.username || "Mesh")
              : (refMsg.member?.nickname || refMsg.author?.username || "Unknown");
            const refPreview = normalizeForMesh(refMsg.content || "").slice(0, 10);
            replyContext = `@[${refAuthor}]\n>${refPreview}..\n`;
          }
        } catch (e) {
          log.debug(`Failed to fetch reply reference: ${e.message}`);
        }
      }

      const hasText = content.length > 0 || replyContext.length > 0;
      const hasAttachments = attachmentLines.length > 0;

      // Skip if nothing to forward
      if (!hasText && !hasAttachments) return;

      // Uploads can take a while; don't send if the bridge was paused meanwhile
      if (isBridgePaused()) {
        log.debug("[debug] Bridge paused during attachment upload; dropping message");
        return;
      }

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
        log.debug(`Tracked outgoing hash=${hash} discordId=${message.id}`);
      };

      if (hasText) {
        const normalizedContent = normalizeForMesh(content);
        let meshText = replyContext
          ? `${name} [D]: ${replyContext}${normalizedContent}`
          : normalizeForMesh(`${name} [D]: ${content}`);
        let wasTruncated = false;
        if (utf8Len(meshText) > getMeshMaxLen()) {
          meshText = truncateUtf8(meshText, getMeshMaxLen() - 3) + "\u2026"; // ellipsis is 3 bytes
          wasTruncated = true;
        }
        await enqueueMeshSend(async () => {
          await connection.sendChannelTextMessage(meshIdx, meshText);
          const ts = lastMeshSendTs; // the second the library stamped on this packet
          trackOutgoing(meshText, ts);
        });
        if (wasTruncated) {
          await message.reply(`Message truncated to ${getMeshMaxLen()} bytes for mesh.`);
        }
      }
      for (const line of attachmentLines) {
        await sendMeshChunked(meshIdx, `${name} [D]: ${line}`, trackOutgoing);
      }
      return;
    }

    // only handle messages starting with prefix
    if (!config.identifier || !message.content.startsWith(config.identifier)) return;

    const args = message.content
      .slice(config.identifier.length)
      .trim()
      .split(/\s+/);

    const command = args.shift()?.toLowerCase();

    if (command === 'advert') {
      await handleAdvert((msg) => message.channel.send(msg), message.member);
    } else if (command === 'send') {
      // Flood protection gate for prefix send
      if (!(await floodAllowDiscordToMesh(message))) return;

      let text = args.join(" ");
      if (message.guild) text = await resolveMentions(text, message.guild);
      const name = message.member?.nickname || message.author.username;
      const meshIdx = getMeshChannelForDiscordChannel(message.channel.id);
      if (meshIdx === null) {
        await message.channel.send("This channel is not mapped to a mesh channel.");
        return;
      }

      await handleSend(text, name, (msg) => message.channel.send(msg), meshIdx, message.id, message.channel.id);
    }
  } catch (e) {
    log.error("Error handling messageCreate:", e);
  }
});

// ---- Reaction mirroring: Discord -> Mesh ----
// ---- Subscription role helper ----
function findSubscribeRoleForEmoji(emojiName) {
  const roleMap = config._SUBSCRIBE_ROLE_MAP || [];
  return roleMap.find(e => e.emoji === emojiName);
}

const mirroredReactions = new Map(); // "messageId:emoji" -> ms, reactions already sent to mesh

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
          log.debug(`Subscribed ${user.username} to ${entry.name}`);
        } catch (e) {
          log.error(`Failed to add subscribe role:`, e);
        }
      }
      return;
    }

    // Only mirror reactions in channels mapped to mesh
    const meshIdx = getMeshChannelForDiscordChannel(message.channel.id);
    if (meshIdx === null) return;

    if (isBridgePaused()) return;

    // Each mirrored reaction is a mesh broadcast, so: skip custom Discord emoji (mesh
    // clients can't show them) and the bot's own messages (votes, notices), send each
    // emoji at most once per message, and count it against flood protection.
    if (reaction.emoji.id) return;
    if (message.author?.id === bot.user.id && !message.webhookId) return;
    const emoji = reaction.emoji.name || "?";
    const mirrorKey = `${message.id}:${emoji}`;
    if (mirroredReactions.has(mirrorKey)) return;
    if (!(await floodAllowDiscordToMesh(message))) return;
    mirroredReactions.set(mirrorKey, Date.now());
    if (mirroredReactions.size > 2000) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [k, t] of mirroredReactions) if (t < cutoff) mirroredReactions.delete(k);
    }

    // Look up the original mesh message by Discord message ID
    const lookup = findHashByDiscordMessageId(message.id);
    if (lookup) {
      // Extract the target sender name
      // For incoming mesh messages, the target is the mesh sender (before ": ")
      // For outgoing Discord messages, the target is our bridge's mesh node name
      let targetName;
      if (lookup.entry.outgoing) {
        targetName = meshSelfName || config.MESH_NODE_NAME || "Unknown";
      } else {
        const meshText = lookup.entry.meshText;
        const colonIdx = meshText.indexOf(": ");
        targetName = colonIdx > 0 ? meshText.slice(0, colonIdx).trim() : "Unknown";
      }

      const reactPayload = `${emoji}@[${targetName}]\n${lookup.hash}`;
      log.debug(`Sending react to mesh ch=${meshIdx}: ${JSON.stringify(reactPayload)}`);
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
    log.error("Error handling reaction:", e);
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
        log.debug(`Unsubscribed ${user.username} from ${entry.name}`);
      } catch (e) {
        log.error(`Failed to remove subscribe role:`, e);
      }
    }
  } catch (e) {
    log.error("Error handling reaction remove:", e);
  }
});

// ---- Graceful shutdown ----
async function shutdown(signal) {
  log.info(`Received ${signal}, shutting down...`);
  stopAllSchedules();
  stopHealthCheck();
  if (pruneTimer) { clearInterval(pruneTimer); pruneTimer = null; }
  cancelEmergencyReminder();
  flushHistory();
  try { bot.destroy(); } catch {}
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// ---- Web UI ----
const bridgeContext = {
  getConfig: () => config,
  getMetrics: () => ({ ...metrics }),
  getBridgeState: () => ({ ...bridgeState }),
  isMeshConnected: () => meshConnected,
  getKnownNodeCount: () => knownNodes.size,
  setBridgePaused,
  // Merge changed keys (the web UI sends only what was edited). Throws if the file
  // can't be written, so the UI doesn't report a save that didn't happen.
  saveConfig: (changes) => {
    const previous = { ...config };
    Object.assign(config, changes);
    try {
      saveConfigAtomic(config);
    } catch (e) {
      for (const k of Object.keys(changes)) {
        if (k in previous) config[k] = previous[k]; else delete config[k];
      }
      throw e;
    }
    log.setDebug(!!config.DEBUG);
  },
  reloadConfig: () => {
    config = loadConfig();
    log.setDebug(!!config.DEBUG);
    webhookCache.clear();
    startAllSchedules();
  },
  adminRoleIds: () => config.BRIDGE_ADMIN_ROLE_IDS || [],
  guildIds: () => config.GUILD_IDS || (config.GUILD_ID ? [config.GUILD_ID] : []),
};

if (config.WEB_PORT) {
  createWebServer(bridgeContext, config).catch(e => {
    log.error("Web server failed to start:", e.message);
  });
}

try {
  await connectMesh();
} catch (e) {
  log.error(`Failed to connect to meshcore device on ${config.SERIAL_PORT || "/dev/ttyUSB0"}:`, e.message);
  process.exit(1);
}

bot.login(config.DISCORD_TOKEN).catch(e => {
  log.error("Failed to login to Discord:", e.message);
  process.exit(1);
});
