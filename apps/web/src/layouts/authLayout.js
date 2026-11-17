/** Split-screen layout for sign-in and registration. */
import { config } from "../config.js";
import { icon } from "../components/icons.js";
import { html, setHtml } from "../utils/dom.js";
import "../styles/auth.css";

const FEATURES = [
  { icon: "hard-drive", title: "Distributed storage", text: "Validated farm datasets are stored in Hadoop HDFS." },
  { icon: "database", title: "HiveQL analytics", text: "Environmental, feed, growth and mortality analysis runs on Apache Hive." },
  { icon: "brain", title: "Predictive insights", text: "Machine learning models estimate risk and forecast growth, for decision support only." },
];

export function mountAuthLayout(container) {
  setHtml(
    container,
    html`<div class="pa-auth">
      <aside class="pa-auth__brand" aria-label="About ${config.appName}">
        <div class="pa-auth__logo">
          <span class="pa-brand-mark pa-brand-mark--inverse">${icon("sprout", { size: 20, strokeWidth: 2 })}</span>
          <div>
            <div class="pa-auth__name">${config.appName}</div>
            <div class="pa-auth__tagline">${config.appTagline}</div>
          </div>
        </div>
        <div class="pa-auth__pitch">
          <h2>Data-driven decisions for modern poultry operations.</h2>
          <p>Bring farm records, environmental readings and production data together, analyse them at scale, and act on early signals.</p>
          <ul class="pa-auth__features">
            ${FEATURES.map(
              (f) => html`<li>
                <span class="pa-auth__feature-icon">${icon(f.icon, { size: 18 })}</span>
                <div><div class="pa-auth__feature-title">${f.title}</div><div class="pa-auth__feature-text">${f.text}</div></div>
              </li>`,
            )}
          </ul>
        </div>
        <div class="pa-auth__foot">Apache Hive-Based Predictive Analytics System for Poultry Farming</div>
      </aside>
      <main class="pa-auth__panel">
        <div class="pa-auth__mobile-logo">
          <span class="pa-brand-mark">${icon("sprout", { size: 18, strokeWidth: 2 })}</span>
          <span class="pa-brand-name">${config.appName}</span>
        </div>
        <div class="pa-auth__form-wrap" data-auth-content></div>
      </main>
    </div>`,
  );
}
