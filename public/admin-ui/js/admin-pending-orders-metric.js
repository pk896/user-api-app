// public/admin-ui/js/admin-pending-orders-metric.js
'use strict';

(function () {
  const pendingOrdersEl = document.getElementById('admin-pending-orders-value');
  const pendingValueEl = document.getElementById('admin-pending-orders-money');
  const pendingItemsEl = document.getElementById('admin-pending-orders-items');
  const pendingBarEl = document.getElementById('admin-pending-orders-bar');
  const pendingMetaEl = document.getElementById('admin-pending-orders-meta');

  if (
    !pendingOrdersEl ||
    !pendingValueEl ||
    !pendingItemsEl ||
    !pendingBarEl ||
    !pendingMetaEl
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

    pendingBarEl.style.width = `${safePercent}%`;
    pendingBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadPendingOrdersMetric() {
    try {
      pendingOrdersEl.textContent = 'Loading...';
      pendingValueEl.textContent = '0';
      pendingItemsEl.textContent = '0';
      pendingMetaEl.textContent = 'Loading pending orders...';
      setProgressBar(0);

      const response = await fetch('/api/admin/pending-orders-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Pending Orders metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const pendingOrders = Number(payload.pendingOrders || 0);
      const pendingOrdersValue = Number(payload.pendingOrdersValue || 0);
      const pendingItems = Number(payload.pendingItems || 0);
      const windowDays = Number(payload.windowDays || 30);

      pendingOrdersEl.textContent = String(pendingOrders);
      pendingValueEl.textContent = formatMoney(pendingOrdersValue, currency);
      pendingItemsEl.textContent = String(pendingItems);

      pendingMetaEl.textContent =
        `Last ${windowDays} days • Paid but not shipped/delivered`;

      setProgressBar(pendingOrders > 0 ? 100 : 0);
    } catch (error) {
      console.error('❌ admin pending orders metric frontend error:', error);

      pendingOrdersEl.textContent = 'Failed';
      pendingValueEl.textContent = '0';
      pendingItemsEl.textContent = '0';
      pendingMetaEl.textContent = 'Could not load Pending Orders';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadPendingOrdersMetric);
})();

