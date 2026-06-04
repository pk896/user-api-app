// public/admin-ui/js/admin-gross-sales-metric.js
'use strict';

(function () {
  const grossSalesEl = document.getElementById('admin-gross-sales-value');
  const grossSalesOrdersEl = document.getElementById('admin-gross-sales-orders');
  const grossSalesBarEl = document.getElementById('admin-gross-sales-bar');
  const grossSalesMetaEl = document.getElementById('admin-gross-sales-meta');

  if (!grossSalesEl || !grossSalesOrdersEl || !grossSalesBarEl || !grossSalesMetaEl) {
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

    grossSalesBarEl.style.width = `${safePercent}%`;
    grossSalesBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadGrossSalesMetric() {
    try {
      grossSalesEl.textContent = 'Loading...';
      grossSalesOrdersEl.textContent = '0';
      grossSalesMetaEl.textContent = 'Loading last 30 days...';
      setProgressBar(0);

      const response = await fetch('/api/admin/gross-sales-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Gross Sales metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const grossSales = Number(payload.grossSales || 0);
      const grossSalesOrders = Number(payload.grossSalesOrders || 0);
      const windowDays = Number(payload.windowDays || 30);

      grossSalesEl.textContent = formatMoney(grossSales, currency);
      grossSalesOrdersEl.textContent = String(grossSalesOrders);
      grossSalesMetaEl.textContent = `Last ${windowDays} days • Before refunds, fees, payouts & shipping`;

      setProgressBar(grossSales > 0 ? 100 : 0);
    } catch (error) {
      console.error('❌ admin gross sales metric frontend error:', error);

      grossSalesEl.textContent = 'Failed';
      grossSalesOrdersEl.textContent = '0';
      grossSalesMetaEl.textContent = 'Could not load Gross Sales';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadGrossSalesMetric);
})();

