// public/seller-ui/js/seller-top-best-sellers-card.js
'use strict';

function escapeTopBestSellersHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatTopBestSellersCurrency(value) {
  const amount = Number(value || 0);

  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function buildTopBestSellerItem(product, index) {
  const name = escapeTopBestSellersHtml(product?.name || 'Unnamed product');
  const imageUrl = String(product?.imageUrl || '').trim();
  const soldCount = Number(product?.soldCount || 0);
  const estRevenue = Number(product?.estRevenue || 0);

  const imageHtml = imageUrl
    ? `<img src="${escapeTopBestSellersHtml(imageUrl)}" alt="${name}" class="rounded border flex-shrink-0" width="48" height="48">`
    : `<div class="rounded border d-flex align-items-center justify-content-center flex-shrink-0 bg-body-tertiary" style="width:48px;height:48px;">📦</div>`;

  return `
    <div class="d-flex align-items-center justify-content-between gap-2 border rounded p-2">
      <div class="d-flex align-items-center gap-2 flex-grow-1 overflow-hidden">
        <div class="badge text-bg-success flex-shrink-0">${index + 1}</div>
        ${imageHtml}
        <div class="flex-grow-1 overflow-hidden">
          <div class="fw-semibold text-truncate">${name}</div>
          <div class="small text-body-secondary">Sold: ${soldCount}</div>
          <div class="small text-success">Revenue: ${formatTopBestSellersCurrency(estRevenue)}</div>
        </div>
      </div>

      <a href="/store/product/${encodeURIComponent(String(product?.customId || ''))}" class="btn btn-sm btn-success flex-shrink-0">
        View
      </a>
    </div>
  `;
}

async function loadSellerTopBestSellersCard() {
  try {
    const response = await fetch('/api/seller/top-best-sellers', {
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
      throw new Error(payload.message || 'Failed to load top best sellers');
    }

    const listEl = document.getElementById('seller-top-best-sellers-list');
    if (!listEl) return;

    const products = Array.isArray(payload?.products) ? payload.products : [];

    if (products.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-3">
          <div class="fw-semibold text-body-secondary">No best sellers yet</div>
          <div class="small text-body-secondary">Your sold products will appear here.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = products.map((product, index) => buildTopBestSellerItem(product, index)).join('');
  } catch (error) {
    console.error('❌ Failed to load seller top best sellers card:', error);

    const listEl = document.getElementById('seller-top-best-sellers-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="text-danger small">
          Failed to load top best sellers.
        </div>
      `;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSellerTopBestSellersCard();
});