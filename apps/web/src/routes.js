/**
 * Route table. Pages are loaded lazily (one chunk per page).
 * layout: "app" (sidebar shell, requires session) | "auth" (public split-screen).
 * section/tab/subtab place the page inside the 7-section navigation (see navigation.js).
 * Detail routes (e.g. /farms/:id) keep their parent tab highlighted.
 */
export const ROUTES = [
  // Authentication (separate screens)
  { path: "/login", layout: "auth", public: true, load: () => import("./pages/login.js") },
  { path: "/register", layout: "auth", public: true, load: () => import("./pages/register.js") },

  // 1. Dashboard
  { path: "/dashboard", section: "dashboard", load: () => import("./pages/dashboard.js") },

  // 2. Farm Management
  { path: "/farms", section: "farm-management", tab: "farms", load: () => import("./pages/farms.js") },
  { path: "/farms/:id", section: "farm-management", tab: "farms", detail: true, load: () => import("./pages/farmDetail.js") },
  { path: "/batches", section: "farm-management", tab: "batches", load: () => import("./pages/batches.js") },
  { path: "/batches/:id", section: "farm-management", tab: "batches", detail: true, load: () => import("./pages/batchDetail.js") },

  // 3. Data Management
  { path: "/datasets/upload", section: "data-management", tab: "upload", load: () => import("./pages/datasetUpload.js") },
  { path: "/data-collection", section: "data-management", tab: "manual", load: () => import("./pages/dataCollection.js") },

  // 4. Big Data Analytics
  { path: "/big-data", section: "big-data", tab: "cluster", load: () => import("./pages/bigData.js") },
  { path: "/analytics/environment", section: "big-data", tab: "history", subtab: "environment", load: () => import("./pages/analyticsEnvironment.js") },
  { path: "/analytics/feed", section: "big-data", tab: "history", subtab: "feed", load: () => import("./pages/analyticsFeed.js") },
  { path: "/analytics/growth", section: "big-data", tab: "history", subtab: "growth", load: () => import("./pages/analyticsGrowth.js") },
  { path: "/analytics/mortality", section: "big-data", tab: "history", subtab: "mortality", load: () => import("./pages/analyticsMortality.js") },

  // 5. Predictive Analytics
  { path: "/predictions", section: "predictive", tab: "predictions", load: () => import("./pages/predictions.js") },
  { path: "/models", section: "predictive", tab: "evaluation", load: () => import("./pages/modelPerformance.js") },

  // 6. Reports
  { path: "/reports", section: "reports", load: () => import("./pages/reports.js") },

  // 7. Administration & Security
  { path: "/users", section: "admin", tab: "users", load: () => import("./pages/users.js") },
  { path: "/audit-logs", section: "admin", tab: "audit", load: () => import("./pages/auditLogs.js") },
  { path: "/settings", section: "admin", tab: "settings", load: () => import("./pages/settings.js") },

  // Short aliases for section roots
  { path: "/farm-management", redirect: "/farms" },
  { path: "/data-management", redirect: "/datasets/upload" },
  { path: "/analytics", redirect: "/analytics/environment" },
  { path: "/predictive-analytics", redirect: "/predictions" },
  { path: "/admin", redirect: "/users" },
];

export const NOT_FOUND = { path: "*", load: () => import("./pages/notFound.js") };
export const DEFAULT_PATH = "/dashboard";
