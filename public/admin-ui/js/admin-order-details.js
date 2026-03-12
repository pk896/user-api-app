// user-api-app/public/admin-ui/js/admin-order-details.js
'use strict';

(function () {
  const metaEl = document.getElementById('admin-order-details-meta');
  const rootEl = document.getElementById('admin-order-details-root');
  const receiptBtnTop = document.getElementById('admin-order-receipt-btn-top');

  if (!metaEl || !rootEl || !receiptBtnTop) {
    return;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(value, currency) {
    const num = Number(value || 0);
    const safeNum = Number.isFinite(num) ? num : 0;
    return `${escapeHtml(currency || 'USD')} ${safeNum.toFixed(2)}`;
  }

  function formatMoneyObject(obj, fallbackCurrency) {
    if (!obj) return '—';
    return formatMoney(obj.value, obj.currency || fallbackCurrency || 'USD');
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
  }

  function formatVariants(variants) {
    if (!variants || typeof variants !== 'object') return '—';

    const entries = Object.entries(variants).filter(function ([, v]) {
      return v != null && String(v).trim() !== '';
    });

    if (!entries.length) return '—';

    return entries.map(function ([key, value]) {
      return `<span class="badge bg-light text-dark border me-1 mb-1">${escapeHtml(key)}: ${escapeHtml(value)}</span>`;
    }).join('');
  }

  function getOrderIdFromQuery() {
    const params = new URLSearchParams(window.location.search);
    return params.get('id') || '';
  }

  function renderOrder(order) {
    const currency = order?.amount?.currency || 'USD';

    const itemsHtml = Array.isArray(order.items) && order.items.length
      ? order.items.map(function (item) {
          const imageHtml = item.imageUrl
            ? `<img src="${escapeHtml(item.imageUrl)}" alt="${escapeHtml(item.name || 'Item')}" class="rounded border" style="width:64px;height:64px;object-fit:cover;">`
            : `<div class="rounded border d-flex align-items-center justify-content-center text-body-secondary" style="width:64px;height:64px;">—</div>`;

          return `
            <div class="card mb-3">
              <div class="card-body">
                <div class="d-flex gap-3">
                  <div>${imageHtml}</div>
                  <div class="flex-grow-1">
                    <div class="fw-semibold">${escapeHtml(item.name || '—')}</div>
                    <div class="small text-body-secondary mb-2">Product ID: ${escapeHtml(item.productId || '—')}</div>

                    <div class="row g-3">
                      <div class="col-md-3">
                        <div class="small text-body-secondary">Quantity</div>
                        <div class="fw-semibold">${escapeHtml(item.quantity || 0)}</div>
                      </div>
                      <div class="col-md-3">
                        <div class="small text-body-secondary">Net Price</div>
                        <div class="fw-semibold">${formatMoneyObject(item.price, currency)}</div>
                      </div>
                      <div class="col-md-3">
                        <div class="small text-body-secondary">Gross Price</div>
                        <div class="fw-semibold">${formatMoneyObject(item.priceGross, currency)}</div>
                      </div>
                      <div class="col-md-3">
                        <div class="small text-body-secondary">Variants</div>
                        <div>${formatVariants(item.variants)}</div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          `;
        }).join('')
      : `<div class="text-body-secondary">No items found.</div>`;

    const refundsHtml = Array.isArray(order.refunds) && order.refunds.length
      ? order.refunds.map(function (refund) {
          return `
            <tr>
              <td>${escapeHtml(refund.refundId || '—')}</td>
              <td>${escapeHtml(refund.status || '—')}</td>
              <td>${formatMoney(refund.amount, refund.currency || currency)}</td>
              <td>${escapeHtml(formatDate(refund.createdAt))}</td>
              <td>${escapeHtml(refund.source || '—')}</td>
            </tr>
          `;
        }).join('')
      : `
        <tr>
          <td colspan="5" class="text-center text-body-secondary">No refunds recorded.</td>
        </tr>
      `;

    rootEl.innerHTML = `
      <div class="row g-4 mb-4">
        <div class="col-lg-6">
          <div class="card h-100">
            <div class="card-header fw-semibold">Order Summary</div>
            <div class="card-body">
              <div class="row g-3">
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Order ID</div>
                  <div class="fw-semibold">${escapeHtml(order.orderId || '—')}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Receipt Number</div>
                  <div class="fw-semibold">${escapeHtml(order.receiptNumber || '—')}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Status</div>
                  <div class="fw-semibold">${escapeHtml(order.status || '—')}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Payment Status</div>
                  <div class="fw-semibold">${escapeHtml(order.paymentStatus || '—')}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Fulfillment Status</div>
                  <div class="fw-semibold">${escapeHtml(order.fulfillmentStatus || '—')}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Created</div>
                  <div class="fw-semibold">${escapeHtml(formatDate(order.createdAt))}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Updated</div>
                  <div class="fw-semibold">${escapeHtml(formatDate(order.updatedAt))}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Order Amount</div>
                  <div class="fw-semibold">${formatMoney(order.amount?.value, currency)}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Refunded Total</div>
                  <div class="fw-semibold">${formatMoney(order.refundedTotal, currency)}</div>
                </div>
                <div class="col-sm-6">
                  <div class="small text-body-secondary">Refunded At</div>
                  <div class="fw-semibold">${escapeHtml(formatDate(order.refundedAt))}</div>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div class="col-lg-6">
          <div class="card h-100">
            <div class="card-header fw-semibold">Buyer / Shipping</div>
            <div class="card-body">
              <div class="mb-3">
                <div class="small text-body-secondary">Business Buyer</div>
                <div class="fw-semibold">${escapeHtml(order.businessBuyer?.name || '—')}</div>
                <div class="small text-body-secondary">${escapeHtml(order.businessBuyer?.email || '')}</div>
                <div class="small text-body-secondary">${escapeHtml(order.businessBuyer?.phone || '')}</div>
              </div>

              <hr>

              <div class="mb-3">
                <div class="small text-body-secondary">Payer</div>
                <div class="fw-semibold">
                  ${escapeHtml(order.payer?.name?.given || '')} ${escapeHtml(order.payer?.name?.surname || '')}
                </div>
                <div class="small text-body-secondary">${escapeHtml(order.payer?.email || '—')}</div>
              </div>

              <hr>

              <div>
                <div class="small text-body-secondary">Shipping Address</div>
                <div class="fw-semibold">${escapeHtml(order.shipping?.name || '—')}</div>
                <div>${escapeHtml(order.shipping?.address_line_1 || '')}</div>
                <div>${escapeHtml(order.shipping?.address_line_2 || '')}</div>
                <div>${escapeHtml(order.shipping?.admin_area_2 || '')}${order.shipping?.admin_area_1 ? ', ' + escapeHtml(order.shipping?.admin_area_1) : ''}</div>
                <div>${escapeHtml(order.shipping?.postal_code || '')}</div>
                <div>${escapeHtml(order.shipping?.country_code || '')}</div>
                <div class="small text-body-secondary mt-2">${escapeHtml(order.shipping?.phone || '')}</div>
                <div class="small text-body-secondary">${escapeHtml(order.shipping?.email || '')}</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card mb-4">
        <div class="card-header fw-semibold">Order Items</div>
        <div class="card-body">
          ${itemsHtml}
        </div>
      </div>

      <div class="card mb-4">
        <div class="card-header fw-semibold">Refund History</div>
        <div class="card-body">
          <div class="table-responsive">
            <table class="table border align-middle mb-0">
              <thead class="fw-semibold text-nowrap">
                <tr>
                  <th class="bg-body-secondary">Refund ID</th>
                  <th class="bg-body-secondary">Status</th>
                  <th class="bg-body-secondary">Amount</th>
                  <th class="bg-body-secondary">Created</th>
                  <th class="bg-body-secondary">Source</th>
                </tr>
              </thead>
              <tbody>
                ${refundsHtml}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  async function loadOrder() {
    const id = getOrderIdFromQuery();

    if (!id) {
      metaEl.textContent = 'Missing order id';
      rootEl.innerHTML = '<div class="alert alert-danger mb-0">Missing order id in the URL.</div>';
      return;
    }

    try {
      metaEl.textContent = `Loading order ${id}...`;

      const response = await fetch(`/api/admin/orders/${encodeURIComponent(id)}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const data = await response.json().catch(function () {
        return {};
      });

      if (!response.ok || !data.ok) {
        throw new Error(data.message || 'Failed to load order details');
      }

      const order = data.order || {};
      metaEl.textContent = `Viewing order ${order.orderId || id}`;
      receiptBtnTop.href = order.receiptUrl || '#';

      renderOrder(order);
    } catch (error) {
      console.error('admin order details error:', error);
      metaEl.textContent = 'Failed to load order';
      rootEl.innerHTML = `<div class="alert alert-danger mb-0">${escapeHtml(error.message || 'Failed to load order')}</div>`;
    }
  }

  loadOrder();
})();