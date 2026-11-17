/** Growth analytics: body-weight curves and average daily gain by flock age. */
import { lineChart, palette } from "../charts/index.js";
import { getGrowthCurves } from "../services/analytics.js";
import { html } from "../utils/dom.js";
import { formatNumber } from "../utils/format.js";
import { createAnalyticsPage, mean } from "./_analyticsPage.js";

/** Adds daily gain (g/day) between consecutive weight points of one batch. */
function withGain(points) {
  const sorted = [...points].sort((a, b) => a.ageDays - b.ageDays);
  return sorted.map((p, i) => {
    const prev = sorted[i - 1];
    const gain = prev && p.ageDays > prev.ageDays ? (p.avgWeightG - prev.avgWeightG) / (p.ageDays - prev.ageDays) : null;
    return { ...p, gainG: gain };
  });
}

function ageLabels(batches) {
  const maxAge = Math.max(0, ...batches.flatMap((b) => b.points.map((p) => p.ageDays)));
  return Array.from({ length: maxAge + 1 }, (_, i) => String(i));
}

const batchLabel = (b) => `${b.code} (${b.poultryType})`;

export default createAnalyticsPage({
  title: "Growth Analytics",
  subtitle: "Body-weight development and average daily gain by flock age.",
  filters: { batch: true, range: false },
  statCount: 4,
  load: ({ farmId, batchId }) => getGrowthCurves({ farmId, batchId }),
  stats(batches) {
    const latest = batches.map((b) => withGain(b.points)).filter((p) => p.length).map((p) => p.at(-1));
    const recentGain = batches.map((b) => mean(withGain(b.points).slice(-7).map((p) => p.gainG)));
    return [
      { label: "Batches tracked", value: formatNumber(batches.length), icon: "layers", tone: "info", footnote: "With weight records" },
      { label: "Latest average weight", value: formatNumber(mean(latest.map((p) => p.avgWeightG)), { decimals: 0 }), unit: "g", icon: "scale", footnote: "Mean of each batch's latest weighing" },
      { label: "Average daily gain", value: formatNumber(mean(recentGain), { decimals: 1 }), unit: "g/day", icon: "trending-up", footnote: "Last 7 days of records" },
      { label: "Oldest flock age", value: formatNumber(latest.length ? Math.max(...latest.map((p) => p.ageDays)) : null), unit: "days", icon: "calendar", tone: "warning", footnote: "Among selected batches" },
    ];
  },
  charts: [
    {
      id: "growth-curves",
      title: "Growth curves",
      subtitle: "Average body weight by age",
      icon: "trending-up",
      isEmpty: (batches) => !batches.some((b) => b.points.length),
      draw(canvas, batches) {
        const labels = ageLabels(batches);
        const datasets = batches.map((b, i) => {
          const byAge = new Map(b.points.map((p) => [p.ageDays, p.avgWeightG]));
          return { label: batchLabel(b), data: labels.map((a) => byAge.get(Number(a)) ?? null), color: palette[i % palette.length] };
        });
        lineChart(canvas, { labels, datasets, unit: "g", decimals: 0, yTitle: "Weight (g)", xTitle: "Age (days)" });
      },
    },
    {
      id: "growth-adg",
      title: "Average daily gain",
      subtitle: "Grams gained per day, 3-day smoothed",
      icon: "activity",
      isEmpty: (batches) => !batches.some((b) => b.points.length > 1),
      draw(canvas, batches) {
        const labels = ageLabels(batches);
        const datasets = batches.map((b, i) => {
          const gains = withGain(b.points);
          const byAge = new Map(
            gains.map((p, idx) => {
              const win = gains.slice(Math.max(0, idx - 2), idx + 1).map((x) => x.gainG);
              return [p.ageDays, mean(win)];
            }),
          );
          return { label: batchLabel(b), data: labels.map((a) => byAge.get(Number(a)) ?? null), color: palette[i % palette.length] };
        });
        lineChart(canvas, { labels, datasets, unit: "g/day", decimals: 1, yTitle: "g / day", xTitle: "Age (days)" });
      },
    },
  ],
  table: {
    title: "Weight records by batch",
    fileBase: "growth-analytics",
    sortKey: "ageDays",
    rows: (batches) =>
      batches.flatMap((b) =>
        withGain(b.points).map((p) => ({ key: `${b.batchId}-${p.ageDays}`, code: b.code, farmName: b.farmName, poultryType: b.poultryType, ...p })),
      ),
    columns: [
      { key: "code", label: "Batch", sortable: true, render: (r) => html`<span class="pa-cell-primary">${r.code}</span><span class="pa-cell-secondary">${r.poultryType}</span>` },
      { key: "farmName", label: "Farm", sortable: true },
      { key: "ageDays", label: "Age (days)", sortable: true, align: "num" },
      { key: "avgWeightG", label: "Avg weight (g)", sortable: true, align: "num", render: (r) => formatNumber(r.avgWeightG) },
      { key: "gainG", label: "Daily gain (g)", sortable: true, align: "num", render: (r) => formatNumber(r.gainG, { decimals: 1 }) },
    ],
    csv: {
      headers: ["batch", "farm", "poultry_type", "age_days", "avg_weight_g", "daily_gain_g"],
      row: (r) => [r.code, r.farmName, r.poultryType, r.ageDays, r.avgWeightG, r.gainG === null ? "" : Math.round(r.gainG * 10) / 10],
    },
  },
});
