// utils/money.js
'use strict';

function moneyToCents(value) {
  // value can be "15.00", 15, "15", etc.
  const s = String(value ?? '0').trim();
  if (!s) return 0;

  // normalize "15", "15.0", "15.00"
  const neg = s.startsWith('-');
  const t = neg ? s.slice(1) : s;

  const [wholeRaw, fracRaw = ''] = t.split('.');
  const whole = wholeRaw.replace(/[^\d]/g, '') || '0';
  const frac = (fracRaw.replace(/[^\d]/g, '') + '00').slice(0, 2);

  const cents = (parseInt(whole, 10) * 100) + parseInt(frac, 10);
  return neg ? -cents : cents;
}

function centsToMoneyString(cents) {
  const n = Math.round(Number(cents || 0));
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  const whole = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}

module.exports = { moneyToCents, centsToMoneyString };
