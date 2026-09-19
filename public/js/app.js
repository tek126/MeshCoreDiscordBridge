import { apiFetch } from "./api.js";
import { renderStatus, renderControls, stopStatusPolling } from "./bridge-controls.js";
import { renderConfigEditor } from "./config-editor.js";

const loginScreen = document.getElementById("login-screen");
const appScreen = document.getElementById("app-screen");
const content = document.getElementById("tab-content");
const userInfo = document.getElementById("user-info");
const tabs = document.querySelectorAll(".tab-btn");

window.addEventListener("show-login", (e) => {
  showLogin(e.detail);
});

async function init() {
  // Check for error params
  const params = new URLSearchParams(window.location.search);
  if (params.get("error")) {
    const errors = {
      forbidden: "Access denied. You need an admin role in the Discord server.",
      denied: "Discord authorization was cancelled.",
      invalid_state: "Invalid OAuth state. Please try again.",
      auth_failed: "Authentication failed. Please try again.",
    };
    document.getElementById("login-error").textContent = errors[params.get("error")] || "Login failed.";
    window.history.replaceState({}, "", "/");
    showLogin();
    return;
  }

  try {
    const me = await apiFetch("/api/me");
    showApp(me);
  } catch {
    showLogin();
  }
}

function showLogin(msg) {
  loginScreen.classList.remove("hidden");
  appScreen.classList.add("hidden");
  if (msg) document.getElementById("login-error").textContent = msg;
}

function showApp(user) {
  loginScreen.classList.add("hidden");
  appScreen.classList.remove("hidden");

  const avatarUrl = user.avatar
    ? `https://cdn.discordapp.com/avatars/${user.userId}/${user.avatar}.png?size=32`
    : "https://cdn.discordapp.com/embed/avatars/0.png";
  userInfo.innerHTML = `<img src="${avatarUrl}" class="avatar"> ${user.username} <a href="/auth/logout" class="logout-link">Logout</a>`;

  // Tab navigation
  tabs.forEach(tab => {
    tab.onclick = () => navigate(tab.dataset.tab);
  });

  window.addEventListener("hashchange", () => {
    const hash = window.location.hash.slice(1) || "status";
    navigate(hash);
  });

  const hash = window.location.hash.slice(1) || "status";
  navigate(hash);
}

function navigate(tab) {
  stopStatusPolling();

  tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === tab));
  window.location.hash = tab;

  switch (tab) {
    case "status":
      renderStatus(content);
      break;
    case "config":
      renderConfigEditor(content);
      break;
    case "controls":
      renderControls(content);
      break;
    default:
      renderStatus(content);
  }
}

init();
