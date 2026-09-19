import { Router } from "express";
import log from "../../logger.js";

export function createBridgeRoutes(ctx) {
  const router = Router();

  router.get("/status", (req, res) => {
    const metrics = ctx.getMetrics();
    const bridgeState = ctx.getBridgeState();
    const uptimeMs = Date.now() - metrics.startedAt;
    const h = Math.floor(uptimeMs / 3600000);
    const m = Math.floor((uptimeMs % 3600000) / 60000);

    res.json({
      bridge: bridgeState,
      meshConnected: ctx.isMeshConnected(),
      knownNodes: ctx.getKnownNodeCount(),
      uptime: `${h}h ${m}m`,
      uptimeMs,
      metrics: {
        meshToDiscord: metrics.meshToDiscord,
        discordToMesh: metrics.discordToMesh,
        reactionsApplied: metrics.reactionsApplied,
        errors: metrics.errors,
        lastMeshMessage: metrics.lastMeshMessage,
        lastDiscordForward: metrics.lastDiscordForward,
      },
    });
  });

  router.post("/bridge/pause", (req, res) => {
    ctx.setBridgePaused(true, req.session.username + " (web)");
    log.info(`Bridge paused via web UI by ${req.session.username}`);
    res.json({ ok: true, paused: true });
  });

  router.post("/bridge/resume", (req, res) => {
    ctx.setBridgePaused(false);
    log.info(`Bridge resumed via web UI by ${req.session.username}`);
    res.json({ ok: true, paused: false });
  });

  router.post("/bridge/reload", (req, res) => {
    try {
      ctx.reloadConfig();
      log.info(`Config reloaded via web UI by ${req.session.username}`);
      res.json({ ok: true });
    } catch (e) {
      log.error("Config reload error:", e);
      res.status(500).json({ error: e.message });
    }
  });

  return router;
}
