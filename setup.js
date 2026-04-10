import readline from "readline";
import fs from "fs";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question, defaultVal = "") {
  const suffix = defaultVal ? ` [${defaultVal}]` : "";
  return new Promise((resolve) => {
    rl.question(`${question}${suffix}: `, (answer) => {
      resolve(answer.trim() || defaultVal);
    });
  });
}

async function askYesNo(question, defaultVal = "y") {
  const answer = await ask(`${question} (y/n)`, defaultVal);
  return answer.toLowerCase().startsWith("y");
}

function printSection(title) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"=".repeat(60)}\n`);
}

function printHelp(text) {
  console.log(`  -> ${text}`);
}

async function main() {
  console.log(`
  __  __           _      ____
 |  \\/  | ___  ___| |__  / ___|___  _ __ ___
 | |\\/| |/ _ \\/ __| '_ \\| |   / _ \\| '__/ _ \\
 | |  | |  __/\\__ \\ | | | |__| (_) | | |  __/
 |_|  |_|\\___||___/_| |_|\\____\\___/|_|  \\___|
  Discord Bridge Setup Wizard
`);

  // Load existing config if present
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync("./config.json", "utf8"));
    console.log("  Found existing config.json — current values will be shown as defaults.\n");
  } catch {
    console.log("  No existing config.json found — starting fresh.\n");
  }

  const config = {};

  // ============================================================
  // Discord Bot Setup
  // ============================================================
  printSection("Discord Bot Setup");

  printHelp("Go to https://discord.com/developers/applications");
  printHelp("Click your application (or create one).");
  printHelp("The Application ID is on the General Information page.\n");
  config.CLIENT_ID = await ask("Application (Client) ID", existing.CLIENT_ID || "");

  printHelp("\nGo to the Bot tab in the Developer Portal.");
  printHelp("Click 'Reset Token' to generate a new token, or use your existing one.");
  printHelp("Make sure these Privileged Intents are enabled:");
  printHelp("  - Presence Intent");
  printHelp("  - Server Members Intent");
  printHelp("  - Message Content Intent\n");
  config.DISCORD_TOKEN = await ask("Bot Token", existing.DISCORD_TOKEN || "");

  printHelp("\nRight-click your Discord server name -> Copy Server ID.");
  printHelp("(Enable Developer Mode in Discord Settings -> Advanced if you don't see this.)\n");
  const guildIdInput = await ask("Server (Guild) ID(s), comma-separated", (existing.GUILD_IDS || []).join(", "));
  config.GUILD_IDS = guildIdInput.split(",").map((s) => s.trim()).filter(Boolean);

  // ============================================================
  // Serial Port
  // ============================================================
  printSection("MeshCore Device");

  printHelp("Connect your MeshCore device via USB.");
  printHelp("Common ports: /dev/ttyUSB0 (Linux), /dev/tty.usbserial-XXXX (macOS), COM3 (Windows).");
  printHelp("You can use 'ls /dev/ttyUSB*' or 'ls /dev/ttyACM*' on Linux to find it.\n");
  config.SERIAL_PORT = await ask("Serial port", existing.SERIAL_PORT || "/dev/ttyUSB0");

  printHelp("\nThis is the name your MeshCore device advertises on the mesh network.");
  printHelp("Other mesh users will see this name. Check your device's config if unsure.\n");
  config.MESH_NODE_NAME = await ask("Mesh node name", existing.MESH_NODE_NAME || "");

  // ============================================================
  // Discord Channels
  // ============================================================
  printSection("Discord Channel Setup");

  printHelp("Right-click any Discord channel -> Copy Channel ID to get its ID.\n");

  printHelp("This is the default channel for messages that don't match a specific route.");
  config.DISCORD_CHANNEL_ID = await ask("Default/Public Discord channel ID", existing.DISCORD_CHANNEL_ID || "");

  // ============================================================
  // Channel Routing
  // ============================================================
  printSection("Channel Routing");

  printHelp("Map mesh channel indices to Discord channel IDs.");
  printHelp("Mesh channel 0 is typically 'Public'.");
  printHelp("You can find mesh channel indices in MeshCoreOne or the companion app.");
  printHelp("Enter routes as: meshIndex=discordChannelId (one per line).");
  printHelp("Press Enter on an empty line when done.\n");

  config.DISCORD_ROUTES = { ...existing.DISCORD_ROUTES } || {};
  config.DISCORD_TO_MESH_ROUTES = { ...existing.DISCORD_TO_MESH_ROUTES } || {};

  if (Object.keys(config.DISCORD_ROUTES).length > 0) {
    console.log("  Current routes:");
    for (const [idx, chId] of Object.entries(config.DISCORD_ROUTES)) {
      console.log(`    Mesh ch ${idx} -> Discord ${chId}`);
    }
    const keepRoutes = await askYesNo("\n  Keep existing routes?", "y");
    if (!keepRoutes) {
      config.DISCORD_ROUTES = {};
      config.DISCORD_TO_MESH_ROUTES = {};
    }
  }

  if (await askYesNo("Add channel routes?", Object.keys(config.DISCORD_ROUTES).length === 0 ? "y" : "n")) {
    while (true) {
      const route = await ask("  meshIndex=discordChannelId (or Enter to finish)");
      if (!route) break;
      const [idx, chId] = route.split("=").map((s) => s.trim());
      if (idx && chId) {
        config.DISCORD_ROUTES[idx] = chId;
        config.DISCORD_TO_MESH_ROUTES[chId] = Number(idx);
        console.log(`    Added: Mesh ch ${idx} <-> Discord ${chId}`);
      }
    }
  }

  // ============================================================
  // Always-Forward Channels
  // ============================================================
  printSection("Always-Forward Channels");

  printHelp("These Discord channels automatically forward ALL messages to mesh.");
  printHelp("They must also have a route configured above.");
  printHelp("Enter Discord channel IDs, one per line. Enter to finish.\n");

  config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS = [...(existing.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS || [])];

  if (config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS.length > 0) {
    console.log("  Current always-forward channels:");
    for (const id of config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS) {
      console.log(`    ${id}`);
    }
    const keepForward = await askYesNo("\n  Keep existing list?", "y");
    if (!keepForward) {
      config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS = [];
    }
  }

  if (await askYesNo("Add always-forward channels?", config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS.length === 0 ? "y" : "n")) {
    while (true) {
      const chId = await ask("  Discord channel ID (or Enter to finish)");
      if (!chId) break;
      if (!config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS.includes(chId)) {
        config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS.push(chId);
        console.log(`    Added: ${chId}`);
      }
    }
  }

  // ============================================================
  // ImgBB (Image Uploads)
  // ============================================================
  printSection("Image Uploads (Optional)");

  printHelp("Images posted in Discord can be uploaded to ImgBB and the link sent to mesh.");
  printHelp("Sign up at https://imgbb.com, then get an API key at https://api.imgbb.com\n");
  config.IMGBB_API_KEY = await ask("ImgBB API key (or Enter to skip)", existing.IMGBB_API_KEY || "");

  // ============================================================
  // Emergency Channel (Optional)
  // ============================================================
  printSection("Emergency Channel (Optional)");

  printHelp("An emergency mesh channel can trigger @everyone alerts on Discord.");
  printHelp("First message pings everyone, auto-replies to mesh, and reminds if no response.\n");

  if (await askYesNo("Configure an emergency channel?", existing.EMERGENCY_MESH_CHANNEL_IDX != null ? "y" : "n")) {
    config.EMERGENCY_MESH_CHANNEL_IDX = Number(await ask("  Emergency mesh channel index", String(existing.EMERGENCY_MESH_CHANNEL_IDX ?? "")));
    config.EMERGENCY_DISCORD_CHANNEL_ID = await ask("  Emergency Discord channel ID", existing.EMERGENCY_DISCORD_CHANNEL_ID || "");
    config.EMERGENCY_COOLDOWN_MINUTES = Number(await ask("  Cooldown before re-alerting (minutes)", String(existing.EMERGENCY_COOLDOWN_MINUTES ?? 30)));
    config.EMERGENCY_REMINDER_MINUTES = Number(await ask("  Reminder if no reply (minutes)", String(existing.EMERGENCY_REMINDER_MINUTES ?? 5)));
  } else {
    config.EMERGENCY_MESH_CHANNEL_IDX = null;
    config.EMERGENCY_DISCORD_CHANNEL_ID = "";
    config.EMERGENCY_COOLDOWN_MINUTES = 30;
    config.EMERGENCY_REMINDER_MINUTES = 5;
  }

  // ============================================================
  // Bridge Prefixes
  // ============================================================
  printSection("Bridge Prefix Stripping (Optional)");

  printHelp("If other bridges relay messages to your mesh network, their node name");
  printHelp("gets prepended to messages (e.g. 'txtMesh: SomeUser: hello').");
  printHelp("List bridge names here to strip them for cleaner display.\n");

  config.BRIDGE_PREFIXES = [...(existing.BRIDGE_PREFIXES || [])];

  if (config.BRIDGE_PREFIXES.length > 0) {
    console.log("  Current prefixes:", config.BRIDGE_PREFIXES.join(", "));
  }

  if (await askYesNo("Add bridge prefixes?", config.BRIDGE_PREFIXES.length === 0 ? "y" : "n")) {
    while (true) {
      const prefix = await ask("  Bridge node name (or Enter to finish)");
      if (!prefix) break;
      if (!config.BRIDGE_PREFIXES.includes(prefix)) {
        config.BRIDGE_PREFIXES.push(prefix);
      }
    }
  }

  // ============================================================
  // Advanced Settings
  // ============================================================
  printSection("Advanced Settings");

  config.identifier = await ask("Command prefix for legacy text commands", existing.identifier || "!");
  config.MESH_MAXLEN = Number(await ask("Max mesh message length", String(existing.MESH_MAXLEN ?? 120)));
  config.MESH_CHUNK_DELAY_MS = Number(await ask("Delay between chunked messages (ms)", String(existing.MESH_CHUNK_DELAY_MS ?? 4000)));
  config.DEBUG = await askYesNo("Enable debug logging?", existing.DEBUG ? "y" : "n");

  // Flood protection
  const floodCfg = existing.FLOOD_PROTECT || {};
  config.FLOOD_PROTECT = {
    WINDOW_SECONDS: Number(await ask("Flood window (seconds)", String(floodCfg.WINDOW_SECONDS ?? 15))),
    MAX_MESSAGES_PER_WINDOW: Number(await ask("Max messages per window", String(floodCfg.MAX_MESSAGES_PER_WINDOW ?? 6))),
    COOLDOWN_SECONDS: Number(await ask("Flood cooldown (seconds)", String(floodCfg.COOLDOWN_SECONDS ?? 300))),
    WARN_IN_CHANNEL: await askYesNo("Warn in channel when flood protection triggers?", floodCfg.WARN_IN_CHANNEL !== false ? "y" : "n"),
  };

  // ============================================================
  // Optional fields with defaults
  // ============================================================
  config.DISCORD_CHANNEL_ID_MESHMONDAY = existing.DISCORD_CHANNEL_ID_MESHMONDAY || "";
  config.NODE_ANNOUNCE_CHANNEL_ID = existing.NODE_ANNOUNCE_CHANNEL_ID || "";
  config.SUBSCRIBE_CHANNEL_ID = existing.SUBSCRIBE_CHANNEL_ID || "";
  config.SUBSCRIBE_MESSAGE_ID = existing.SUBSCRIBE_MESSAGE_ID || "";
  config.SUBSCRIBABLE_CHANNELS = existing.SUBSCRIBABLE_CHANNELS || [];
  config.BRIDGE_ADMIN_ROLE_IDS = existing.BRIDGE_ADMIN_ROLE_IDS || [];
  config._SUBSCRIBE_ROLE_MAP = existing._SUBSCRIBE_ROLE_MAP || [];

  // ============================================================
  // Save
  // ============================================================
  printSection("Save Configuration");

  console.log("  Config preview:\n");
  console.log(`  Bot Token:      ${config.DISCORD_TOKEN ? "****" + config.DISCORD_TOKEN.slice(-6) : "(not set)"}`);
  console.log(`  Client ID:      ${config.CLIENT_ID || "(not set)"}`);
  console.log(`  Guild IDs:      ${config.GUILD_IDS.join(", ") || "(none)"}`);
  console.log(`  Serial Port:    ${config.SERIAL_PORT}`);
  console.log(`  Node Name:      ${config.MESH_NODE_NAME || "(not set)"}`);
  console.log(`  Routes:         ${Object.keys(config.DISCORD_ROUTES).length} configured`);
  console.log(`  Always-Forward: ${config.DISCORD_ALWAYS_FORWARD_CHANNEL_IDS.length} channels`);
  console.log(`  ImgBB:          ${config.IMGBB_API_KEY ? "configured" : "not set"}`);
  console.log(`  Emergency:      ${config.EMERGENCY_MESH_CHANNEL_IDX != null ? "configured" : "not set"}`);
  console.log(`  Debug:          ${config.DEBUG}`);
  console.log("");

  if (fs.existsSync("./config.json")) {
    const overwrite = await askYesNo("config.json already exists. Overwrite?", "y");
    if (!overwrite) {
      console.log("\n  Aborted. Config not saved.\n");
      rl.close();
      return;
    }
  }

  fs.writeFileSync("./config.json", JSON.stringify(config, null, 2));
  console.log("\n  config.json saved successfully!");
  console.log("\n  Next steps:");
  console.log("    1. npm install");
  console.log("    2. node main.js (or pm2 start main.js --name mesh-bridge)");
  console.log("    3. Run /subscribe-setup in Discord to set up channel subscriptions\n");

  rl.close();
}

main().catch((e) => {
  console.error("Setup error:", e);
  rl.close();
  process.exit(1);
});
