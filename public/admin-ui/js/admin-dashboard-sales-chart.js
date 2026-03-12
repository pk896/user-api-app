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

  const btnDay = document.querySelector('label[for="option1"]');
  const btnMonth = document.querySelector('label[for="option2"]');
  const btnYear = document.querySelector('label[for="option3"]');

  const inputDay = document.getElementById('option1');
  const inputMonth = document.getElementById('option2');
  const inputYear = document.getElementById('option3');

  const rangeLabelEl = document.getElementById('admin-main-chart-range');

  let chart = null;
  let cache = { day: [], month: [], year: [] };

  function toMoney(n) {
    const x = Number(n || 0);
    return Math.round(x * 100) / 100;
  }

  function formatCurrency(value) {
    const amount = Number(value || 0);

    return new Intl.NumberFormat('en-ZA', {
      style: 'currency',
      currency: 'ZAR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(amount);
  }

  function formatCompactNumber(value) {
    const amount = Number(value || 0);

    return new Intl.NumberFormat('en', {
      notation: 'compact',
      maximumFractionDigits: 1
    }).format(amount);
  }

  function formatAxisCurrency(value) {
    const amount = Number(value || 0);

    if (Math.abs(amount) >= 1000) {
      return `R${formatCompactNumber(amount)}`;
    }

    return `R${amount.toFixed(0)}`;
  }

  function formatWholeNumber(value) {
    return new Intl.NumberFormat('en-ZA').format(Number(value || 0));
  }

  function labelFor(key, mode) {
    if (!key) return '';

    if (mode === 'year') {
      const d = new Date(`${key}-01T00:00:00`);
      return d.toLocaleDateString('en-ZA', { month: 'short', year: 'numeric' });
    }

    const d = new Date(`${key}T00:00:00`);

    if (mode === 'day') {
      return d.toLocaleDateString('en-ZA', { weekday: 'short' });
    }

    return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' });
  }

  function buildDataset(series, mode) {
    const labels = series.map((x) => labelFor(x.key, mode));
    const sales = series.map((x) => toMoney(x.sales));
    const orders = series.map((x) => Number(x.orders || 0));

    return { labels, sales, orders };
  }

  function getRangeLabel(mode) {
    if (mode === 'day') return 'Last 7 days';
    if (mode === 'year') return 'Last 12 months';
    return 'Last 30 days';
  }

  function ensureChart() {
    if (chart) return;

    chart = new Chart(canvas, {
      type: 'line',
      data: {
        labels: [],
        datasets: [
          {
            label: 'Sales Amount',
            yAxisID: 'ySales',
            data: [],
            backgroundColor: 'rgba(124, 58, 237, 0.12)',
            borderColor: '#7C3AED',
            pointBackgroundColor: '#7C3AED',
            pointBorderColor: '#ffffff',
            pointHoverBackgroundColor: '#ffffff',
            pointHoverBorderColor: '#7C3AED',
            borderWidth: 3,
            tension: 0.35,
            fill: true
          },
          {
            label: 'Orders',
            yAxisID: 'yOrders',
            data: [],
            backgroundColor: 'transparent',
            borderColor: '#22C55E',
            pointBackgroundColor: '#22C55E',
            pointBorderColor: '#ffffff',
            pointHoverBackgroundColor: '#ffffff',
            pointHoverBorderColor: '#22C55E',
            borderWidth: 2,
            tension: 0.35,
            fill: false
          }
        ]
      },
      options: {
        maintainAspectRatio: false,
        responsive: true,
        interaction: {
          intersect: false,
          mode: 'index'
        },
        plugins: {
          legend: {
            display: true,
            labels: {
              color: coreui.Utils.getStyle('--cui-body-color'),
              usePointStyle: true,
              boxWidth: 10
            }
          },
          tooltip: {
            callbacks: {
              label(context) {
                const datasetLabel = context.dataset?.label || '';
                const rawValue = Number(context.raw || 0);

                if (datasetLabel === 'Sales Amount') {
                  return `${datasetLabel}: ${formatCurrency(rawValue)}`;
                }

                if (datasetLabel === 'Orders') {
                  return `${datasetLabel}: ${formatWholeNumber(rawValue)}`;
                }

                return `${datasetLabel}: ${formatWholeNumber(rawValue)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: {
              color: coreui.Utils.getStyle('--cui-border-color-translucent'),
              drawOnChartArea: false
            },
            ticks: {
              color: coreui.Utils.getStyle('--cui-body-color')
            }
          },
          ySales: {
            type: 'linear',
            position: 'left',
            beginAtZero: true,
            min: 0,
            border: {
              color: coreui.Utils.getStyle('--cui-border-color-translucent')
            },
            grid: {
              color: coreui.Utils.getStyle('--cui-border-color-translucent')
            },
            ticks: {
              color: '#7C3AED',
              maxTicksLimit: 6,
              callback(value) {
                return formatAxisCurrency(value);
              }
            },
            title: {
              display: true,
              text: 'Sales Amount',
              color: '#7C3AED'
            }
          },
          yOrders: {
            type: 'linear',
            position: 'right',
            beginAtZero: true,
            min: 0,
            border: {
              color: coreui.Utils.getStyle('--cui-border-color-translucent')
            },
            grid: {
              drawOnChartArea: false
            },
            ticks: {
              color: '#22C55E',
              maxTicksLimit: 6,
              callback(value) {
                return formatCompactNumber(value);
              }
            },
            title: {
              display: true,
              text: 'Orders',
              color: '#22C55E'
            }
          }
        },
        elements: {
          line: {
            tension: 0.35
          },
          point: {
            radius: 3,
            hitRadius: 10,
            hoverRadius: 5,
            hoverBorderWidth: 2
          }
        }
      }
    });
  }

  function setActiveButton(mode) {
    [btnDay, btnMonth, btnYear].forEach((b) => b && b.classList.remove('active'));

    if (mode === 'day' && btnDay) btnDay.classList.add('active');
    if (mode === 'month' && btnMonth) btnMonth.classList.add('active');
    if (mode === 'year' && btnYear) btnYear.classList.add('active');

    if (inputDay) inputDay.checked = mode === 'day';
    if (inputMonth) inputMonth.checked = mode === 'month';
    if (inputYear) inputYear.checked = mode === 'year';
  }

  function render(mode) {
    ensureChart();

    const series = cache[mode] || [];
    const { labels, sales, orders } = buildDataset(series, mode);

    chart.data.labels = labels.length ? labels : ['No data'];
    chart.data.datasets[0].data = sales.length ? sales : [0];
    chart.data.datasets[1].data = orders.length ? orders : [0];

    const maxSalesValue = Math.max(...(sales.length ? sales : [0]), 0);
    const maxOrdersValue = Math.max(...(orders.length ? orders : [0]), 0);

    chart.options.scales.ySales.min = 0;
    chart.options.scales.ySales.max = Math.ceil(Math.max(maxSalesValue, 1) * 1.15);

    chart.options.scales.yOrders.min = 0;
    chart.options.scales.yOrders.max = Math.ceil(Math.max(maxOrdersValue, 1) * 1.15);

    chart.update();
    setActiveButton(mode);

    if (rangeLabelEl) {
      rangeLabelEl.textContent = getRangeLabel(mode);
    }
  }

  async function load() {
    const res = await fetch('/admin/api/dashboard/sales-series', { credentials: 'include' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    if (!data?.ok) throw new Error(data?.message || 'Bad response');

    cache.day = Array.isArray(data.day) ? data.day : [];
    cache.month = Array.isArray(data.month) ? data.month : [];
    cache.year = Array.isArray(data.year) ? data.year : [];

    render('month');
  }

  function wireButtons() {
    if (inputDay) {
      inputDay.addEventListener('change', () => {
        if (inputDay.checked) render('day');
      });
    }

    if (inputMonth) {
      inputMonth.addEventListener('change', () => {
        if (inputMonth.checked) render('month');
      });
    }

    if (inputYear) {
      inputYear.addEventListener('change', () => {
        if (inputYear.checked) render('year');
      });
    }
  }

  document.documentElement.addEventListener('ColorSchemeChange', () => {
    if (!chart) return;

    chart.options.scales.x.grid.color = coreui.Utils.getStyle('--cui-border-color-translucent');
    chart.options.scales.x.ticks.color = coreui.Utils.getStyle('--cui-body-color');

    chart.options.scales.ySales.border.color = coreui.Utils.getStyle('--cui-border-color-translucent');
    chart.options.scales.ySales.grid.color = coreui.Utils.getStyle('--cui-border-color-translucent');

    chart.options.scales.yOrders.border.color = coreui.Utils.getStyle('--cui-border-color-translucent');

    chart.options.plugins.legend.labels.color = coreui.Utils.getStyle('--cui-body-color');

    chart.update();
  });

  wireButtons();

  load().catch((e) => {
    console.warn('[admin-dashboard-sales-chart] failed:', e);
  });
})();

console.log('[admin-dashboard-sales-chart] Chart type:', typeof Chart);
console.log('[admin-dashboard-sales-chart] main-chart:', document.getElementById('main-chart'));


