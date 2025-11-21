// utils/safeUrl.js
const dns = require('dns').promises;
const net = require('net');

// RFC1918 + localhost + link-local, etc.
const PRIVATE_RANGES = [
  { range: '10.0.0.0', mask: 8 },
  { range: '172.16.0.0', mask: 12 },
  { range: '192.168.0.0', mask: 16 },
  { range: '127.0.0.0', mask: 8 }, // loopback
  { range: '169.254.0.0', mask: 16 }, // link-local
  { range: '::1', mask: 128 }, // IPv6 loopback
  { range: 'fc00::', mask: 7 }, // ULA
  { range: 'fe80::', mask: 10 }, // link-local
];

function ipInCidr(ip, cidrBase, mask) {
  // v4 only quick check; enough for most cases
  if (net.isIP(ip) !== 4 || net.isIP(cidrBase) !== 4) {return false;}
  const toInt = (x) => x.split('.').reduce((a, b) => (a << 8) + +b, 0) >>> 0;
  const ipInt = toInt(ip),
    baseInt = toInt(cidrBase);
  const maskInt = mask === 0 ? 0 : (~0 << (32 - mask)) >>> 0;
  return (ipInt & maskInt) === (baseInt & maskInt);
}

function isPrivateIp(ip) {
  if (net.isIP(ip) === 6) {
    // quick reject common private v6
    return (
      ['::1'].includes(ip.toLowerCase()) ||
      ip.startsWith('fc') ||
      ip.startsWith('fd') ||
      ip.startsWith('fe80')
    );
  }
  return PRIVATE_RANGES.some((c) => ipInCidr(ip, c.range, c.mask));
}

function basicUrlChecks(u) {
  try {
    const url = new URL(u);
    if (!['http:', 'https:'].includes(url.protocol)) {return null;}
    // ban credentials in URL (user:pass@)
    if (url.username || url.password) {return null;}
    // disallow empty host
    if (!url.hostname) {return null;}
    return url;
  } catch {
    return null;
  }
}

// Optional: allowlist your own domains for sensitive fields
const DEFAULT_ALLOWED_HOSTS = new Set([
  'phakisi-e-commerce-product-images.s3.us-east-1.amazonaws.com',
  'yourcdn.example.com',
  // add more as needed
]);

async function isSafeHttpUrl(input, { allowedHosts = null, requirePublicIP = false } = {}) {
  const url = basicUrlChecks(input);
  if (!url) {return { ok: false, reason: 'invalid-url' };}

  if (allowedHosts && !allowedHosts.has(url.hostname)) {
    return { ok: false, reason: 'host-not-allowed' };
  }

  if (requirePublicIP) {
    try {
      const addrs = await dns.lookup(url.hostname, { all: true, verbatim: true });
      if (!addrs.length) {return { ok: false, reason: 'dns-failed' };}
      if (addrs.some((a) => isPrivateIp(a.address))) {
        return { ok: false, reason: 'private-ip' };
      }
    } catch {
      return { ok: false, reason: 'dns-error' };
    }
  }
  return { ok: true, url };
}

module.exports = { isSafeHttpUrl, DEFAULT_ALLOWED_HOSTS };
