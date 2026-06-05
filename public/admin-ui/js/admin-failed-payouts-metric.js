// public/admin-ui/js/admin-failed-payouts-metric.js
'use strict';

(function () {
  const failedPayoutsEl = document.getElementById('admin-failed-payouts-value');
  const failedItemsEl = document.getElementById('admin-failed-payouts-items');
  const failedBatchesEl = document.getElementById('admin-failed-payouts-batches');
  const latestFailedEl = document.getElementById('admin-failed-payouts-latest');
  const failedPayoutsBarEl = document.getElementById('admin-failed-payouts-bar');
  const failedPayoutsMetaEl = document.getElementById('admin-failed-payouts-meta');

  if (
    !failedPayoutsEl ||
    !failedItemsEl ||
    !failedBatchesEl ||
    !latestFailedEl ||
    !failedPayoutsBarEl ||
    !failedPayoutsMetaEl
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

    failedPayoutsBarEl.style.width = `${safePercent}%`;
    failedPayoutsBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadFailedPayoutsMetric() {
    try {
      failedPayoutsEl.textContent = 'Loading...';
      failedItemsEl.textContent = '0';
      failedBatchesEl.textContent = '0';
      latestFailedEl.textContent = '—';
      failedPayoutsMetaEl.textContent = 'Loading failed payouts...';
      setProgressBar(0);

      const response = await fetch('/api/admin/failed-payouts-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Failed Payouts metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const failedPayouts = Number(payload.failedPayouts || 0);
      const failedItems = Number(payload.failedItems || 0);
      const failedBatchesCount = Number(payload.failedBatchesCount || 0);
      const latestFailedAt = payload.latestFailedAt || null;
      const windowDays = Number(payload.windowDays || 30);

      failedPayoutsEl.textContent = formatMoney(failedPayouts, currency);
      failedItemsEl.textContent = String(failedItems);
      failedBatchesEl.textContent = String(failedBatchesCount);
      latestFailedEl.textContent = formatDate(latestFailedAt);

      failedPayoutsMetaEl.textContent =
        `Last ${windowDays} days • FAILED payout items only`;

      setProgressBar(failedPayouts > 0 ? 100 : 0);
    } catch (error) {
      console.error('❌ admin failed payouts metric frontend error:', error);

      failedPayoutsEl.textContent = 'Failed';
      failedItemsEl.textContent = '0';
      failedBatchesEl.textContent = '0';
      latestFailedEl.textContent = '—';
      failedPayoutsMetaEl.textContent = 'Could not load Failed Payouts';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadFailedPayoutsMetric);
})();