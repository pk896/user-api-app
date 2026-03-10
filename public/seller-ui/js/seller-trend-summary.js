// public/seller-ui/js/seller-trend-summary.js
'use strict';

function setSellerTrendSummaryBar(elementId, value, maxValue) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const safeValue = Number(value || 0);
  const safeMax = Math.max(Number(maxValue || 0), 1);
  const percent = Math.max(0, Math.min(100, Math.round((safeValue / safeMax) * 100)));

  el.style.width = `${percent}%`;
  el.setAttribute('aria-valuenow', String(percent));
}

async function loadSellerTrendSummary() {
  try {
    const response = await fetch('/api/seller/trend-summary', {
      method: 'GET',
      credentials: 'same-origin',
      headers: {
        Accept: 'application/json'
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json();

    if (!payload.ok) {
      throw new Error(payload.message || 'Failed to load seller trend summary');
    }

    const salesLast30Days = Number(payload?.summary?.salesLast30Days || 0);
    const refundsLast30Days = Number(payload?.summary?.refundsLast30Days || 0);
    const ordersLast30Days = Number(payload?.summary?.ordersLast30Days || 0);
    const lastSalesPeakLast30Days = Number(payload?.summary?.lastSalesPeakLast30Days || 0);

    const salesEl = document.getElementById('seller-summary-sales-last-30-days');
    const refundsEl = document.getElementById('seller-summary-refunds-last-30-days');
    const ordersEl = document.getElementById('seller-summary-orders-last-30-days');
    const peakEl = document.getElementById('seller-summary-last-sales-peak-last-30-days');

    if (salesEl) {
      salesEl.textContent = String(salesLast30Days);
    }

    if (refundsEl) {
      refundsEl.textContent = String(refundsLast30Days);
    }

    if (ordersEl) {
      ordersEl.textContent = String(ordersLast30Days);
    }

    if (peakEl) {
      peakEl.textContent = String(lastSalesPeakLast30Days);
    }

    const maxValue = Math.max(
      salesLast30Days,
      refundsLast30Days,
      ordersLast30Days,
      lastSalesPeakLast30Days,
      1
    );

    setSellerTrendSummaryBar(
      'seller-summary-sales-last-30-days-bar',
      salesLast30Days,
      maxValue
    );
    setSellerTrendSummaryBar(
      'seller-summary-refunds-last-30-days-bar',
      refundsLast30Days,
      maxValue
    );
    setSellerTrendSummaryBar(
      'seller-summary-orders-last-30-days-bar',
      ordersLast30Days,
      maxValue
    );
    setSellerTrendSummaryBar(
      'seller-summary-last-sales-peak-last-30-days-bar',
      lastSalesPeakLast30Days,
      maxValue
    );
  } catch (error) {
    console.error('❌ Failed to load seller trend summary:', error);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSellerTrendSummary();

  const refreshMainChartBtn = document.getElementById('refresh-main-chart');
  if (refreshMainChartBtn) {
    refreshMainChartBtn.addEventListener('click', () => {
      loadSellerTrendSummary();
    });
  }
});