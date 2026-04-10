# MeshCore Discord Bridge

A bidirectional bridge between **MeshCore** mesh networks and **Discord**, with webhook-based message display, image uploads, emoji reaction mirroring, channel subscriptions, emergency alerts, and operator controls.

This fork significantly extends the original project with multi-channel routing, multi-server support, flood protection, message chunking, reaction mirroring (compatible with MeshCoreOne), webhook-based posting with per-user avatars, image uploads, and much more.

---

## Prerequisites

* **Node.js:** v18.0.0 or higher (required for top-level await and native fetch)
* **Hardware:** A MeshCore node flashed with the latest client firmware, connected via USB
* **Process Manager:** PM2 is recommended for 24/7 background operation

---

## Quick Start

```bash
git clone https://github.com/tek126/MeshCoreDiscordBridge.git
cd MeshCoreDiscordBridge
npm install
node setup.js
```

The **setup wizard** will walk you through configuration step by step, including where to find each value in Discord.

---

## Installation & Setup

### 1. Hardware

1. Flash your MeshCore node and connect it via USB.
2. Identify your serial port:
   - Linux: `/dev/ttyUSB0` or `/dev/ttyACM0`
   - macOS: `/dev/tty.usbserial-XXXX`
   - Windows: `COM3`, `COM4`, etc.

### 2. Discord Developer Portal

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and create a new application.
2. In the **Bot** tab, enable:
   - Presence Intent
   - Server Members Intent
   - Message Content Intent
3. Copy your **Bot Token**.
4. Go to **OAuth2 > URL Generator**, select `bot` and `applications.commands`, then use the generated link to invite the bot to your server.
5. Grant the bot these server-level permissions:
   - **Send Messages**
   - **Manage Webhooks** (for webhook-based message display)
   - **Add Reactions** (for reaction mirroring from mesh)
   - **Manage Roles** (for channel subscriptions)
   - **Manage Channels** (for channel subscription visibility)

### 3. ImgBB API Key (optional, for image uploads)

1. Create a free account at [imgbb.com](https://imgbb.com)
2. Go to [api.imgbb.com](https://api.imgbb.com) and click "Get API Key"
3. Copy the key into your config

### 4. Configuration

Run the setup wizard for guided configuration:

```bash
node setup.js
```

Or create `config.json` manually in the root directory (this file is gitignored). See [Config Reference](#config-reference) below for all options.

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
- **Webhook-based display** -- Mesh users appear with their own username and unique auto-generated avatar in Discord
- **Reaction mirroring** -- Emoji reactions from MeshCoreOne are applied as native Discord reactions on the correct message (hash-compatible with MeshCoreOne's Crockford Base32 algorithm)
- **Bridge prefix stripping** -- Configurable list of other bridge node names to strip (e.g. `txtMesh`)
- **Message deduplication** -- Duplicate messages from multiple bridges are detected and dropped (30-second window)
- **Node join announcements** -- New mesh nodes are announced in Discord when first discovered
- **Unmapped channel labels** -- Messages from mesh channels without a Discord route are labeled with the channel name
- **Profanity filter** -- Language warning sent back to mesh

### Discord to Mesh
- **Always-forward channels** -- Designated Discord channels automatically relay all messages to mesh
- **Image uploads** -- Images posted in Discord are uploaded to ImgBB and the link is sent to mesh
- **File attachments** -- Non-image files are sent with file type, size, and a shortened link (e.g. `[PDF, 1.4MB] https://tinyurl.com/...`)
- **Reaction mirroring** -- Discord emoji reactions on bridged messages are sent to mesh in MeshCoreOne-compatible format with correct hash
- **`[D]` tag** -- Discord-origin messages are tagged with `[D]` so mesh users can identify them
- **Message chunking** -- Long messages are split with `n/N` counters and paced to avoid mesh overload
- **Flood protection** -- Per-channel rate limiting prevents accidental mesh spam

### Emergency Channel
- **@everyone alerts** -- First message on the emergency mesh channel pings `@everyone` in Discord
- **Auto-reply** -- Sends a confirmation message back to mesh ("Your message has been forwarded...")
- **Reminder pings** -- If no Discord user responds within a configurable time (default 5 min), pings `@everyone` again
- **Cooldown** -- Configurable cooldown (default 30 min) before a new alert cycle can trigger

### Channel Subscriptions
- **Reaction-based roles** -- Users react to a message to subscribe/unsubscribe from mesh channels
- **Auto-setup** -- `/subscribe-setup` creates roles, sets channel permissions, and posts the subscription message
- **Channel visibility** -- Subscribed channels are visible only to users with the corresponding role
- **Public channels** -- Public and emergency channels remain visible to everyone

### Bridge Controls
- **Auto-reconnect** -- Automatically reconnects if the USB serial connection drops
- **Live config reload** -- Reload `config.json` without restarting via `/bridge reload`
- **Pause/resume** -- Temporarily halt all forwarding in both directions
- **Persistent message history** -- Reaction hash tracking survives restarts (saved to disk)

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
| `/subscribe-setup` | Post channel subscription message | Admin |

Legacy prefix commands (`!send`, `!advert`) are also supported using the configured `identifier`.

---

## Config Reference

Run `node setup.js` for guided configuration. Below is a reference of all config keys.

### Core Settings

| Key | Description |
|-----|-------------|
| `identifier` | Prefix for legacy text commands (e.g. `!` means `!send`) |
| `CLIENT_ID` | Discord Application ID (Developer Portal > General Information) |
| `DISCORD_TOKEN` | Discord bot token (Developer Portal > Bot) |
| `SERIAL_PORT` | USB serial port for MeshCore device (e.g. `/dev/ttyUSB0`) |
| `GUILD_IDS` | Array of Discord server IDs for slash command registration |
| `MESH_NODE_NAME` | Your bridge's MeshCore device name (used for outgoing reaction targeting) |

### Channel Routing

| Key | Description |
|-----|-------------|
| `DISCORD_CHANNEL_ID` | Default/fallback Discord channel for messages |
| `DISCORD_ROUTES` | Maps mesh channel index to Discord channel ID (mesh to Discord) |
| `DISCORD_TO_MESH_ROUTES` | Maps Discord channel ID to mesh channel index (Discord to mesh) |
| `DISCORD_ALWAYS_FORWARD_CHANNEL_IDS` | Discord channels that auto-forward all messages to mesh |
| `DISCORD_CHANNEL_ID_MESHMONDAY` | Optional channel for messages containing `#meshmonday` |

### Image & File Uploads

| Key | Description |
|-----|-------------|
| `IMGBB_API_KEY` | ImgBB API key for image uploads (get one at [api.imgbb.com](https://api.imgbb.com)) |

### Emergency Channel

| Key | Description |
|-----|-------------|
| `EMERGENCY_MESH_CHANNEL_IDX` | Mesh channel index for emergency messages |
| `EMERGENCY_DISCORD_CHANNEL_ID` | Discord channel ID for emergency alerts |
| `EMERGENCY_COOLDOWN_MINUTES` | Minutes before a new alert cycle can trigger (default `30`) |
| `EMERGENCY_REMINDER_MINUTES` | Minutes before re-pinging if no Discord reply (default `5`) |

### Channel Subscriptions

| Key | Description |
|-----|-------------|
| `SUBSCRIBE_CHANNEL_ID` | Discord channel where the subscription message is posted |
| `SUBSCRIBE_MESSAGE_ID` | Auto-populated after running `/subscribe-setup` |
| `SUBSCRIBABLE_CHANNELS` | Array of `{ name, emoji, discordChannelId }` objects |
| `_SUBSCRIBE_ROLE_MAP` | Auto-populated role mapping (do not edit manually) |

### Bridge Configuration

| Key | Description |
|-----|-------------|
| `BRIDGE_PREFIXES` | Array of other bridge node names to strip from messages |
| `BRIDGE_ADMIN_ROLE_IDS` | Discord role IDs allowed to use admin commands |
| `NODE_ANNOUNCE_CHANNEL_ID` | Channel for new node announcements (falls back to default) |
| `DEBUG` | Enable verbose debug logging (`true`/`false`) |

### Message Handling

| Key | Description |
|-----|-------------|
| `MESH_MAXLEN` | Max message length for mesh in characters (default `120`) |
| `MESH_CHUNK_DELAY_MS` | Delay in ms between chunked message parts (default `4000`) |

### Flood Protection (`FLOOD_PROTECT`)

| Key | Description |
|-----|-------------|
| `WINDOW_SECONDS` | Sliding window duration for rate limiting (default `15`) |
| `MAX_MESSAGES_PER_WINDOW` | Max messages allowed per window before cooldown (default `6`) |
| `COOLDOWN_SECONDS` | How long to block forwarding after limit is hit (default `300`) |
| `WARN_IN_CHANNEL` | Post a warning in Discord when flood protection triggers (`true`/`false`) |

---

## Credits

Originally created by [Hude06](https://github.com/Hude06/MeshCoreDiscordBridge). This fork by [tek126](https://github.com/tek126/MeshCoreDiscordBridge) with significant feature additions.
