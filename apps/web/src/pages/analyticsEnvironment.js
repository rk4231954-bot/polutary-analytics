/** Environmental analytics: house temperature and relative humidity. */
import { colors, lineChart, palette } from "../charts/index.js";
import { getDailyRecords } from "../services/analytics.js";
import { html } from "../utils/dom.js";
import { formatDate, formatNumber } from "../utils/format.js";
import { createAnalyticsPage, mean, rowKey, seriesByFarm } from "./_analyticsPage.js";

const HEAT_THRESHOLD_C = 32;
const hasValues = (records, key) => records.some((r) => Number.isFinite(r[key]));

export default createAnalyticsPage({
  title: "Environmental Analytics",
  subtitle: "House temperature and relative humidity trends across farms.",
  statCount: 6,
  load: ({ farmId, days }) => getDailyRecords({ farmId, days }),
  stats(records) {
    const temps = records.map((r) => r.temperatureC).filter(Number.isFinite);
    const hums = records.map((r) => r.humidityPct).filter(Number.isFinite);
    const hotDays = new Set(records.filter((r) => r.temperatureC > HEAT_THRESHOLD_C).map((r) => r.date)).size;
    return [
      { label: "Average temperature", value: formatNumber(mean(temps), { decimals: 1 }), unit: "°C", icon: "thermometer", footnote: "Mean of daily averages" },
      { label: "Minimum temperature", value: formatNumber(temps.length ? Math.min(...temps) : null, { decimals: 1 }), unit: "°C", icon: "arrow-down", tone: "info", footnote: "Lowest daily average" },
      { label: "Maximum temperature", value: formatNumber(temps.length ? Math.max(...temps) : null, { decimals: 1 }), unit: "°C", icon: "arrow-up", tone: "danger", footnote: "Highest daily average" },
      { label: "Average humidity", value: formatNumber(mean(hums), { decimals: 1 }), unit: "% RH", icon: "droplets", tone: "info", footnote: "Mean relative humidity" },
      { label: "Humidity range", value: hums.length ? `${formatNumber(Math.min(...hums), { decimals: 0 })}–${formatNumber(Math.max(...hums), { decimals: 0 })}` : "—", unit: "% RH", icon: "sliders", footnote: "Min–max daily average" },
      { label: `Days above ${HEAT_THRESHOLD_C} °C`, value: formatNumber(hotDays), icon: "alert-triangle", tone: hotDays ? "warning" : "brand", footnote: "Any farm, selected period" },
    ];
  },
  charts: [
    {
      id: "env-temp",
      title: "Temperature trend",
      subtitle: `Daily average by farm · dashed line marks ${HEAT_THRESHOLD_C} °C`,
      icon: "thermometer",
      isEmpty: (r) => !hasValues(r, "temperatureC"),
      draw(canvas, records) {
        const s = seriesByFarm(records, (r) => r.temperatureC, palette);
        s.datasets.push({ label: `${HEAT_THRESHOLD_C} °C threshold`, data: s.labels.map(() => HEAT_THRESHOLD_C), color: colors.danger, dashed: true, borderWidth: 1.5 });
        lineChart(canvas, { ...s, unit: "°C", decimals: 1, yTitle: "°C" });
      },
    },
    {
      id: "env-hum",
      title: "Relative humidity trend",
      subtitle: "Daily average by farm",
      icon: "droplets",
      isEmpty: (r) => !hasValues(r, "humidityPct"),
      draw(canvas, records) {
        lineChart(canvas, { ...seriesByFarm(records, (r) => r.humidityPct, palette), unit: "%", decimals: 1, yTitle: "% RH" });
      },
    },
  ],
  table: {
    title: "Daily environmental records",
    fileBase: "environmental-analytics",
    sortKey: "date",
    rows: (records) => records.map((r) => ({ ...r, key: rowKey(r) })),
    columns: [
      { key: "date", label: "Date", sortable: true, render: (r) => formatDate(r.date) },
      { key: "farmName", label: "Farm", sortable: true, render: (r) => html`<span class="pa-cell-primary">${r.farmName}</span>` },
      { key: "temperatureC", label: "Temperature (°C)", sortable: true, align: "num", render: (r) => html`<span class="${r.temperatureC > HEAT_THRESHOLD_C ? "pa-analytics-flag" : ""}">${formatNumber(r.temperatureC, { decimals: 1 })}</span>` },
      { key: "humidityPct", label: "Humidity (% RH)", sortable: true, align: "num", render: (r) => formatNumber(r.humidityPct, { decimals: 1 }) },
    ],
    csv: { headers: ["date", "farm", "temperature_c", "humidity_pct"], row: (r) => [r.date, r.farmName, r.temperatureC, r.humidityPct] },
  },
});
