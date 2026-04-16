// public/seller-ui/js/seller-fastest-growing-products-card.js
'use strict';

function escapeFastestGrowingHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatFastestGrowingCurrency(value) {
  const amount = Number(value || 0);

  return new Intl.NumberFormat('en-ZA', {
    style: 'currency',
    currency: 'ZAR',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  }).format(amount);
}

function formatGrowthPercent(value, previousSoldCount = 0) {
  const prev = Number(previousSoldCount || 0);

  if (prev <= 0) {
    return 'N/A (prev 7d = 0)';
  }

  const n = Number(value);

  if (!Number.isFinite(n)) {
    return 'N/A';
  }

  if (n === 100) return '+100%';

  return `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;
}

function buildFastestGrowingProductItem(product, index) {
  const name = escapeFastestGrowingHtml(product?.name || 'Unnamed product');
  const imageUrl = String(product?.imageUrl || '').trim();

  const currentSoldCount = Number(product?.currentSoldCount || 0);
  const previousSoldCount = Number(product?.previousSoldCount || 0);
  const growthCount = Number(product?.growthCount || 0);
  const growthRevenue = Number(product?.growthRevenue || 0);
  const growthPercent = product?.growthPercent;

  const imageHtml = imageUrl
    ? `<img src="${escapeFastestGrowingHtml(imageUrl)}" alt="${name}" class="rounded border flex-shrink-0" width="48" height="48">`
    : `<div class="rounded border d-flex align-items-center justify-content-center flex-shrink-0 bg-body-tertiary" style="width:48px;height:48px;">📦</div>`;

  return `
    <div class="border rounded p-2">
      <div class="d-flex flex-column gap-2">
        <div class="d-flex align-items-start gap-2">
          <div class="badge bg-primary flex-shrink-0 mt-1">${index + 1}</div>
          ${imageHtml}
          <div class="flex-grow-1 overflow-hidden">
            <div class="fw-semibold text-truncate">${name}</div>

            <div class="small text-body-secondary">
              <div>Last 7 days: ${currentSoldCount}</div>
              <div>Previous 7 days: ${previousSoldCount}</div>
            </div>

            <div class="small text-success">Growth: +${growthCount} units</div>

            <div class="small text-body-secondary">
              <div>Revenue growth: ${formatFastestGrowingCurrency(growthRevenue)}</div>
              <div>Growth rate: ${formatGrowthPercent(growthPercent, previousSoldCount)}</div>
            </div>
          </div>
        </div>

        <div>
          <a href="/store/product/${encodeURIComponent(String(product?.customId || ''))}" class="btn btn-sm btn-primary w-100">
            View
          </a>
        </div>
      </div>
    </div>
  `;
}

async function loadSellerFastestGrowingProductsCard() {
  try {
    const response = await fetch('/api/seller/fastest-growing-products', {
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
      throw new Error(payload.message || 'Failed to load fastest growing products');
    }

    const listEl = document.getElementById('seller-fastest-growing-products-list');
    if (!listEl) return;

    const products = Array.isArray(payload?.products) ? payload.products : [];

    if (products.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-3">
          <div class="fw-semibold text-body-secondary">No growing products yet</div>
          <div class="small text-body-secondary">Products with stronger last 7 days growth will appear here.</div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = products.map((product, index) => buildFastestGrowingProductItem(product, index)).join('');
  } catch (error) {
    console.error('❌ Failed to load seller fastest growing products card:', error);

    const listEl = document.getElementById('seller-fastest-growing-products-list');
    if (listEl) {
      listEl.innerHTML = `
        <div class="text-danger small">
          Failed to load fastest growing products.
        </div>
      `;
    }
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSellerFastestGrowingProductsCard();
});
