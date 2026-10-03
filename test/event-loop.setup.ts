import { beforeEach } from "vitest";

// A vitest worker reports each test to the main process over RPC and treats a
// reply not handled within 60s as an unhandled error, which fails the run
// though every test passed. Much of this suite is synchronous — node:sqlite,
// Ed25519, hashing — and awaits only settled promises, so a whole file can run
// without the worker's event loop taking a turn: the pool-v3 kept-state file
// held it for 18 of its 20s locally, and took 73s on a loaded Windows runner.
//
// One macrotask before each test lets the worker read the replies waiting for
// it, so the window that must stay under 60s is one test, not one file.
beforeEach(() => new Promise<void>((resolve) => setImmediate(resolve)));
