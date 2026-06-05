// public/admin-ui/js/admin-payouts-completed-metric.js
'use strict';

(function () {
  const payoutsCompletedEl = document.getElementById('admin-payouts-completed-value');
  const completedItemsEl = document.getElementById('admin-payouts-completed-items');
  const completedBatchesEl = document.getElementById('admin-payouts-completed-batches');
  const latestCompletedEl = document.getElementById('admin-payouts-completed-latest');
  const payoutsCompletedBarEl = document.getElementById('admin-payouts-completed-bar');
  const payoutsCompletedMetaEl = document.getElementById('admin-payouts-completed-meta');

  if (
    !payoutsCompletedEl ||
    !completedItemsEl ||
    !completedBatchesEl ||
    !latestCompletedEl ||
    !payoutsCompletedBarEl ||
    !payoutsCompletedMetaEl
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

  function formatDate(value) {
    if (!value) {
      return '—';
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return '—';
    }

    return date.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }

  function setProgressBar(percent) {
    const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));

    payoutsCompletedBarEl.style.width = `${safePercent}%`;
    payoutsCompletedBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadPayoutsCompletedMetric() {
    try {
      payoutsCompletedEl.textContent = 'Loading...';
      completedItemsEl.textContent = '0';
      completedBatchesEl.textContent = '0';
      latestCompletedEl.textContent = '—';
      payoutsCompletedMetaEl.textContent = 'Loading completed payouts...';
      setProgressBar(0);

      const response = await fetch('/api/admin/payouts-completed-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Payouts Completed metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const payoutsCompleted = Number(payload.payoutsCompleted || 0);
      const completedItems = Number(payload.completedItems || 0);
      const completedBatchesCount = Number(payload.completedBatchesCount || 0);
      const latestCompletedAt = payload.latestCompletedAt || null;
      const windowDays = Number(payload.windowDays || 30);

      payoutsCompletedEl.textContent = formatMoney(payoutsCompleted, currency);
      completedItemsEl.textContent = String(completedItems);
      completedBatchesEl.textContent = String(completedBatchesCount);
      latestCompletedEl.textContent = formatDate(latestCompletedAt);

      payoutsCompletedMetaEl.textContent =
        `Last ${windowDays} days • SENT payout items only`;

      setProgressBar(payoutsCompleted > 0 ? 100 : 0);
    } catch (error) {
      console.error('❌ admin payouts completed metric frontend error:', error);

      payoutsCompletedEl.textContent = 'Failed';
      completedItemsEl.textContent = '0';
      completedBatchesEl.textContent = '0';
      latestCompletedEl.textContent = '—';
      payoutsCompletedMetaEl.textContent = 'Could not load Payouts Completed';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadPayoutsCompletedMetric);
})();

