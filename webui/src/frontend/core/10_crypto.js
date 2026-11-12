// Крипто для входа SCRAM и шифрования RSA OAEP.
// WebCrypto (crypto.subtle) по http://192.168.1.1 недоступен (нет secure context),
// поэтому SHA-1/SHA-256/HMAC/PBKDF2 свои; RSA — на BigInt.
// Совместимость с CryptoJS стока: HmacSHA256(message, key) — порядок аргументов как у CryptoJS.

const utf8 = (s) => (typeof s === 'string' ? new TextEncoder().encode(s) : s);
const hex = (b) => Array.prototype.map.call(b, (x) => (x < 16 ? '0' : '') + x.toString(16)).join('');
const unhex = (h) => {
  const out = new Uint8Array(h.length >> 1);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
};
const concat = (...arrs) => {
  let n = 0;
  arrs.forEach((a) => { n += a.length; });
  const out = new Uint8Array(n);
  let o = 0;
  arrs.forEach((a) => { out.set(a, o); o += a.length; });
  return out;
};

const rnd = (n) => {
  const b = new Uint8Array(n);
  if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(b);
  else for (let i = 0; i < n; i++) b[i] = Math.floor(Math.random() * 256);
  return b;
};

// Дополнение MD для SHA-1 и SHA-256 (big-endian длина)
const mdPad = (msg) => {
  const l = msg.length;
  const n = ((l + 9 + 63) >> 6) << 6;
  const b = new Uint8Array(n);
  b.set(msg);
  b[l] = 0x80;
  const bits = l * 8;
  const dv = new DataView(b.buffer);
  dv.setUint32(n - 4, bits >>> 0);
  dv.setUint32(n - 8, Math.floor(bits / 0x100000000));
  return dv;
};

const K256 = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const sha256 = (data) => {
  const dv = mdPad(utf8(data));
  const H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const W = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = W[i - 15], b = W[i - 2];
      const s0 = rotr(a, 7) ^ rotr(a, 18) ^ (a >>> 3);
      const s1 = rotr(b, 17) ^ rotr(b, 19) ^ (b >>> 10);
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K256[i] + W[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e; H[5] += f; H[6] += g; H[7] += h;
  }
  const out = new Uint8Array(32);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
  return out;
};

const sha1 = (data) => {
  const dv = mdPad(utf8(data));
  const H = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
  const W = new Uint32Array(80);
  const rotl = (x, n) => (x << n) | (x >>> (32 - n));
  for (let off = 0; off < dv.byteLength; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(off + i * 4);
    for (let i = 16; i < 80; i++) W[i] = rotl(W[i - 3] ^ W[i - 8] ^ W[i - 14] ^ W[i - 16], 1);
    let [a, b, c, d, e] = H;
    for (let i = 0; i < 80; i++) {
      let f, k;
      if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else { f = b ^ c ^ d; k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + W[i]) | 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    H[0] += a; H[1] += b; H[2] += c; H[3] += d; H[4] += e;
  }
  const out = new Uint8Array(20);
  const odv = new DataView(out.buffer);
  for (let i = 0; i < 5; i++) odv.setUint32(i * 4, H[i]);
  return out;
};

// HMAC-SHA256 в обычном порядке: (ключ, сообщение)
const hmac256 = (key, msg) => {
  key = utf8(key);
  if (key.length > 64) key = sha256(key);
  const k = new Uint8Array(64);
  k.set(key);
  const ip = k.map((x) => x ^ 0x36);
  const op = k.map((x) => x ^ 0x5c);
  return sha256(concat(op, sha256(concat(ip, utf8(msg)))));
};

const pbkdf2 = (password, salt, iterations, len) => {
  const pw = utf8(password);
  const out = new Uint8Array(len);
  for (let block = 1, o = 0; o < len; block++) {
    let u = hmac256(pw, concat(salt, new Uint8Array([block >>> 24, (block >>> 16) & 255, (block >>> 8) & 255, block & 255])));
    const t = u.slice();
    for (let i = 1; i < iterations; i++) {
      u = hmac256(pw, u);
      for (let j = 0; j < t.length; j++) t[j] ^= u[j];
    }
    out.set(t.subarray(0, Math.min(t.length, len - o)), o);
    o += t.length;
  }
  return out;
};

// --- SCRAM как у стока (lib/scram.js + CryptoJS) ---
// CryptoJS.HmacSHA256(message, key): ключ — второй аргумент.
const cjHmac = (message, key) => hmac256(key, message);
const scram = {
  nonce: () => hex(rnd(32)),
  salted: (pwd, saltHex, iter) => pbkdf2(pwd, unhex(saltHex), M.int(iter, 100), 32),
  clientKey: (spwd) => cjHmac(spwd, 'Client Key'),
  serverKey: (spwd) => cjHmac(spwd, 'Server Key'),
  storedKey: (ckey) => sha256(ckey),
  signature: (stored, authMsg) => cjHmac(stored, authMsg),
  // все результаты — hex, как toString() у CryptoJS
  proofs(pwd, saltHex, iter, authMsg) {
    const spwd = scram.salted(pwd, saltHex, iter);
    const ckey = scram.clientKey(spwd);
    const csig = scram.signature(scram.storedKey(ckey), authMsg);
    const proof = ckey.map((x, i) => x ^ csig[i]);
    const skey = scram.serverKey(spwd);
    return {
      clientProof: hex(proof),
      serverProof: hex(scram.signature(skey, authMsg)),
      serverKey: hex(skey),
      saltedHex: hex(spwd),
    };
  },
};

// --- base64 от UTF-8 строки (как base64_encode стока) ---
const b64utf8 = (s) => {
  const b = utf8(s);
  let bin = '';
  for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
  return btoa(bin);
};

// --- RSA OAEP (SHA-1, пустая метка) как lib/rsa.js стока ---
const big = (h) => BigInt('0x' + (h || '0'));
const modpow = (b, e, m) => {
  let r = BigInt(1);
  const Z = BigInt(0), ONE = BigInt(1), TWO = BigInt(2);
  b %= m;
  while (e > Z) {
    if (e % TWO === ONE) r = (r * b) % m;
    e /= TWO;
    b = (b * b) % m;
  }
  return r;
};
const mgf1 = (seed, len) => {
  const out = new Uint8Array(len);
  for (let c = 0, o = 0; o < len; c++) {
    const h = sha1(concat(seed, new Uint8Array([c >>> 24, (c >>> 16) & 255, (c >>> 8) & 255, c & 255])));
    out.set(h.subarray(0, Math.min(20, len - o)), o);
    o += 20;
  }
  return out;
};
const oaepEncrypt = (nHex, eHex, msg) => {
  const n = big(nHex);
  const k = Math.ceil(n.toString(16).length / 2);
  const m = utf8(msg);
  if (m.length > k - 42) throw new Error('RSA: сообщение длиннее ключа');
  const db = new Uint8Array(k - 21);
  db.set(sha1(new Uint8Array(0)));
  db[db.length - m.length - 1] = 1;
  db.set(m, db.length - m.length);
  const seed = rnd(20);
  const dbMask = mgf1(seed, db.length);
  const mdb = db.map((x, i) => x ^ dbMask[i]);
  const sMask = mgf1(mdb, 20);
  const ms = seed.map((x, i) => x ^ sMask[i]);
  const em = concat(new Uint8Array([0]), ms, mdb);
  const c = modpow(big(hex(em)), big(eHex), n).toString(16);
  return c.padStart(k * 2, '0');
};
// Шифрование тела запроса целиком, как doRSAEncrypt стока: base64(utf8), куски по 214 символов
const rsaEncryptBody = (nHex, eHex, text) => {
  if (!text) return '';
  const s = b64utf8(text);
  let out = '';
  for (let i = 0; i < s.length; i += 214) out += oaepEncrypt(nHex, eHex, s.substr(i, 214));
  return out;
};


// --- AES-CBC расшифровка (чтение пароля Wi-Fi через api/user/pwd, как getDAesString стока) ---
// Ключ 16/24/32 байта; IV короче 16 байт дополняется нулями (так ведет себя CryptoJS с IV из 8 байт).
const SBOX = new Uint8Array(256);
const INV = new Uint8Array(256);
(() => {
  let p = 1, q = 1;
  do {
    p = p ^ ((p << 1) & 0xff) ^ (p & 0x80 ? 0x1b : 0);
    q ^= q << 1; q ^= q << 2; q ^= q << 4; q &= 0xff; if (q & 0x80) q ^= 0x09;
    const x = q ^ ((q << 1) | (q >> 7)) ^ ((q << 2) | (q >> 6)) ^ ((q << 3) | (q >> 5)) ^ ((q << 4) | (q >> 4));
    SBOX[p] = (x ^ 0x63) & 0xff;
  } while (p !== 1);
  SBOX[0] = 0x63;
  for (let i = 0; i < 256; i++) INV[SBOX[i]] = i;
})();
const xt = (a) => ((a << 1) ^ (a & 0x80 ? 0x1b : 0)) & 0xff;
const mul = (a, b) => { let r = 0; while (b) { if (b & 1) r ^= a; a = xt(a); b >>= 1; } return r; };
const expandKey = (key) => {
  const nk = key.length / 4, nr = nk + 6, w = new Uint8Array(16 * (nr + 1));
  w.set(key);
  let rcon = 1;
  for (let i = nk; i < 4 * (nr + 1); i++) {
    let t = w.slice((i - 1) * 4, i * 4);
    if (i % nk === 0) { t = new Uint8Array([SBOX[t[1]] ^ rcon, SBOX[t[2]], SBOX[t[3]], SBOX[t[0]]]); rcon = xt(rcon); }
    else if (nk > 6 && i % nk === 4) t = t.map((b) => SBOX[b]);
    for (let j = 0; j < 4; j++) w[i * 4 + j] = w[(i - nk) * 4 + j] ^ t[j];
  }
  return { w, nr };
};
const decBlock = (inp, ks) => {
  const s = inp.slice();
  const { w, nr } = ks;
  const ark = (r) => { for (let i = 0; i < 16; i++) s[i] ^= w[r * 16 + i]; };
  ark(nr);
  for (let r = nr - 1; r >= 0; r--) {
    const t = s.slice();
    for (let c = 0; c < 4; c++) for (let rr = 0; rr < 4; rr++) s[c * 4 + rr] = INV[t[((c - rr + 4) % 4) * 4 + rr]];
    ark(r);
    if (r > 0) {
      for (let c = 0; c < 4; c++) {
        const a = s.slice(c * 4, c * 4 + 4);
        for (let rr = 0; rr < 4; rr++) {
          s[c * 4 + rr] = mul(a[rr], 14) ^ mul(a[(rr + 1) % 4], 11) ^ mul(a[(rr + 2) % 4], 13) ^ mul(a[(rr + 3) % 4], 9);
        }
      }
    }
  }
  return s;
};
const aesCbcDecrypt = (data, key, iv) => {
  const ks = expandKey(key);
  let prev = new Uint8Array(16);
  prev.set(iv.subarray(0, 16));
  const out = new Uint8Array(data.length);
  for (let o = 0; o + 16 <= data.length; o += 16) {
    const blk = data.subarray(o, o + 16);
    const d = decBlock(blk, ks);
    for (let i = 0; i < 16; i++) out[o + i] = d[i] ^ prev[i];
    prev = blk;
  }
  const pad = out[out.length - 1];
  return pad > 0 && pad <= 16 ? out.subarray(0, out.length - pad) : out;
};

M.crypto = { aesCbcDecrypt, sha256, sha1, hmac256, pbkdf2, hex, unhex, utf8, rnd, scram, b64utf8, oaepEncrypt, rsaEncryptBody,
  sha256hex: (s) => hex(sha256(s)) };
