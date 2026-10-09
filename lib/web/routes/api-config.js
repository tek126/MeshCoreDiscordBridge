import { Router } from "express";
import log from "../../logger.js";
import { validateConfig, REQUIRED_KEYS, VALIDATED_KEYS } from "../../config.js";

const REDACTED_KEYS = ["DISCORD_TOKEN", "WEB_CLIENT_SECRET", "IMGBB_API_KEY", "FILE_HOST_TOKEN"];
const PLACEHOLDER = "********";

function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config));
  for (const key of REDACTED_KEYS) {
    if (copy[key]) copy[key] = PLACEHOLDER;
  }
  return copy;
}

function restoreSecrets(newConfig, currentConfig) {
  for (const key of REDACTED_KEYS) {
    if (newConfig[key] === PLACEHOLDER && currentConfig[key]) {
      newConfig[key] = currentConfig[key];
    }
  }
  return newConfig;
}

export function createConfigRoutes(ctx) {
  const router = Router();

  router.get("/config", (req, res) => {
    res.json(redactConfig(ctx.getConfig()));
  });

  router.get("/config/schema", (req, res) => {
    res.json({
      required: REQUIRED_KEYS,
      optional: VALIDATED_KEYS,
    });
  });

  // The body holds only the changed keys; they are merged into the live config.
  router.put("/config", (req, res) => {
    try {
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "Expected an object of config changes" });
      }
      const changes = {};
      for (const [key, value] of Object.entries(body)) {
        if (key === "__proto__" || key === "constructor" || key === "prototype") continue;
        changes[key] = value;
      }
      restoreSecrets(changes, ctx.getConfig());
      const warnings = validateConfig({ ...ctx.getConfig(), ...changes });
      ctx.saveConfig(changes);
      log.info(`Config updated via web UI by ${req.session.username}`);
      res.json({ ok: true, warnings });
    } catch (e) {
      log.error("Config save error:", e);
      res.status(400).json({ error: e.message });
    }
  });

  return router;
}
