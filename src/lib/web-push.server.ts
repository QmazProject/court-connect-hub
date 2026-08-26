/**
 * Web Push (RFC 8291 / RFC 8292) on Web Crypto only.
 *
 * The `web-push` package is Node-only — it reaches for `crypto.createECDH` and
 * `createHmac`, neither of which exists on Cloudflare Workers, which is what this
 * project deploys to. So the two things a push needs are done by hand here:
 *
 *   1. An `aes128gcm` encrypted payload (RFC 8291). The push service is an untrusted
 *      relay: it forwards bytes it cannot read, and only the browser that produced
 *      the subscription holds the key to open them.
 *   2. A VAPID `Authorization` header (RFC 8292) — an ES256 JWT proving the sender is
 *      the origin the user subscribed to, so nobody else can push to that endpoint.
 *
 * Everything below is Web Crypto, which Workers, Deno and modern Node all implement.
 */

const enc = new TextEncoder();

function b64urlToBytes(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64url(b: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** HKDF extract+expand in one call — `deriveBits` does both, which is exactly the
 *  shape RFC 8291 asks for at each of its three derivations. */
async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

export type PushSubscriptionRecord = {
  endpoint: string;
  /** The browser's public key, base64url, 65 raw bytes. */
  p256dh: string;
  /** The subscription's shared auth secret, base64url, 16 bytes. */
  auth: string;
};

export type VapidKeys = {
  publicKey: string;
  privateKey: string;
  /** Contact for the push service, e.g. `mailto:ops@example.com`. */
  subject: string;
};

/**
 * Encrypt `payload` for one subscription, producing the `aes128gcm` body.
 *
 * The record layout at the end is fixed by RFC 8188: salt, record size, then the
 * sender's ephemeral public key inline, so the receiver can derive the same secret
 * without a second round trip.
 */
async function encryptPayload(sub: PushSubscriptionRecord, payload: string): Promise<Uint8Array> {
  const uaPublic = b64urlToBytes(sub.p256dh);
  const authSecret = b64urlToBytes(sub.auth);

  // A fresh sender keypair per message: reusing one would let the push service link
  // messages, and RFC 8291 requires it to be per-record anyway.
  const ephemeral = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
    "deriveBits",
  ]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));

  const uaKey = await crypto.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, ephemeral.privateKey, 256),
  );

  // The key-derivation info binds both public keys into the secret, so a payload
  // cannot be replayed at a different subscription.
  const keyInfo = concat(enc.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, shared, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  // 0x02 is the last-record delimiter. One record is always enough here: push
  // services cap payloads near 4 KB and these are short notifications.
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      aesKey,
      plaintext as BufferSource,
    ),
  );

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096, false); // record size
  header[20] = asPublic.length; // always 65
  return concat(header, asPublic, ciphertext);
}

/** Build the `Authorization: vapid …` header proving who is sending. */
async function vapidHeader(endpoint: string, keys: VapidKeys): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = { typ: "JWT", alg: "ES256" };
  const body = {
    aud: audience,
    // Twelve hours: push services reject anything beyond 24, and a short window
    // limits how long a leaked token is useful.
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: keys.subject,
  };
  const signingInput = `${bytesToB64url(enc.encode(JSON.stringify(header)))}.${bytesToB64url(
    enc.encode(JSON.stringify(body)),
  )}`;

  // The stored public key is the 65-byte uncompressed point; JWK needs x and y
  // separately, and the private scalar `d` alone is not importable.
  const pub = b64urlToBytes(keys.publicKey);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: keys.privateKey,
    ext: true,
  };
  const signingKey = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      enc.encode(signingInput) as BufferSource,
    ),
  );
  // Web Crypto already returns the raw r||s pair ES256 wants — no DER unwrapping.
  return `vapid t=${signingInput}.${bytesToB64url(sig)}, k=${keys.publicKey}`;
}

export type PushResult =
  | { ok: true }
  /** The subscription is dead (404/410). The caller should delete the row: the
   *  browser has revoked it and every future send would fail the same way. */
  | { ok: false; gone: true; status: number; detail: string }
  | { ok: false; gone: false; status: number; detail: string };

export async function sendWebPush(
  sub: PushSubscriptionRecord,
  payload: string,
  keys: VapidKeys,
): Promise<PushResult> {
  let body: Uint8Array;
  let authorization: string;
  try {
    body = await encryptPayload(sub, payload);
    authorization = await vapidHeader(sub.endpoint, keys);
  } catch (e) {
    // A malformed p256dh/auth pair fails here rather than at the push service, and
    // it will never succeed, so report it as gone and let the caller drop the row.
    return {
      ok: false,
      gone: true,
      status: 0,
      detail: e instanceof Error ? e.message : "Could not encrypt push payload",
    };
  }

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "86400",
      Urgency: "normal",
    },
    body: body as BodyInit,
  });

  if (res.ok) return { ok: true };
  const detail = await res.text().catch(() => "");
  return {
    ok: false,
    gone: res.status === 404 || res.status === 410,
    status: res.status,
    detail: detail.slice(0, 300),
  };
}
