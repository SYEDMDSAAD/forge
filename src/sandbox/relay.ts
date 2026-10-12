// The only way sandboxed code reaches the network. Runners have no network of
// their own (`--network none`); they ask the host for each request, and the host
// enforces the skill's domain allowlist on every redirect hop and refuses any
// address on this machine or a private network.
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net from "node:net";

// Node gives each IPv6/IPv4 connect attempt 250ms by default; on high-latency
// links (e.g. from India) that fails ~1 in 4 requests with ETIMEDOUT.
net.setDefaultAutoSelectFamilyAttemptTimeout(2000);

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const MAX_HOPS = 5;

export interface RelayRequest {
  id: number;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  /** base64 */
  body?: string;
}

export type RelayResponse =
  | { id: number; ok: true; status: number; statusText: string; headers: [string, string][]; body: string; url: string; redirected: boolean }
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

/** Perform one sandboxed fetch. Never throws: failures come back as `{ ok: false }`. */
export async function relayFetch(req: RelayRequest, allowed: string[], fetched: string[], timeoutMs: number): Promise<RelayResponse> {
  try {
    let url = new URL(req.url);
    let method = (req.method ?? "GET").toUpperCase();
    let body = req.body ? Buffer.from(req.body, "base64") : undefined;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      if (!/^(host|connection|content-length|transfer-encoding|accept-encoding)$/i.test(k)) headers[k.toLowerCase()] = String(v);
    }
    headers["user-agent"] ??= "Forge/1.0 (MCP skill sandbox)";
    headers["accept-encoding"] = "identity";

    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      if (url.protocol !== "https:" && url.protocol !== "http:") throw new RelayError("EPROTOCOL", `Blocked protocol ${url.protocol}`);
      if (!isAllowed(url.hostname, allowed)) {
        throw new RelayError("EBLOCKED", `Blocked by Forge sandbox: ${url.hostname} is not in this tool's allowed domains (${allowed.join(", ") || "none"})`);
      }
      fetched.push(url.href);
      const res = await once(url, method, headers, body, timeoutMs);
      if (res.status >= 300 && res.status < 400 && res.location) {
        url = new URL(res.location, url);
        if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) [method, body] = ["GET", undefined];
        continue;
      }
      return { id: req.id, ok: true, status: res.status, statusText: res.statusText, headers: res.headers, body: res.body.toString("base64"), url: url.href, redirected: hop > 0 };
    }
    throw new RelayError("EREDIRECTS", "Too many redirects");
  } catch (e) {
    const err = e as Error & { code?: string };
    return { id: req.id, ok: false, code: err.code ?? "EFETCH", error: err.message };
  }
}
