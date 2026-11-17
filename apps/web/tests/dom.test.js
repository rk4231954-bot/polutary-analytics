import { describe, expect, test } from "bun:test";
import { escapeHtml, html, raw } from "../src/utils/dom.js";

describe("escapeHtml", () => {
  test("escapes markup-significant characters", () => {
    expect(escapeHtml(`<img src=x onerror="alert('x')">&\``)).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;&#96;",
    );
  });
  test("renders null and undefined as empty strings", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("html tagged template", () => {
  test("escapes interpolated values", () => {
    const name = "<script>alert(1)</script>";
    expect(String(html`<td>${name}</td>`)).toBe("<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>");
  });
  test("does not double-escape nested templates or raw markup", () => {
    const inner = html`<b>${"a&b"}</b>`;
    expect(String(html`<p>${inner}${raw("<i>ok</i>")}</p>`)).toBe("<p><b>a&amp;b</b><i>ok</i></p>");
  });
  test("joins arrays and drops false/null", () => {
    expect(String(html`<ul>${["<x>", "y"].map((v) => html`<li>${v}</li>`)}${false}${null}</ul>`)).toBe(
      "<ul><li>&lt;x&gt;</li><li>y</li></ul>",
    );
  });
});
