// The part of vitest the in-browser suites use (slice 39, scripts/browser/check.mjs): describe, it and test with
// skipIf, runIf and skip, the four hooks, and vitest's own `expect` (@vitest/expect over chai, as vitest builds it).
// The suites import "vitest"; the browser build resolves it here. Tests run in order, one at a time, each awaited.
import * as chai from "chai";
import { JestAsymmetricMatchers, JestChaiExpect, JestExtend } from "@vitest/expect";

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(JestAsymmetricMatchers);

export const expect = (value, message) => chai.expect(value, message);
Object.assign(expect, chai.expect);
expect.unreachable = message => chai.assert.fail(`expected${message ? ` "${message}" ` : " "}not to be reached`);

const rootSuite = { name: "", parent: undefined, tests: [], children: [], hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] }, skip: false };
let current = rootSuite;

function suite(name, body, skip = false) {
  const own = { name, parent: current, tests: [], children: [], hooks: { beforeAll: [], afterAll: [], beforeEach: [], afterEach: [] }, skip };
  current.children.push(own);
  const outer = current;
  current = own;
  try { body?.(); } finally { current = outer; }
}
function test(name, body, skip = false) { current.tests.push({ name, body, skip }); }
const conditional = make => Object.assign(make(false), {
  skip: make(true),
  skipIf: condition => make(Boolean(condition)),
  runIf: condition => make(!condition),
});
export const describe = conditional(skip => (name, body) => suite(name, body, skip));
export const it = conditional(skip => (name, body) => test(name, body, skip));
export { it as test };
export const beforeAll = fn => { current.hooks.beforeAll.push(fn); };
export const afterAll = fn => { current.hooks.afterAll.push(fn); };
export const beforeEach = fn => { current.hooks.beforeEach.push(fn); };
export const afterEach = fn => { current.hooks.afterEach.push(fn); };

const chain = suite => suite === undefined ? [] : [...chain(suite.parent), suite];
const fullName = (suite, name) => [...chain(suite).map(s => s.name).filter(Boolean), name].join(" > ");

/** Run every registered suite; `report` receives each result as it ends. */
export async function run(report = () => {}) {
  const results = [];
  const visit = async (suite, skipped) => {
    const skip = skipped || suite.skip;
    if (!skip) for (const hook of suite.hooks.beforeAll) await hook();
    for (const t of suite.tests) {
      const name = fullName(suite, t.name), started = performance.now();
      if (skip || t.skip) { const result = { name, state: "skip" }; results.push(result); report(result); continue; }
      let error;
      try {
        for (const s of chain(suite)) for (const hook of s.hooks.beforeEach) await hook();
        await t.body?.();
      } catch (caught) { error = caught; }
      for (const s of chain(suite).reverse()) for (const hook of s.hooks.afterEach) { try { await hook(); } catch (caught) { error ??= caught; } }
      const result = { name, state: error === undefined ? "pass" : "fail", ms: Math.round(performance.now() - started),
        ...(error === undefined ? {} : { error: String(error?.stack ?? error) }) };
      results.push(result);
      report(result);
    }
    for (const child of suite.children) await visit(child, skip);
    if (!skip) for (const hook of suite.hooks.afterAll) await hook();
  };
  await visit(rootSuite, false);
  return results;
}
