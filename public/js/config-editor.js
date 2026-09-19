import { apiFetch } from "./api.js";

let currentConfig = {};

export async function renderConfigEditor(container) {
  container.innerHTML = `<div class="config-loading">Loading config...</div>`;

  try {
    currentConfig = await apiFetch("/api/config");
    renderForm(container);
  } catch (e) {
    container.innerHTML = `<div class="error">Failed to load config: ${e.message}</div>`;
  }
}

function renderForm(container) {
  const keys = Object.keys(currentConfig).sort((a, b) => {
    const order = ["identifier", "CLIENT_ID", "DISCORD_TOKEN", "SERIAL_PORT", "GUILD_IDS",
      "DEBUG", "DISCORD_CHANNEL_ID"];
    const ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  let html = `<div class="config-form">`;

  for (const key of keys) {
    html += renderField(key, currentConfig[key]);
  }

  html += `
    <div class="config-actions">
      <button id="cfg-save" class="btn btn-ok">Save</button>
      <button id="cfg-save-reload" class="btn btn-neutral">Save &amp; Reload</button>
      <span id="cfg-msg" class="config-msg"></span>
    </div>
  </div>`;

  container.innerHTML = html;

  document.getElementById("cfg-save").onclick = () => saveConfig(false);
  document.getElementById("cfg-save-reload").onclick = () => saveConfig(true);
}

function renderField(key, value) {
  const type = getValueType(value);
  const id = `cfg-${key}`;

  let input;
  if (type === "boolean") {
    input = `<label class="toggle"><input type="checkbox" id="${id}" ${value ? "checked" : ""}><span class="toggle-slider"></span></label>`;
  } else if (type === "number") {
    input = `<input type="number" id="${id}" value="${value ?? ""}" class="cfg-input">`;
  } else if (type === "string") {
    const isSecret = ["DISCORD_TOKEN", "WEB_CLIENT_SECRET", "IMGBB_API_KEY"].includes(key);
    input = `<input type="${isSecret ? "password" : "text"}" id="${id}" value="${escHtml(String(value ?? ""))}" class="cfg-input">`;
  } else if (type === "string-array") {
    input = renderStringArray(id, value);
  } else if (type === "object-array") {
    input = `<textarea id="${id}" class="cfg-textarea" rows="4">${escHtml(JSON.stringify(value, null, 2))}</textarea>`;
  } else if (type === "kv-object") {
    input = renderKvObject(id, value);
  } else if (type === "object") {
    input = `<textarea id="${id}" class="cfg-textarea" rows="4">${escHtml(JSON.stringify(value, null, 2))}</textarea>`;
  } else if (value === null) {
    input = `<input type="text" id="${id}" value="" class="cfg-input" placeholder="null">`;
  } else {
    input = `<input type="text" id="${id}" value="${escHtml(String(value))}" class="cfg-input">`;
  }

  return `
    <div class="config-field">
      <label class="cfg-label" for="${id}">${key}</label>
      <div class="cfg-control">${input}</div>
    </div>
  `;
}

function renderStringArray(id, arr) {
  const items = (arr || []).map((v, i) => `
    <div class="tag-item">
      <input type="text" value="${escHtml(String(v))}" class="tag-input" data-id="${id}" data-idx="${i}">
      <button class="tag-remove" data-id="${id}" data-idx="${i}">&times;</button>
    </div>
  `).join("");

  return `<div class="tag-list" id="${id}">${items}
    <button class="tag-add btn-sm" data-id="${id}">+ Add</button>
  </div>`;
}

function renderKvObject(id, obj) {
  const entries = Object.entries(obj || {});
  const rows = entries.map(([k, v], i) => `
    <div class="kv-row">
      <input type="text" value="${escHtml(k)}" class="kv-key" data-id="${id}" data-idx="${i}" placeholder="key">
      <input type="text" value="${escHtml(String(v))}" class="kv-val" data-id="${id}" data-idx="${i}" placeholder="value">
      <button class="tag-remove" data-id="${id}" data-idx="${i}">&times;</button>
    </div>
  `).join("");

  return `<div class="kv-editor" id="${id}">${rows}
    <button class="tag-add btn-sm" data-id="${id}">+ Add</button>
  </div>`;
}

// Delegate click handlers for dynamic add/remove
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("tag-add")) {
    const id = e.target.dataset.id;
    const container = document.getElementById(id);
    if (!container) return;

    if (container.classList.contains("kv-editor")) {
      const idx = container.querySelectorAll(".kv-row").length;
      const row = document.createElement("div");
      row.className = "kv-row";
      row.innerHTML = `
        <input type="text" class="kv-key" data-id="${id}" data-idx="${idx}" placeholder="key">
        <input type="text" class="kv-val" data-id="${id}" data-idx="${idx}" placeholder="value">
        <button class="tag-remove" data-id="${id}" data-idx="${idx}">&times;</button>
      `;
      container.insertBefore(row, e.target);
    } else {
      const idx = container.querySelectorAll(".tag-item").length;
      const item = document.createElement("div");
      item.className = "tag-item";
      item.innerHTML = `
        <input type="text" value="" class="tag-input" data-id="${id}" data-idx="${idx}">
        <button class="tag-remove" data-id="${id}" data-idx="${idx}">&times;</button>
      `;
      container.insertBefore(item, e.target);
    }
  }

  if (e.target.classList.contains("tag-remove")) {
    e.target.parentElement.remove();
  }
});

function getValueType(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  if (typeof value === "string") return "string";
  if (Array.isArray(value)) {
    if (value.length === 0 || typeof value[0] === "string") return "string-array";
    return "object-array";
  }
  if (typeof value === "object") {
    const vals = Object.values(value);
    if (vals.length > 0 && vals.every(v => typeof v === "string" || typeof v === "number")) {
      return "kv-object";
    }
    return "object";
  }
  return "unknown";
}

function collectFormValues() {
  const result = {};

  document.querySelectorAll(".config-field").forEach(field => {
    const label = field.querySelector(".cfg-label");
    if (!label) return;
    const key = label.textContent;
    const id = `cfg-${key}`;
    const el = document.getElementById(id);
    if (!el) return;

    const origType = getValueType(currentConfig[key]);

    if (origType === "boolean") {
      result[key] = el.checked;
    } else if (origType === "number") {
      const v = el.value.trim();
      result[key] = v === "" ? null : Number(v);
    } else if (origType === "string") {
      result[key] = el.value;
    } else if (origType === "string-array") {
      const inputs = el.querySelectorAll(".tag-input");
      result[key] = Array.from(inputs).map(i => i.value).filter(v => v.length > 0);
    } else if (origType === "kv-object") {
      const obj = {};
      el.querySelectorAll(".kv-row").forEach(row => {
        const k = row.querySelector(".kv-key")?.value?.trim();
        const v = row.querySelector(".kv-val")?.value?.trim();
        if (k) {
          obj[k] = /^\d+$/.test(v) ? Number(v) : v;
        }
      });
      result[key] = obj;
    } else if (origType === "object-array" || origType === "object") {
      try {
        result[key] = JSON.parse(el.value);
      } catch {
        result[key] = currentConfig[key];
      }
    } else if (origType === "null") {
      const v = el.value.trim();
      result[key] = v === "" ? null : (isNaN(Number(v)) ? v : Number(v));
    } else {
      result[key] = el.value;
    }
  });

  return result;
}

async function saveConfig(andReload) {
  const msgEl = document.getElementById("cfg-msg");
  try {
    const values = collectFormValues();
    const resp = await apiFetch("/api/config", { method: "PUT", body: values });
    if (resp.warnings?.length > 0) {
      msgEl.textContent = `Saved with warnings: ${resp.warnings.join(", ")}`;
      msgEl.className = "config-msg msg-warn";
    } else {
      msgEl.textContent = "Saved!";
      msgEl.className = "config-msg msg-ok";
    }

    if (andReload) {
      await apiFetch("/api/bridge/reload", { method: "POST" });
      msgEl.textContent += " Config reloaded.";
    }

    currentConfig = await apiFetch("/api/config");
    setTimeout(() => { msgEl.textContent = ""; }, 5000);
  } catch (e) {
    msgEl.textContent = e.message;
    msgEl.className = "config-msg msg-err";
  }
}

function escHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
