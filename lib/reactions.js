import fs from "fs";
import log from "./logger.js";

// ---- PocketMesh reaction detection and parsing ----
// New (MeshCoreOne): "@[Some User]emoji\nhash"  -- emoji after target name
// Old:              "emoji@[Some User]hash"     -- emoji before target name
const EMOJI_PAT = String.raw`(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*)`;

const POCKETMESH_REACT_NEW_RE = new RegExp(
  String.raw`^\s*(?:.*?:\s*)?@\[[^\]]*\]${EMOJI_PAT}\s*[a-z0-9]{8}\s*$`, "iu");
const POCKETMESH_REACT_OLD_RE = new RegExp(
  String.raw`^\s*(?:.*?:\s*)?${EMOJI_PAT}@\[[^\]]*\]\s*[a-z0-9]{8}\s*$`, "iu");

const REACT_PARSE_NEW_RE = new RegExp(
  String.raw`^(?:.*?:\s*)?@\[([^\]]*)\](${EMOJI_PAT})\s*([a-z0-9]{8})\s*$`, "isu");
const REACT_PARSE_OLD_RE = new RegExp(
  String.raw`^(?:.*?:\s*)?(${EMOJI_PAT})@\[([^\]]*)\]\s*([a-z0-9]{8})\s*$`, "isu");

export function isPocketMeshReact(text) {
  if (!text) return false;
  const normalized = String(text).replace(/\r\n/g, "\n");
  return POCKETMESH_REACT_NEW_RE.test(normalized) || POCKETMESH_REACT_OLD_RE.test(normalized);
}

export function parseMeshReaction(text) {
  const normalized = String(text).replace(/\r\n/g, "\n");
  const newMatch = normalized.match(REACT_PARSE_NEW_RE);
  if (newMatch) return { emoji: newMatch[2], targetName: newMatch[1], hash: newMatch[3] };
  const oldMatch = normalized.match(REACT_PARSE_OLD_RE);
  if (oldMatch) return { emoji: oldMatch[1], targetName: oldMatch[2], hash: oldMatch[3] };
  return null;
}

// ---- Message history for reaction matching (persisted to disk) ----
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
  log.info(`Loaded ${messageHistory.size} messages from history${pruned ? ` (pruned ${pruned} expired)` : ""}.`);
} catch {
  // File doesn't exist yet or is invalid — start fresh
}

let historySaveTimer = null;

function scheduleSaveHistory() {
  if (historySaveTimer) return;
  historySaveTimer = setTimeout(() => {
    historySaveTimer = null;
    const now = Date.now();
    for (const [hash, entry] of messageHistory) {
      if (entry.trackedAt && (now - entry.trackedAt) > HISTORY_MAX_AGE_MS) {
        messageHistory.delete(hash);
      }
    }
    try {
      fs.writeFileSync(HISTORY_FILE, JSON.stringify([...messageHistory]));
    } catch (e) {
      log.error("Failed to save message history:", e);
    }
  }, 5000);
}

export function trackMessage(hash, entry) {
  entry.trackedAt = Date.now();
  messageHistory.set(hash, entry);
  scheduleSaveHistory();
}

export function findHashByDiscordMessageId(discordMessageId) {
  for (const [hash, entry] of messageHistory) {
    if (entry.discordMessageId === discordMessageId) return { hash, entry };
  }
  return null;
}

export function getMessageHistory() {
  return messageHistory;
}

export function getHistorySaveTimer() {
  return historySaveTimer;
}

export function clearHistorySaveTimer() {
  if (historySaveTimer) { clearTimeout(historySaveTimer); historySaveTimer = null; }
}

export function flushHistory() {
  clearHistorySaveTimer();
  const now = Date.now();
  for (const [hash, entry] of messageHistory) {
    if (entry.trackedAt && (now - entry.trackedAt) > HISTORY_MAX_AGE_MS) {
      messageHistory.delete(hash);
    }
  }
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify([...messageHistory]));
    log.info("Message history saved.");
  } catch (e) {
    log.error("Failed to save message history on shutdown:", e);
  }
}

// ---- Message deduplication ----
const DEDUP_WINDOW_MS = 30_000;
const recentMessages = new Map();

export function isDuplicate(channelIdx, body) {
  const key = `${channelIdx}:${body}`;
  const now = Date.now();
  const prev = recentMessages.get(key);
  if (prev && (now - prev) < DEDUP_WINDOW_MS) {
    return true;
  }
  recentMessages.set(key, now);
  if (recentMessages.size > 500) {
    for (const [k, t] of recentMessages) {
      if (now - t > DEDUP_WINDOW_MS) recentMessages.delete(k);
    }
  }
  return false;
}

export { HISTORY_MAX_AGE_MS };
