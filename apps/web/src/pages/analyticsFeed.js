/** Feed analytics: daily consumption and intake per bird. */
import { barChart, colors, lineChart, palette } from "../charts/index.js";
import { getDailyRecords } from "../services/analytics.js";
import { html } from "../utils/dom.js";
import { formatDate, formatNumber } from "../utils/format.js";
import { createAnalyticsPage, mean, movingAverage, rowKey, seriesByFarm, sortedDates, totalsByDate } from "./_analyticsPage.js";

/** Grams of feed per live bird for one record. */
const gramsPerBird = (r) => (r.birdCount > 0 && Number.isFinite(r.feedKg) ? (r.feedKg * 1000) / r.birdCount : null);

export default createAnalyticsPage({
  title: "Feed Analytics",
  subtitle: "Feed delivered, daily intake per bird and consumption trends.",
  statCount: 4,
  load: ({ farmId, days }) => getDailyRecords({ farmId, days }),
  stats(records) {
    const totals = totalsByDate(records, "feedKg");
    const total = totals.values.reduce((s, v) => s + v, 0);
    const lastDate = sortedDates(records).at(-1);
    const latestBirds = records.filter((r) => r.date === lastDate).reduce((s, r) => s + (r.birdCount || 0), 0);
    const perBird = mean(records.map(gramsPerBird));
    return [
      { label: "Total feed", value: formatNumber(total / 1000, { decimals: 1 }), unit: "t", icon: "wheat", tone: "warning", footnote: `${totals.labels.length} days in period` },
      { label: "Average per day", value: formatNumber(totals.values.length ? total / totals.values.length : null, { decimals: 0 }), unit: "kg", icon: "calendar", footnote: "All selected farms" },
      { label: "Feed per bird", value: formatNumber(latestBirds ? total / latestBirds : null, { decimals: 2 }), unit: "kg", icon: "bird", tone: "info", footnote: "Period total ÷ current live birds" },
      { label: "Daily intake per bird", value: formatNumber(perBird, { decimals: 0 }), unit: "g", icon: "scale", footnote: "Mean grams per bird per day" },
    ];
  },
  charts: [
    {
      id: "feed-daily",
      title: "Daily feed consumption",
      subtitle: "Total kg per day with 7-day average",
      icon: "wheat",
      isEmpty: (r) => !r.some((x) => x.feedKg > 0),
      draw(canvas, records) {
        const t = totalsByDate(records, "feedKg");
        barChart(canvas, {
          labels: t.labels,
          datasets: [
            { label: "Feed", data: t.values.map((v) => Math.round(v * 10) / 10), color: colors.warning, muted: true },
            { label: "7-day average", data: movingAverage(t.values), color: colors.warning, type: "line" },
          ],
          unit: "kg",
          decimals: 0,
          yTitle: "kg",
        });
      },
    },
    {
      id: "feed-per-bird",
      title: "Feed intake per bird",
      subtitle: "Grams per live bird per day, by farm",
      icon: "bird",
      isEmpty: (r) => !r.some((x) => gramsPerBird(x) !== null),
      draw(canvas, records) {
        lineChart(canvas, { ...seriesByFarm(records, gramsPerBird, palette), unit: "g", decimals: 0, yTitle: "g / bird / day" });
      },
    },
  ],
  table: {
    title: "Daily feed records",
    fileBase: "feed-analytics",
    sortKey: "date",
    rows: (records) => records.map((r) => ({ ...r, key: rowKey(r), gramsPerBird: gramsPerBird(r) })),
    columns: [
      { key: "date", label: "Date", sortable: true, render: (r) => formatDate(r.date) },
      { key: "farmName", label: "Farm", sortable: true, render: (r) => html`<span class="pa-cell-primary">${r.farmName}</span>` },
      { key: "feedKg", label: "Feed (kg)", sortable: true, align: "num", render: (r) => formatNumber(r.feedKg, { decimals: 1 }) },
      { key: "birdCount", label: "Live birds", sortable: true, align: "num", render: (r) => formatNumber(r.birdCount) },
      { key: "gramsPerBird", label: "g / bird", sortable: true, align: "num", render: (r) => formatNumber(r.gramsPerBird, { decimals: 0 }) },
    ],
    csv: {
      headers: ["date", "farm", "feed_kg", "live_birds", "feed_g_per_bird"],
      row: (r) => [r.date, r.farmName, r.feedKg, r.birdCount, r.gramsPerBird === null ? "" : Math.round(r.gramsPerBird * 10) / 10],
    },
  },
});
