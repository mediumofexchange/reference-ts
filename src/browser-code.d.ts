/**
 * The browser bundle's code name (slice 39): SHA-256 over every source file the bundle holds, by path and content,
 * as hex, which scripts/browser/build.mjs defines when it builds the bundle. It is not defined under Node, where
 * `typeof MOE_BROWSER_CODE` is "undefined" and the package's own files name the code (reader.ts `codeName`).
 */
declare const MOE_BROWSER_CODE: string | undefined;
