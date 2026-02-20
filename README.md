# MeshCore ↔ Discord Bridge

This project provides a bridge between **MeshCore** and **Discord**, allowing messages to flow between RF mesh networks and Discord channels.

This fork significantly extends the original project with **multi-channel routing, multi-server support, flood protection, message chunking, and operator controls**, making it suitable for real-world mesh deployments where bandwidth is limited and message loss is possible.

---

## MeshCore Setup

1. Flash your MeshCore node with the **latest client firmware** over USB.
2. Connect the node to the system running this bridge.
3. Update `config.json` and set the correct serial port for your node:
   - Linux: `/dev/ttyUSB0`, `/dev/ttyACM0`
   - macOS: `/dev/tty.usbserial-XXXX`
   - Windows: `COM3`, `COM4`, etc.

---

## Discord Setup

1. Open the **Discord Developer Portal** and create a new application.
2. In the **Bot** tab, enable:
   - Presence Intent  
   - Server Members Intent  
   - Message Content Intent
3. Copy your **Bot Token** into `config.json`.
4. Enable **Developer Mode** in Discord.
5. Copy the IDs of the Discord channels you want to bridge.
6. Add the bot to one or more servers (guilds).
7. Configure routing and permissions in `config.json`.

This fork supports **multiple Discord servers (guilds)** from a single bot instance.

---

## Message Flow Overview

### Mesh → Discord

- Mesh messages are routed to Discord channels based on **mesh channel index**.
- PocketMesh emoji “reaction” messages are automatically ignored.
- Profanity triggers a warning back to the originating mesh channel and echoes the warning in Discord.
- Optional hashtag-based routing (e.g. `#meshmonday`) is preserved.
- Forwarding can be paused globally via command.

### Discord → Mesh

- Messages can be sent via:
  - Slash command (`/send`)
  - Prefix command (`!send`, `/send`, etc.)
  - Always-forward mode for a designated Discord channel
- Discord channels are explicitly mapped to mesh channel indices.
- Long messages are safely **chunked and paced** to fit MeshCore limits.
- Flood protection prevents accidental mesh overload.

---

## Commands

### Discord → Mesh

- `/send <message>`
- `!send <message>` (prefix configurable)
- `/advert` or `!advert` — sends a flood advert from the connected node

Messages are routed to the mesh channel mapped to the Discord channel they originate from.

---

### Bridge Control Commands

These commands require Administrator, Manage Guild, or an allowed role.

- `/bridge status` — show current forwarding state  
- `/bridge pause` — pause all mesh ↔ Discord forwarding  
- `/bridge resume` — resume normal operation  

---

## Flood Protection

To protect the mesh from excessive traffic:

- Per-Discord-channel rate limiting is enforced.
- Exceeding the limit triggers a temporary cooldown.
- An optional warning message is posted in Discord.
- All thresholds are configurable.

---

## Mesh Message Chunking & Reliability

MeshCore imposes message length and throughput limits. This fork adds:

- Automatic **message chunking** for long Discord messages
- `n/N` counters added **only when chunking is required**
- Configurable delay between chunks
- A serialized send queue to prevent interleaving
- Tunable maximum length for different firmware/client behavior

This greatly improves delivery reliability on lossy or multi-hop mesh networks.

---

## Configuration (`config.json`)

### Core Settings

```json
"identifier"
"CLIENT_ID"
"DISCORD_TOKEN"
"SERIAL_PORT"
"GUILD_IDS"
