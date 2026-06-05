// public/admin-ui/js/admin-refund-rate-metric.js
'use strict';

(function () {
  const refundRateEl = document.getElementById('admin-refund-rate-value');
  const refundRatePaidOrdersEl = document.getElementById('admin-refund-rate-paid-orders');
  const refundRateRefundedOrdersEl = document.getElementById('admin-refund-rate-refunded-orders');
  const refundRateEventsEl = document.getElementById('admin-refund-rate-events');
  const refundRateBarEl = document.getElementById('admin-refund-rate-bar');
  const refundRateMetaEl = document.getElementById('admin-refund-rate-meta');

  if (
    !refundRateEl ||
    !refundRatePaidOrdersEl ||
    !refundRateRefundedOrdersEl ||
    !refundRateEventsEl ||
    !refundRateBarEl ||
    !refundRateMetaEl
  ) {
    return;
  }

  function formatPercent(value) {
    const numeric = Number(value || 0);
    const safeValue = Number.isFinite(numeric) ? numeric : 0;

    return `${safeValue.toFixed(2)}%`;
  }

  function setProgressBar(percent) {
    const safePercent = Math.max(0, Math.min(100, Number(percent || 0)));

    refundRateBarEl.style.width = `${safePercent}%`;
    refundRateBarEl.setAttribute('aria-valuenow', String(Math.round(safePercent)));
  }

  async function loadRefundRateMetric() {
    try {
      refundRateEl.textContent = 'Loading...';
      refundRatePaidOrdersEl.textContent = '0';
      refundRateRefundedOrdersEl.textContent = '0';
      refundRateEventsEl.textContent = '0';
      refundRateMetaEl.textContent = 'Loading last 30 days...';
      setProgressBar(0);

      const response = await fetch('/api/admin/refund-rate-metric', {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || 'Failed to load Refund Rate metric');
      }

      const refundRate = Number(payload.refundRate || 0);
      const paidOrders = Number(payload.paidOrders || 0);
      const refundedOrders = Number(payload.refundedOrders || 0);
      const refundEvents = Number(payload.refundEvents || 0);
      const windowDays = Number(payload.windowDays || 30);

      refundRateEl.textContent = formatPercent(refundRate);
      refundRatePaidOrdersEl.textContent = String(paidOrders);
      refundRateRefundedOrdersEl.textContent = String(refundedOrders);
      refundRateEventsEl.textContent = String(refundEvents);

      refundRateMetaEl.textContent =
        `Last ${windowDays} days • Refunded orders divided by paid orders`;

      setProgressBar(refundRate);
    } catch (error) {
      console.error('❌ admin refund rate metric frontend error:', error);

      refundRateEl.textContent = 'Failed';
      refundRatePaidOrdersEl.textContent = '0';
      refundRateRefundedOrdersEl.textContent = '0';
      refundRateEventsEl.textContent = '0';
      refundRateMetaEl.textContent = 'Could not load Refund Rate';
      setProgressBar(0);
    }
  }

  document.addEventListener('DOMContentLoaded', loadRefundRateMetric);
})();

