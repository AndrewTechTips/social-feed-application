// @ts-check
// Turning values into the words and marks a person reads: times, initials, the
// tinted avatar that stands in for a face.
//
// Pure, except that the relative times are relative to *now* — which is worth
// saying out loud, because it is the reason a card re-rendered a minute later
// says something different with the same input.

import { h } from "./dom.js";

// — time ----------------------------------------------------------------------
const MIN = 60,
  HOUR = 3600,
  DAY = 86400;

export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 45) return "just now";
  if (secs < 90) return "a minute ago";
  if (secs < HOUR) return `${Math.round(secs / MIN)}m ago`;
  if (secs < DAY) return `${Math.round(secs / HOUR)}h ago`;
  if (secs < 7 * DAY) return `${Math.round(secs / DAY)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: secs > 330 * DAY ? "numeric" : undefined,
  });
}

export function fullTime(iso) {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

export function wasEdited(post) {
  return post.updated_at && post.created_at && post.updated_at !== post.created_at;
}

// — initials avatar (no image fetch, quiet deterministic tint) -----------
// Takes a username. It used to take an email and split it at the @, which was
// only ever possible because posts carried their author's address around.
export function initials(username) {
  const name = String(username || "");
  const parts = name.split(/[^a-z0-9]+/i).filter(Boolean);
  const pick =
    parts.length >= 2
      ? parts[0][0] + parts[1][0]
      : (name.replace(/[^a-z0-9]/gi, "") || "?").slice(0, 2);
  return pick.toUpperCase();
}

function hueFor(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) hash = (hash * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(hash) % 360;
}

export function avatar(username, variant) {
  return h(
    "span",
    {
      class: "avatar" + (variant ? ` avatar--${variant}` : ""),
      style: { "--h": hueFor(String(username || "")) },
      "aria-hidden": "true",
    },
    initials(username)
  );
}
