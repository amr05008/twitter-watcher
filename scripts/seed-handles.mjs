#!/usr/bin/env node
// Sync watch-handles.txt -> the Worker's D1 watch list, through the same
// /api/watch-targets and /api/promote routes the API/MCP use. No hand-written SQL.
//
// watch-handles.txt (repo root) is the human-friendly source of truth: one handle
// per line, `#` starts a comment (whole-line or inline), blank lines ignored, a
// leading `@` is stripped.
//
// Config — env vars, falling back to .dev.vars for local dev:
//   WATCHER_URL    base URL of the Worker, e.g. https://twitter-watcher.you.workers.dev
//   TRIGGER_TOKEN  the X-Trigger-Token secret
//
// Flags:
//   --local     target http://localhost:8787 (a running `npm run dev`) instead of WATCHER_URL
//   --prune     remove handles that are in D1 but NOT in the file (true two-way sync)
//   --dry-run   print what would change; make no mutating requests
//
// Examples:
//   WATCHER_URL=https://...workers.dev TRIGGER_TOKEN=xxxx npm run seed
//   npm run seed -- --local --dry-run
//   npm run seed -- --prune

import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const DRY = flags.has("--dry-run");
const PRUNE = flags.has("--prune");
const LOCAL = flags.has("--local");

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// Minimal .dev.vars (dotenv-style) reader, used only as a fallback for config.
async function loadDevVars() {
  try {
    const raw = await readFile(join(root, ".dev.vars"), "utf8");
    const out = {};
    for (const line of raw.split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq !== -1) out[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
    }
    return out;
  } catch {
    return {};
  }
}

// "@Handle  # note" -> "Handle". Returns lowercase-keyed map so we dedupe and diff
// case-insensitively (Twitter handles are), while preserving the file's casing for adds.
function parseHandles(text) {
  const seen = new Map();
  for (const rawLine of text.split("\n")) {
    const handle = rawLine.split("#")[0].trim().replace(/^@/, "").trim();
    if (!handle) continue;
    const key = handle.toLowerCase();
    if (!seen.has(key)) seen.set(key, handle);
  }
  return seen;
}

const devVars = await loadDevVars();
const baseUrl = (LOCAL
  ? "http://localhost:8787"
  : process.env.WATCHER_URL || devVars.WATCHER_URL || ""
).replace(/\/$/, "");
const token = process.env.TRIGGER_TOKEN || devVars.TRIGGER_TOKEN || "";

if (!baseUrl) die("set WATCHER_URL (or pass --local for a running `npm run dev`)");
if (!token) die("set TRIGGER_TOKEN (env var, or in .dev.vars)");

const fileText = await readFile(join(root, "watch-handles.txt"), "utf8").catch(() =>
  die("watch-handles.txt not found at repo root"),
);
const wanted = parseHandles(fileText);
if (wanted.size === 0) die("watch-handles.txt has no handles");

const headers = { "x-trigger-token": token, "content-type": "application/json" };

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch (e) {
    return die(`could not reach ${baseUrl}${path} — is the Worker deployed/running? (${e.message})`);
  }
  if (res.status === 404) {
    die(`404 from ${path} — wrong TRIGGER_TOKEN, or wrong WATCHER_URL (${baseUrl}). The Worker 404s on token mismatch by design.`);
  }
  if (!res.ok) die(`${method} ${path} -> ${res.status} ${await res.text()}`);
  return res.json();
}

console.log(`→ ${baseUrl}  (${wanted.size} handle(s) in watch-handles.txt)${DRY ? "  [dry-run]" : ""}`);

const { targets } = await api("GET", "/api/watch-targets");
const remote = new Map();
for (const t of targets) {
  if (t.source === "twitter" && t.kind === "handle") remote.set(t.handle.toLowerCase(), t.handle);
}

const toAdd = [...wanted].filter(([k]) => !remote.has(k)).map(([, h]) => h);
const toPrune = [...remote].filter(([k]) => !wanted.has(k)).map(([, h]) => h);
const unchanged = wanted.size - toAdd.length;

for (const handle of toAdd) {
  if (DRY) { console.log(`+ ${handle}`); continue; }
  const r = await api("POST", "/api/promote", { handle });
  console.log(`+ ${handle}${r.alreadyExisted ? " (already existed)" : ""}`);
}

if (PRUNE) {
  for (const handle of toPrune) {
    if (DRY) { console.log(`- ${handle}`); continue; }
    await api("DELETE", "/api/watch-targets", { handle });
    console.log(`- ${handle}`);
  }
} else if (toPrune.length) {
  console.log(`\n${toPrune.length} handle(s) in D1 but not in this file (use \`-- --prune\` to remove): ${toPrune.join(", ")}`);
}

console.log(
  `\n✓ ${DRY ? "would add" : "added"} ${toAdd.length}, ${unchanged} unchanged` +
    (PRUNE ? `, ${DRY ? "would remove" : "removed"} ${toPrune.length}` : ""),
);
