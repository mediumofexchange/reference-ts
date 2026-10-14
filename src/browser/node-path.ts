// node:path's POSIX functions the library uses, in a browser engine (slice 39), for the browser bundle
// (scripts/browser/build.mjs substitutes this module for node:path). The browser host keeps no files, so these only
// compose names; a name is never opened (node-fs.ts).
export const sep = "/";

function normalized(path: string): string {
  const absolute = path.startsWith("/"), parts: string[] = [];
  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") { if (parts.length > 0 && parts[parts.length - 1] !== "..") parts.pop(); else if (!absolute) parts.push(".."); }
    else parts.push(part);
  }
  const joined = parts.join("/") + (parts.length > 0 && path.endsWith("/") ? "/" : "");
  return absolute ? `/${joined}` : joined === "" ? "." : joined;
}

export const isAbsolute = (path: string): boolean => path.startsWith("/");
export const join = (...paths: string[]): string => normalized(paths.filter(path => path !== "").join("/") || ".");
export function resolve(...paths: string[]): string {
  let resolved = "";
  for (let i = paths.length - 1; i >= 0 && !resolved.startsWith("/"); i--) if (paths[i] !== "") resolved = resolved === "" ? paths[i]! : `${paths[i]}/${resolved}`;
  return normalized(resolved.startsWith("/") ? resolved : `/${resolved}`);
}
export function dirname(path: string): string {
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path, at = trimmed.lastIndexOf("/");
  return at < 0 ? "." : at === 0 ? "/" : trimmed.slice(0, at);
}
export function basename(path: string, suffix?: string): string {
  const name = path.replace(/\/+$/, "").split("/").pop() ?? "";
  return suffix !== undefined && name.endsWith(suffix) && name !== suffix ? name.slice(0, -suffix.length) : name;
}
export function relative(from: string, to: string): string {
  const a = resolve(from).split("/").filter(Boolean), b = resolve(to).split("/").filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return [...a.slice(i).map(() => ".."), ...b.slice(i)].join("/");
}

export default { sep, isAbsolute, join, resolve, dirname, basename, relative };
