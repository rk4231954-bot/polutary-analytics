/**
 * Sign-in page. Authenticates against the real Flask API (POST /auth/login).
 * No credentials are stored client-side; the server sets a session cookie.
 */
import { config } from "../config.js";
import { icon } from "../components/icons.js";
import { openFormModal, setButtonLoading } from "../components/modal.js";
import { bindPasswordToggles, passwordField } from "../components/passwordField.js";
import { callout } from "../components/ui.js";
import { login } from "../services/auth.js";
import { clearPreviewOptOut, enterPreview, setUser } from "../services/session.js";
import { $, html, on, setHtml } from "../utils/dom.js";
import { liveValidate, rules, validateForm } from "../utils/validation.js";

/** Only allow in-app relative paths as post-login redirect targets. */
export function safeNext(next) {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard";
}

const FIELD_RULES = {
  email: [rules.required("Email"), rules.email()],
  password: [rules.required("Password")],
};

function errorMessage(error) {
  if (error?.isNetworkError || error?.code === "BAD_RESPONSE")
    return "The authentication service is unreachable. Make sure the Flask API is running, then try again.";
  if (error?.status === 401 || error?.status === 400) return "Incorrect email or password.";
  if (error?.status === 423 || error?.status === 429)
    return error.message || "Too many attempts. Please wait before trying again.";
  if (error?.status === 404) return "Sign-in is not available yet: the authentication API has not been implemented.";
  return "Sign-in failed. Please try again.";
}

export default {
  title: "Sign in",
  render(root, ctx) {
    const registered = ctx.query.registered === "1";
    setHtml(
      root,
      html`<h1 class="pa-auth__title">Sign in</h1>
        <p class="pa-auth__subtitle">Welcome back. Sign in to manage your farms and analytics.</p>
        ${registered
          ? html`<div class="mb-4">${callout({ tone: "success", title: "Account created", message: "You can now sign in with your new credentials." })}</div>`
          : ""}
        <div data-form-error></div>
        <form novalidate data-login-form>
          <div class="pa-field mb-3">
            <label class="form-label" for="login-email">Email</label>
            <input class="form-control" type="email" id="login-email" name="email" autocomplete="email" inputmode="email" placeholder="you@farm.org" />
          </div>
          ${passwordField({
            name: "password",
            label: "Password",
            autocomplete: "current-password",
            id: "login-password",
            hint: html`<button type="button" class="btn btn-link p-0 pa-text-sm" data-action="forgot">Forgot password?</button>`,
          })}
          <div class="form-check mb-4">
            <input class="form-check-input" type="checkbox" id="login-remember" name="remember" />
            <label class="form-check-label pa-text-sm" for="login-remember">Keep me signed in on this device</label>
          </div>
          <button type="submit" class="btn btn-primary">Sign in</button>
        </form>
        ${config.demoMode
          ? html`<div class="pa-auth__divider"><span>or</span></div>
              <button type="button" class="btn btn-secondary w-100" data-action="preview">${icon("eye", { size: 16 })}Continue in preview mode</button>
              <p class="pa-text-xs pa-text-2 mt-2 mb-0 text-center">Browse the interface with illustrative sample data. No account is used and nothing can be saved.</p>`
          : ""}
        <p class="pa-auth__alt">New to ${config.appName}? <a href="#/register">Create an account</a></p>`,
    );

    const form = $("[data-login-form]", root);
    const errorBox = $("[data-form-error]", root);
    liveValidate(form, FIELD_RULES);

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setHtml(errorBox, "");
      const { valid, values } = validateForm(form, FIELD_RULES);
      if (!valid) return;
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true, "Signing in…");
      try {
        const response = await login({ email: values.email, password: values.password, remember: Boolean(values.remember) });
        clearPreviewOptOut();
        setUser(response.user);
        ctx.navigate(safeNext(ctx.query.next));
      } catch (error) {
        if (!ctx.isCurrent()) return;
        setHtml(errorBox, html`<div class="mb-3">${callout({ tone: "danger", title: "Unable to sign in", message: errorMessage(error) })}</div>`);
        form.elements.namedItem("password").value = "";
      } finally {
        if (button.isConnected) setButtonLoading(button, false);
      }
    });

    const offs = [
      bindPasswordToggles(root),
      on(root, "click", '[data-action="forgot"]', () =>
        openFormModal({
          title: "Reset your password",
          size: "sm",
          cancelLabel: "Close",
          body: html`<p class="pa-text-2 mb-3">
              Password resets are handled by your system administrator. Contact an administrator and ask them to reset your
              access; they can do this from <strong>Users &amp; Roles</strong>.
            </p>
            <p class="pa-text-2 pa-text-sm mb-0">For security, this application does not send reset links by email.</p>`,
        }),
      ),
      on(root, "click", '[data-action="preview"]', () => {
        enterPreview();
        ctx.navigate("/dashboard");
      }),
    ];
    ctx.onCleanup(() => offs.forEach((off) => off()));
  },
};
