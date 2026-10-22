// The security tools' logic: JWTs (js/tools/jwt.mjs), hashes
// (js/tools/hashes.mjs), and UUIDs and tokens (js/tools/random.mjs).
// Tokens are signed here with Web Crypto, for every family of "alg".
import { createHash, createHmac } from "node:crypto";
import * as J from "../../js/tools/jwt.mjs";
import * as H from "../../js/tools/hashes.mjs";
import * as R from "../../js/tools/random.mjs";

const ok = (l, c, x = "") => { console.log((c ? "PASS " : "FAIL ") + l + (c ? "" : "  " + x)); if (!c) process.exitCode = 1; };
const throws = (f, pattern) => { try { f(); return false; } catch (e) { return pattern.test(e.message); } };
const rejects = async (p, pattern) => { try { await p; return false; } catch (e) { return pattern.test(e.message); } };

// ---- JWT
const b64url = (bytes) => Buffer.from(bytes).toString("base64url");
const part = (obj) => b64url(Buffer.from(JSON.stringify(obj)));
async function sign(alg, header, payload, privateKey, params) {
  const input = `${part({ alg, typ: "JWT", ...header })}.${part(payload)}`;
  const sig = await crypto.subtle.sign(params, privateKey, new TextEncoder().encode(input));
  return `${input}.${b64url(new Uint8Array(sig))}`;
}
const pem = async (key) => `-----BEGIN PUBLIC KEY-----\n${Buffer.from(await crypto.subtle.exportKey("spki", key)).toString("base64").match(/.{1,64}/g).join("\n")}\n-----END PUBLIC KEY-----`;

const payload = { sub: "1234567890", name: "Ada", iat: 1700000000, exp: 1700003600 };
const hsKey = await crypto.subtle.importKey("raw", new TextEncoder().encode("secret"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
const hs = await sign("HS256", {}, payload, hsKey, { name: "HMAC" });
const t = J.decodeJwt(`Bearer ${hs}\n`);
ok("decodes header and payload, Bearer and whitespace allowed", t.header.alg === "HS256" && t.payload.name === "Ada" && t.signature.length === 32);
ok("HS256 verifies with the right secret", await J.verifyJwt(t, "secret") === true);
ok("and not with the wrong one", await J.verifyJwt(t, "Secret") === false);
ok("base64 secrets", await J.verifyJwt(t, Buffer.from("secret").toString("base64"), { secretIsBase64: true }) === true);
ok("key kinds", J.keyKind("HS512") === "secret" && J.keyKind("RS256") === "public" && J.keyKind("EdDSA") === "public" && J.keyKind("XX1") === null);

const times = (now) => J.tokenTimes(payload, now * 1000).status;
ok("expiry", times(1700000001) === "valid" && times(1700003600) === "expired" && J.tokenTimes({ nbf: 2e9 }, 1.9e12).status === "not-yet"
  && J.tokenTimes({}, 0).status === "no-expiry" && J.tokenTimes(payload, 0).expires === 1700003600000);

const families = [
  ["RS256", { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, { name: "RSASSA-PKCS1-v1_5" }],
  ["PS384", { name: "RSA-PSS", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-384" }, { name: "RSA-PSS", saltLength: 48 }],
  ["ES256", { name: "ECDSA", namedCurve: "P-256" }, { name: "ECDSA", hash: "SHA-256" }],
  ["ES512", { name: "ECDSA", namedCurve: "P-521" }, { name: "ECDSA", hash: "SHA-512" }],
  ["EdDSA", { name: "Ed25519" }, { name: "Ed25519" }],
];
for (const [alg, gen, params] of families) {
  const pair = await crypto.subtle.generateKey(gen, true, ["sign", "verify"]);
  const other = await crypto.subtle.generateKey(gen, true, ["sign", "verify"]);
  const token = J.decodeJwt(await sign(alg, { kid: "k1" }, payload, pair.privateKey, params));
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  ok(`${alg}: PEM, JWK, JWKS by kid, and a private JWK's public part`,
    await J.verifyJwt(token, await pem(pair.publicKey)) && await J.verifyJwt(token, JSON.stringify(jwk))
    && await J.verifyJwt(token, JSON.stringify({ keys: [{ ...jwk, kid: "k0" }, { ...jwk, kid: "k1" }] }))
    && await J.verifyJwt(token, JSON.stringify(privateJwk)));
  ok(`${alg}: another key fails`, await J.verifyJwt(token, await pem(other.publicKey)) === false);
}

ok("JWE is named", throws(() => J.decodeJwt("a.b.c.d.e"), /encrypted token/));
ok("wrong number of parts", throws(() => J.decodeJwt("a.b"), /three parts/));
ok("not JSON", throws(() => J.decodeJwt("bm9wZQ.e30.x"), /header isn't base64url-encoded JSON/));
ok("empty is null", J.decodeJwt("  ") === null);
const none = J.decodeJwt(`${part({ alg: "none" })}.${part(payload)}.`);
ok('"alg": "none" is called out', await rejects(J.verifyJwt(none, "x"), /isn't signed at all/));
ok("certificates and private keys are explained", await rejects(J.verifyJwt(J.decodeJwt(hs.replace(/^[^.]+/, part({ alg: "RS256" }))),
  "-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"), /certificate/)
  && await rejects(J.verifyJwt(J.decodeJwt(hs.replace(/^[^.]+/, part({ alg: "RS256" }))), "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----"), /PUBLIC KEY/));
ok("a JWKS without the kid", await rejects(J.verifyJwt(J.decodeJwt(hs.replace(/^[^.]+/, part({ alg: "RS256", kid: "x" }))), '{"keys":[{"kid":"a"},{"kid":"b"}]}'), /no key with the token's kid \(x\)/));

// ---- hashes, against Node's own
const text = new TextEncoder().encode("The quick brown fox jumps over the lazy dog");
const all = H.ALGORITHMS.map((a) => a.id);
const r = H.hashBytes(text, all);
const node = (name) => createHash(name).update(text).digest("hex");
ok("md5, sha1, sha2 and sha3 match Node", H.formatDigest(r.md5, "hex") === node("md5") && H.formatDigest(r.sha1, "hex") === node("sha1")
  && H.formatDigest(r.sha256, "hex") === node("sha256") && H.formatDigest(r.sha384, "hex") === node("sha384")
  && H.formatDigest(r.sha512, "hex") === node("sha512") && H.formatDigest(r.sha3_256, "hex") === node("sha3-256") && H.formatDigest(r.sha3_512, "hex") === node("sha3-512"));
ok("blake3 known answer", H.formatDigest(H.hashBytes(new Uint8Array(), ["blake3"]).blake3, "hex") === "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
const keyed = H.hashBytes(text, all, new TextEncoder().encode("key"));
ok("HMACs match Node, and BLAKE3 sits out", H.formatDigest(keyed.sha256, "hex") === createHmac("sha256", "key").update(text).digest("hex")
  && H.formatDigest(keyed.md5, "hex") === createHmac("md5", "key").update(text).digest("hex") && !("blake3" in keyed));
const fileBytes = new Uint8Array(9 * 1024 * 1024 + 17).map((_, i) => i * 13);
let steps = 0;
const fromFile = await H.hashFile(new Blob([fileBytes]), ["sha256", "md5"], { onProgress: () => steps++ });
ok("a file, in slices, gives the same hashes", H.formatDigest(fromFile.sha256, "hex") === createHash("sha256").update(fileBytes).digest("hex")
  && H.formatDigest(fromFile.md5, "hex") === createHash("md5").update(fileBytes).digest("hex") && steps === 3);
const stop = new AbortController();
stop.abort();
ok("hashing a file can be stopped", await rejects(H.hashFile(new Blob([fileBytes]), ["sha256"], { signal: stop.signal }), /abort/i));
ok("formats", H.formatDigest(r.md5, "HEX") === node("md5").toUpperCase() && H.formatDigest(r.md5, "base64") === createHash("md5").update(text).digest("base64"));
const expected = H.parseDigest(node("sha256").toUpperCase().match(/../g).join(":"));
ok("a pasted checksum finds its algorithm, hex or base64", H.findMatch(r, expected) === "sha256"
  && H.findMatch(r, H.parseDigest(createHash("sha1").update(text).digest("base64"))) === "sha1" && H.findMatch(r, H.parseDigest("00ff")) === null
  && H.parseDigest("not a hash!") === null);

// ---- UUIDs and tokens
const v4 = R.uuidV4();
ok("v4 shape", /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v4), v4);
const v7 = R.uuidV7(1700000000123);
ok("v7 shape and time", /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab]/.test(v7) && R.inspectUuid(v7).time === 1700000000123 && R.inspectUuid(v7).version === 7);
const batch = R.uuids(7, 50);
ok("a v7 batch is sorted and unique", batch.every((u, i) => i === 0 || batch[i - 1] < u) && new Set(R.uuids(4, 1000)).size === 1000);
ok("formats", R.formatUuid(v4, { upper: true, hyphens: false, braces: true }) === `{${v4.replace(/-/g, "").toUpperCase()}}`);
const v1 = R.inspectUuid("c232ab00-9414-11ec-b3c8-9f6bdeced846");
ok("v1 time (RFC 9562's example)", v1.version === 1 && new Date(v1.time).toISOString() === "2022-02-22T19:22:22.000Z", new Date(v1.time).toISOString());
const v6 = R.inspectUuid("1EC9414C-232A-6B00-B3C8-9F6BDECED846");
ok("v6 time (RFC 9562's example)", v6.version === 6 && new Date(v6.time).toISOString() === "2022-02-22T19:22:22.000Z");
ok("nil, max, braces, urn and bad input", R.inspectUuid("00000000-0000-0000-0000-000000000000").variant === "the nil UUID"
  && R.inspectUuid(`{urn:uuid:${v4}}`.replace("{urn", "urn").replace(/}$/, "")).version === 4 && R.inspectUuid(`{${v4}}`).version === 4
  && throws(() => R.inspectUuid("1234"), /32 hex digits/) && R.inspectUuid("") === null);
ok("tokens", /^[0-9a-f]{64}$/.test(R.randomToken("hex", 32)) && /^[A-Za-z0-9+/]{43}=$/.test(R.randomToken("base64", 32))
  && /^[A-Za-z0-9_-]{43}$/.test(R.randomToken("base64url", 32)) && /^[A-Za-z0-9]{40}$/.test(R.randomToken("alphanumeric", 40)));
const counts = new Map();
for (const ch of R.randomToken("alphanumeric", 62000)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
ok("alphanumeric characters are even", counts.size === 62 && [...counts.values()].every((n) => n > 800 && n < 1200), JSON.stringify([...counts.values()].slice(0, 5)));
ok("token strength", R.tokenBits("hex", 32) === 256 && R.tokenBits("alphanumeric", 22) === 130);
