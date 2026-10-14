import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// The browser host's equivalence run (slice 39): the library's suites over the modules the browser bundle substitutes
// for node:sqlite and node:crypto (src/browser/), in Node, so one store, reader and capsule implementation is held to
// one behaviour on both hosts. The test files themselves are the Node suites, unchanged; a test that keeps a database
// file skips here (`BROWSER_HOST` in test/support.ts), since the browser host keeps none and refuses one by name
// (test/browser-host.test.ts). scripts/browser/check.mjs runs the file-free suites in a browser engine itself.
const own = (path: string): string => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  ...base,
  resolve: {
    alias: [
      { find: /^node:sqlite$/, replacement: own("./src/browser/node-sqlite.ts") },
      { find: /^node:crypto$/, replacement: own("./src/browser/node-crypto.ts") },
    ],
  },
  test: {
    ...base.test,
    env: { MOE_TEST_HOST: "browser" },
    // Every suite that reaches node:sqlite or node:crypto through the library and keeps no database file of its own;
    // the journal, wallet, backer and replica suites keep theirs.
    include: [
      "test/browser-host.test.ts",
      "test/pool-v3-replay-store.test.ts",
      "test/pool-v3-evidence-store.test.ts",
      "test/pool-v3-state.test.ts",
      "test/pool-v3-scope-reader.test.ts",
      "test/pool-v3-succinct.test.ts",
      "test/pool-v3-capsules.test.ts",
      "test/pool-v3-commitments.test.ts",
      "test/pool-v3-fault-evidence.test.ts",
      "test/pool-v3-force.test.ts",
      "test/pool-v3-headers.test.ts",
      "test/pool-v3-import-work.test.ts",
      "test/pool-v3-package.test.ts",
      "test/pool-v3-records.test.ts",
      "test/pool-v3-recovery-witness.test.ts",
      "test/pool-v3-request.test.ts",
      "test/pool-v3-service-client.test.ts",
      "test/pool-v3-service-wire.test.ts",
      "test/pool-v3-spent-set.test.ts",
      "test/pool-v3-trail.test.ts",
      "test/pool-v3-verify-ahead.test.ts",
      "test/lit-fault-evidence.test.ts",
      "test/lit-records.test.ts",
      "test/lit-state.test.ts",
      "test/lit-transport.test.ts",
      "test/lit-wallet-keys.test.ts",
      "test/neutral-core.test.ts",
      "test/ergo-publisher.test.ts",
      "test/ergo-supplier.test.ts",
      "test/record-range.test.ts",
      "test/venue-records.test.ts",
    ],
    // The substitutes must be the ones transformed, not node's own modules.
    server: { deps: { inline: [/src[\\/]browser/] } },
  },
});
