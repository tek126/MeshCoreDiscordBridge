function getCsrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)csrf=([^;]*)/);
  return match ? match[1] : "";
}

export async function apiFetch(url, opts = {}) {
  const headers = { ...opts.headers };

  if (opts.body && typeof opts.body === "object" && !(opts.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(opts.body);
  }

  if (["POST", "PUT", "PATCH", "DELETE"].includes((opts.method || "GET").toUpperCase())) {
    headers["X-CSRF-Token"] = getCsrfToken();
  }

  const res = await fetch(url, { ...opts, headers });

  if (res.status === 401) {
    window.location.hash = "";
    showLogin("Session expired. Please log in again.");
    throw new Error("Unauthorized");
  }

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `Request failed: ${res.status}`);
  }

  return res.json();
}

function showLogin(msg) {
  const event = new CustomEvent("show-login", { detail: msg });
  window.dispatchEvent(event);
}
