/**
 * Chart.js setup and chart factories with the Poultry Analytics visual style.
 *
 * Every chart lives in a fixed-height `.pa-chart` container (responsive width,
 * maintainAspectRatio: false). Creating a chart on a canvas that already has
 * one destroys the old instance first; the router destroys all charts inside
 * the content area when the page changes.
 */
import {
  ArcElement, BarController, BarElement, CategoryScale, Chart, DoughnutController, Filler, Legend,
  LinearScale, LineController, LineElement, PointElement, Tooltip,
} from "chart.js";
import { html } from "../utils/dom.js";
import { formatNumber, formatShortDate } from "../utils/format.js";

Chart.register(
  ArcElement, BarController, BarElement, CategoryScale, DoughnutController, Filler, Legend, LinearScale,
  LineController, LineElement, PointElement, Tooltip,
);

/** Mirrors --pa-chart-* tokens (Chart.js cannot read CSS variables at draw time). */
export const palette = ["#21845a", "#3182ce", "#e5a000", "#8b5cf6", "#dc4545", "#0f766e"];
export const colors = {
  text: "#17231d",
  text2: "#5f6b63",
  grid: "#edf1ee",
  border: "#e2e8e3",
  forest: "#174c36",
  emerald: "#21845a",
  danger: "#dc4545",
  warning: "#e5a000",
  info: "#3182ce",
  prediction: "#8b5cf6",
};

Chart.defaults.font.family = '"Inter Variable", "Inter", system-ui, sans-serif';
Chart.defaults.font.size = 12;
Chart.defaults.color = colors.text2;
Chart.defaults.borderColor = colors.grid;
Chart.defaults.animation.duration = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 400;

export function withAlpha(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

const tooltip = {
  backgroundColor: "#17231d",
  titleColor: "#ffffff",
  bodyColor: "#dfe7e2",
  borderColor: "#17231d",
  borderWidth: 0,
  padding: 10,
  cornerRadius: 8,
  titleFont: { size: 12, weight: "600" },
  bodyFont: { size: 12 },
  boxPadding: 4,
  usePointStyle: true,
};

const legend = {
  position: "top",
  align: "start",
  labels: { usePointStyle: true, pointStyle: "rectRounded", boxWidth: 8, boxHeight: 8, padding: 14, color: colors.text2 },
};

function valueFormatter(unit, decimals) {
  return (value) => `${formatNumber(value, { decimals })}${unit ? ` ${unit}` : ""}`;
}

/** Labels that are ISO dates (YYYY-MM-DD) are shown as "12 Mar". */
function maybeDateLabel(label) {
  return typeof label === "string" && /^\d{4}-\d{2}-\d{2}$/.test(label) ? formatShortDate(label) : label;
}

function baseOptions({ unit = "", decimals = 1, yTitle, xTitle, showLegend = true, stacked = false, beginAtZero = false, horizontal = false }) {
  const fmt = valueFormatter(unit, decimals);
  const valueAxis = {
    beginAtZero,
    stacked,
    grid: { color: colors.grid, drawTicks: false },
    border: { display: false },
    ticks: { padding: 8, maxTicksLimit: 6, callback: (v) => formatNumber(v, { decimals: Math.min(decimals, 1), compact: Math.abs(v) >= 10000 }) },
    title: yTitle ? { display: true, text: yTitle, color: colors.text2, font: { size: 11, weight: "500" } } : undefined,
  };
  const categoryAxis = {
    stacked,
    grid: { display: false },
    border: { color: colors.border },
    ticks: {
      padding: 6,
      autoSkip: true,
      maxRotation: 0,
      autoSkipPadding: 16,
      callback(value) {
        return maybeDateLabel(this.getLabelForValue(value));
      },
    },
    title: xTitle ? { display: true, text: xTitle, color: colors.text2, font: { size: 11, weight: "500" } } : undefined,
  };
  return {
    responsive: true,
    maintainAspectRatio: false,
    indexAxis: horizontal ? "y" : "x",
    interaction: { mode: "index", intersect: false },
    layout: { padding: { top: 4, right: 4 } },
    plugins: {
      legend: { ...legend, display: showLegend },
      tooltip: {
        ...tooltip,
        callbacks: {
          title: (items) => (items.length ? String(maybeDateLabel(items[0].label)) : ""),
          label: (item) => {
            const v = horizontal ? item.parsed.x : item.parsed.y;
            if (v === null || v === undefined) return `${item.dataset.label}: no data`;
            return `${item.dataset.label}: ${fmt(v)}`;
          },
        },
      },
    },
    scales: horizontal ? { x: valueAxis, y: categoryAxis } : { x: categoryAxis, y: valueAxis },
  };
}

function lineDataset(ds, index) {
  const color = ds.color || palette[index % palette.length];
  return {
    label: ds.label,
    data: ds.data,
    borderColor: color,
    backgroundColor: ds.fill ? withAlpha(color, 0.08) : color,
    fill: ds.fill ? "origin" : false,
    borderWidth: ds.borderWidth || 2,
    borderDash: ds.dashed ? [6, 4] : undefined,
    tension: 0.35,
    pointRadius: 0,
    pointHoverRadius: 4,
    pointHoverBorderWidth: 2,
    pointHoverBackgroundColor: "#fff",
    pointBackgroundColor: color,
    spanGaps: true,
    yAxisID: ds.yAxisID,
    order: ds.order,
  };
}

function prepare(canvas) {
  const existing = Chart.getChart(canvas);
  if (existing) existing.destroy();
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{labels: string[], datasets: Array<{label: string, data: number[], color?: string, dashed?: boolean, fill?: boolean}>,
 *          unit?: string, decimals?: number, yTitle?: string, xTitle?: string, showLegend?: boolean, beginAtZero?: boolean}} spec
 */
export function lineChart(canvas, spec) {
  prepare(canvas);
  return new Chart(canvas, {
    type: "line",
    data: { labels: spec.labels, datasets: spec.datasets.map(lineDataset) },
    options: baseOptions(spec),
  });
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{labels: string[], datasets: Array<{label: string, data: number[], color?: string, type?: "line"}>,
 *          unit?: string, decimals?: number, yTitle?: string, stacked?: boolean, horizontal?: boolean, showLegend?: boolean}} spec
 */
export function barChart(canvas, spec) {
  prepare(canvas);
  const datasets = spec.datasets.map((ds, i) => {
    if (ds.type === "line") return { ...lineDataset(ds, i), type: "line", order: 0 };
    const color = ds.color || palette[i % palette.length];
    return {
      label: ds.label,
      data: ds.data,
      backgroundColor: ds.muted ? withAlpha(color, 0.35) : color,
      hoverBackgroundColor: color,
      borderRadius: 4,
      borderSkipped: false,
      maxBarThickness: spec.horizontal ? 18 : 28,
      categoryPercentage: 0.7,
      barPercentage: 0.85,
      order: 1,
    };
  });
  return new Chart(canvas, {
    type: "bar",
    data: { labels: spec.labels, datasets },
    options: baseOptions({ beginAtZero: true, ...spec }),
  });
}

/** Doughnut for part-of-whole (e.g. role distribution). */
export function doughnutChart(canvas, { labels, data, colors: segmentColors, unit = "" }) {
  prepare(canvas);
  return new Chart(canvas, {
    type: "doughnut",
    data: {
      labels,
      datasets: [{ data, backgroundColor: segmentColors || palette, borderColor: "#fff", borderWidth: 2, hoverOffset: 4 }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: "70%",
      plugins: {
        legend: { ...legend, position: "bottom", align: "center" },
        tooltip: { ...tooltip, callbacks: { label: (item) => `${item.label}: ${formatNumber(item.parsed)}${unit ? ` ${unit}` : ""}` } },
      },
    },
  });
}

/** Destroys every chart rendered inside `root` (called by the router on navigation). */
export function destroyCharts(root) {
  root?.querySelectorAll("canvas").forEach((canvas) => Chart.getChart(canvas)?.destroy());
}

/** True when at least one dataset has at least one numeric value. */
export function hasData(datasets) {
  return datasets?.some((ds) => ds.data?.some((v) => v !== null && v !== undefined && Number.isFinite(v)));
}

/** Markup for a chart container. Pass `label` for screen readers. */
export function chartCanvas(id, { size = "", label = "Chart" } = {}) {
  return html`<div class="pa-chart ${size ? `pa-chart--${size}` : ""}"><canvas id="${id}" role="img" aria-label="${label}"></canvas></div>`;
}
