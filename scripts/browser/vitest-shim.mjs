// The part of vitest the in-browser suites use (slice 39, scripts/browser/check.mjs): describe, it and test with
// skipIf, runIf, skip and each, the four hooks, vitest's own `expect` (@vitest/expect over chai, as vitest builds it)
// and its spies (@vitest/spy); a module reset has no meaning in a bundle and is refused.
// The suites import "vitest"; the browser build resolves it here. Tests run in order, one at a time, each awaited.
import * as chai from "chai";
import { JestAsymmetricMatchers, JestChaiExpect, JestExtend } from "@vitest/expect";
import { fn, spyOn } from "@vitest/spy";

chai.use(JestExtend);
chai.use(JestChaiExpect);
chai.use(JestAsymmetricMatchers);

/** The running test, as vitest's `expect` records it: an unawaited `.rejects` or `.resolves` lands in its promises,
 * which the runner awaits when the test ends, as vitest does. */
let running;
export const expect = (value, message) => {
  const assertion = chai.expect(value, message);
  if (running !== undefined) chai.util.flag(assertion, "vitest-test", running);
  return assertion;
};
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
/** `each(rows)(name, body)`: one test a row, its arguments the row's (an array) or the row itself, named by printf-style %s, %i and %d. */
const each = register => rows => (name, body) => {
  for (const row of rows) {
    const args = Array.isArray(row) ? row : [row];
    let at = 0;
    register(name.replace(/%[sidfjo]/g, () => String(args[at++])), () => body(...args));
  }
};
const conditional = make => Object.assign(make(false), {
  skip: make(true),
  skipIf: condition => make(Boolean(condition)),
  runIf: condition => make(!condition),
  each: each(make(false)),
});
export const describe = conditional(skip => (name, body) => suite(name, body, skip));
export const it = conditional(skip => (name, body) => test(name, body, skip));
export { it as test };
export const vi = { fn, spyOn, resetModules() { throw new Error("a browser bundle has no module registry to reset"); } };
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
      running = { name, promises: [], onFinished: [] };
      try {
        for (const s of chain(suite)) for (const hook of s.hooks.beforeEach) await hook();
        await t.body?.();
        // Assertions left unawaited settle before the test ends, as under vitest.
        while (running.promises.length > 0) await Promise.all([...running.promises]);
      } catch (caught) { error = caught; } finally { running = undefined; }
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
