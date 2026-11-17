/** Account registration. Creates the account through the real API (POST /auth/register). */
import { config } from "../config.js";
import { setButtonLoading } from "../components/modal.js";
import { bindPasswordChecklist, bindPasswordToggles, passwordChecklist, passwordField } from "../components/passwordField.js";
import { toast } from "../components/toast.js";
import { callout } from "../components/ui.js";
import { register } from "../services/auth.js";
import { $, html, setHtml } from "../utils/dom.js";
import { applyServerErrors, liveValidate, rules, validateForm } from "../utils/validation.js";

const FIELD_RULES = {
  fullName: [rules.required("Full name"), rules.minLength(2, "Full name"), rules.maxLength(120, "Full name")],
  email: [rules.required("Email"), rules.email()],
  password: [rules.required("Password"), rules.password()],
  confirmPassword: [rules.required("Password confirmation"), rules.matches("password", "Passwords do not match.")],
};

function errorMessage(error) {
  if (error?.isNetworkError || error?.code === "BAD_RESPONSE")
    return "The registration service is unreachable. Make sure the Flask API is running, then try again.";
  if (error?.status === 404) return "Registration is not available yet: the authentication API has not been implemented.";
  if (error?.status === 409) return "An account with this email may already exist. Try signing in instead.";
  return error?.message || "Registration failed. Please try again.";
}

export default {
  title: "Create account",
  render(root, ctx) {
    setHtml(
      root,
      html`<h1 class="pa-auth__title">Create your account</h1>
        <p class="pa-auth__subtitle">An administrator assigns your role and farms after registration.</p>
        <div data-form-error></div>
        <form novalidate data-register-form>
          <div class="pa-field mb-3">
            <label class="form-label" for="reg-name">Full name</label>
            <input class="form-control" type="text" id="reg-name" name="fullName" autocomplete="name" maxlength="120" />
          </div>
          <div class="pa-field mb-3">
            <label class="form-label" for="reg-email">Email</label>
            <input class="form-control" type="email" id="reg-email" name="email" autocomplete="email" inputmode="email" placeholder="you@farm.org" />
          </div>
          ${passwordField({ name: "password", label: "Password", autocomplete: "new-password", id: "reg-password" })}
          ${passwordChecklist("reg-pw-reqs")}
          ${passwordField({ name: "confirmPassword", label: "Confirm password", autocomplete: "new-password", id: "reg-confirm" })}
          <button type="submit" class="btn btn-primary mt-2">Create account</button>
        </form>
        <p class="pa-auth__alt">Already have an account? <a href="#/login">Sign in</a></p>`,
    );

    const form = $("[data-register-form]", root);
    const errorBox = $("[data-form-error]", root);
    liveValidate(form, FIELD_RULES);
    const offs = [
      bindPasswordToggles(root),
      bindPasswordChecklist(form.elements.namedItem("password"), $("#reg-pw-reqs", root)),
    ];
    ctx.onCleanup(() => offs.forEach((off) => off()));

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      setHtml(errorBox, "");
      const { valid, values } = validateForm(form, FIELD_RULES);
      if (!valid) return;
      const button = form.querySelector('button[type="submit"]');
      setButtonLoading(button, true, "Creating account…");
      try {
        await register({ fullName: values.fullName, email: values.email, password: values.password });
        toast.success("Account created", `Welcome to ${config.appName}. Please sign in.`);
        ctx.navigate("/login?registered=1");
      } catch (error) {
        if (!ctx.isCurrent()) return;
        if (error?.fields && Object.keys(error.fields).length) applyServerErrors(form, error.fields);
        setHtml(errorBox, html`<div class="mb-3">${callout({ tone: "danger", title: "Unable to create account", message: errorMessage(error) })}</div>`);
      } finally {
        if (button.isConnected) setButtonLoading(button, false);
      }
    });
  },
};
