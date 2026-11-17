import { icon } from "../components/icons.js";
import { emptyState } from "../components/states.js";
import { html, setHtml } from "../utils/dom.js";

export default {
  title: "Page not found",
  breadcrumb: [{ label: "Page not found" }],
  render(root) {
    setHtml(
      root,
      html`<div class="pa-card">${emptyState({
        icon: "search",
        title: "Page not found",
        message: "The page you are looking for does not exist or has moved.",
        action: html`<a class="btn btn-primary btn-sm" href="#/dashboard">${icon("arrow-left", { size: 14 })}Back to dashboard</a>`,
      })}</div>`,
    );
  },
};
