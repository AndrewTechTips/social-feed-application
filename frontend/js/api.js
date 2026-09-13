// fetch wrapper: attaches the auth header, sends/parses JSON, normalises errors,
// and handles the three cross-cutting status codes (401 / 403 / 429) in one place.

import { apiFetch } from "./config.js";
import { get, clearSession } from "./store.js";
import { toast } from "./ui.js";

export class ApiError extends Error {
  constructor(status, detail, data) {
    super(detail || `Request failed (${status})`);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.data = data;
  }
}

// Pull a human string out of FastAPI's error shapes:
//   {"detail": "message"}  or  {"detail": [{loc, msg, ...}]}  (422)
function readDetail(data, status) {
  if (!data) return `Request failed (${status})`;
  const d = data.detail;
  if (typeof d === "string") return d;
  if (Array.isArray(d) && d.length) return d[0].msg || "That didn't go through. Try again?";
  return `Request failed (${status})`;
}

async function request(path, { method = "GET", body, form, auth = true, signal } = {}) {
  const headers = {};
  const session = get("session");
  const sendAuth = auth && session && session.token;
  if (sendAuth) headers.Authorization = `Bearer ${session.token}`;

  let payload;
  if (form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    payload = new URLSearchParams(form).toString();
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    payload = JSON.stringify(body);
  }

  let res;
  try {
    // apiFetch is the real network on a dev machine and the in-browser demo
    // backend on the published site — same arguments, same Response either way.
    res = await apiFetch(path, { method, headers, body: payload, signal });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    // fetch only rejects on network-level failure (server down, DNS, CORS block)
    throw new ApiError(0, "Can't reach the server. Is the backend running?");
  }

  let data = null;
  if (res.status !== 204) {
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch (e) {
        data = { detail: text };
      }
    }
  }

  if (res.ok) return data;

  // — cross-cutting handling ------------------------------------------------
  if (res.status === 401 && sendAuth) {
    clearSession();
    if (!location.hash.startsWith("#/login")) location.hash = "#/login";
    toast("Your session expired.");
  } else if (res.status === 403) {
    toast("You can't edit that.");
  } else if (res.status === 429) {
    toast("You're doing that a bit fast — try again in a minute.");
  }

  throw new ApiError(res.status, readDetail(data, res.status), data);
}

export const api = {
  get: (path, opts) => request(path, { ...opts, method: "GET" }),
  post: (path, body, opts) => request(path, { ...opts, method: "POST", body }),
  put: (path, body, opts) => request(path, { ...opts, method: "PUT", body }),
  patch: (path, body, opts) => request(path, { ...opts, method: "PATCH", body }),
  del: (path, opts) => request(path, { ...opts, method: "DELETE" }),
  form: (path, form, opts) => request(path, { ...opts, method: "POST", form }),
};
