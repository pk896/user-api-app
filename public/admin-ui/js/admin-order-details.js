// user-api-app/public/admin-ui/js/admin-order-details.js
'use strict';

(function () {
  const meta = document.getElementById('admin-order-details-meta');
  const root = document.getElementById('admin-order-details-root');
  const receiptBtnTop = document.getElementById('admin-order-receipt-btn-top');

  if (!meta || !root || !receiptBtnTop) {
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
    const safe = Number.isFinite(num) ? num : 0;
    return `${escapeHtml(currency || 'USD')} ${safe.toFixed(2)}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
  }

  function getPayerDisplayName(payer) {
    if (!payer) return '—';

    if (typeof payer.fullName === 'string' && payer.fullName.trim()) {
      return payer.fullName.trim();
    }

    if (typeof payer.name === 'string' && payer.name.trim()) {
      return payer.name.trim();
    }

    if (payer.name && typeof payer.name === 'object') {
      const given =
        typeof payer.name.given_name === 'string' ? payer.name.given_name.trim() : '';
      const surname =
        typeof payer.name.surname === 'string' ? payer.name.surname.trim() : '';
      const combined = [given, surname].filter(Boolean).join(' ').trim();

      if (combined) return combined;
    }

    if (typeof payer.given_name === 'string' || typeof payer.surname === 'string') {
      const given = typeof payer.given_name === 'string' ? payer.given_name.trim() : '';
      const surname = typeof payer.surname === 'string' ? payer.surname.trim() : '';
      const combined = [given, surname].filter(Boolean).join(' ').trim();

      if (combined) return combined;
    }

    return '—';
  }

  function statusBadge(status) {
    const normalized = String(status || '').trim().toUpperCase();

    switch (normalized) {
      case 'COMPLETED':
        return '<span class="badge badge-brand-green">Completed</span>';
      case 'REFUNDED':
        return '<span class="badge bg-danger">Refunded</span>';
      case 'PARTIALLY_REFUNDED':
        return '<span class="badge bg-warning text-dark">Partial Refund</span>';
      default:
        return `<span class="badge bg-secondary">${escapeHtml(normalized || 'UNKNOWN')}</span>`;
    }
  }

  function getQueryId() {
    const params = new URLSearchParams(window.location.search);
    return (params.get('id') || '').trim();
  }

  function renderItems(items, currency) {
    if (!Array.isArray(items) || !items.length) {
      return `
        <div class="text-body-secondary">No items found for this order.</div>
      `;
    }

    return `
      <div class="table-responsive">
        <table class="table table-bordered align-middle mb-0">
          <thead>
            <tr>
              <th>Item</th>
              <th class="text-end">Qty</th>
              <th class="text-end">Unit Price</th>
            </tr>
          </thead>
          <tbody>
            ${items.map((item) => {
              const qty = Number(item?.quantity || 0);
              const priceValue =
                item?.priceGross?.value ??
                item?.price?.value ??
                item?.priceGross ??
                item?.price ??
                0;

              return `
                <tr>
                  <td>
                    <div class="fw-semibold">${escapeHtml(item?.name || 'Unnamed item')}</div>
                    <div class="small text-body-secondary">${escapeHtml(item?.productId || '')}</div>
                  </td>
                  <td class="text-end">${escapeHtml(qty)}</td>
                  <td class="text-end">${formatMoney(priceValue, currency)}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderRefunds(refunds, currency) {
    if (!Array.isArray(refunds) || !refunds.length) {
      return `<div class="text-body-secondary">No refund events recorded.</div>`;
    }

    return `
      <div class="table-responsive">
        <table class="table table-bordered align-middle mb-0">
          <thead>
            <tr>
              <th>Refund ID</th>
              <th class="text-end">Amount</th>
              <th>Created</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            ${refunds.map((refund) => {
              const amountValue =
                refund?.amount?.value ??
                refund?.amount ??
                0;

              return `
                <tr>
                  <td>${escapeHtml(refund?.id || refund?._id || '—')}</td>
                  <td class="text-end">${formatMoney(amountValue, refund?.amount?.currency || currency)}</td>
                  <td>${escapeHtml(formatDate(refund?.create_time || refund?.createdAt || refund?.created_at))}</td>
                  <td>${escapeHtml(refund?.status || '—')}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderOrder(order) {
    const currency = order?.amount?.currency || 'USD';
    const amountValue = order?.amount?.value || 0;
    const refundedTotal = Number(order?.refundedTotal || 0);
    const availableValue = Number(amountValue || 0) - refundedTotal;

    receiptBtnTop.href = order?.receiptUrl || '#';
    receiptBtnTop.style.pointerEvents = order?.receiptUrl ? 'auto' : 'none';
    receiptBtnTop.classList.toggle('disabled', !order?.receiptUrl);

    meta.textContent = `${order?.orderId || 'Unknown order'} • ${formatDate(order?.createdAt)}`;

    root.innerHTML = `
      <div class="row g-4">
        <div class="col-12 col-xl-8">
          <div class="card border-brand-purple shadow-sm">
            <div class="card-header bg-brand-purple-soft text-brand-purple fw-semibold">
              Order Summary
            </div>
            <div class="card-body">
              <div class="row g-3">
                <div class="col-md-6">
                  <div class="small text-body-secondary">Order ID</div>
                  <div class="fw-semibold">${escapeHtml(order?.orderId || '—')}</div>
                </div>
                <div class="col-md-6">
                  <div class="small text-body-secondary">Receipt Number</div>
                  <div class="fw-semibold">${escapeHtml(order?.receiptNumber || '—')}</div>
                </div>
                <div class="col-md-6">
                  <div class="small text-body-secondary">Status</div>
                  <div>${statusBadge(order?.status)}</div>
                </div>
                <div class="col-md-6">
                  <div class="small text-body-secondary">Payment Status</div>
                  <div class="fw-semibold">${escapeHtml(order?.paymentStatus || '—')}</div>
                </div>
                <div class="col-md-6">
                  <div class="small text-body-secondary">Fulfillment Status</div>
                  <div class="fw-semibold">${escapeHtml(order?.fulfillmentStatus || '—')}</div>
                </div>
                <div class="col-md-6">
                  <div class="small text-body-secondary">Created</div>
                  <div class="fw-semibold">${escapeHtml(formatDate(order?.createdAt))}</div>
                </div>
                <div class="col-md-6">
                  <div class="small text-body-secondary">Updated</div>
                  <div class="fw-semibold">${escapeHtml(formatDate(order?.updatedAt))}</div>
                </div>
              </div>
            </div>
          </div>

          <div class="card border-brand-purple shadow-sm mt-4">
            <div class="card-header bg-brand-purple-soft text-brand-purple fw-semibold">
              Items
            </div>
            <div class="card-body">
              ${renderItems(order?.items, currency)}
            </div>
          </div>

          <div class="card border-brand-purple shadow-sm mt-4">
            <div class="card-header bg-brand-purple-soft text-brand-purple fw-semibold">
              Refunds
            </div>
            <div class="card-body">
              ${renderRefunds(order?.refunds, currency)}
            </div>
          </div>
        </div>

        <div class="col-12 col-xl-4">
          <div class="card border-brand-purple shadow-sm">
            <div class="card-header bg-brand-purple-soft text-brand-purple fw-semibold">
              Amounts
            </div>
            <div class="card-body">
              <div class="d-flex justify-content-between mb-2">
                <span class="text-body-secondary">Order Total</span>
                <span class="fw-semibold">${formatMoney(amountValue, currency)}</span>
              </div>
              <div class="d-flex justify-content-between mb-2">
                <span class="text-body-secondary">Refunded Total</span>
                <span class="fw-semibold">${formatMoney(refundedTotal, currency)}</span>
              </div>
              <hr>
              <div class="d-flex justify-content-between">
                <span class="text-body-secondary">Available</span>
                <span class="fw-semibold">${formatMoney(availableValue, currency)}</span>
              </div>
            </div>
          </div>

          <div class="card border-brand-purple shadow-sm mt-4">
            <div class="card-header bg-brand-purple-soft text-brand-purple fw-semibold">
              Buyer Business
            </div>
            <div class="card-body">
              <div class="small text-body-secondary">Business Name</div>
              <div class="fw-semibold mb-3">${escapeHtml(order?.businessBuyer?.name || '—')}</div>

              <div class="small text-body-secondary">Email</div>
              <div class="fw-semibold mb-3">${escapeHtml(order?.businessBuyer?.email || '—')}</div>

              <div class="small text-body-secondary">Phone</div>
              <div class="fw-semibold">${escapeHtml(order?.businessBuyer?.phone || '—')}</div>
            </div>
          </div>

          <div class="card border-brand-purple shadow-sm mt-4">
            <div class="card-header bg-brand-purple-soft text-brand-purple fw-semibold">
              Payer
            </div>
            <div class="card-body">
              <div class="small text-body-secondary">Name</div>
              <div class="fw-semibold mb-3">${escapeHtml(getPayerDisplayName(order?.payer))}</div>

              <div class="small text-body-secondary">Email</div>
              <div class="fw-semibold mb-3">${escapeHtml(order?.payer?.email || '—')}</div>

              <div class="small text-body-secondary">Payer ID</div>
              <div class="fw-semibold">${escapeHtml(order?.payer?.payerId || order?.payer?.id || '—')}</div>
            </div>
          </div>

          <div class="card border-brand-purple shadow-sm mt-4">
            <div class="card-header bg-brand-purple-soft text-brand-purple fw-semibold">
              Receipt
            </div>
            <div class="card-body">
              <a
                href="${escapeHtml(order?.receiptUrl || '#')}"
                target="_blank"
                rel="noopener noreferrer"
                class="btn btn-brand-purple w-100"
              >
                Open Receipt
              </a>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  async function loadOrder() {
    const id = getQueryId();

    if (!id) {
      meta.textContent = 'Missing order id';
      root.innerHTML = `
        <div class="alert alert-danger mb-0">
          Missing order id in URL. Open this page from Orders Explorer.
        </div>
      `;
      receiptBtnTop.href = '#';
      receiptBtnTop.classList.add('disabled');
      return;
    }

    try {
      meta.textContent = 'Loading order...';
      root.innerHTML = `
        <div class="text-center text-brand-purple py-4 fw-semibold">Loading order details...</div>
      `;

      const response = await fetch(`/api/admin/orders/${encodeURIComponent(id)}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok || !data.order) {
        throw new Error(data.message || 'Failed to load order details');
      }

      renderOrder(data.order);
    } catch (error) {
      console.error('admin order details error:', error);
      meta.textContent = 'Failed to load order';
      root.innerHTML = `
        <div class="alert alert-danger mb-0">
          ${escapeHtml(error.message || 'Failed to load order details')}
        </div>
      `;
      receiptBtnTop.href = '#';
      receiptBtnTop.classList.add('disabled');
    }
  }

  loadOrder();
})();