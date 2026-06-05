// public/admin-ui/js/admin-orders-needing-labels-metric.js
'use strict';

(function () {
  const needingLabelsEl = document.getElementById('admin-orders-needing-labels-value');
  const readyForLabelEl = document.getElementById('admin-orders-needing-labels-ready');
  const missingChoiceEl = document.getElementById('admin-orders-needing-labels-missing-choice');
  const needingLabelsValueEl = document.getElementById('admin-orders-needing-labels-money');
  const needingLabelsBarEl = document.getElementById('admin-orders-needing-labels-bar');
  const needingLabelsMetaEl = document.getElementById('admin-orders-needing-labels-meta');

  if (
    !needingLabelsEl ||
    !readyForLabelEl ||
    !missingChoiceEl ||
    !needingLabelsValueEl ||
    !needingLabelsBarEl ||
    !needingLabelsMetaEl
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

    needingLabelsBarEl.style.width = `${safePercent}%`;
    needingLabelsBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadOrdersNeedingLabelsMetric() {
    try {
      needingLabelsEl.textContent = 'Loading...';
      readyForLabelEl.textContent = '0';
      missingChoiceEl.textContent = '0';
      needingLabelsValueEl.textContent = '0';
      needingLabelsMetaEl.textContent = 'Loading orders needing labels...';
      setProgressBar(0);

      const response = await fetch('/api/admin/orders-needing-labels-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Orders Needing Labels metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const ordersNeedingLabels = Number(payload.ordersNeedingLabels || 0);
      const readyForLabel = Number(payload.readyForLabel || 0);
      const missingPayerChoice = Number(payload.missingPayerChoice || 0);
      const ordersNeedingLabelsValue = Number(payload.ordersNeedingLabelsValue || 0);
      const itemsNeedingLabels = Number(payload.itemsNeedingLabels || 0);
      const windowDays = Number(payload.windowDays || 30);

      needingLabelsEl.textContent = String(ordersNeedingLabels);
      readyForLabelEl.textContent = String(readyForLabel);
      missingChoiceEl.textContent = String(missingPayerChoice);
      needingLabelsValueEl.textContent = formatMoney(ordersNeedingLabelsValue, currency);

      needingLabelsMetaEl.textContent =
        `Last ${windowDays} days • ${itemsNeedingLabels} item(s) inside these orders`;

      setProgressBar(ordersNeedingLabels > 0 ? 100 : 0);
    } catch (error) {
      console.error('❌ admin orders needing labels metric frontend error:', error);

      needingLabelsEl.textContent = 'Failed';
      readyForLabelEl.textContent = '0';
      missingChoiceEl.textContent = '0';
      needingLabelsValueEl.textContent = '0';
      needingLabelsMetaEl.textContent = 'Could not load Orders Needing Labels';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadOrdersNeedingLabelsMetric);
})();

