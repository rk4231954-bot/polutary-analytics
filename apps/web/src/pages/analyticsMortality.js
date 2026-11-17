/** Mortality analytics: daily deaths, mortality rate and cumulative mortality by farm. */
import { barChart, colors, lineChart, palette } from "../charts/index.js";
import { getDailyRecords } from "../services/analytics.js";
import { html } from "../utils/dom.js";
import { formatDate, formatNumber, formatPercent } from "../utils/format.js";
import { createAnalyticsPage, movingAverage, rowKey, sortedDates, totalsByDate } from "./_analyticsPage.js";

/** Cumulative deaths as % of the population at the start of the period (birds alive + that day's deaths). */
function cumulativeByFarm(records) {
  const labels = sortedDates(records);
  const farms = [...new Map(records.map((r) => [r.farmId, r.farmName])).entries()];
  const datasets = farms.map(([farmId, farmName], i) => {
    const rows = records.filter((r) => r.farmId === farmId).sort((a, b) => (a.date < b.date ? -1 : 1));
    const start = rows.find((r) => r.birdCount > 0);
    const base = start ? start.birdCount + (start.mortality || 0) : 0;
    let cum = 0;
    const byDate = new Map(
      rows.map((r) => {
        cum += r.mortality || 0;
        return [r.date, base ? (cum / base) * 100 : null];
      }),
    );
    return { label: farmName, data: labels.map((d) => byDate.get(d) ?? null), color: palette[i % palette.length] };
  });
  return { labels, datasets };
}

const dailyRate = (r) => (r.birdCount > 0 ? (r.mortality / (r.birdCount + r.mortality)) * 100 : null);

export default createAnalyticsPage({
  title: "Mortality Analytics",
  subtitle: "Daily deaths, mortality rate and cumulative mortality by farm.",
  statCount: 4,
  load: ({ farmId, days }) => getDailyRecords({ farmId, days }),
  stats(records) {
    const t = totalsByDate(records, "mortality");
    const deaths = t.values.reduce((s, v) => s + v, 0);
    const birds = totalsByDate(records, "birdCount");
    const avgBirds = birds.values.length ? birds.values.reduce((s, v) => s + v, 0) / birds.values.length : 0;
    let peakIdx = -1;
    t.values.forEach((v, i) => {
      if (peakIdx === -1 || v > t.values[peakIdx]) peakIdx = i;
    });
    return [
      { label: "Total deaths", value: formatNumber(deaths), unit: "birds", icon: "heart-pulse", tone: "danger", footnote: `${t.labels.length} days in period` },
      { label: "Mortality rate", value: formatPercent(avgBirds ? (deaths / avgBirds) * 100 : null, 2), icon: "activity", tone: "warning", footnote: "Deaths ÷ average live birds" },
      { label: "Average per day", value: formatNumber(t.values.length ? deaths / t.values.length : null, { decimals: 1 }), unit: "birds", icon: "calendar", footnote: "All selected farms" },
      {
        label: "Peak day",
        value: peakIdx >= 0 ? formatNumber(t.values[peakIdx]) : "—",
        unit: peakIdx >= 0 ? "birds" : "",
        icon: "alert-triangle",
        tone: "danger",
        footnote: peakIdx >= 0 ? formatDate(t.labels[peakIdx]) : "No records",
      },
    ];
  },
  charts: [
    {
      id: "mort-daily",
      title: "Daily mortality",
      subtitle: "Deaths per day with 7-day average",
      icon: "heart-pulse",
      isEmpty: (r) => r.length === 0,
      draw(canvas, records) {
        const t = totalsByDate(records, "mortality");
        barChart(canvas, {
          labels: t.labels,
          datasets: [
            { label: "Deaths", data: t.values, color: colors.danger, muted: true },
            { label: "7-day average", data: movingAverage(t.values), color: colors.danger, type: "line" },
          ],
          unit: "birds",
          decimals: 1,
          yTitle: "Birds",
        });
      },
    },
    {
      id: "mort-cum",
      title: "Cumulative mortality",
      subtitle: "% of starting population, by farm",
      icon: "trending-up",
      isEmpty: (r) => !r.some((x) => x.birdCount > 0),
      draw(canvas, records) {
        lineChart(canvas, { ...cumulativeByFarm(records), unit: "%", decimals: 2, yTitle: "Cumulative %", beginAtZero: true });
      },
    },
  ],
  table: {
    title: "Daily mortality records",
    fileBase: "mortality-analytics",
    sortKey: "date",
    rows: (records) => records.map((r) => ({ ...r, key: rowKey(r), ratePct: dailyRate(r) })),
    columns: [
      { key: "date", label: "Date", sortable: true, render: (r) => formatDate(r.date) },
      { key: "farmName", label: "Farm", sortable: true, render: (r) => html`<span class="pa-cell-primary">${r.farmName}</span>` },
      { key: "mortality", label: "Deaths", sortable: true, align: "num", render: (r) => formatNumber(r.mortality) },
      { key: "birdCount", label: "Live birds", sortable: true, align: "num", render: (r) => formatNumber(r.birdCount) },
      { key: "ratePct", label: "Daily rate", sortable: true, align: "num", render: (r) => formatPercent(r.ratePct, 3) },
    ],
    csv: {
      headers: ["date", "farm", "deaths", "live_birds", "daily_mortality_pct"],
      row: (r) => [r.date, r.farmName, r.mortality, r.birdCount, r.ratePct === null ? "" : Math.round(r.ratePct * 1000) / 1000],
    },
  },
});
