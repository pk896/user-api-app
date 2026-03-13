// public/admin-ui/js/admin-dashboard-traffic-sales.js
'use strict';

(async function () {
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

  const dayLabels = {
    mon: document.querySelector('#bar-mon-new')?.closest('.progress-group')?.querySelector('.progress-group-prepend .text-body-secondary'),
    tue: document.querySelector('#bar-tue-new')?.closest('.progress-group')?.querySelector('.progress-group-prepend .text-body-secondary'),
    wed: document.querySelector('#bar-wed-new')?.closest('.progress-group')?.querySelector('.progress-group-prepend .text-body-secondary'),
    thu: document.querySelector('#bar-thu-new')?.closest('.progress-group')?.querySelector('.progress-group-prepend .text-body-secondary'),
    fri: document.querySelector('#bar-fri-new')?.closest('.progress-group')?.querySelector('.progress-group-prepend .text-body-secondary'),
    sat: document.querySelector('#bar-sat-new')?.closest('.progress-group')?.querySelector('.progress-group-prepend .text-body-secondary'),
    sun: document.querySelector('#bar-sun-new')?.closest('.progress-group')?.querySelector('.progress-group-prepend .text-body-secondary'),
  };

  const keyMap = {
    Monday: 'mon',
    Tuesday: 'tue',
    Wednesday: 'wed',
    Thursday: 'thu',
    Friday: 'fri',
    Saturday: 'sat',
    Sunday: 'sun',
  };

  const defaultDayText = {
    mon: 'Monday',
    tue: 'Tuesday',
    wed: 'Wednesday',
    thu: 'Thursday',
    fri: 'Friday',
    sat: 'Saturday',
    sun: 'Sunday',
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

  function formatShortDate(isoDate) {
    if (!isoDate) return '';
    const d = new Date(`${isoDate}T00:00:00`);
    if (Number.isNaN(d.getTime())) return String(isoDate);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
    });
  }

  function setDayLabel(key, dayName, isoDate) {
    const el = dayLabels[key];
    if (!el) return;

    const shortDate = formatShortDate(isoDate);
    el.textContent = shortDate ? `${dayName} (${shortDate})` : dayName;
  }

  function resetWeekBars() {
    for (const k of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      setBar(bars[k]?.new, 0);
      setBar(bars[k]?.rec, 0);
    }
  }

  function resetWeekLabels() {
    for (const k of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) {
      const el = dayLabels[k];
      if (!el) continue;
      el.textContent = defaultDayText[k];
    }
  }

  function applyLabelsFromList(list) {
    resetWeekLabels();

    for (const item of list) {
      const key = keyMap[item?.day];
      if (!key) continue;
      setDayLabel(key, item.day, item.date);
    }
  }

  function updateFromPayload(data) {
    setText(elNewToday, data?.today?.newClients ?? 0);
    setText(elRecToday, data?.today?.recurringClients ?? 0);

    const list = Array.isArray(data?.week?.days) ? data.week.days : [];
    resetWeekBars();
    applyLabelsFromList(list);

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
    const res = await fetch('/admin/api/dashboard/traffic-sales', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data || data.ok !== true) throw new Error('Bad response shape');

    updateFromPayload(data);
  } catch (err) {
    console.warn('[admin-dashboard-traffic-sales] Failed to load:', err);
    setText(elNewToday, '—');
    setText(elRecToday, '—');
    resetWeekBars();
    resetWeekLabels();
  }
})();