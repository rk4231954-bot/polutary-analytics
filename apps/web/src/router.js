/**
 * Hash router (#/path?query). Hash routing keeps the frontend deployable as
 * static files, independent of the Flask backend.
 *
 * Page module contract (default export):
 *   {
 *     title: string,                       // shown in the top bar and document title
 *     breadcrumb?: Array<{label, path?}>,  // defaults to [nav group, nav item]
 *     render(root: HTMLElement, ctx): void | Promise<void>
 *   }
 * ctx: {
 *   params, query, user,
 *   navigate(path), setTitle(title, breadcrumb?),
 *   onCleanup(fn)   — runs when the user leaves the page,
 *   isCurrent()     — false once the user has navigated away (ignore stale async results)
 * }
 */
import { destroyCharts } from "./charts/index.js";
import { errorState, loadingState } from "./components/states.js";
import { mountAuthLayout } from "./layouts/authLayout.js";
import { appShell, mountAppShell } from "./layouts/appShell.js";
import { renderSectionHost } from "./layouts/sectionHost.js";
import { breadcrumbFor, getSection, getTab } from "./navigation.js";
import { DEFAULT_PATH, NOT_FOUND, ROUTES } from "./routes.js";
import { resolveSession } from "./services/session.js";
import { config } from "./config.js";
import { setHtml } from "./utils/dom.js";

let cleanups = [];
let navToken = 0;
let currentLayout = null;

function compile(path) {
  const keys = [];
  const pattern = path.replace(/:([a-zA-Z]+)/g, (_m, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { regex: new RegExp(`^${pattern}/?$`), keys };
}
const compiled = ROUTES.map((r) => ({ ...r, ...compile(r.path) }));

export function parseHash(hash = window.location.hash) {
  const value = hash.replace(/^#/, "") || DEFAULT_PATH;
  const [path, qs = ""] = value.split("?");
  return { path: path || DEFAULT_PATH, query: Object.fromEntries(new URLSearchParams(qs)) };
}

function match(path) {
  for (const route of compiled) {
    const m = path.match(route.regex);
    if (m) {
      const params = {};
      route.keys.forEach((k, i) => {
        params[k] = decodeURIComponent(m[i + 1]);
      });
      return { route, params };
    }
  }
  return { route: { ...NOT_FOUND, layout: "app" }, params: {} };
}

export function navigate(path, { replace = false } = {}) {
  const target = `#${path}`;
  if (replace) {
    window.history.replaceState(null, "", target);
    handleRoute();
  } else if (window.location.hash === target) {
    handleRoute();
  } else {
    window.location.hash = path;
  }
}

function runCleanups(root) {
  cleanups.forEach((fn) => {
    try {
      fn();
    } catch (error) {
      console.error(error);
    }
  });
  cleanups = [];
  destroyCharts(root);
}

async function handleRoute() {
  const token = ++navToken;
  const { path, query } = parseHash();
  if (path === "/" || path === "") return navigate(DEFAULT_PATH, { replace: true });
  const { route, params } = match(path);
  if (route.redirect) return navigate(route.redirect, { replace: true });
  const layout = route.layout || "app";

  let user = null;
  if (!route.public) {
    user = await resolveSession();
    if (token !== navToken) return;
    if (!user) {
      const next = encodeURIComponent(window.location.hash.slice(1) || DEFAULT_PATH);
      return navigate(`/login?next=${next}`, { replace: true });
    }
  }

  // Mount (or switch) the layout.
  const appRoot = document.getElementById("app");
  const previousContent = currentLayout === "app" ? appShell.content() : appRoot;
  runCleanups(previousContent);
  if (currentLayout !== layout) {
    setHtml(appRoot, "");
    if (layout === "app") mountAppShell(appRoot, { navigate });
    else mountAuthLayout(appRoot);
    currentLayout = layout;
  }
  const root = layout === "app" ? appShell.content() : appRoot.querySelector("[data-auth-content]");
  if (layout === "app") {
    appShell.setActive(route.section);
    appShell.closeMobileNav();
  }

  setHtml(root, loadingState("Loading page…"));
  let page;
  try {
    page = (await route.load()).default;
  } catch (error) {
    if (token !== navToken) return;
    console.error(error);
    setHtml(root, errorState({ message: "This page failed to load. Check the browser console for details." }, { retry: false }));
    return;
  }
  if (token !== navToken) return;

  // Pages inside a tabbed section render into the section host's panel.
  const section = getSection(route.section);
  const tab = getTab(section, route.tab);
  const subtab = tab?.subtabs?.find((st) => st.id === route.subtab);
  const sectionCrumbs = breadcrumbFor(route.section, route.tab, route.subtab);
  const topTitle = section?.tabs ? section.label : page.title || config.appName;
  const docTitle = subtab?.label || tab?.label || page.title || config.appName;

  const setTitle = (title, breadcrumb) => {
    document.title = `${title} · ${config.appName}`;
    if (layout !== "app") return;
    // Detail pages pass their own title (e.g. a farm name); keep the section context in the crumbs.
    const crumbs = breadcrumb || sectionCrumbs;
    appShell.setPageMeta(section?.tabs && !breadcrumb ? topTitle : title, crumbs);
  };
  setTitle(docTitle, page.breadcrumb);

  const ctx = {
    params,
    query,
    user,
    navigate,
    setTitle,
    onCleanup: (fn) => cleanups.push(fn),
    isCurrent: () => token === navToken,
  };

  root.scrollTop = 0;
  window.scrollTo({ top: 0 });
  try {
    setHtml(root, "");
    let target = root;
    if (section?.tabs) {
      target = renderSectionHost(root, { section, tabId: route.tab, subtabId: route.subtab });
      if (route.detail) target.classList.add("pa-panel--detail");
    }
    await page.render(target, ctx);
  } catch (error) {
    if (token !== navToken) return;
    console.error(error);
    setHtml(root, errorState(error, { retry: false }));
  }
}

export function startRouter() {
  window.addEventListener("hashchange", handleRoute);
  handleRoute();
}
