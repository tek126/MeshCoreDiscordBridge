import express from "express";
import { fileURLToPath } from "url";
import path from "path";
import log from "../logger.js";
import { requireAuth, csrfMiddleware } from "./auth.js";
import { createAuthRoutes } from "./routes/api-auth.js";
import { createConfigRoutes } from "./routes/api-config.js";
import { createBridgeRoutes } from "./routes/api-bridge.js";

export async function createWebServer(ctx, config) {
  const app = express();
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const publicDir = path.resolve(__dirname, "../../public");

  app.use(express.json());
  app.use(csrfMiddleware);
  app.use(express.static(publicDir));

  // Auth routes (no auth required)
  app.use("/auth", createAuthRoutes(ctx, config));

  // API routes (auth required)
  app.use("/api", requireAuth, createAuthRoutes(ctx, config));
  app.use("/api", requireAuth, createConfigRoutes(ctx));
  app.use("/api", requireAuth, createBridgeRoutes(ctx));

  // SPA fallback
  app.get("/{*path}", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  const port = Number(config.WEB_PORT);
  app.listen(port, () => {
    log.info(`Web UI listening on port ${port}`);
  });
}
