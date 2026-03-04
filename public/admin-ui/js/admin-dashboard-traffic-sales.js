// public/admin-ui/js/admin-dashboard-traffic-sales.js
'use strict';

(async function () {
  // If the page doesn't have the elements, do nothing (prevents breaking other pages)
  const elNewToday = document.getElementById('stat-new-clients-today');
  const elRecToday = document.getElementById('stat-recurring-clients-today');
  if (!elNewToday || !elRecToday) return;

  const bars = {
    mon: { new: document.getElementById('bar-mon-new'), rec: document.getElementById('bar-mon-rec') },
    tue: { new: document.getElementById('bar-tue-new'), rec: document.getElementById('bar-tue-rec') },
    wed: { new: document.getElementById('bar-wed-new'), rec: document.getElementById('bar-wed-rec') },
    thu: { new: document.getElementById('bar-thu-new'), rec: document.getElementById('bar-thu-rec') },
    fri: { new: document.getElementById('bar-fri-new'), rec: document.getElementById('bar-fri-rec') },
    sat: { new: document.getElementById('bar-sat-new'), rec: document.getElementById('bar-sat-rec') },
    sun: { new: document.getElementById('bar-sun-new'), rec: document.getElementById('bar-sun-rec') },
  };

  // Backend returns day names like "Monday", map to bar keys
  const keyMap = {
    Monday: 'mon',
    Tuesday: 'tue',
    Wednesday: 'wed',
    Thursday: 'thu',
    Friday: 'fri',
    Saturday: 'sat',
    Sunday: 'sun',
  };

  function clampPct(pct) {
    const n = Number(pct);
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(100, n));
  }

  function setBar(barEl, pct) {
    if (!barEl) return;
    const safe = clampPct(pct);
    barEl.style.width = `${safe}%`;
    barEl.setAttribute('aria-valuenow', String(safe));
  }

  function setText(el, value) {
    if (!el) return;
    el.textContent = value === null || value === undefined ? '—' : String(value);
  }

  function resetWeekBars() {
    for (const k of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      setBar(bars[k]?.new, 0);
      setBar(bars[k]?.rec, 0);
    }
  }

  function updateFromPayload(data) {
    // Today
    setText(elNewToday, data?.today?.newClients ?? 0);
    setText(elRecToday, data?.today?.recurringClients ?? 0);

    // Week
    const list = Array.isArray(data?.week?.days) ? data.week.days : [];
    resetWeekBars();

    // Prefer backend percentages (newPct/recurringPct). Fallback to scaling by max if missing.
    const hasPct = list.some((x) => x && (x.newPct !== undefined || x.recurringPct !== undefined));

    if (hasPct) {
      for (const item of list) {
        const key = keyMap[item?.day];
        if (!key) continue;
        setBar(bars[key]?.new, item?.newPct ?? 0);
        setBar(bars[key]?.rec, item?.recurringPct ?? 0);
      }
      return;
    }

    // Fallback: scale by max values (if backend didn't send pct)
    let max = 1;
    for (const item of list) {
      const n = Number(item?.newClients ?? 0);
      const r = Number(item?.recurringClients ?? 0);
      if (Number.isFinite(n)) max = Math.max(max, n);
      if (Number.isFinite(r)) max = Math.max(max, r);
    }

    for (const item of list) {
      const key = keyMap[item?.day];
      if (!key) continue;

      const n = Number(item?.newClients ?? 0);
      const r = Number(item?.recurringClients ?? 0);

      setBar(bars[key]?.new, (n / max) * 100);
      setBar(bars[key]?.rec, (r / max) * 100);
    }
  }

  try {
    // Your backend mount: app.use('/admin/api/dashboard', adminDashboardRouter);
    // Router path: router.get('/traffic-sales', ...)
    const res = await fetch('/admin/api/dashboard/traffic-sales', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data || data.ok !== true) throw new Error('Bad response shape');

    updateFromPayload(data);
  } catch (err) {
    console.warn('[admin-dashboard-traffic-sales] Failed to load:', err);
    // Keep UI safe, do not crash anything
    setText(elNewToday, '—');
    setText(elRecToday, '—');
    resetWeekBars();
  }
})();