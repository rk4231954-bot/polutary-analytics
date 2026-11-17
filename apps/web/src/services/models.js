/**
 * Model evaluation results. ALWAYS from the real API — never sample data,
 * not even in preview mode, because evaluation metrics must be measured.
 *
 * GET /models/evaluations → { evaluations: [{
 *   modelName, algorithm, task: "classification"|"regression", target, dataset, trainedAt, testSize,
 *   metrics: { accuracy, precision, recall, f1, rocAuc } | { mae, mse, rmse, r2 },
 *   confusionMatrix?: { labels: string[], matrix: number[][] }   // rows = actual, columns = predicted
 * }] }
 */
import { api } from "./apiClient.js";
import { apiOnly } from "./dataSource.js";

export const getModelEvaluations = () => apiOnly(async () => (await api.get("/models/evaluations")).evaluations || []);
