// public/admin-ui/js/admin-platform-fees-metric.js
'use strict';

(function () {
  const platformFeesEl = document.getElementById('admin-platform-fees-value');
  const platformFeesOrdersEl = document.getElementById('admin-platform-fees-orders');
  const platformFeesRateEl = document.getElementById('admin-platform-fees-rate');
  const platformFeesBaseEl = document.getElementById('admin-platform-fees-base');
  const platformFeesBarEl = document.getElementById('admin-platform-fees-bar');
  const platformFeesMetaEl = document.getElementById('admin-platform-fees-meta');

  if (
    !platformFeesEl ||
    !platformFeesOrdersEl ||
    !platformFeesRateEl ||
    !platformFeesBaseEl ||
    !platformFeesBarEl ||
    !platformFeesMetaEl
  ) {
    return;
  }

  function formatMoney(amount, currency) {
    const numeric = Number(amount || 0);
    const safeAmount = Number.isFinite(numeric) ? numeric : 0;

    const resolvedCurrency =
      String(currency || '').trim().toUpperCase() || 'USD';

    try {
      const formatted = new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: resolvedCurrency,
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      }).format(safeAmount);

      if (resolvedCurrency === 'ZAR') {
        return formatted.replace(/^ZAR\s?/, 'R');
      }

      return formatted;
    } catch {
      return `${resolvedCurrency} ${safeAmount.toFixed(2)}`;
    }
  }

  function setProgressBar(percent) {
    const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));

    platformFeesBarEl.style.width = `${safePercent}%`;
    platformFeesBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadPlatformFeesMetric() {
    try {
      platformFeesEl.textContent = 'Loading...';
      platformFeesOrdersEl.textContent = '0';
      platformFeesRateEl.textContent = '0%';
      platformFeesBaseEl.textContent = '0';
      platformFeesMetaEl.textContent = 'Loading last 30 days...';
      setProgressBar(0);

      const response = await fetch('/api/admin/platform-fees-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Platform Fees Earned metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const platformFeesEarned = Number(payload.platformFeesEarned || 0);
      const feeBaseSales = Number(payload.feeBaseSales || 0);
      const ordersCounted = Number(payload.ordersCounted || 0);
      const averagePlatformFeePercent = Number(payload.averagePlatformFeePercent || 0);
      const windowDays = Number(payload.windowDays || 30);

      const progressPercent =
        feeBaseSales > 0 ? (platformFeesEarned / feeBaseSales) * 100 : 0;

      platformFeesEl.textContent = formatMoney(platformFeesEarned, currency);
      platformFeesOrdersEl.textContent = String(ordersCounted);
      platformFeesRateEl.textContent = `${averagePlatformFeePercent.toFixed(2)}%`;
      platformFeesBaseEl.textContent = formatMoney(feeBaseSales, currency);

      platformFeesMetaEl.textContent =
        `Last ${windowDays} days • Commission after refunds`;

      setProgressBar(progressPercent);
    } catch (error) {
      console.error('❌ admin platform fees metric frontend error:', error);

      platformFeesEl.textContent = 'Failed';
      platformFeesOrdersEl.textContent = '0';
      platformFeesRateEl.textContent = '0%';
      platformFeesBaseEl.textContent = '0';
      platformFeesMetaEl.textContent = 'Could not load Platform Fees Earned';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadPlatformFeesMetric);
})();

