import crypto from "crypto";
import log from "../logger.js";

const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const sessions = new Map();
const pendingStates = new Map();

// Cleanup expired sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions) {
    if (now - session.createdAt > SESSION_TTL_MS) sessions.delete(token);
  }
  for (const [state, data] of pendingStates) {
    if (now - data.createdAt > 300_000) pendingStates.delete(state);
  }
}, 600_000);

export function createSession(userData) {
  const token = crypto.randomBytes(32).toString("hex");
  sessions.set(token, { ...userData, createdAt: Date.now() });
  return token;
}

export function getSession(token) {
  if (!token) return null;
  const session = sessions.get(token);
  if (!session) return null;
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token);
    return null;
  }
  return session;
}

export function deleteSession(token) {
  sessions.delete(token);
}

export function createOAuthState() {
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, { createdAt: Date.now() });
  return state;
}

export function validateOAuthState(state) {
  if (!pendingStates.has(state)) return false;
  pendingStates.delete(state);
  return true;
}

export function parseCookies(header) {
  const cookies = {};
  if (!header) return cookies;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key) cookies[key.trim()] = rest.join("=").trim();
  }
  return cookies;
}

export function requireAuth(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);
  const session = getSession(cookies.session);
  if (!session) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  req.session = session;
  next();
}

export function csrfMiddleware(req, res, next) {
  const cookies = parseCookies(req.headers.cookie);

  if (!cookies.csrf) {
    const csrfToken = crypto.randomBytes(16).toString("hex");
    res.setHeader("Set-Cookie", `csrf=${csrfToken}; Path=/; SameSite=Strict`);
    cookies.csrf = csrfToken;
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) {
    const headerToken = req.headers["x-csrf-token"];
    if (!headerToken || headerToken !== cookies.csrf) {
      return res.status(403).json({ error: "Invalid CSRF token" });
    }
  }

  next();
}

export async function exchangeCode(clientId, clientSecret, code, redirectUri) {
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
  });

  const res = await fetch("https://discord.com/api/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${text}`);
  }

  return res.json();
}

export async function fetchDiscordUser(accessToken) {
  const res = await fetch("https://discord.com/api/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`Failed to fetch user: ${res.status}`);
  return res.json();
}

export async function fetchGuildMember(accessToken, guildId) {
  const res = await fetch(`https://discord.com/api/users/@me/guilds/${guildId}/member`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return null;
  return res.json();
}

export async function checkAdminAccess(accessToken, guildIds, adminRoleIds) {
  for (const guildId of guildIds) {
    const member = await fetchGuildMember(accessToken, guildId);
    if (!member) continue;

    // Check permissions (bitfield)
    const perms = BigInt(member.permissions || 0);
    const ADMINISTRATOR = 1n << 3n;
    const MANAGE_GUILD = 1n << 5n;
    if ((perms & ADMINISTRATOR) || (perms & MANAGE_GUILD)) return true;

    // Check role IDs
    if (member.roles?.some(r => adminRoleIds.includes(r))) return true;
  }
  return false;
}
