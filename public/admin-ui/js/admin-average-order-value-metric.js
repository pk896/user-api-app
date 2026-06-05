// public/admin-ui/js/admin-average-order-value-metric.js
'use strict';

(function () {
  const averageOrderValueEl = document.getElementById('admin-average-order-value');
  const paidOrdersEl = document.getElementById('admin-average-order-paid-orders');
  const paidSalesEl = document.getElementById('admin-average-order-paid-sales');
  const highestOrderEl = document.getElementById('admin-average-order-highest');
  const averageOrderBarEl = document.getElementById('admin-average-order-bar');
  const averageOrderMetaEl = document.getElementById('admin-average-order-meta');

  if (
    !averageOrderValueEl ||
    !paidOrdersEl ||
    !paidSalesEl ||
    !highestOrderEl ||
    !averageOrderBarEl ||
    !averageOrderMetaEl
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

    averageOrderBarEl.style.width = `${safePercent}%`;
    averageOrderBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadAverageOrderValueMetric() {
    try {
      averageOrderValueEl.textContent = 'Loading...';
      paidOrdersEl.textContent = '0';
      paidSalesEl.textContent = '0';
      highestOrderEl.textContent = '0';
      averageOrderMetaEl.textContent = 'Loading last 30 days...';
      setProgressBar(0);

      const response = await fetch('/api/admin/average-order-value-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Average Order Value metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const averageOrderValue = Number(payload.averageOrderValue || 0);
      const totalPaidProductSales = Number(payload.totalPaidProductSales || 0);
      const paidOrders = Number(payload.paidOrders || 0);
      const totalItemsSold = Number(payload.totalItemsSold || 0);
      const highestOrderValue = Number(payload.highestOrderValue || 0);
      const windowDays = Number(payload.windowDays || 30);

      const progressPercent =
        highestOrderValue > 0 ? (averageOrderValue / highestOrderValue) * 100 : 0;

      averageOrderValueEl.textContent = formatMoney(averageOrderValue, currency);
      paidOrdersEl.textContent = String(paidOrders);
      paidSalesEl.textContent = formatMoney(totalPaidProductSales, currency);
      highestOrderEl.textContent = formatMoney(highestOrderValue, currency);

      averageOrderMetaEl.textContent =
        `Last ${windowDays} days • ${totalItemsSold} item(s) sold`;

      setProgressBar(progressPercent);
    } catch (error) {
      console.error('❌ admin average order value metric frontend error:', error);

      averageOrderValueEl.textContent = 'Failed';
      paidOrdersEl.textContent = '0';
      paidSalesEl.textContent = '0';
      highestOrderEl.textContent = '0';
      averageOrderMetaEl.textContent = 'Could not load Average Order Value';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadAverageOrderValueMetric);
})();