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

function formatFastestGrowingCurrency(value, currency = 'USD') {
  const amount = Number(value || 0);

  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(amount);
}

function formatSellerGrowthPercent(value) {
  const n = Number(value || 0);

  if (!Number.isFinite(n)) return '0.0%';

  const sign = n > 0 ? '+' : '';

  return `${sign}${n.toFixed(1)}%`;
}

function formatSellerGrowthUnits(value) {
  const n = Number(value || 0);
  const sign = n > 0 ? '+' : '';

  return `${sign}${n}`;
}

function buildFastestGrowingProductItem(product, index, currency) {
  const name = escapeFastestGrowingHtml(product?.name || 'Unnamed product');
  const category = escapeFastestGrowingHtml(product?.category || 'General');
  const imageUrl = String(product?.imageUrl || '').trim();
  const customId = String(product?.customId || '').trim();

  const currentWeeklySold = Number(product?.currentWeeklySold || 0);
  const previousWeeklySold = Number(product?.previousWeeklySold || 0);
  const weeklyGrowthCount = Number(product?.weeklyGrowthCount || 0);
  const weeklyGrowthPercent = Number(product?.weeklyGrowthPercent || 0);
  const weeklyRevenueGrowth = Number(product?.weeklyRevenueGrowth || 0);

  const currentMonthlySold = Number(product?.currentMonthlySold || 0);
  const previousMonthlySold = Number(product?.previousMonthlySold || 0);
  const monthlyGrowthCount = Number(product?.monthlyGrowthCount || 0);
  const monthlyGrowthPercent = Number(product?.monthlyGrowthPercent || 0);
  const monthlyRevenueGrowth = Number(product?.monthlyRevenueGrowth || 0);

  const imageHtml = imageUrl
    ? `<img src="${escapeFastestGrowingHtml(imageUrl)}" alt="${name}" class="rounded border flex-shrink-0" width="48" height="48" style="object-fit:contain;">`
    : `<div class="rounded border d-flex align-items-center justify-content-center flex-shrink-0 bg-body-tertiary" style="width:48px;height:48px;">📦</div>`;

  const viewHref = customId
    ? `/store/product/${encodeURIComponent(customId)}`
    : '/products/all';

  return `
    <div class="border rounded p-2">
      <div class="d-flex flex-column gap-2">
        <div class="d-flex align-items-start gap-2">
          <div class="badge bg-primary flex-shrink-0 mt-1">${index + 1}</div>

          ${imageHtml}

          <div class="flex-grow-1 overflow-hidden">
            <div class="fw-semibold text-truncate">${name}</div>
            <div class="small text-body-secondary text-truncate">${category}</div>

            <div class="row g-2 mt-2">
              <div class="col-12 col-md-6">
                <div class="border rounded p-2 h-100">
                  <div class="d-flex justify-content-between align-items-center gap-2">
                    <span class="small fw-semibold text-body-secondary">Weekly</span>
                    <span class="badge bg-success">${formatSellerGrowthPercent(weeklyGrowthPercent)}</span>
                  </div>

                  <div class="small text-body-secondary mt-1">
                    Last 7 days: <strong>${currentWeeklySold}</strong>
                  </div>

                  <div class="small text-body-secondary">
                    Previous 7 days: <strong>${previousWeeklySold}</strong>
                  </div>

                  <div class="small text-success">
                    Units: ${formatSellerGrowthUnits(weeklyGrowthCount)}
                  </div>

                  <div class="small text-body-secondary">
                    Revenue: ${formatFastestGrowingCurrency(weeklyRevenueGrowth, currency)}
                  </div>
                </div>
              </div>

              <div class="col-12 col-md-6">
                <div class="border rounded p-2 h-100">
                  <div class="d-flex justify-content-between align-items-center gap-2">
                    <span class="small fw-semibold text-body-secondary">Monthly</span>
                    <span class="badge bg-primary">${formatSellerGrowthPercent(monthlyGrowthPercent)}</span>
                  </div>

                  <div class="small text-body-secondary mt-1">
                    Last 30 days: <strong>${currentMonthlySold}</strong>
                  </div>

                  <div class="small text-body-secondary">
                    Previous 30 days: <strong>${previousMonthlySold}</strong>
                  </div>

                  <div class="small text-success">
                    Units: ${formatSellerGrowthUnits(monthlyGrowthCount)}
                  </div>

                  <div class="small text-body-secondary">
                    Revenue: ${formatFastestGrowingCurrency(monthlyRevenueGrowth, currency)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div>
          <a href="${viewHref}" class="btn btn-sm btn-primary w-100">
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
        Accept: 'application/json',
      },
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
    const currency = String(payload?.currency || '').trim().toUpperCase() || 'USD';

    if (products.length === 0) {
      listEl.innerHTML = `
        <div class="text-center py-3">
          <div class="fw-semibold text-body-secondary">No growing products yet</div>
          <div class="small text-body-secondary">
            Products with stronger weekly or monthly sales growth will appear here.
          </div>
        </div>
      `;
      return;
    }

    listEl.innerHTML = products
      .map((product, index) => buildFastestGrowingProductItem(product, index, currency))
      .join('');
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