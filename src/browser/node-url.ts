// node:url's `fileURLToPath` in a browser engine (slice 39), for the browser bundle: a module there lives at an
// http(s) URL, never a file, so a file URL is the only one it reads and any other is refused as Node refuses it.
export function fileURLToPath(url: string | URL): string {
  const own = typeof url === "string" ? new URL(url) : url;
  if (own.protocol !== "file:") throw Object.assign(new TypeError("The URL must be of scheme file"), { code: "ERR_INVALID_URL_SCHEME" });
  return decodeURIComponent(own.pathname);
}

export default { fileURLToPath };
