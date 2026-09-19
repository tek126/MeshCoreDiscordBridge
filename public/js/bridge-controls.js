import { apiFetch } from "./api.js";

let statusInterval = null;

function timeAgo(ts) {
  if (!ts) return "never";
  const sec = Math.floor((Date.now() - ts) / 1000);
  if (sec < 60) return `${sec}s ago`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m ago`;
}

export function renderStatus(container) {
  container.innerHTML = `
    <div class="status-grid" id="status-grid">
      <div class="status-loading">Loading...</div>
    </div>
  `;
  refreshStatus();
  if (statusInterval) clearInterval(statusInterval);
  statusInterval = setInterval(refreshStatus, 5000);
}

async function refreshStatus() {
  try {
    const data = await apiFetch("/api/status");
    const grid = document.getElementById("status-grid");
    if (!grid) return;

    const paused = data.bridge.paused;
    grid.innerHTML = `
      <div class="stat-card ${paused ? 'stat-warn' : 'stat-ok'}">
        <div class="stat-label">Bridge</div>
        <div class="stat-value">${paused ? "PAUSED" : "RUNNING"}</div>
        ${paused && data.bridge.pausedBy ? `<div class="stat-sub">by ${data.bridge.pausedBy}</div>` : ""}
      </div>
      <div class="stat-card ${data.meshConnected ? 'stat-ok' : 'stat-err'}">
        <div class="stat-label">Mesh Device</div>
        <div class="stat-value">${data.meshConnected ? "Connected" : "Disconnected"}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Uptime</div>
        <div class="stat-value">${data.uptime}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Known Nodes</div>
        <div class="stat-value">${data.knownNodes}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Mesh &rarr; Discord</div>
        <div class="stat-value">${data.metrics.meshToDiscord}</div>
        <div class="stat-sub">${timeAgo(data.metrics.lastMeshMessage)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Discord &rarr; Mesh</div>
        <div class="stat-value">${data.metrics.discordToMesh}</div>
        <div class="stat-sub">${timeAgo(data.metrics.lastDiscordForward)}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Reactions</div>
        <div class="stat-value">${data.metrics.reactionsApplied}</div>
      </div>
      <div class="stat-card ${data.metrics.errors > 0 ? 'stat-warn' : ''}">
        <div class="stat-label">Errors</div>
        <div class="stat-value">${data.metrics.errors}</div>
      </div>
    `;
  } catch (e) {
    // Silently retry on next interval
  }
}

export function renderControls(container) {
  container.innerHTML = `
    <div class="controls-panel">
      <h2>Bridge Controls</h2>
      <div class="control-buttons">
        <button id="btn-pause" class="btn btn-warn">Pause Bridge</button>
        <button id="btn-resume" class="btn btn-ok">Resume Bridge</button>
        <button id="btn-reload" class="btn btn-neutral">Reload Config</button>
      </div>
      <div id="control-msg" class="control-msg"></div>
    </div>
  `;

  document.getElementById("btn-pause").onclick = async () => {
    if (!confirm("Pause all bridge forwarding?")) return;
    try {
      await apiFetch("/api/bridge/pause", { method: "POST" });
      showControlMsg("Bridge paused.", "warn");
    } catch (e) { showControlMsg(e.message, "err"); }
  };

  document.getElementById("btn-resume").onclick = async () => {
    try {
      await apiFetch("/api/bridge/resume", { method: "POST" });
      showControlMsg("Bridge resumed.", "ok");
    } catch (e) { showControlMsg(e.message, "err"); }
  };

  document.getElementById("btn-reload").onclick = async () => {
    if (!confirm("Reload config from disk?")) return;
    try {
      await apiFetch("/api/bridge/reload", { method: "POST" });
      showControlMsg("Config reloaded.", "ok");
    } catch (e) { showControlMsg(e.message, "err"); }
  };
}

function showControlMsg(text, type) {
  const el = document.getElementById("control-msg");
  if (!el) return;
  el.textContent = text;
  el.className = `control-msg msg-${type}`;
  setTimeout(() => { el.textContent = ""; }, 5000);
}

export function stopStatusPolling() {
  if (statusInterval) { clearInterval(statusInterval); statusInterval = null; }
}
