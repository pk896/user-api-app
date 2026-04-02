// public/js/admin-dashboard-stats.js
'use strict';

// -----------------------------
// small helpers
// -----------------------------
function setText(id, value, { emptyIfNull = true } = {}) {
  const el = document.getElementById(id);
  if (!el) return;

  if (emptyIfNull && (value === null || value === undefined || value === '')) {
    el.textContent = '';
    return;
  }

  el.textContent = String(value);
}

function money(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return '';
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function setAdminSummaryBar(elementId, value, maxValue) {
  const el = document.getElementById(elementId);
  if (!el) return;

  const safeValue = Number(value || 0);
  const safeMax = Math.max(Number(maxValue || 0), 1);
  const percent = Math.max(0, Math.min(100, Math.round((safeValue / safeMax) * 100)));

  el.style.width = `${percent}%`;
  el.setAttribute('aria-valuenow', String(percent));
}

// -----------------------------
// API loaders
// -----------------------------
async function loadAdminBusinessStats() {
  try {
    const res = await fetch('/api/admin/stats/businesses', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) throw new Error('Failed to load businesses stats: ' + res.status);

    const data = await res.json();
    if (!data || data.ok !== true) throw new Error(data?.message || 'Bad response');

    // fallback businesses count
    setText('stat-total-businesses', data.totalBusinesses);

    // app users (businesses + users)
    try {
      const res2 = await fetch('/api/admin/stats/app-users', {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });

      if (!res2.ok) throw new Error('Failed to load app users stats: ' + res2.status);

      const data2 = await res2.json();
      if (!data2 || data2.ok !== true) throw new Error(data2?.message || 'Bad response');

      setText('stat-total-app-users', data2.totalAppUsers);
      setText('stat-total-businesses', data2.totalBusinesses);
      setText('stat-non-business-users', data2.nonBusinessUsers);
    } catch (e) {
      console.error('admin app users stats error:', e);
      setText('stat-total-app-users', data.totalBusinesses);
      setText('stat-non-business-users', '—', { emptyIfNull: false });
    }

    setText('stat-sellers', data.sellers);
    setText('stat-suppliers', data.suppliers);
    setText('stat-buyers', data.buyers);
  } catch (err) {
    console.error('admin business stats error:', err);
  }
}

async function loadAdminInventoryStats() {
  try {
    const res = await fetch('/api/admin/stats/inventory', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) throw new Error('Failed to load inventory stats: ' + res.status);

    const data = await res.json();
    if (!data || data.ok !== true) throw new Error(data?.message || 'Bad response');

    setText('stat-seller-products', data?.sellers?.totalProducts);
    setText('stat-seller-stock', data?.sellers?.totalStock);

    const value = Number(data?.sellers?.inventoryValue ?? 0);
    const formattedValue = Number.isFinite(value) ? money(value) : '';
    setText('stat-seller-value', formattedValue);
  } catch (err) {
    console.error('admin inventory stats error:', err);
  }
}

async function loadAdminOrdersStats() {
  try {
    const res = await fetch('/api/admin/stats/orders', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });

    if (!res.ok) throw new Error('Failed to load orders stats: ' + res.status);

    const data = await res.json();
    if (!data || data.ok !== true) throw new Error(data?.message || 'Bad response');

    setText('stat-total-orders', data.totalOrders);
    setText('stat-pending-orders', data.pendingOrders);

    setText('stat-total-paid', money(data.totalPaid));
    setText('stat-refunded-orders', data.refundedOrders);

    setText('stat-refunds-count', data.refundsCount);
    setText('stat-refunded-total', money(data.refundedTotal));

    const available = Number(data.totalPaid || 0) - Number(data.refundedTotal || 0);
    setText('stat-available-revenue', money(available));

    setText('stat-chargebacks-count', data.chargebacksCount);

    const totalOrders = Number(data.totalOrders || 0);
    const pendingOrders = Number(data.pendingOrders || 0);
    const totalPaid = Number(data.totalPaid || 0);
    const refundsCount = Number(data.refundsCount || 0);
    const availableRevenue = Number(available || 0);
    const chargebacksCount = Number(data.chargebacksCount || 0);

    // Count-based bars
    const countMaxValue = Math.max(
      totalOrders,
      refundsCount,
      chargebacksCount,
      1
    );

    // Money-based bars
    const moneyMaxValue = Math.max(
      totalPaid,
      availableRevenue,
      1
    );

    // Total Orders bar should reflect pending volume within the last 30 days
    setAdminSummaryBar('admin-summary-total-orders-bar', pendingOrders, countMaxValue);

    // Money bars
    setAdminSummaryBar('admin-summary-total-paid-bar', totalPaid, moneyMaxValue);
    setAdminSummaryBar('admin-summary-available-revenue-bar', availableRevenue, moneyMaxValue);

    // Other count bars
    setAdminSummaryBar('admin-summary-refunds-bar', refundsCount, countMaxValue);
    setAdminSummaryBar('admin-summary-chargebacks-bar', chargebacksCount, countMaxValue);
  } catch (err) {
    console.error('admin orders stats error:', err);
  }
}

// -----------------------------
// init
// -----------------------------
document.addEventListener('DOMContentLoaded', () => {
  loadAdminBusinessStats();
  loadAdminInventoryStats();
  loadAdminOrdersStats();
});