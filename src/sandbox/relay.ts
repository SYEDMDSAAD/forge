// The only way sandboxed code reaches the network. Runners have no network of
// their own (`--network none`); they ask the host for each request, and the host
// enforces the skill's domain allowlist on every redirect hop and refuses any
// address on this machine or a private network.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { config } from "../config.js";
import { filterContent } from "./content-filter.js";

// Node gives each IPv6/IPv4 connect attempt 250ms by default; on high-latency
// links (e.g. from India) that fails ~1 in 4 requests with ETIMEDOUT.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 5;
// Public APIs shed load with these; a GET is retried after a short pause.
const BUSY = new Set([429, 502, 503, 504]);
const RETRY_DELAYS_MS = [400, 1200];

export interface RelayRequest {
  id: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** base64 */
  body?: string;
}

export type RelayResponse =
  | { id: number; ok: true; status: number; statusText: string; headers: [string, string][]; body: string; url: string; redirected: boolean; staleMs?: number }
  | { id: number; ok: false; code: string; error: string };

class RelayError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Loopback, private, link-local, CGNAT, multicast and unspecified addresses. */
export function isPrivateAddress(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
  }
  const v = ip.toLowerCase();
  if (v === "::" || v === "::1") return true;
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return /^f[cd]/.test(v) || /^fe[89ab]/.test(v) || /^ff/.test(v);
}

/** DNS lookup used for the actual connection, so a name can't resolve to a public IP when checked and a private one when used. */
const safeLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const blocked = addresses.find((a) => isPrivateAddress(a.address));
    if (blocked || !addresses.length) {
      const e = Object.assign(new Error(`Blocked by Forge sandbox: ${hostname} resolves to a private or local address`), { code: "EPRIVATEADDR" });
      return callback(e, "", 0);
    }
    if (options.all) return (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
};

function isAllowed(host: string, allowed: string[]): boolean {
  const h = host.toLowerCase();
  return allowed.some((d) => h === d || h.endsWith("." + d));
}

function once(url: URL, method: string, headers: Record<string, string>, body: Buffer | undefined, timeoutMs: number) {
  return new Promise<{ status: number; statusText: string; headers: [string, string][]; body: Buffer; location?: string }>((resolve, reject) => {
    const lib = url.protocol === "https:" ? https : http;
    const req = lib.request(url, { method, headers, lookup: safeLookup, timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY_BYTES) req.destroy(new RelayError("EBODYTOOLARGE", `Response from ${url.hostname} is larger than ${MAX_BODY_BYTES} bytes`));
        else chunks.push(c);
      });
      res.on("end", () => {
        const pairs: [string, string][] = [];
        for (let i = 0; i < res.rawHeaders.length; i += 2) pairs.push([res.rawHeaders[i], res.rawHeaders[i + 1]]);
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", headers: pairs, body: Buffer.concat(chunks), location: res.headers.location });
      });
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new RelayError("ETIMEDOUT", `Request to ${url.hostname} timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(body);
  });
}

// ---------- response cache ----------
// Repeat questions skip the source, and when a source is down a skill can answer
// from its last good reply (labelled with its age by the server). Freshness
// follows each source's Cache-Control; a few that send none get a default.

interface Cached {
  status: number;
  statusText: string;
  headers: [string, string][];
  body: string;
  storedAt: number;
  freshUntil: number;
}
const cache = new Map<string, Cached>();
const MAX_ENTRIES = 500;
const MAX_CACHED_BYTES = 1024 * 1024;
const MAX_FRESH_MS = 60 * 60_000;
// Send no Cache-Control, but their data only changes every 15 minutes or so.
const DEFAULT_FRESH_MS: Record<string, number> = { "open-meteo.com": 10 * 60_000, "thespacedevs.com": 10 * 60_000 };

const header = (headers: [string, string][], name: string) => headers.find(([k]) => k.toLowerCase() === name)?.[1];

/** How long a response may be reused as fresh; undefined means it must not be stored at all. */
function freshFor(host: string, headers: [string, string][]): number | undefined {
  const cc = header(headers, "cache-control")?.toLowerCase();
  if (cc?.includes("no-store") || cc?.includes("private")) return undefined;
  if (cc?.includes("no-cache")) return 0;
  const maxAge = cc && /max-age=(\d+)/.exec(cc);
  if (maxAge) return Math.min(MAX_FRESH_MS, Math.max(0, (Number(maxAge[1]) - Number(header(headers, "age") ?? 0)) * 1000));
  const known = Object.keys(DEFAULT_FRESH_MS).find((d) => host === d || host.endsWith("." + d));
  return known ? DEFAULT_FRESH_MS[known] : 0;
}

function remember(key: string, res: Extract<RelayResponse, { ok: true }>) {
  const freshMs = freshFor(new URL(res.url).hostname, res.headers);
  if (freshMs === undefined || res.body.length > (MAX_CACHED_BYTES * 4) / 3) return;
  const now = Date.now();
  cache.delete(key);
  cache.set(key, { status: res.status, statusText: res.statusText, headers: res.headers, body: res.body, storedAt: now, freshUntil: now + freshMs });
  if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
}

function fromCache(id: number, key: string, hit: Cached, kind: "hit" | "stale"): RelayResponse {
  const staleMs = kind === "stale" ? Date.now() - hit.storedAt : undefined;
  return { id, ok: true, status: hit.status, statusText: hit.statusText, headers: [...hit.headers, ["x-forge-cache", kind]], body: hit.body, url: key, redirected: false, ...(staleMs !== undefined ? { staleMs } : {}) };
}

/** Failures that mean "the source is down or busy", as opposed to a request Forge refused. */
function sourceFailed(res: RelayResponse): boolean {
  if (res.ok) return BUSY.has(res.status) || res.status >= 500;
  return !["EBLOCKED", "EPRIVATEADDR", "EPROTOCOL", "ELIMIT", "EREDIRECTS", "EBODYTOOLARGE"].includes(res.code);
}

/** Test hook: put a response in the cache as if it had been fetched `ageMs` ago. */
export function seedCache(url: string, body: string, ageMs: number, freshMs = 0) {
  const storedAt = Date.now() - ageMs;
  cache.set(url, { status: 200, statusText: "OK", headers: [["content-type", "application/json"]], body: Buffer.from(body).toString("base64"), storedAt, freshUntil: storedAt + freshMs });
}

/**
 * Perform one sandboxed fetch, through the cache for plain GETs. With `allowStale`
 * (real use, not tests), a failing source is answered from its last good reply.
 */
export async function relayFetch(req: RelayRequest, allowed: string[], fetched: string[], timeoutMs: number, opts: { allowStale?: boolean } = {}): Promise<RelayResponse> {
  const method = (req.method ?? "GET").toUpperCase();
  const key = config.cache && method === "GET" && !req.body ? req.url : undefined;
  if (key) {
    const hit = cache.get(key);
    const host = URL.canParse(key) ? new URL(key).hostname : "";
    if (hit && Date.now() < hit.freshUntil && isAllowed(host, allowed)) {
      fetched.push(key);
      return fromCache(req.id, key, hit, "hit");
    }
  }
  const res = await fetchUpstream(req, allowed, fetched, timeoutMs);
  if (!key) return res;
  if (res.ok && res.status === 200 && !res.redirected) remember(key, res);
  else if (opts.allowStale && sourceFailed(res)) {
    const old = cache.get(key);
    if (old && Date.now() - old.storedAt <= config.cacheMaxStaleMs) return fromCache(req.id, key, old, "stale");
  }
  return res;
}

/** One fetch from the source itself. Never throws: failures come back as `{ ok: false }`. */
async function fetchUpstream(req: RelayRequest, allowed: string[], fetched: string[], timeoutMs: number): Promise<RelayResponse> {
  try {
    let url = new URL(req.url);
    let method = (req.method ?? "GET").toUpperCase();
    let body = req.body ? Buffer.from(req.body, "base64") : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!/^(host|connection|content-length|transfer-encoding|accept-encoding)$/i.test(k)) headers[k.toLowerCase()] = String(v);
    }
    // Identifies Forge with a contact page, as Wikimedia and other public APIs ask of automated clients.
    headers["user-agent"] ??= "Forge/1.0 (https://github.com/SYEDMDSAAD/forge; MCP skill sandbox)";
    headers["accept-encoding"] = "identity";

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new RelayError("EPROTOCOL", `Blocked protocol ${url.protocol}`);
      if (!isAllowed(url.hostname, allowed)) {
        throw new RelayError("EBLOCKED", `Blocked by Forge sandbox: ${url.hostname} is not in this tool's allowed domains (${allowed.join(", ") || "none"})`);
      }
      fetched.push(url.href);
      let res = await once(url, method, headers, body, timeoutMs);
      for (const delay of method === "GET" || method === "HEAD" ? RETRY_DELAYS_MS : []) {
        if (!BUSY.has(res.status)) break;
        await new Promise((r) => setTimeout(r, delay));
        res = await once(url, method, headers, body, timeoutMs);
      }
      if (res.status >= 300 && res.status < 400 && res.location) {
        url = new URL(res.location, url);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) [method, body] = ["GET", undefined];
        continue;
      }
      // Feeds lose their explicit and spam stories here, before the skill or its cross-check reads them.
      const contentType = res.headers.find(([k]) => k.toLowerCase() === "content-type")?.[1];
      const safe = filterContent(res.body, contentType);
      return { id: req.id, ok: true, status: res.status, statusText: res.statusText, headers: res.headers, body: safe.toString("base64"), url: url.href, redirected: hop > 0 };
    }
    throw new RelayError("EREDIRECTS", "Too many redirects");
  } catch (e) {
    const err = e as Error & { code?: string };
    return { id: req.id, ok: false, code: err.code ?? "EFETCH", error: err.message };
  }
}
