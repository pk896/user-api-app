// utils/fx/getFxRate.js
'use strict';

const { fetch } = require('undici');

// ======================================================
// ✅ FX provider config
// ======================================================

// Provider selection:
// - FX_PROVIDER=frankfurter   (built-in public provider, no key)
// - FX_PROVIDER=custom        (your own API at FX_API_BASE)
// - FX_PROVIDER=off           (disable FX, strict mismatch fail)
// Backward compatibility:
// - If FX_API_BASE is set and FX_PROVIDER is not set, we auto-use "custom"
const FX_API_BASE = String(process.env.FX_API_BASE || '').trim();

const FX_PROVIDER = (() => {
  const raw = String(process.env.FX_PROVIDER || '').trim().toLowerCase();

  if (raw === 'frankfurter') return 'frankfurter';
  if (raw === 'custom') return 'custom';
  if (raw === 'off' || raw === 'none' || raw === 'disabled') return 'off';

  if (FX_API_BASE) return 'custom';
  return 'frankfurter';
})();

const FX_TIMEOUT_MS = (() => {
  const n = Number(String(process.env.FX_TIMEOUT_MS || '').trim());
  return Number.isFinite(n) ? Math.max(3000, Math.min(15000, Math.floor(n))) : 8000;
})();

const FX_CACHE_TTL_MS = (() => {
  const n = Number(String(process.env.FX_CACHE_TTL_MS || '').trim());
  return Number.isFinite(n)
    ? Math.max(60_000, Math.min(6 * 60 * 60 * 1000, Math.floor(n)))
    : 10 * 60 * 1000;
})();

const _fxCache = new Map();    // key => { rate, expiresAt }
const _fxInflight = new Map(); // key => Promise<number>

// ======================================================
// ✅ Helpers
// ======================================================
function _assertCcy(ccy) {
  const s = String(ccy || '').toUpperCase().trim();
  if (!/^[A-Z]{3}$/.test(s)) {
    const err = new Error(`Invalid FX currency code: ${ccy}`);
    err.code = 'FX_INVALID_CURRENCY';
    throw err;
  }
  return s;
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(t);
  }
}

async function _getFxRateFromCustom(from, to) {
  if (!FX_API_BASE) {
    const err = new Error('FX_PROVIDER=custom but FX_API_BASE is not configured.');
    err.code = 'FX_NOT_CONFIGURED';
    throw err;
  }

  const url =
    `${FX_API_BASE.replace(/\/$/, '')}/convert` +
    `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

  const res = await fetchWithTimeout(
    url,
    { method: 'GET', headers: { Accept: 'application/json' } },
    FX_TIMEOUT_MS
  );

  const json = await res.json().catch(() => ({}));
  const rawRate = json?.rate ?? json?.data?.rate ?? null;
  const rate = Number(rawRate);

  if (!res.ok || !Number.isFinite(rate) || rate <= 0) {
    const err = new Error(`FX custom provider failed for ${from}->${to}`);
    err.code = 'FX_LOOKUP_FAILED';
    throw err;
  }

  return rate;
}

async function _getFxRateFromFrankfurter(from, to) {
  const hosts = [
    'https://api.frankfurter.dev/v1/latest',
    'https://api.frankfurter.app/latest', // fallback
  ];

  let lastErr = null;

  for (const baseUrl of hosts) {
    try {
      const url =
        `${baseUrl}?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;

      const res = await fetchWithTimeout(
        url,
        { method: 'GET', headers: { Accept: 'application/json' } },
        FX_TIMEOUT_MS
      );

      const json = await res.json().catch(() => ({}));
      const rate = Number(json?.rates?.[to]);

      if (res.ok && Number.isFinite(rate) && rate > 0) {
        return rate;
      }

      lastErr = new Error(`Frankfurter bad response from ${baseUrl}`);
    } catch (e) {
      lastErr = e;
    }
  }

  const err = new Error(
    `FX Frankfurter lookup failed for ${from}->${to}: ${lastErr?.message || 'unknown error'}`
  );
  err.code = 'FX_LOOKUP_FAILED';
  throw err;
}

async function getFxRate(fromCcy, toCcy) {
  const from = _assertCcy(fromCcy);
  const to = _assertCcy(toCcy);

  if (from === to) return 1;

  if (FX_PROVIDER === 'off') {
    const err = new Error(`FX is disabled (FX_PROVIDER=off): ${from}->${to}`);
    err.code = 'FX_DISABLED';
    throw err;
  }

  const key = `${from}->${to}`;
  const now = Date.now();

  // ✅ cache hit
  const cached = _fxCache.get(key);
  if (cached && Number.isFinite(cached.rate) && cached.expiresAt > now) {
    return cached.rate;
  }

  // ✅ de-dupe concurrent lookups
  if (_fxInflight.has(key)) {
    return _fxInflight.get(key);
  }

  const p = (async () => {
    let rate = null;

    if (FX_PROVIDER === 'custom') {
      rate = await _getFxRateFromCustom(from, to);
    } else if (FX_PROVIDER === 'frankfurter') {
      rate = await _getFxRateFromFrankfurter(from, to);
    } else {
      const err = new Error(`Unsupported FX_PROVIDER: ${FX_PROVIDER}`);
      err.code = 'FX_PROVIDER_INVALID';
      throw err;
    }

    if (!Number.isFinite(rate) || rate <= 0) {
      const err = new Error(`Invalid FX rate for ${from}->${to}`);
      err.code = 'FX_INVALID_RATE';
      throw err;
    }

    _fxCache.set(key, {
      rate,
      expiresAt: Date.now() + FX_CACHE_TTL_MS,
    });

    return rate;
  })();

  _fxInflight.set(key, p);

  try {
    return await p;
  } finally {
    _fxInflight.delete(key);
  }
}

async function convertMoneyAmount(amount, fromCcy, toCcy) {
  const n = Number(amount);
  if (!Number.isFinite(n)) {
    const err = new Error('Invalid amount for conversion');
    err.code = 'FX_INVALID_AMOUNT';
    throw err;
  }

  const from = _assertCcy(fromCcy);
  const to = _assertCcy(toCcy);

  // Fast path
  if (from === to) {
    const same = +n.toFixed(2);
    return {
      value: same,
      currency: to,
      fx: {
        rate: 1,
        from,
        to,
        original: +n.toFixed(2),
        converted: same,
        provider: FX_PROVIDER,
      },
    };
  }

  const rate = await getFxRate(from, to);
  const converted = +(n * rate).toFixed(2);

  return {
    value: converted,
    currency: to,
    fx: {
      rate: +Number(rate).toFixed(8),
      from,
      to,
      original: +n.toFixed(2),
      converted,
      provider: FX_PROVIDER,
    },
  };
}

module.exports = {
  getFxRate,
  convertMoneyAmount,
  FX_PROVIDER,
};