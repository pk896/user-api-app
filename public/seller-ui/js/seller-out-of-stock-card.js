// public/seller-ui/js/seller-out-of-stock-card.js
'use strict';

function escapeOutOfStockHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildOutOfStockProductItem(product) {
  const name = escapeOutOfStockHtml(product?.name || 'Unnamed product');
  const imageUrl = String(product?.imageUrl || '').trim();
  const stock = Number(product?.stock || 0);

  const imageHtml = imageUrl
    ? `<img src="${escapeOutOfStockHtml(imageUrl)}" alt="${name}" class="rounded border flex-shrink-0" width="48" height="48">`
    : `<div class="rounded border d-flex align-items-center justify-content-center flex-shrink-0 bg-body-tertiary" style="width:48px;height:48px;">📦</div>`;

  return `
    <div class="d-flex align-items-center justify-content-between gap-2 border rounded p-2">
      <div class="d-flex align-items-center gap-2 flex-grow-1 overflow-hidden">
        ${imageHtml}
        <div class="flex-grow-1 overflow-hidden">
          <div class="fw-semibold text-truncate">${name}</div>
          <div class="small text-danger">Remaining stock: ${stock}</div>
        </div>
      </div>

      <a href="/products/edit/${encodeURIComponent(String(product?.customId || ''))}" class="btn btn-sm btn-danger flex-shrink-0">
        Restock
      </a>
    </div>
  `;
}

async function loadSellerOutOfStockCard() {
  try {
    const response = await fetch('/api/seller/out-of-stock-products', {
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
      throw new Error(payload.message || 'Failed to load out of stock products');
    }

    const listEl = document.getElementById('seller-out-of-stock-products-list');
    if (!listEl) return;

    const products = Array.isArray(payload?.products) ? payload.products : [];
    const outOfStockCount = Number(payload?.stats?.outOfStockCount || 0);

    if (products.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-3">
          <div class="fw-semibold text-success">No out of stock products</div>
          <div class="small text-body-secondary">Everything currently has stock.</div>
        </div>
      `;
      return;
    }

    const visibleProducts = products.slice(0, 5);

    listEl.innerHTML = `
      ${visibleProducts.map(buildOutOfStockProductItem).join('')}
      ${
        outOfStockCount > 5
          ? `<div class="small text-body-secondary text-center pt-1">Showing 5 of ${outOfStockCount} out of stock products</div>`
          : ''
      }
    `;
  } catch (error) {
    console.error('❌ Failed to load seller out of stock card:', error);

    const listEl = document.getElementById('seller-out-of-stock-products-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="text-danger small">
          Failed to load out of stock products.
        </div>
      `;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSellerOutOfStockCard();
});