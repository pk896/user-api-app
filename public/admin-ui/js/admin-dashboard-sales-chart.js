// public/admin-ui/js/admin-dashboard-sales-chart.js
/* global Chart, coreui */
console.log('[admin-dashboard-sales-chart] loaded');

(function () {
  const canvas = document.getElementById('main-chart');
  if (!canvas) return;

  const existing = Chart.getChart('main-chart');
  if (existing) {
    console.warn('[admin-dashboard-sales-chart] Destroying existing chart on #main-chart');
    existing.destroy();
  }
        
  // Buttons
  const btnDay = document.querySelector('label[for="option1"]');
  const btnMonth = document.querySelector('label[for="option2"]');
  const btnYear = document.querySelector('label[for="option3"]');

  let chart = null;
  let cache = { day: [], month: [], year: [] };

  function toMoney(n) {
    const x = Number(n || 0);
    return Math.round(x * 100) / 100;
  }

  function labelFor(key, mode) {
    // key: YYYY-MM-DD or YYYY-MM
    if (!key) return '';
    if (mode === 'year') {
      // YYYY-MM -> "Mar 2026"
      const d = new Date(key + '-01T00:00:00');
      return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    }
    // YYYY-MM-DD
    const d = new Date(key + 'T00:00:00');
    if (mode === 'day') {
      return d.toLocaleDateString(undefined, { weekday: 'short' }); // Mon Tue Wed...
    }
    // month
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  function buildDataset(series, mode) {
    const labels = series.map((x) => labelFor(x.key, mode));
    const sales = series.map((x) => toMoney(x.sales));
    const orders = series.map((x) => Number(x.orders || 0));

    return { labels, sales, orders };
  }

  function ensureChart() {
    if (chart) return;

    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Sales',
            data: [],
            fill: true,
          },
          {
            label: 'Orders',
            data: [],
            fill: false,
            yAxisID: 'y1',
          },
        ],
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        interaction: { intersect: false, mode: 'index' },
        scales: {
          y: {
            beginAtZero: true,
            ticks: {
              callback: (value) => value,
            },
          },
          y1: {
            beginAtZero: true,
            position: 'right',
            grid: { drawOnChartArea: false },
          },
        },
        plugins: {
          legend: { display: true },
        },
      },
    });
  }

  function setActiveButton(mode) {
    // CoreUI uses label.active
    [btnDay, btnMonth, btnYear].forEach((b) => b && b.classList.remove('active'));
    if (mode === 'day' && btnDay) btnDay.classList.add('active');
    if (mode === 'month' && btnMonth) btnMonth.classList.add('active');
    if (mode === 'year' && btnYear) btnYear.classList.add('active');
  }

  function render(mode) {
    ensureChart();
    const series = cache[mode] || [];
    const { labels, sales, orders } = buildDataset(series, mode);

    chart.data.labels = labels;
    chart.data.datasets[0].data = sales;
    chart.data.datasets[1].data = orders;
    chart.update();
    setActiveButton(mode);
  }

  async function load() {
    const res = await fetch('/admin/api/dashboard/sales-series', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data?.ok) throw new Error(data?.message || 'Bad response');

    cache.day = Array.isArray(data.day) ? data.day : [];
    cache.month = Array.isArray(data.month) ? data.month : [];
    cache.year = Array.isArray(data.year) ? data.year : [];

    // Default view = Month (matches your checked option2)
    render('month');
  }

  function wireButtons() {
    const inputDay = document.getElementById('option1');
    const inputMonth = document.getElementById('option2');
    const inputYear = document.getElementById('option3');

    if (inputDay) inputDay.addEventListener('change', () => render('day'));
    if (inputMonth) inputMonth.addEventListener('change', () => render('month'));
    if (inputYear) inputYear.addEventListener('change', () => render('year'));
  }

  // Boot
  wireButtons();
  load().catch((e) => {
    console.warn('[admin-dashboard-sales-chart] failed:', e);
  });
})();

console.log('[admin-dashboard-sales-chart] Chart type:', typeof Chart);
console.log('[admin-dashboard-sales-chart] main-chart:', document.getElementById('main-chart'));