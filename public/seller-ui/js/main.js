// C:\Users\phaki\user-api-app\public\seller-ui\js\main.js
/* global Chart, coreui */

/**
 * --------------------------------------------------------------------------
 * CoreUI Boostrap Admin Template main.js
 * Licensed under MIT (https://github.com/coreui/coreui-free-bootstrap-admin-template/blob/main/LICENSE)
 * --------------------------------------------------------------------------
 */

/**
 * Dashboard Charts
 *
 * This module initializes and manages all charts on the main Dashboard page (index.html).
 * It includes:
 * - Card charts (small charts in statistic cards)
 * - Main chart (large chart showing traffic/metrics over time)
 * - Custom tooltip configuration using CoreUI's ChartJS utilities
 * - Theme-aware chart updates (responds to dark/light mode changes)
 *
 * All charts use Chart.js with CoreUI's custom styling and color variables.
 */

Chart.defaults.pointHitDetectionRadius = 1;
Chart.defaults.plugins.tooltip.enabled = false;
Chart.defaults.plugins.tooltip.mode = 'index';
Chart.defaults.plugins.tooltip.position = 'nearest';
Chart.defaults.plugins.tooltip.external = coreui.ChartJS.customTooltips;
Chart.defaults.defaultFontColor = coreui.Utils.getStyle('--cui-body-color');

const cardChart1 = new Chart(document.getElementById('card-chart1'), {
  type: 'line',
  data: {
    labels: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
    datasets: [{
      label: 'Stock movement',
      backgroundColor: 'transparent',
      borderColor: 'rgba(255,255,255,.55)',
      pointBackgroundColor: coreui.Utils.getStyle('--cui-primary'),
      data: [0, 0, 0, 0, 0, 0, 0]
    }]
  },
  options: {
    plugins: {
      legend: {
        display: false
      }
    },
    maintainAspectRatio: false,
    scales: {
      x: {
        border: {
          display: false
        },
        grid: {
          display: false,
          drawBorder: false
        },
        ticks: {
          display: false
        }
      },
      y: {
        display: false,
        grid: {
          display: false
        },
        ticks: {
          display: false
        }
      }
    },
    elements: {
      line: {
        borderWidth: 1,
        tension: 0.4
      },
      point: {
        radius: 4,
        hitRadius: 10,
        hoverRadius: 4
      }
    }
  }
});

async function loadSellerCard1Stats() {
  try {
    const response = await fetch('/api/seller/stats', {
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
      throw new Error(payload.message || 'Failed to load seller stats');
    }

    const totalProducts = Number(payload?.stats?.totalProducts || 0);
    const totalStock = Number(payload?.stats?.totalStock || 0);
    const chartLabels = Array.isArray(payload?.chart?.labels) ? payload.chart.labels : [];
    const chartData = Array.isArray(payload?.chart?.data)
      ? payload.chart.data.map((value) => Number(value || 0))
      : [];

    const weeklyMovement = chartData.reduce((sum, value) => sum + value, 0);

    const totalProductsEl = document.getElementById('seller-total-products');
    const totalStockEl = document.getElementById('seller-total-stock');
    const movementTextEl = document.getElementById('seller-stock-movement-text');

    if (totalProductsEl) {
      totalProductsEl.textContent = String(totalProducts);
    }

    if (totalStockEl) {
      totalStockEl.textContent = String(totalStock);
    }

    if (movementTextEl) {
      if (weeklyMovement > 0) {
        movementTextEl.textContent = ` (+${weeklyMovement} added this week)`;
      } else if (weeklyMovement < 0) {
        movementTextEl.textContent = ` (${weeklyMovement} removed this week)`;
      } else {
        movementTextEl.textContent = '';
      }
    }

    cardChart1.data.labels = chartLabels.length ? chartLabels : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    cardChart1.data.datasets[0].data = chartData.length ? chartData : [0, 0, 0, 0, 0, 0, 0];
    cardChart1.update();
  } catch (error) {
    console.error('❌ Failed to load seller card 1 stats:', error);
  }
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

function formatUsdCurrency(value) {
  const amount = Number(value || 0);

  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
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

async function loadSellerInventoryValue() {
  try {
    const response = await fetch('/api/seller/inventory-value', {
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

    if (!payload.success) {
      throw new Error(payload.message || 'Failed to load inventory value');
    }

    const inventoryValue = Number(payload?.data?.inventoryValue || 0);
    const totalUnits = Number(payload?.data?.totalUnits || 0);

    const inventoryValueEl = document.getElementById('seller-inventory-value');
    const inventoryUnitsEl = document.getElementById('seller-inventory-units');

    if (inventoryValueEl) {
      inventoryValueEl.textContent = formatCurrency(inventoryValue);
    }

    if (inventoryUnitsEl) {
      inventoryUnitsEl.textContent = String(totalUnits);
    }

    const historyLabels = Array.isArray(payload?.data?.history?.labels)
      ? payload.data.history.labels
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const historyData = Array.isArray(payload?.data?.history?.data)
      ? payload.data.history.data.map((value) => Number(value || 0))
      : [0, 0, 0, 0, 0, 0, 0];

    const maxChartValue = Math.max(...historyData, 1);

    cardChart2.data.labels = historyLabels;
    cardChart2.data.datasets[0].label = 'Inventory Value';
    cardChart2.data.datasets[0].data = historyData;
    cardChart2.options.scales.y.min = 0;
    cardChart2.options.scales.y.max = Math.ceil(maxChartValue * 1.2);
    cardChart2.update();
  } catch (error) {
    console.error('❌ Failed to load seller inventory value:', error);

    const inventoryValueEl = document.getElementById('seller-inventory-value');
    if (inventoryValueEl) {
      inventoryValueEl.textContent = 'Error';
    }
  }
}

const cardChart2 = new Chart(document.getElementById('card-chart2'), {
  type: 'line',
  data: {
    labels: ['Inventory Value'],
    datasets: [{
      label: 'Inventory Value',
      backgroundColor: 'transparent',
      borderColor: 'rgba(255,255,255,.55)',
      pointBackgroundColor: coreui.Utils.getStyle('--cui-info'),
      data: [0]
    }]
  },
  options: {
    plugins: {
      legend: {
        display: false
      }
    },
    maintainAspectRatio: false,
    scales: {
      x: {
        border: {
          display: false
        },
        grid: {
          display: false,
          drawBorder: false
        },
        ticks: {
          display: false
        }
      },
      y: {
        min: 0,
        max: 100,
        display: false,
        grid: {
          display: false
        },
        ticks: {
          display: false
        }
      }
    },
    elements: {
      line: {
        borderWidth: 1
      },
      point: {
        radius: 4,
        hitRadius: 10,
        hoverRadius: 4
      }
    }
  }
});

async function loadSellerEarnings() {
  try {
    const response = await fetch('/api/seller/earnings', {
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
      throw new Error(payload.message || 'Failed to load seller earnings');
    }

    const paidEarnings = Number(payload?.stats?.paidEarnings || 0);
    const eligibility = Number(payload?.stats?.eligibility || 0);

    const paidEarningsEl = document.getElementById('seller-paid-earnings');
    const eligibilityEl = document.getElementById('seller-eligibility');

    if (paidEarningsEl) {
      paidEarningsEl.textContent = formatUsdCurrency(paidEarnings);
    }

    if (eligibilityEl) {
      eligibilityEl.textContent = formatUsdCurrency(eligibility);
    }

    const chartLabels = Array.isArray(payload?.chart?.labels)
      ? payload.chart.labels
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const chartData = Array.isArray(payload?.chart?.data)
      ? payload.chart.data.map((value) => Number(value || 0))
      : [0, 0, 0, 0, 0, 0, 0];

    const maxChartValue = Math.max(...chartData, 1);

    cardChart3.data.labels = chartLabels;
    cardChart3.data.datasets[0].label = 'Recent paid amount';
    cardChart3.data.datasets[0].data = chartData;
    cardChart3.options.scales.y.min = 0;
    cardChart3.options.scales.y.max = Math.ceil(maxChartValue * 1.2);
    cardChart3.update();
  } catch (error) {
    console.error('❌ Failed to load seller earnings:', error);

    const paidEarningsEl = document.getElementById('seller-paid-earnings');
    if (paidEarningsEl) {
      paidEarningsEl.textContent = 'Error';
    }
  }
}

// eslint-disable-next-line no-unused-vars
const cardChart3 = new Chart(document.getElementById('card-chart3'), {
  type: 'line',
  data: {
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    datasets: [{
      label: 'Recent paid amount',
      backgroundColor: 'rgba(255,255,255,.2)',
      borderColor: 'rgba(255,255,255,.55)',
      data: [0, 0, 0, 0, 0, 0, 0],
      fill: true
    }]
  },
  options: {
    plugins: {
      legend: {
        display: false
      }
    },
    maintainAspectRatio: false,
    scales: {
      x: {
        display: false
      },
      y: {
        display: false
      }
    },
    elements: {
      line: {
        borderWidth: 2,
        tension: 0.4
      },
      point: {
        radius: 0,
        hitRadius: 10,
        hoverRadius: 4
      }
    }
  }
});

async function loadSellerPendingStats() {
  try {
    const response = await fetch('/api/seller/pending-stats', {
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
      throw new Error(payload.message || 'Failed to load seller pending stats');
    }

    const pendingEarnings = Number(payload?.stats?.pendingEarnings || 0);
    const refundedAmount = Number(payload?.stats?.refundedAmount || 0);

    const pendingEarningsEl = document.getElementById('seller-pending-earnings');
    const refundedAmountEl = document.getElementById('seller-refunded-amount');

    if (pendingEarningsEl) {
      pendingEarningsEl.textContent = formatUsdCurrency(pendingEarnings);
    }

    if (refundedAmountEl) {
      refundedAmountEl.textContent = formatUsdCurrency(refundedAmount);
    }

    const chartLabels = Array.isArray(payload?.chart?.labels)
      ? payload.chart.labels
      : ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const chartData = Array.isArray(payload?.chart?.data)
      ? payload.chart.data.map((value) => Number(value || 0))
      : [0, 0, 0, 0, 0, 0, 0];

    const maxChartValue = Math.max(...chartData, 1);

    cardChart4.data.labels = chartLabels;
    cardChart4.data.datasets[0].label = 'Pending earnings';
    cardChart4.data.datasets[0].data = chartData;
    cardChart4.options.scales.y.min = 0;
    cardChart4.options.scales.y.max = Math.ceil(maxChartValue * 1.2);
    cardChart4.update();
  } catch (error) {
    console.error('❌ Failed to load seller pending stats:', error);

    const pendingEarningsEl = document.getElementById('seller-pending-earnings');
    if (pendingEarningsEl) {
      pendingEarningsEl.textContent = 'Error';
    }
  }
}

// eslint-disable-next-line no-unused-vars
const cardChart4 = new Chart(document.getElementById('card-chart4'), {
  type: 'line',
  data: {
    labels: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    datasets: [{
      label: 'Pending earnings',
      backgroundColor: 'rgba(255,255,255,.2)',
      borderColor: 'rgba(255,255,255,.55)',
      data: [0, 0, 0, 0, 0, 0, 0],
      fill: true
    }]
  },
  options: {
    plugins: {
      legend: {
        display: false
      }
    },
    maintainAspectRatio: false,
    scales: {
      x: {
        display: false
      },
      y: {
        display: false
      }
    },
    elements: {
      line: {
        borderWidth: 2,
        tension: 0.4
      },
      point: {
        radius: 0,
        hitRadius: 10,
        hoverRadius: 4
      }
    }
  }
});

let sellerMainChartRange = 'month';

async function loadSellerMainChart(range = sellerMainChartRange) {
  try {
    sellerMainChartRange = range;

    const response = await fetch(`/api/seller/trend-overview?range=${encodeURIComponent(range)}`, {
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
      throw new Error(payload.message || 'Failed to load seller trend overview');
    }

    const labels = Array.isArray(payload?.chart?.labels)
      ? payload.chart.labels
      : [];

    const salesData = Array.isArray(payload?.chart?.sales)
      ? payload.chart.sales.map((value) => Number(value || 0))
      : [];

    const stockData = Array.isArray(payload?.chart?.stock)
      ? payload.chart.stock.map((value) => Number(value || 0))
      : [];

    const rangeEl = document.getElementById('seller-main-chart-range');
    if (rangeEl) {
      rangeEl.textContent = payload?.rangeLabel || 'Day / Month / Year';
    }

    mainChart.data.labels = labels.length ? labels : ['No data'];
    mainChart.data.datasets[0].data = salesData.length ? salesData : [0];
    mainChart.data.datasets[1].data = stockData.length ? stockData : [0];

    const maxSalesValue = Math.max(...(salesData.length ? salesData : [0]), 0);
    const minStockValue = Math.min(...(stockData.length ? stockData : [0]), 0);
    const maxStockValue = Math.max(...(stockData.length ? stockData : [0]), 0);

    mainChart.options.scales.ySales.min = 0;
    mainChart.options.scales.ySales.max = Math.ceil(Math.max(maxSalesValue, 1) * 1.15);

    mainChart.options.scales.yStock.min = minStockValue < 0 ? Math.floor(minStockValue * 1.15) : 0;
    mainChart.options.scales.yStock.max = Math.ceil(Math.max(maxStockValue, 1) * 1.15);

    mainChart.update();
    updateSellerMainChartRangeButtons(range);
  } catch (error) {
    console.error('❌ Failed to load seller main chart:', error);
  }
}

function updateSellerMainChartRangeButtons(activeRange) {
  const dayInput = document.getElementById('seller-chart-range-day');
  const monthInput = document.getElementById('seller-chart-range-month');
  const yearInput = document.getElementById('seller-chart-range-year');

  const dayLabel = document.querySelector('label[for="seller-chart-range-day"]');
  const monthLabel = document.querySelector('label[for="seller-chart-range-month"]');
  const yearLabel = document.querySelector('label[for="seller-chart-range-year"]');

  if (dayInput) {
    dayInput.checked = activeRange === 'day';
  }

  if (monthInput) {
    monthInput.checked = activeRange === 'month';
  }

  if (yearInput) {
    yearInput.checked = activeRange === 'year';
  }

  if (dayLabel) {
    dayLabel.classList.toggle('active', activeRange === 'day');
  }

  if (monthLabel) {
    monthLabel.classList.toggle('active', activeRange === 'month');
  }

  if (yearLabel) {
    yearLabel.classList.toggle('active', activeRange === 'year');
  }
}

const mainChart = new Chart(document.getElementById('main-chart'), {
  type: 'line',
  data: {
    labels: [],
    datasets: [
      {
        label: 'Sales Amount',
        yAxisID: 'ySales',
        backgroundColor: 'rgba(124, 58, 237, 0.12)',
        borderColor: '#7C3AED',
        pointBackgroundColor: '#7C3AED',
        pointBorderColor: '#ffffff',
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: '#7C3AED',
        borderWidth: 3,
        tension: 0.35,
        fill: true,
        data: [0]
      },
      {
        label: 'Stock Movement',
        yAxisID: 'yStock',
        backgroundColor: 'transparent',
        borderColor: '#22C55E',
        pointBackgroundColor: '#22C55E',
        pointBorderColor: '#ffffff',
        pointHoverBackgroundColor: '#ffffff',
        pointHoverBorderColor: '#22C55E',
        borderWidth: 2,
        tension: 0.35,
        fill: false,
        data: [0]
      }
    ]
  },
  options: {
    maintainAspectRatio: false,
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

            if (datasetLabel === 'Stock Movement') {
              return `${datasetLabel}: ${new Intl.NumberFormat('en-ZA').format(rawValue)}`;
            }

            return `${datasetLabel}: ${new Intl.NumberFormat('en-ZA').format(rawValue)}`;
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
          display: false
        }
      },
      yStock: {
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
          display: false
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

document.documentElement.addEventListener('ColorSchemeChange', () => {
  cardChart1.data.datasets[0].pointBackgroundColor = coreui.Utils.getStyle('--cui-primary');
  cardChart2.data.datasets[0].pointBackgroundColor = coreui.Utils.getStyle('--cui-info');

  mainChart.options.scales.x.grid.color = coreui.Utils.getStyle('--cui-border-color-translucent');
  mainChart.options.scales.x.ticks.color = coreui.Utils.getStyle('--cui-body-color');

  mainChart.options.scales.ySales.border.color = coreui.Utils.getStyle('--cui-border-color-translucent');
  mainChart.options.scales.ySales.grid.color = coreui.Utils.getStyle('--cui-border-color-translucent');

  mainChart.options.scales.yStock.border.color = coreui.Utils.getStyle('--cui-border-color-translucent');

  mainChart.options.plugins.legend.labels.color = coreui.Utils.getStyle('--cui-body-color');

  cardChart1.update();
  cardChart2.update();
  cardChart3.update();
  cardChart4.update();
  mainChart.update();
});

loadSellerCard1Stats();
loadSellerInventoryValue();
loadSellerEarnings();
loadSellerPendingStats();
loadSellerMainChart('month');

const refreshInventoryValueBtn = document.getElementById('refresh-inventory-value');

if (refreshInventoryValueBtn) {
  refreshInventoryValueBtn.addEventListener('click', (event) => {
    event.preventDefault();
    loadSellerInventoryValue();
  });
}

const refreshEarningsBtn = document.getElementById('refresh-earnings');

if (refreshEarningsBtn) {
  refreshEarningsBtn.addEventListener('click', (event) => {
    event.preventDefault();
    loadSellerEarnings();
  });
}

const refreshPendingStatsBtn = document.getElementById('refresh-pending-stats');

if (refreshPendingStatsBtn) {
  refreshPendingStatsBtn.addEventListener('click', (event) => {
    event.preventDefault();
    loadSellerPendingStats();
  });
}

const refreshMainChartBtn = document.getElementById('refresh-main-chart');

if (refreshMainChartBtn) {
  refreshMainChartBtn.addEventListener('click', (event) => {
    event.preventDefault();
    loadSellerMainChart(sellerMainChartRange);
  });
}

const sellerChartRangeDay = document.getElementById('seller-chart-range-day');
const sellerChartRangeMonth = document.getElementById('seller-chart-range-month');
const sellerChartRangeYear = document.getElementById('seller-chart-range-year');

if (sellerChartRangeDay) {
  sellerChartRangeDay.addEventListener('change', () => {
    if (sellerChartRangeDay.checked) {
      loadSellerMainChart('day');
    }
  });
}

if (sellerChartRangeMonth) {
  sellerChartRangeMonth.addEventListener('change', () => {
    if (sellerChartRangeMonth.checked) {
      loadSellerMainChart('month');
    }
  });
}

if (sellerChartRangeYear) {
  sellerChartRangeYear.addEventListener('change', () => {
    if (sellerChartRangeYear.checked) {
      loadSellerMainChart('year');
    }
  });
}

//# sourceMappingURL=main.js.map