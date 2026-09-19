import { Router } from "express";
import log from "../../logger.js";
import {
  createOAuthState, validateOAuthState, exchangeCode,
  fetchDiscordUser, checkAdminAccess, createSession,
  deleteSession, parseCookies, getSession,
} from "../auth.js";

export function createAuthRoutes(ctx, config) {
  const router = Router();

  router.get("/discord", (req, res) => {
    const state = createOAuthState();
    const params = new URLSearchParams({
      client_id: config.CLIENT_ID,
      redirect_uri: config.WEB_CALLBACK_URL,
      response_type: "code",
      scope: "identify guilds.members.read",
      state,
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
  });

  router.get("/callback", async (req, res) => {
    const { code, state, error } = req.query;

    if (error || !code) {
      return res.redirect("/?error=denied");
    }

    if (!validateOAuthState(state)) {
      return res.redirect("/?error=invalid_state");
    }

    try {
      const tokenData = await exchangeCode(
        config.CLIENT_ID,
        config.WEB_CLIENT_SECRET,
        code,
        config.WEB_CALLBACK_URL,
      );

      const user = await fetchDiscordUser(tokenData.access_token);

      const isAdmin = await checkAdminAccess(
        tokenData.access_token,
        ctx.guildIds(),
        ctx.adminRoleIds(),
      );

      if (!isAdmin) {
        log.warn(`Web UI access denied for ${user.username} (${user.id})`);
        return res.redirect("/?error=forbidden");
      }

      const sessionToken = createSession({
        userId: user.id,
        username: user.username,
        avatar: user.avatar,
        discriminator: user.discriminator,
      });

      res.setHeader("Set-Cookie", `session=${sessionToken}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
      log.info(`Web UI login: ${user.username} (${user.id})`);
      res.redirect("/");
    } catch (e) {
      log.error("OAuth callback error:", e);
      res.redirect("/?error=auth_failed");
    }
  });

  router.get("/logout", (req, res) => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.session) deleteSession(cookies.session);
    res.setHeader("Set-Cookie", "session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0");
    res.redirect("/");
  });

  // /api/me — requires auth (mounted under /api with requireAuth)
  router.get("/me", (req, res) => {
    if (!req.session) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    res.json({
      username: req.session.username,
      avatar: req.session.avatar,
      userId: req.session.userId,
    });
  });

  return router;
}
