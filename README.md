# MeshCore Discord Bridge

A bidirectional bridge between **MeshCore** mesh networks and **Discord**, with webhook-based message display, image uploads, emoji reaction mirroring, and operator controls.

This fork significantly extends the original project with multi-channel routing, multi-server support, flood protection, message chunking, reaction mirroring (compatible with MeshCoreOne), webhook-based posting with per-user avatars, image uploads, and much more.

---

## Prerequisites

* **Node.js:** v18.0.0 or higher (required for top-level await and native fetch)
* **Hardware:** A MeshCore node flashed with the latest client firmware, connected via USB
* **Process Manager:** PM2 is recommended for 24/7 background operation

---

## Installation & Setup

### 1. Clone & Install

```bash
git clone https://github.com/tek126/MeshCoreDiscordBridge.git
cd MeshCoreDiscordBridge
npm install
```

### 2. Hardware

1. Flash your MeshCore node and connect it via USB.
2. Identify your serial port:
   - Linux: `/dev/ttyUSB0` or `/dev/ttyACM0`
   - macOS: `/dev/tty.usbserial-XXXX`
   - Windows: `COM3`, `COM4`, etc.

### 3. Discord Developer Portal

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. In the **Bot** tab, enable:
   - Presence Intent
   - Server Members Intent
   - Message Content Intent
3. Copy your **Bot Token**.
4. Go to **OAuth2 > URL Generator**, select `bot` and `applications.commands`, then use the generated link to invite the bot to your server.
5. Grant the bot these permissions in each bridged channel:
   - **Send Messages**
   - **Manage Webhooks** (required for webhook-based message display)
   - **Add Reactions** (required for reaction mirroring from mesh)

### 4. ImgBB API Key (for image uploads)

1. Create a free account at [imgbb.com](https://imgbb.com)
2. Go to [api.imgbb.com](https://api.imgbb.com) and click "Get API Key"
3. Copy the key into your config

### 5. Configuration

Create a `config.json` in the root directory (this file is gitignored):

```json
{
  "identifier": "!",
  "CLIENT_ID": "YOUR_APPLICATION_ID",
  "DISCORD_TOKEN": "YOUR_BOT_TOKEN",
  "SERIAL_PORT": "/dev/ttyUSB0",
  "GUILD_IDS": ["YOUR_SERVER_ID"],
  "DISCORD_CHANNEL_ID": "YOUR_PRIMARY_CHANNEL_ID",
  "DISCORD_CHANNEL_ID_MESHMONDAY": "",
  "IMGBB_API_KEY": "YOUR_IMGBB_API_KEY",
  "DEBUG": false,
  "DISCORD_ROUTES": {
    "0": "DISCORD_CHANNEL_FOR_MESH_CH_0",
    "1": "DISCORD_CHANNEL_FOR_MESH_CH_1"
  },
  "DISCORD_TO_MESH_ROUTES": {
    "DISCORD_CHANNEL_ID": 0,
    "ANOTHER_CHANNEL_ID": 1
  },
  "DISCORD_ALWAYS_FORWARD_CHANNEL_IDS": [
    "CHANNEL_ID_1",
    "CHANNEL_ID_2"
  ],
  "BRIDGE_PREFIXES": ["txtMesh 💬"],
  "BRIDGE_ADMIN_ROLE_IDS": [],
  "NODE_ANNOUNCE_CHANNEL_ID": "",
  "FLOOD_PROTECT": {
    "WINDOW_SECONDS": 15,
    "MAX_MESSAGES_PER_WINDOW": 6,
    "COOLDOWN_SECONDS": 300,
    "WARN_IN_CHANNEL": true
  },
  "MESH_MAXLEN": 120,
  "MESH_CHUNK_DELAY_MS": 4000
}
```

#### Config Reference

| Key | Description |
|-----|-------------|
| `identifier` | Prefix for legacy text commands (e.g. `!send`) |
| `CLIENT_ID` | Discord application ID |
| `DISCORD_TOKEN` | Discord bot token |
| `SERIAL_PORT` | USB serial port for MeshCore device |
| `GUILD_IDS` | Array of Discord server IDs for slash command registration |
| `DISCORD_CHANNEL_ID` | Default Discord channel for messages |
| `DISCORD_CHANNEL_ID_MESHMONDAY` | Optional channel for #meshmonday messages |
| `IMGBB_API_KEY` | ImgBB API key for image uploads |
| `DEBUG` | Enable verbose debug logging |
| `DISCORD_ROUTES` | Maps mesh channel index to Discord channel ID (mesh -> Discord) |
| `DISCORD_TO_MESH_ROUTES` | Maps Discord channel ID to mesh channel index (Discord -> mesh) |
| `DISCORD_ALWAYS_FORWARD_CHANNEL_IDS` | Channels that auto-forward all messages to mesh |
| `BRIDGE_PREFIXES` | Array of other bridge node names to strip (e.g. `["txtMesh 💬"]`) |
| `BRIDGE_ADMIN_ROLE_IDS` | Discord role IDs allowed to use admin commands |
| `NODE_ANNOUNCE_CHANNEL_ID` | Channel for new node announcements (defaults to primary channel) |
| `FLOOD_PROTECT` | Rate limiting settings for Discord -> mesh |
| `MESH_MAXLEN` | Max message length for mesh (default 120) |
| `MESH_CHUNK_DELAY_MS` | Delay between chunked message parts in ms |

---

## Running the Bridge

### With PM2 (recommended)

```bash
sudo npm install pm2@latest -g
pm2 start main.js --name mesh-bridge
pm2 logs mesh-bridge
```

To persist across reboots:

```bash
pm2 startup
pm2 save
```

### Direct

```bash
node main.js
```

---

## Features

### Mesh to Discord
- **Webhook-based display** — Mesh users appear with their own username and unique auto-generated avatar in Discord
- **Reaction mirroring** — Emoji reactions from MeshCoreOne are applied as native Discord reactions on the correct message (hash-compatible with MeshCoreOne's Crockford Base32 algorithm)
- **Bridge prefix stripping** — Configurable list of other bridge prefixes to strip (e.g. `txtMesh 💬:`)
- **Message deduplication** — Duplicate messages from multiple bridges are detected and dropped (30-second window)
- **Node join announcements** — New mesh nodes are announced in Discord when first discovered
- **Profanity filter** — Configurable language warning sent back to mesh

### Discord to Mesh
- **Always-forward channels** — Designated Discord channels automatically relay all messages to mesh
- **Image uploads** — Images posted in Discord are uploaded to ImgBB, shortened via TinyURL, and the link is sent to mesh
- **Reaction mirroring** — Discord emoji reactions on bridged messages are sent to mesh in MeshCoreOne-compatible format
- **`[D]` tag** — Discord-origin messages are tagged with `[D]` so mesh users can identify them
- **Message chunking** — Long messages are split with `n/N` counters and paced to avoid mesh overload
- **Flood protection** — Per-channel rate limiting prevents accidental mesh spam

### Bridge Controls
- **Auto-reconnect** — Automatically reconnects if the USB serial connection drops
- **Live config reload** — Reload `config.json` without restarting via `/bridge reload`
- **Pause/resume** — Temporarily halt all forwarding in both directions

---

## Commands

Use `/meshhelp` in Discord to see all available commands.

| Command | Description | Permission |
|---------|-------------|------------|
| `/send <message>` | Send a message to mesh | Everyone |
| `/advert` | Send a flood advert | Everyone |
| `/nodes` | List all known mesh nodes | Everyone |
| `/repeater <name>` | Show repeater info and stats | Everyone |
| `/meshhelp` | Show command help | Everyone |
| `/bridge status` | Show bridge status | Admin |
| `/bridge pause` | Pause forwarding | Admin |
| `/bridge resume` | Resume forwarding | Admin |
| `/bridge reload` | Reload config.json | Admin |

Legacy prefix commands (`!send`, `!advert`) are also supported using the configured `identifier`.

---

## Credits

Originally created by [Hude06](https://github.com/Hude06/MeshCoreDiscordBridge). This fork by [tek126](https://github.com/tek126/MeshCoreDiscordBridge) with significant feature additions.
