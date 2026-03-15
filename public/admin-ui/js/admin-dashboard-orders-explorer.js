// user-api-app/public/admin-ui/js/admin-dashboard-orders-explorer.js
'use strict';

(function () {
  const tbody = document.getElementById('admin-orders-explorer-tbody');
  const meta = document.getElementById('admin-orders-explorer-meta');
  const pageText = document.getElementById('admin-orders-explorer-page-text');
  const form = document.getElementById('admin-orders-search-form');
  const prevBtn = document.getElementById('admin-orders-prev-btn');
  const nextBtn = document.getElementById('admin-orders-next-btn');
  const resetBtn = document.getElementById('admin-orders-reset-btn');

  const qInput = document.getElementById('admin-orders-q');
  const businessNameInput = document.getElementById('admin-orders-business-name');
  const orderIdInput = document.getElementById('admin-orders-order-id');
  const receiptNumberInput = document.getElementById('admin-orders-receipt-number');
  const statusInput = document.getElementById('admin-orders-status');

  if (
    !tbody ||
    !meta ||
    !pageText ||
    !form ||
    !prevBtn ||
    !nextBtn ||
    !resetBtn ||
    !qInput ||
    !businessNameInput ||
    !orderIdInput ||
    !receiptNumberInput ||
    !statusInput
  ) {
    return;
  }

  let currentPage = 1;
  let totalPages = 1;
  let isLoading = false;
  const pageSize = 20;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatMoney(amount, currency) {
    const numeric = Number(amount || 0);
    const safeAmount = Number.isFinite(numeric) ? numeric : 0;
    return `${escapeHtml(currency || 'USD')} ${safeAmount.toFixed(2)}`;
  }

  function formatDate(value) {
    if (!value) return '—';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString();
  }

  function renderStatusBadge(status) {
    const normalized = String(status || '').trim().toUpperCase();

    switch (normalized) {
      case 'REFUNDED':
        return '<span class="badge bg-danger">Refunded</span>';

      case 'PARTIALLY_REFUNDED':
        return '<span class="badge bg-warning text-dark">Partial Refund</span>';

      case 'COMPLETED':
        return '<span class="badge badge-brand-green">Completed</span>';

      default:
        return `<span class="badge bg-secondary">${escapeHtml(normalized || 'UNKNOWN')}</span>`;
    }
  }

  function buildQueryString(page) {
    const params = new URLSearchParams();

    const q = qInput.value.trim();
    const businessName = businessNameInput.value.trim();
    const orderId = orderIdInput.value.trim();
    const receiptNumber = receiptNumberInput.value.trim();
    const status = statusInput.value.trim();

    if (q) params.set('q', q);
    if (businessName) params.set('businessName', businessName);
    if (orderId) params.set('orderId', orderId);
    if (receiptNumber) params.set('receiptNumber', receiptNumber);
    if (status) params.set('status', status);

    params.set('page', String(page));
    params.set('limit', String(pageSize));

    return params.toString();
  }

  function setLoadingState(loading) {
    isLoading = loading;
    prevBtn.disabled = loading || currentPage <= 1;
    nextBtn.disabled = loading || currentPage >= totalPages;
  }

  function renderRows(orders) {
    if (!Array.isArray(orders) || orders.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="text-center text-body-secondary">No orders found.</td>
        </tr>
      `;
      return;
    }

    tbody.innerHTML = orders.map((order) => {
      const orderId = escapeHtml(order.orderId || '—');
      const receiptNumber = escapeHtml(order.receiptNumber || '—');
      const businessName = escapeHtml(order.businessName || '—');
      const payerEmail = escapeHtml(order.payerEmail || '—');
      const createdAt = escapeHtml(formatDate(order.createdAt));
      const viewUrl = escapeHtml(order.viewUrl || '#');
      const receiptUrl = escapeHtml(order.receiptUrl || '#');

      return `
        <tr>
          <td class="fw-semibold text-nowrap">${orderId}</td>
          <td class="text-nowrap">${receiptNumber}</td>
          <td>${businessName}</td>
          <td>${renderStatusBadge(order.status)}</td>
          <td class="text-end fw-semibold">${formatMoney(order.amount, order.currency)}</td>
          <td class="text-end">${formatMoney(order.refundedTotal, order.currency)}</td>
          <td>${payerEmail}</td>
          <td class="text-nowrap">${createdAt}</td>
          <td class="text-center">
            <div class="d-inline-flex gap-2 flex-wrap justify-content-center">
              <a class="btn btn-sm btn-outline-brand-purple" href="${viewUrl}">
                View
              </a>
              <a
                class="btn btn-sm btn-brand-purple"
                href="${receiptUrl}"
                target="_blank"
                rel="noopener noreferrer"
              >
                Receipt
              </a>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  async function loadOrders(page) {
    try {
      setLoadingState(true);

      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="text-center text-body-secondary">Loading orders...</td>
        </tr>
      `;

      meta.textContent = 'Loading orders...';

      const response = await fetch(`/api/admin/orders?${buildQueryString(page)}`, {
        method: 'GET',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
        },
      });

      const data = await response.json().catch(() => ({}));

      if (!response.ok || !data.ok) {
        throw new Error(data.message || 'Failed to load orders');
      }

      currentPage = Number(data.page || 1);
      totalPages = Math.max(1, Number(data.pages || 1));

      renderRows(Array.isArray(data.orders) ? data.orders : []);

      meta.textContent = `Showing ${Array.isArray(data.orders) ? data.orders.length : 0} of ${Number(data.total || 0)} orders`;
      pageText.textContent = `Page ${currentPage} of ${totalPages}`;
    } catch (error) {
      console.error('admin orders explorer error:', error);

      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="text-center text-danger">
            ${escapeHtml(error.message || 'Failed to load orders')}
          </td>
        </tr>
      `;

      meta.textContent = 'Failed to load orders';
      pageText.textContent = 'Page 1 of 1';
    } finally {
      setLoadingState(false);
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    loadOrders(1);
  });

  resetBtn.addEventListener('click', function () {
    qInput.value = '';
    businessNameInput.value = '';
    orderIdInput.value = '';
    receiptNumberInput.value = '';
    statusInput.value = 'all';
    loadOrders(1);
  });

  prevBtn.addEventListener('click', function () {
    if (isLoading || currentPage <= 1) return;
    loadOrders(currentPage - 1);
  });

  nextBtn.addEventListener('click', function () {
    if (isLoading || currentPage >= totalPages) return;
    loadOrders(currentPage + 1);
  });

  loadOrders(1);
})();