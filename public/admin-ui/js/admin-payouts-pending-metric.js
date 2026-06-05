// public/admin-ui/js/admin-payouts-pending-metric.js
'use strict';

(function () {
  const payoutsPendingEl = document.getElementById('admin-payouts-pending-value');
  const eligibleBusinessesEl = document.getElementById('admin-payouts-pending-eligible');
  const availablePendingEl = document.getElementById('admin-payouts-pending-available');
  const processingPendingEl = document.getElementById('admin-payouts-pending-processing');
  const payoutsPendingBarEl = document.getElementById('admin-payouts-pending-bar');
  const payoutsPendingMetaEl = document.getElementById('admin-payouts-pending-meta');

  if (
    !payoutsPendingEl ||
    !eligibleBusinessesEl ||
    !availablePendingEl ||
    !processingPendingEl ||
    !payoutsPendingBarEl ||
    !payoutsPendingMetaEl
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

    payoutsPendingBarEl.style.width = `${safePercent}%`;
    payoutsPendingBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadPayoutsPendingMetric() {
    try {
      payoutsPendingEl.textContent = 'Loading...';
      eligibleBusinessesEl.textContent = '0';
      availablePendingEl.textContent = '0';
      processingPendingEl.textContent = '0';
      payoutsPendingMetaEl.textContent = 'Loading payout balances...';
      setProgressBar(0);

      const response = await fetch('/api/admin/payouts-pending-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Payouts Pending metric');
      }

      const currency =
        String(payload.currency || '').trim().toUpperCase() || 'USD';

      const payoutsPending = Number(payload.payoutsPending || 0);
      const availablePending = Number(payload.availablePending || 0);
      const processingPending = Number(payload.processingPending || 0);
      const eligibleBusinesses = Number(payload.eligibleBusinesses || 0);
      const processingPendingItems = Number(payload.processingPendingItems || 0);
      const processingBatchesCount = Number(payload.processingBatchesCount || 0);

      payoutsPendingEl.textContent = formatMoney(payoutsPending, currency);
      eligibleBusinessesEl.textContent = String(eligibleBusinesses);
      availablePendingEl.textContent = formatMoney(availablePending, currency);
      processingPendingEl.textContent = formatMoney(processingPending, currency);

      payoutsPendingMetaEl.textContent =
        `${processingPendingItems} payout item(s) still pending in ${processingBatchesCount} batch(es)`;

      setProgressBar(payoutsPending > 0 ? 100 : 0);
    } catch (error) {
      console.error('❌ admin payouts pending metric frontend error:', error);

      payoutsPendingEl.textContent = 'Failed';
      eligibleBusinessesEl.textContent = '0';
      availablePendingEl.textContent = '0';
      processingPendingEl.textContent = '0';
      payoutsPendingMetaEl.textContent = 'Could not load Payouts Pending';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadPayoutsPendingMetric);
})();

