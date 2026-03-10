// public/seller-ui/js/seller-recent-orders-card.js
'use strict';

function escapeRecentOrdersHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatRecentOrdersCurrency(value) {
  const amount = Number(value || 0);

  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function formatRecentOrdersDate(value) {
  if (!value) return '';

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  return date.toLocaleString('en-ZA', {
    dateStyle: 'medium',
    timeStyle: 'short'
  });
}

function getRecentOrdersStatusBadgeClass(status) {
  const normalized = String(status || '').trim().toUpperCase();

  if (['COMPLETED', 'DELIVERED', 'PAID', 'SHIPPED'].includes(normalized)) {
    return 'text-bg-success';
  }

  if (['PENDING', 'PROCESSING', 'PACKING', 'LABEL_CREATED'].includes(normalized)) {
    return 'text-bg-warning';
  }

  if (['REFUNDED', 'CANCELLED', 'CANCELED', 'PARTIALLY_REFUNDED'].includes(normalized)) {
    return 'text-bg-danger';
  }

  return 'text-bg-secondary';
}

function buildRecentOrderItem(order) {
  const fullOrderId = String(order?.orderId || order?._id || '').trim();
  const shortOrderId = fullOrderId ? `#${fullOrderId.slice(-8)}` : '#N/A';
  const safeShortOrderId = escapeRecentOrdersHtml(shortOrderId);
  const safeStatus = escapeRecentOrdersHtml(order?.status || 'PENDING');
  const safeDate = escapeRecentOrdersHtml(formatRecentOrdersDate(order?.createdAt));
  const amountText = formatRecentOrdersCurrency(order?.amount || 0);
  const badgeClass = getRecentOrdersStatusBadgeClass(order?.status);

  return `
    <div class="border rounded p-2">
      <div class="d-flex justify-content-between align-items-start gap-2 mb-2">
        <div class="fw-semibold small">${safeShortOrderId}</div>
        <div class="fw-semibold small text-success">${amountText}</div>
      </div>

      <div class="d-flex justify-content-between align-items-center gap-2 flex-wrap">
        <span class="badge ${badgeClass}">${safeStatus}</span>
        <span class="small text-body-secondary">${safeDate}</span>
      </div>

      <div class="mt-2">
        <a href="/orders" class="btn btn-sm btn-primary">View</a>
      </div>
    </div>
  `;
}

async function loadSellerRecentOrdersCard() {
  try {
    const response = await fetch('/api/seller/recent-orders-card', {
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
      throw new Error(payload.message || 'Failed to load recent orders');
    }

    const listEl = document.getElementById('seller-recent-orders-card-list');
    if (!listEl) return;

    const orders = Array.isArray(payload?.orders) ? payload.orders : [];

    if (orders.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-3">
          <div class="fw-semibold text-body-secondary">No recent orders yet</div>
          <div class="small text-body-secondary">Your recent seller orders will appear here.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = orders.map((order) => buildRecentOrderItem(order)).join('');
  } catch (error) {
    console.error('❌ Failed to load seller recent orders card:', error);

    const listEl = document.getElementById('seller-recent-orders-card-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="text-danger small">
          Failed to load recent orders.
        </div>
      `;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSellerRecentOrdersCard();
});