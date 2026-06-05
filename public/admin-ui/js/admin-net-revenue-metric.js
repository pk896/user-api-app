// public/admin-ui/js/admin-net-revenue-metric.js
'use strict';

(function () {
  const netRevenueEl = document.getElementById('admin-net-revenue-value');
  const netRevenueOrdersEl = document.getElementById('admin-net-revenue-orders');
  const netRevenueRefundedEl = document.getElementById('admin-net-revenue-refunded');
  const netRevenueBarEl = document.getElementById('admin-net-revenue-bar');
  const netRevenueMetaEl = document.getElementById('admin-net-revenue-meta');

  if (
    !netRevenueEl ||
    !netRevenueOrdersEl ||
    !netRevenueRefundedEl ||
    !netRevenueBarEl ||
    !netRevenueMetaEl
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

    netRevenueBarEl.style.width = `${safePercent}%`;
    netRevenueBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadNetRevenueMetric() {
    try {
      netRevenueEl.textContent = 'Loading...';
      netRevenueOrdersEl.textContent = '0';
      netRevenueRefundedEl.textContent = '0';
      netRevenueMetaEl.textContent = 'Loading last 30 days...';
      setProgressBar(0);

      const response = await fetch('/api/admin/net-revenue-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Net Revenue metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const netRevenue = Number(payload.netRevenue || 0);
      const grossSales = Number(payload.grossSales || 0);
      const refundedTotal = Number(payload.refundedTotal || 0);
      const netRevenueOrders = Number(payload.netRevenueOrders || 0);
      const refundedOrders = Number(payload.refundedOrders || 0);
      const windowDays = Number(payload.windowDays || 30);

      const progressPercent =
        grossSales > 0 ? (netRevenue / grossSales) * 100 : 0;

      netRevenueEl.textContent = formatMoney(netRevenue, currency);
      netRevenueOrdersEl.textContent = String(netRevenueOrders);
      netRevenueRefundedEl.textContent = formatMoney(refundedTotal, currency);

      netRevenueMetaEl.textContent =
        `Last ${windowDays} days • ${refundedOrders} refunded order(s) reduced revenue`;

      setProgressBar(progressPercent);
    } catch (error) {
      console.error('❌ admin net revenue metric frontend error:', error);

      netRevenueEl.textContent = 'Failed';
      netRevenueOrdersEl.textContent = '0';
      netRevenueRefundedEl.textContent = '0';
      netRevenueMetaEl.textContent = 'Could not load Net Revenue';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadNetRevenueMetric);
})();

