// SSRF-safe HTTP(S) GET for fetching user-supplied links.
//
// - Every DNS answer is checked, and the socket connects only to an address that
//   passed the check (the check *is* the connection's lookup, so no rebinding gap).
// - IP-literal hosts (including [::1] and ::ffff:127.0.0.1) are checked directly.
// - Only http/https on ports 80/443. Redirects are followed by hand, each hop
//   re-validated, with a hop limit.
// - The body is streamed (and decompressed) with a hard byte cap and a deadline.
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';

/** Error for problems the user can fix (bad URL); safe to show as-is. */
export class UrlError extends Error {
  constructor(message) { super(message); this.name = 'UrlError'; this.status = 400; }
}
/** Network/upstream failure; the message is for server logs only. */
export class FetchError extends Error {
  constructor(message, cause) { super(message, { cause }); this.name = 'FetchError'; }
}

// ---------------------------------------------------------------- address policy
const blocked = new net.BlockList();
for (const [net4, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4], ['255.255.255.255', 32],
]) blocked.addSubnet(net4, prefix, 'ipv4');
for (const [net6, prefix] of [
  ['::', 96],            // unspecified, loopback, deprecated IPv4-compatible
  ['fc00::', 7],         // unique local
  ['fe80::', 10],        // link-local
  ['fec0::', 10],        // deprecated site-local
  ['ff00::', 8],         // multicast
  ['64:ff9b::', 96],     // NAT64
  ['64:ff9b:1::', 48],   // local-use NAT64
  ['2002::', 16],        // 6to4
  ['2001::', 32],        // Teredo
  ['2001:db8::', 32],    // documentation
  ['100::', 64],         // discard-only
]) blocked.addSubnet(net6, prefix, 'ipv6');

/** Parse an IPv6 address into 8 16-bit groups (handles "::", embedded IPv4, zone ids). */
function ipv6Groups(ip) {
  let s = ip.split('%')[0].toLowerCase();
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((a << 8) | b).toString(16) + ':' + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = tail === null ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => parseInt(g, 16));
}

/** True if `ip` is anything other than a plain public unicast address. Fails closed. */
export function isBlockedIp(ip) {
  if (net.isIPv4(ip)) return blocked.check(ip, 'ipv4');
  if (!net.isIPv6(ip)) return true;
  const g = ipv6Groups(ip);
  if (g.length !== 8 || g.some((x) => !(x >= 0 && x <= 0xffff))) return true;
  // IPv4-mapped (::ffff:0:0/96): judge the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) {
    return isBlockedIp(`${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`);
  }
  return blocked.check(g.map((x) => x.toString(16)).join(':'), 'ipv6');
}

const ALLOWED_PORTS = { 'http:': '80', 'https:': '443' };

/** Parse and validate a URL's shape (scheme, port). Throws UrlError. */
export function checkUrl(raw, base) {
  let url;
  try { url = new URL(raw, base); } catch { throw new UrlError('That does not look like a valid URL.'); }
  if (!(url.protocol in ALLOWED_PORTS)) throw new UrlError('Only http(s) links are supported.');
  if (url.port && url.port !== ALLOWED_PORTS[url.protocol]) throw new UrlError('Only links on the standard web ports (80/443) are supported.');
  if (url.username || url.password) throw new UrlError('Links with a username or password are not supported.');
  return url;
}

/** The URL's host without IPv6 brackets. */
const bareHost = (url) => url.hostname.replace(/^\[(.*)\]$/, '$1');

/**
 * `lookup` for http(s).request: resolves every address, refuses the connection if
 * any of them is non-public, and hands back only the validated addresses.
 */
export function safeLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  const family = typeof options === 'number' ? options : options?.family || 0;
  dns.lookup(hostname, { all: true, verbatim: true, family }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length) return callback(Object.assign(new Error(`No addresses for ${hostname}`), { code: 'ENOTFOUND' }));
    const bad = addresses.find((a) => isBlockedIp(a.address));
    if (bad) {
      return callback(Object.assign(new Error(`${hostname} resolves to non-public address ${bad.address}`), { code: 'EBLOCKEDADDRESS' }));
    }
    if (options?.all) return callback(null, addresses);
    return callback(null, addresses[0].address, addresses[0].family);
  });
}

/** Resolve and check a URL's host up front (no connection). Rejects with FetchError. */
export async function assertPublicHost(url) {
  const host = bareHost(url);
  if (net.isIP(host)) {
    if (isBlockedIp(host)) throw new FetchError(`Blocked IP literal ${host}`);
    return [{ address: host, family: net.isIP(host) }];
  }
  return new Promise((resolve, reject) => {
    safeLookup(host, { all: true }, (err, addrs) => (err ? reject(new FetchError(err.message, err)) : resolve(addrs)));
  });
}

// ---------------------------------------------------------------- fetching
function decoderFor(encoding) {
  switch ((encoding || '').trim().toLowerCase()) {
    case '': case 'identity': return null;
    case 'gzip': case 'x-gzip': return () => zlib.createGunzip();
    case 'br': return () => zlib.createBrotliDecompress();
    // "deflate" is meant to be zlib-wrapped but some servers send raw deflate.
    case 'deflate': return (first) => ((first[0] & 0x0f) === 8 ? zlib.createInflate() : zlib.createInflateRaw());
    default: return undefined; // unsupported
  }
}

/** One GET to a validated URL; resolves with the response stream (body not yet read). */
function requestOnce(url, headers, signal) {
  return new Promise((resolve, reject) => {
    const host = bareHost(url);
    if (net.isIP(host) && isBlockedIp(host)) return reject(new FetchError(`Blocked IP literal ${host}`));
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: url.protocol,
      hostname: host,
      port: url.port || ALLOWED_PORTS[url.protocol],
      path: url.pathname + url.search,
      method: 'GET',
      headers: { ...headers, Host: url.host },
      servername: net.isIP(host) ? undefined : host, // SNI stays the hostname
      lookup: safeLookup,
      agent: false,
      signal,
    }, resolve);
    req.on('error', (e) => reject(e instanceof FetchError ? e : new FetchError(`${url.href}: ${e.code || ''} ${e.message}`, e)));
    req.end();
  });
}

/** Read a response body (decompressed) up to `maxBytes`; stops downloading past the cap. */
function readBody(res, maxBytes) {
  return new Promise((resolve, reject) => {
    const makeDecoder = decoderFor(res.headers['content-encoding']);
    if (makeDecoder === undefined) {
      res.destroy();
      return reject(new FetchError(`Unsupported content-encoding ${res.headers['content-encoding']}`));
    }
    const chunks = [];
    let total = 0;
    let done = false;
    let decoder = null;
    const finish = (err) => {
      if (done) return;
      done = true;
      res.destroy();
      decoder?.destroy();
      if (err) reject(err instanceof FetchError ? err : new FetchError(`Body read failed: ${err.message}`, err));
      else resolve(Buffer.concat(chunks, total));
    };
    const onData = (chunk) => {
      if (done) return;
      const room = maxBytes - total;
      if (chunk.length >= room) {
        chunks.push(chunk.subarray(0, room));
        total += room;
        finish(); // hit the cap: keep what we have, stop downloading
        return;
      }
      chunks.push(chunk);
      total += chunk.length;
    };
    const onEnd = () => finish();
    res.on('error', finish);
    res.on('aborted', () => finish(new FetchError('Response aborted')));
    if (!makeDecoder) {
      res.on('data', onData);
      res.on('end', onEnd);
      return;
    }
    res.once('data', (first) => {
      decoder = makeDecoder(first);
      decoder.on('data', onData);
      decoder.on('end', onEnd);
      decoder.on('error', finish);
      decoder.write(first);
      res.pipe(decoder);
    });
    res.on('end', () => { if (!decoder) finish(); }); // empty compressed body
  });
}

/**
 * GET a user-supplied URL safely.
 * @returns {Promise<{status:number, ok:boolean, url:string, headers:object, body:Buffer}>}
 * @throws {UrlError} for an invalid/unsupported URL (safe to show the user)
 * @throws {FetchError|Error} for every network/upstream failure (log it, show something generic)
 */
export async function safeFetch(raw, {
  headers = {}, maxBytes = 5 * 1024 * 1024, timeoutMs = 15000, maxRedirects = 5,
} = {}) {
  let url = checkUrl(raw);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new FetchError(`Timed out after ${timeoutMs} ms`)), timeoutMs);
  const reqHeaders = { 'Accept-Encoding': 'gzip, deflate, br', ...headers };
  try {
    for (let hop = 0; ; hop++) {
      const res = await requestOnce(url, reqHeaders, controller.signal);
      const location = res.headers.location;
      if (res.statusCode >= 300 && res.statusCode < 400 && location) {
        res.destroy();
        if (hop >= maxRedirects) throw new FetchError(`Too many redirects (last: ${url.href})`);
        try { url = checkUrl(location, url); } catch (e) { throw new FetchError(`Bad redirect from ${url.href} to ${location}: ${e.message}`); }
        continue;
      }
      const body = await readBody(res, maxBytes);
      return { status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, url: url.href, headers: res.headers, body };
    }
  } catch (e) {
    if (controller.signal.aborted && !(e instanceof UrlError)) throw controller.signal.reason;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
