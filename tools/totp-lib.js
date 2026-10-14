/*
 * Thuật toán TOTP (RFC 6238) tự chứa, không phụ thuộc thư viện hay API trình duyệt (kể cả crypto.subtle),
 * nên chạy được khi mở trực tiếp file bằng file:// và trong Node để kiểm thử.
 */
(function (root) {
  'use strict';

  var B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

  function base32Decode(input) {
    var s = String(input).replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
    if (s.length === 0) throw new Error('Khóa trống.');
    var bits = 0, value = 0, out = [];
    for (var i = 0; i < s.length; i++) {
      var idx = B32.indexOf(s[i]);
      if (idx < 0) throw new Error('Khóa chỉ gồm chữ A-Z và số 2-7.');
      value = (value << 5) | idx;
      bits += 5;
      if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
    }
    if (out.length < 10) throw new Error('Khóa quá ngắn.');
    return new Uint8Array(out);
  }

  function sha1(bytes) {
    var ml = bytes.length * 8;
    var padLen = ((bytes.length + 1 + 8 + 63) >> 6) << 6;
    var buf = new Uint8Array(padLen);
    buf.set(bytes);
    buf[bytes.length] = 0x80;
    var dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, Math.floor(ml / 4294967296));
    dv.setUint32(padLen - 4, ml >>> 0);
    var h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
    var w = new Uint32Array(80);
    for (var off = 0; off < padLen; off += 64) {
      var i;
      for (i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (i = 16; i < 80; i++) { var x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16]; w[i] = (x << 1) | (x >>> 31); }
      var a = h0, b = h1, c = h2, d = h3, e = h4;
      for (i = 0; i < 80; i++) {
        var f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5A827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
        else { f = b ^ c ^ d; k = 0xCA62C1D6; }
        var t = ((((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0);
        e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    var out = new Uint8Array(20), odv = new DataView(out.buffer);
    odv.setUint32(0, h0); odv.setUint32(4, h1); odv.setUint32(8, h2); odv.setUint32(12, h3); odv.setUint32(16, h4);
    return out;
  }

  function hmacSha1(key, msg) {
    if (key.length > 64) key = sha1(key);
    var ipad = new Uint8Array(64 + msg.length), opad = new Uint8Array(64 + 20);
    for (var i = 0; i < 64; i++) {
      var kb = i < key.length ? key[i] : 0;
      ipad[i] = kb ^ 0x36;
      opad[i] = kb ^ 0x5c;
    }
    ipad.set(msg, 64);
    opad.set(sha1(ipad), 64);
    return sha1(opad);
  }

  /** Mã TOTP tại thời điểm timeMs (mili giây). */
  function totp(secretBase32, timeMs, digits, stepSec) {
    digits = digits || 6;
    stepSec = stepSec || 30;
    var counter = Math.floor(timeMs / 1000 / stepSec);
    var msg = new Uint8Array(8), dv = new DataView(msg.buffer);
    dv.setUint32(0, Math.floor(counter / 4294967296));
    dv.setUint32(4, counter >>> 0);
    var h = hmacSha1(base32Decode(secretBase32), msg);
    var off = h[19] & 0xf;
    var code = (((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3]) % Math.pow(10, digits);
    return String(code).padStart(digits, '0');
  }

  /** Nhận khóa dạng chữ hoặc đường dẫn otpauth://totp/...?secret=... và trả về khóa chuẩn hóa. */
  function parseKey(input) {
    var s = String(input).trim();
    if (/^otpauth:\/\//i.test(s)) {
      var m = /[?&]secret=([^&]+)/i.exec(s);
      if (!m) throw new Error('Đường dẫn otpauth không có khóa (secret).');
      s = decodeURIComponent(m[1]);
    }
    s = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
    base32Decode(s); // kiểm tra hợp lệ
    return s;
  }

  var api = { totp: totp, base32Decode: base32Decode, sha1: sha1, hmacSha1: hmacSha1, parseKey: parseKey };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Totp = api;
})(typeof window !== 'undefined' ? window : this);
