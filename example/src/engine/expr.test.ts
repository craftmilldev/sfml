import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExpression, renderTemplate, walkReferences, ExpressionError } from "./expr.js";

test("field access and indexing", () => {
  const env = { results: { plan: [{ title: "a" }, { title: "b" }] } };
  assert.equal(evaluateExpression("results.plan[1].title", env), "b");
});

test("§7.3: field access on null yields null, and last() over an empty list yields null", () => {
  const env = { results: { work: [] as never[] } };
  assert.equal(evaluateExpression("last(results.work)", env), null);
  assert.equal(evaluateExpression("last(results.work).some_field", env), null);
});

test("empty() and notEmpty()", () => {
  assert.equal(evaluateExpression("empty(x)", { x: [] }), true);
  assert.equal(evaluateExpression("empty(x)", { x: null }), true);
  assert.equal(evaluateExpression("empty(x)", { x: "" }), true);
  assert.equal(evaluateExpression("empty(x)", { x: "a" }), false);
  assert.equal(evaluateExpression("notEmpty(x)", { x: [1] }), true);
});

test("boolean and comparison operators", () => {
  assert.equal(evaluateExpression("a && b", { a: true, b: false }), false);
  assert.equal(evaluateExpression("a || b", { a: false, b: true }), true);
  assert.equal(evaluateExpression("!a", { a: false }), true);
  assert.equal(evaluateExpression("n > 2 && n < 10", { n: 5 }), true);
  assert.equal(evaluateExpression('s == "x"', { s: "x" }), true);
});

test("a malformed expression raises ExpressionError", () => {
  assert.throws(() => evaluateExpression("a &&", {}), ExpressionError);
  assert.throws(() => evaluateExpression("a.b.", {}), ExpressionError);
});

test("evaluating against an unknown identifier raises ExpressionError", () => {
  assert.throws(() => evaluateExpression("unbound", {}), ExpressionError);
});

test("renderTemplate substitutes placeholders and leaves single guillemets alone", () => {
  const out = renderTemplate("Plan «this» issue: ««prompt_vars.issue»» (p««  prompt_vars.priority  »»)", {
    prompt_vars: { issue: "add flag", priority: 2 },
  });
  assert.equal(out, "Plan «this» issue: add flag (p2)");
});

test("renderTemplate inserts non-string values as canonical JSON", () => {
  const out = renderTemplate("data: ««prompt_vars.obj»»", { prompt_vars: { obj: { a: 1 } } });
  assert.equal(out, 'data: {"a":1}');
});

test("renderTemplate: an unterminated «« is a parse failure, not literal text", () => {
  assert.throws(() => renderTemplate("Hello ««prompt_vars.name", { prompt_vars: { name: "x" } }), ExpressionError);
});

test("walkReferences visits each field-selection chain rooted at a top-level identifier", () => {
  const paths: string[][] = [];
  walkReferences("last(results.checks).design.approved && parameters.strict", (p) => paths.push(p));
  assert.deepEqual(paths, [
    ["results", "checks"],
    ["parameters", "strict"],
  ]);
});
