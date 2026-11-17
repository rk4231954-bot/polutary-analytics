/**
 * Application structure: 7 sidebar sections. Sections with `tabs` render a
 * shared header + tab bar (layouts/sectionHost.js); each tab is a page module
 * with its own URL so links, reloads and the browser back button work.
 * A tab may have `subtabs` (rendered as a secondary pill bar).
 */
export const SECTIONS = [
  {
    id: "dashboard",
    label: "Dashboard",
    icon: "dashboard",
    group: "Overview",
    path: "/dashboard",
  },
  {
    id: "farm-management",
    label: "Farm Management",
    icon: "warehouse",
    group: "Operations",
    subtitle: "Farms, poultry batches and bird population.",
    tabs: [
      { id: "farms", label: "Farms", icon: "warehouse", path: "/farms" },
      { id: "batches", label: "Poultry Batches", icon: "bird", path: "/batches" },
    ],
  },
  {
    id: "data-management",
    label: "Data Management",
    icon: "upload-cloud",
    group: "Operations",
    subtitle: "Import, validate and record farm data before it is stored in HDFS.",
    tabs: [
      { id: "upload", label: "CSV Upload & History", icon: "upload-cloud", path: "/datasets/upload" },
      { id: "manual", label: "Manual Entry", icon: "clipboard", path: "/data-collection" },
    ],
  },
  {
    id: "big-data",
    label: "Big Data Analytics",
    icon: "database",
    group: "Insights",
    subtitle: "Hadoop HDFS storage, Apache Hive tables, HiveQL queries and historical analytics.",
    tabs: [
      { id: "cluster", label: "Hadoop & Hive", icon: "server", path: "/big-data" },
      {
        id: "history",
        label: "Historical Analytics",
        icon: "line-chart",
        path: "/analytics/environment",
        subtabs: [
          { id: "environment", label: "Environment", icon: "thermometer", path: "/analytics/environment" },
          { id: "feed", label: "Feed", icon: "wheat", path: "/analytics/feed" },
          { id: "growth", label: "Growth", icon: "trending-up", path: "/analytics/growth" },
          { id: "mortality", label: "Mortality", icon: "heart-pulse", path: "/analytics/mortality" },
        ],
      },
    ],
  },
  {
    id: "predictive",
    label: "Predictive Analytics",
    icon: "brain",
    group: "Insights",
    subtitle: "Machine learning estimates for decision support, with transparent model evaluation.",
    tabs: [
      { id: "predictions", label: "Predictions", icon: "brain", path: "/predictions" },
      { id: "evaluation", label: "Model Evaluation", icon: "gauge", path: "/models" },
    ],
  },
  {
    id: "reports",
    label: "Reports",
    icon: "file-text",
    group: "Insights",
    path: "/reports",
  },
  {
    id: "admin",
    label: "Administration & Security",
    icon: "shield",
    group: "System",
    subtitle: "Users, roles, permissions, audit trail and application settings.",
    tabs: [
      { id: "users", label: "Users & Roles", icon: "users", path: "/users" },
      { id: "audit", label: "Audit Logs", icon: "scroll", path: "/audit-logs" },
      { id: "settings", label: "Settings", icon: "settings", path: "/settings" },
    ],
  },
];

// Sections without tabs link to their own path; others to their first tab.
for (const section of SECTIONS) {
  if (!section.path) section.path = section.tabs[0].path;
}

/** Sidebar groups, derived from SECTIONS (order preserved). */
export const NAV_GROUPS = SECTIONS.reduce((groups, section) => {
  let group = groups.find((g) => g.label === section.group);
  if (!group) groups.push((group = { label: section.group, items: [] }));
  group.items.push(section);
  return groups;
}, []);

export function getSection(id) {
  return SECTIONS.find((s) => s.id === id);
}

export function getTab(section, tabId) {
  return section?.tabs?.find((t) => t.id === tabId);
}

/** Flat list of every destination (sections, tabs, sub-tabs) for the search palette. */
export const SEARCH_ENTRIES = SECTIONS.flatMap((s) => [
  { label: s.label, icon: s.icon, path: s.path, group: "Sections" },
  ...(s.tabs || []).flatMap((t) => [
    { label: `${s.label} › ${t.label}`, icon: t.icon, path: t.path, group: "Pages" },
    ...(t.subtabs || []).map((st) => ({ label: `${t.label} › ${st.label}`, icon: st.icon, path: st.path, group: "Pages" })),
  ]),
]);

/** Breadcrumb for a location: [section, tab?, subtab?]. */
export function breadcrumbFor(sectionId, tabId, subtabId) {
  const section = getSection(sectionId);
  if (!section) return [];
  const crumbs = [{ label: section.label, path: section.path }];
  const tab = getTab(section, tabId);
  if (tab) crumbs.push({ label: tab.label, path: tab.path });
  const sub = tab?.subtabs?.find((s) => s.id === subtabId);
  if (sub) crumbs.push({ label: sub.label, path: sub.path });
  return crumbs;
}
