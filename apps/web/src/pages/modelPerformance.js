/**
 * Model performance — evaluation metrics measured by apps/ml on held-out test
 * data. This page NEVER shows sample values, not even in preview mode.
 */
import { barChart, chartCanvas, palette } from "../charts/index.js";
import { createDataTable } from "../components/dataTable.js";
import { icon } from "../components/icons.js";
import { emptyState, errorState, loadingState, skeletonKpis } from "../components/states.js";
import { callout, card, kpiCard, pageHeader, selectOptions } from "../components/ui.js";
import { getModelEvaluations } from "../services/models.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { formatDate, formatDateTime, formatNumber, titleCase } from "../utils/format.js";
import "../styles/pages/models.css";

const CLASSIFICATION_METRICS = [
  { key: "accuracy", label: "Accuracy" },
  { key: "precision", label: "Precision" },
  { key: "recall", label: "Recall" },
  { key: "f1", label: "F1-score" },
  { key: "rocAuc", label: "ROC-AUC" },
];
const REGRESSION_METRICS = [
  { key: "mae", label: "MAE" },
  { key: "mse", label: "MSE" },
  { key: "rmse", label: "RMSE" },
  { key: "r2", label: "R²" },
];

const METRIC_REFERENCE = [
  ["Accuracy", "Share of all test predictions that were correct. Misleading when classes are imbalanced."],
  ["Precision", "Of the cases predicted positive (e.g. high risk), the share that were actually positive."],
  ["Recall", "Of the actual positive cases, the share the model detected."],
  ["F1-score", "Harmonic mean of precision and recall; balances false alarms against missed cases."],
  ["ROC-AUC", "Probability that the model ranks a random positive case above a random negative one (0.5 = chance)."],
  ["Confusion matrix", "Counts of actual (rows) versus predicted (columns) classes on the test set."],
  ["MAE", "Mean absolute error — average size of prediction errors, in the target's units."],
  ["MSE", "Mean squared error — penalises large errors more heavily; in squared units."],
  ["RMSE", "Square root of MSE — error magnitude back in the target's units."],
  ["R²", "Share of variance in the target explained by the model (1 = perfect, 0 = no better than the mean)."],
];

const fmtScore = (v) => formatNumber(v, { decimals: 3 });
const fmtTestSize = (v) => (v === null || v === undefined ? "—" : v > 0 && v < 1 ? `${formatNumber(v * 100)}% hold-out` : `${formatNumber(v)} rows`);

function metricReferenceCard() {
  return card({
    title: "Metric reference",
    subtitle: "How to read the evaluation results",
    icon: "info",
    body: html`<dl class="pa-dl pa-metric-ref">
      ${METRIC_REFERENCE.map(([term, def]) => html`<dt>${term}</dt><dd>${def}</dd>`)}
    </dl>`,
  });
}

function modelCell(e) {
  return html`<span class="pa-cell-primary">${e.modelName}</span><span class="pa-cell-secondary">${e.algorithm} · target: ${e.target}</span>`;
}

export default {
  title: "Model Performance",
  async render(root, ctx) {
    const state = { evaluations: [], cmModel: "", tables: [] };

    setHtml(
      root,
      html`${pageHeader({
          title: "Model Performance",
          subtitle: "Evaluation metrics measured on held-out test data.",
          actions: html`<button type="button" class="btn btn-secondary btn-sm" data-action="refresh">${icon("refresh", { size: 14 })}Refresh</button>`,
        })}
        <div class="pa-section">
          ${callout({
            tone: "info",
            icon: "flask",
            title: "Measured results only",
            message:
              "Metrics are computed by the ML service on a held-out test split of a documented dataset. This page never displays sample, estimated or hand-entered values.",
          })}
        </div>
        <div data-body>${skeletonKpis(4)}</div>
        <div class="pa-section mt-4">${metricReferenceCard()}</div>`,
    );
    const body = $("[data-body]", root);

    function destroyTables() {
      state.tables.forEach((t) => t.destroy());
      state.tables = [];
    }

    function renderConfusion() {
      const target = $("[data-cm]", body);
      if (!target) return;
      const model = state.evaluations.find((e) => e.modelName === state.cmModel);
      const cm = model?.confusionMatrix;
      if (!cm?.labels?.length || !cm.matrix?.length) {
        setHtml(target, emptyState({ icon: "columns", title: "No confusion matrix", message: "This evaluation did not include a confusion matrix.", compact: true }));
        return;
      }
      const max = Math.max(...cm.matrix.flat(), 1);
      const total = cm.matrix.flat().reduce((s, v) => s + v, 0);
      setHtml(
        target,
        html`<div class="pa-table-wrap">
          <table class="pa-cm" aria-label="Confusion matrix for ${model.modelName}">
            <thead>
              <tr><th scope="col" class="pa-cm__corner">Actual ↓ / Predicted →</th>${cm.labels.map((l) => html`<th scope="col">${titleCase(l)}</th>`)}</tr>
            </thead>
            <tbody>
              ${cm.matrix.map(
                (row, i) => html`<tr>
                  <th scope="row">${titleCase(cm.labels[i])}</th>
                  ${row.map((v, j) => {
                    const intensity = v / max;
                    const diag = i === j;
                    const bg = diag ? `rgba(33, 132, 90, ${0.08 + intensity * 0.6})` : `rgba(220, 69, 69, ${v ? 0.06 + intensity * 0.45 : 0})`;
                    return html`<td style="background:${bg}" class="${intensity > 0.55 ? "is-strong" : ""}">
                      <span class="pa-cm__count">${formatNumber(v)}</span>
                      <span class="pa-cm__pct">${total ? formatNumber((v / total) * 100, { decimals: 1 }) : 0}%</span>
                    </td>`;
                  })}
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
        <p class="pa-text-xs pa-text-2 mt-2 mb-0">Diagonal cells (green) are correct predictions; off-diagonal cells (red) are errors. Percentages are of all ${formatNumber(total)} test cases.</p>`,
      );
    }

    function renderPopulated(evaluations) {
      const cls = evaluations.filter((e) => e.task === "classification");
      const reg = evaluations.filter((e) => e.task === "regression");
      const latest = evaluations.map((e) => e.trainedAt).filter(Boolean).sort().at(-1);
      state.cmModel = cls.find((e) => e.confusionMatrix)?.modelName || cls[0]?.modelName || "";

      setHtml(
        body,
        html`<section class="pa-section">
            <div class="pa-grid pa-grid--4 pa-models-kpis">
              ${kpiCard({ label: "Models evaluated", value: formatNumber(evaluations.length), icon: "cpu", footnote: "With stored evaluation results" })}
              ${kpiCard({ label: "Classification models", value: formatNumber(cls.length), icon: "target", tone: "info", footnote: "e.g. mortality risk" })}
              ${kpiCard({ label: "Regression models", value: formatNumber(reg.length), icon: "trending-up", tone: "warning", footnote: "e.g. weight, feed forecasts" })}
              ${kpiCard({ label: "Latest training run", value: latest ? formatDate(latest, { day: "numeric", month: "short" }) : "—", icon: "clock", footnote: latest ? formatDateTime(latest) : "No date recorded" })}
            </div>
          </section>
          ${cls.length
            ? html`<section class="pa-section">
                <div class="pa-grid pa-grid--main-side">
                  ${card({ title: "Classification models", subtitle: "Higher is better for every metric", icon: "target", flush: true, body: html`<div data-table="cls"></div>` })}
                  ${card({
                    title: "Confusion matrix",
                    icon: "columns",
                    actions: html`<label class="visually-hidden" for="cm-model">Model</label>
                      <select class="form-select form-select-sm" id="cm-model" data-filter="cm">${selectOptions(cls.map((e) => ({ value: e.modelName, label: e.modelName })), state.cmModel)}</select>`,
                    body: html`<div data-cm></div>`,
                  })}
                </div>
                <div class="mt-4">${card({ title: "Classification comparison", subtitle: "Scores on the test set (0–1)", icon: "bar-chart", body: chartCanvas("models-cls-chart", { size: "lg", label: "Classification metrics by model" }) })}</div>
              </section>`
            : ""}
          ${reg.length
            ? html`<section class="pa-section">
                ${card({ title: "Regression models", subtitle: "Lower is better for MAE, MSE and RMSE; higher is better for R²", icon: "trending-up", flush: true, body: html`<div data-table="reg"></div>` })}
                <div class="pa-grid pa-grid--2 mt-4">
                  ${card({ title: "Error comparison", subtitle: "MAE and RMSE in target units", icon: "bar-chart", body: chartCanvas("models-reg-err", { label: "MAE and RMSE by model" }) })}
                  ${card({ title: "Explained variance", subtitle: "R² on the test set", icon: "bar-chart", body: chartCanvas("models-reg-r2", { label: "R squared by model" }) })}
                </div>
              </section>`
            : ""}
          <section class="pa-section">
            ${card({
              title: "Training provenance",
              subtitle: "Dataset and test split behind each result",
              icon: "database",
              flush: true,
              body: html`<div data-table="prov"></div>`,
            })}
          </section>`,
      );

      destroyTables();
      if (cls.length) {
        state.tables.push(
          createDataTable($('[data-table="cls"]', body), {
            rowKey: "modelName",
            rows: cls.map((e) => ({ ...e, ...e.metrics })),
            sortKey: "f1",
            sortDir: "desc",
            caption: "Classification model metrics",
            columns: [
              { key: "modelName", label: "Model", sortable: true, render: modelCell },
              ...CLASSIFICATION_METRICS.map((m) => ({ key: m.key, label: m.label, sortable: true, align: "num", render: (r) => fmtScore(r[m.key]) })),
            ],
          }),
        );
        barChart($("#models-cls-chart", body), {
          labels: CLASSIFICATION_METRICS.map((m) => m.label),
          datasets: cls.map((e, i) => ({ label: e.modelName, data: CLASSIFICATION_METRICS.map((m) => e.metrics?.[m.key] ?? null), color: palette[i % palette.length] })),
          decimals: 3,
          yTitle: "Score",
        });
        renderConfusion();
      }
      if (reg.length) {
        state.tables.push(
          createDataTable($('[data-table="reg"]', body), {
            rowKey: "modelName",
            rows: reg.map((e) => ({ ...e, ...e.metrics })),
            sortKey: "rmse",
            sortDir: "asc",
            caption: "Regression model metrics",
            columns: [
              { key: "modelName", label: "Model", sortable: true, render: modelCell },
              ...REGRESSION_METRICS.map((m) => ({ key: m.key, label: m.label, sortable: true, align: "num", render: (r) => fmtScore(r[m.key]) })),
            ],
          }),
        );
        barChart($("#models-reg-err", body), {
          labels: reg.map((e) => e.modelName),
          datasets: [
            { label: "MAE", data: reg.map((e) => e.metrics?.mae ?? null), color: palette[1] },
            { label: "RMSE", data: reg.map((e) => e.metrics?.rmse ?? null), color: palette[2] },
          ],
          decimals: 2,
        });
        barChart($("#models-reg-r2", body), {
          labels: reg.map((e) => e.modelName),
          datasets: [{ label: "R²", data: reg.map((e) => e.metrics?.r2 ?? null), color: palette[0] }],
          decimals: 3,
          showLegend: false,
        });
      }
      state.tables.push(
        createDataTable($('[data-table="prov"]', body), {
          rowKey: "modelName",
          rows: evaluations,
          sortKey: "trainedAt",
          sortDir: "desc",
          caption: "Training provenance",
          columns: [
            { key: "modelName", label: "Model", sortable: true, render: modelCell },
            { key: "task", label: "Task", sortable: true, render: (r) => html`<span class="pa-badge pa-badge--${r.task === "classification" ? "info" : "warning"}">${titleCase(r.task)}</span>` },
            { key: "dataset", label: "Dataset", sortable: true, render: (r) => html`<span class="pa-mono">${r.dataset || "—"}</span>` },
            { key: "testSize", label: "Test split", sortable: true, align: "num", render: (r) => fmtTestSize(r.testSize) },
            { key: "trainedAt", label: "Trained", sortable: true, render: (r) => formatDateTime(r.trainedAt) },
          ],
        }),
      );
    }

    async function load() {
      destroyTables();
      setHtml(body, loadingState("Loading evaluation results…"));
      try {
        const { data } = await getModelEvaluations();
        if (!ctx.isCurrent()) return;
        state.evaluations = data;
        if (!data.length) {
          setHtml(
            body,
            html`<div class="pa-card">${emptyState({
              icon: "gauge",
              title: "No models evaluated yet",
              message:
                "Evaluation results appear here after models are trained and evaluated on a documented dataset (Stage 10). Nothing is shown until real metrics exist.",
            })}</div>`,
          );
          return;
        }
        renderPopulated(data);
      } catch (error) {
        if (!ctx.isCurrent()) return;
        setHtml(
          body,
          html`<div class="pa-card">
            ${errorState(error, { title: error?.isNetworkError ? "Evaluation results unavailable" : undefined })}
            <div class="pa-models-note">
              ${icon("info", { size: 14 })}
              <span>Model evaluations are produced in Stage 10, when models are trained and tested on a documented dataset. No placeholder metrics are displayed.</span>
            </div>
          </div>`,
        );
      }
    }

    const offs = [
      on(root, "click", '[data-action="refresh"], [data-action="retry"]', () => load()),
      on(root, "change", "[data-filter=cm]", (e) => {
        state.cmModel = e.target.value;
        renderConfusion();
      }),
    ];
    ctx.onCleanup(() => {
      offs.forEach((off) => off());
      destroyTables();
    });

    await load();
  },
};
