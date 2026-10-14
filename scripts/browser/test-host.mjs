// The test files' Node globals in a browser engine (slice 40): the in-browser file suites (files.mjs) import the
// library's Node suites unchanged, which read `process.versions` and `process.env` at their top level. Imported
// first, before any suite. Not part of the library's bundle (holder.ts).
globalThis.process ??= { env: {}, versions: { node: "24.21.0" }, platform: "browser", pid: 0, execPath: "" };
