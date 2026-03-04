// public/admin-ui/js/admin-dashboard-top-sellers.js
(async function () {
  // Safe-guard: only run if our target elements exist
  const tbody = document.getElementById('top-sellers-tbody');
  const locList = document.getElementById('top-business-locations');
  const meta = document.getElementById('top-sellers-meta');

  if (!tbody || !locList) return;

  function money(v) {
    const n = Number(v || 0);
    // Simple formatting (no currency conversion here)
    return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  function dateShort(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }

  function escapeHtml(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function setMeta(text) {
    if (!meta) return;
    meta.textContent = text || '';
  }

  function renderEmptyRow(msg) {
    tbody.innerHTML = `
      <tr>
        <td colspan="6" class="text-center text-body-secondary">${escapeHtml(msg)}</td>
      </tr>
    `;
  }

  try {
    // 30-day window by default (backend supports ?days=)
    const res = await fetch('/admin/api/dashboard/top-sellers-locations?days=30', {
      credentials: 'include',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data?.ok) throw new Error(data?.message || 'Bad response');

    const sellers = Array.isArray(data.topSellers) ? data.topSellers : [];
    const locations = Array.isArray(data.topLocations) ? data.topLocations : [];

    setMeta(`Top sellers (last ${Number(data.windowDays || 30)} days)`);

    // -------- Top sellers table --------
    if (sellers.length === 0) {
      renderEmptyRow('No seller sales found in this window.');
    } else {
      tbody.innerHTML = sellers
        .map((s, i) => {
          const name = escapeHtml(s.businessName || '(unknown)');
          const place = escapeHtml(`${s.country || '—'}${s.city ? `, ${s.city}` : ''}`);
          const revenue = money(s.revenue);
          const orders = Number(s.ordersCount || 0).toLocaleString();
          const items = Number(s.itemsSold || 0).toLocaleString();
          const last = dateShort(s.lastOrderAt);

          return `
            <tr class="align-middle">
              <td class="text-center fw-semibold">${i + 1}</td>
              <td>
                <div class="text-nowrap fw-semibold">${name}</div>
                <div class="small text-body-secondary text-nowrap">${place}</div>
              </td>
              <td class="text-end fw-semibold">${revenue}</td>
              <td class="text-end">${orders}</td>
              <td class="text-end">${items}</td>
              <td class="text-end small text-body-secondary">${escapeHtml(last)}</td>
            </tr>
          `;
        })
        .join('');
    }

    // -------- Top locations list --------
    if (locations.length === 0) {
      locList.innerHTML = `<li class="list-group-item text-body-secondary">No location data.</li>`;
    } else {
      locList.innerHTML = locations
        .map((l) => {
          const label = escapeHtml(`${l.country || 'Unknown'}${l.city ? `, ${l.city}` : ''}`);
          const count = Number(l.count || 0).toLocaleString();
          return `
            <li class="list-group-item d-flex justify-content-between align-items-center">
              <span>${label}</span>
              <span class="badge bg-primary rounded-pill">${count}</span>
            </li>
          `;
        })
        .join('');
    }
  } catch (err) {
    console.warn('[admin-dashboard-top-sellers] Failed to load:', err);
    setMeta('Top sellers');
    renderEmptyRow('Failed to load top sellers.');
    locList.innerHTML = `<li class="list-group-item text-body-secondary">Failed to load locations.</li>`;
  }
})();