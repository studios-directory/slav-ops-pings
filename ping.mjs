// Sends one signed heartbeat per watched app to the Ops Cockpit.
// Node 22 built-ins only. No secrets are ever printed. See README.md.
import { createHmac, randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

import appsFile from "./apps.json" with { type: "json" };

const GET_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 15_000;
const CONCURRENCY = 4;
const DETAIL_MAX = 200;
// C0 controls (CR, LF, tab included), DEL and C1 controls.
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/g;

/**
 * @typedef {{ slug: string, health_url: string }} WatchedApp
 * @typedef {typeof fetch} FetchFn
 * @typedef {{ app: string, ok: boolean, status: number | null, latency_ms: number | null, detail?: string, checked_at: string }} Heartbeat
 */

/**
 * HMAC-SHA256 hex of `${timestamp}.${nonce}.${rawBody}`. Must stay byte-identical to `signBody`
 * in the cockpit (`lib/ops/hmac.ts`); a unit test in the cockpit repo compares them.
 * @param {string} secret
 * @param {number} timestamp unix seconds
 * @param {string} nonce
 * @param {string} rawBody
 * @returns {string}
 */
export function signHeartbeat(secret, timestamp, nonce, rawBody) {
  return createHmac("sha256", secret).update(`${timestamp}.${nonce}.${rawBody}`, "utf8").digest("hex");
}

/**
 * @param {string} text
 * @returns {string}
 */
function clampDetail(text) {
  const clamped = text.replace(CONTROL_CHARS, "").slice(0, DETAIL_MAX);
  return clamped.replace(/[\ud800-\udbff]$/, "");
}

/**
 * GETs the app's health URL. Never throws: a network error or timeout becomes `ok: false`.
 * @param {WatchedApp} app
 * @param {FetchFn} fetchFn
 * @returns {Promise<Heartbeat>}
 */
export async function checkApp(app, fetchFn = fetch) {
  const started = performance.now();
  try {
    const res = await fetchFn(app.health_url, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "slav-ops-pings/1" },
      signal: AbortSignal.timeout(GET_TIMEOUT_MS),
    });
    const latency = Math.round(performance.now() - started);
    const ok = res.status >= 200 && res.status <= 299;
    /** @type {Heartbeat} */
    const hb = { app: app.slug, ok, status: res.status, latency_ms: latency, checked_at: new Date().toISOString() };
    if (ok) {
      await res.body?.cancel();
    } else {
      hb.detail = clampDetail(await res.text().catch(() => ""));
    }
    return hb;
  } catch (err) {
    const message = err instanceof Error ? `${err.name}: ${err.message}` : "request failed";
    return {
      app: app.slug,
      ok: false,
      status: null,
      latency_ms: null,
      detail: clampDetail(message),
      checked_at: new Date().toISOString(),
    };
  }
}

/**
 * Posts one signed heartbeat. Throws when the cockpit does not answer 2xx.
 * @param {string} cockpitUrl
 * @param {string} secret
 * @param {object} heartbeat
 * @param {FetchFn} fetchFn
 * @returns {Promise<number>} the HTTP status
 */
export async function postHeartbeat(cockpitUrl, secret, heartbeat, fetchFn = fetch) {
  const body = JSON.stringify(heartbeat);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomBytes(16).toString("base64url");
  const res = await fetchFn(`${cockpitUrl.replace(/\/+$/, "")}/api/ops/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-ops-timestamp": String(timestamp),
      "x-ops-nonce": nonce,
      "x-ops-signature": signHeartbeat(secret, timestamp, nonce, body),
    },
    body,
    signal: AbortSignal.timeout(POST_TIMEOUT_MS),
  });
  await res.body?.cancel();
  if (!res.ok) throw new Error(`cockpit answered ${res.status}`);
  return res.status;
}

/** @param {string} line */
function writeLine(line) {
  process.stdout.write(`${line}\n`);
}

/**
 * Checks the apps four at a time (worst case about 30 s) and posts each result. One app's failure never stops the rest.
 * @param {{ apps: readonly WatchedApp[], cockpitUrl: string, secret: string, dryRun: boolean, fetchFn?: FetchFn, log?: (line: string) => void }} options
 * @returns {Promise<(Heartbeat & { posted: boolean })[]>}
 */
export async function runPings({ apps, cockpitUrl, secret, dryRun, fetchFn = fetch, log = writeLine }) {
  /** @type {{ order: number, result: Heartbeat & { posted: boolean } }[]} */
  const done = [];
  const queue = apps.map((app, order) => ({ app, order }));
  // Four workers pull apps from a shared index, so a slow app delays only its own worker.
  // Results are sorted by their original position, so the summary keeps apps.json order.
  const worker = async () => {
    for (let item = queue.shift(); item; item = queue.shift()) {
      const { app, order } = item;
      const hb = await checkApp(app, fetchFn);
      let posted = false;
      let note = "";
      if (dryRun) {
        note = "dry-run";
      } else {
        try {
          await postHeartbeat(cockpitUrl, secret, hb, fetchFn);
          posted = true;
        } catch (err) {
          note = `POST FAILED (${err instanceof Error ? err.message : "unknown"})`;
        }
      }
      log(
        `${hb.app} ${app.health_url} ok=${hb.ok} status=${hb.status ?? "none"} latency=${hb.latency_ms === null ? "none" : `${hb.latency_ms}ms`}${note ? ` [${note}]` : ""}`,
      );
      done.push({ order, result: { ...hb, posted } });
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, apps.length) }, worker));
  return done.sort((a, b) => a.order - b.order).map((d) => d.result);
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const cockpitUrl = process.env.COCKPIT_URL ?? "";
  const secret = process.env.PINGS_HMAC_SECRET ?? "";
  if (!dryRun && (!cockpitUrl || !secret)) {
    console.error("COCKPIT_URL and PINGS_HMAC_SECRET must be set");
    process.exitCode = 1;
    return;
  }
  const results = await runPings({ apps: appsFile, cockpitUrl, secret, dryRun });
  if (!dryRun && results.some((r) => !r.posted)) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
