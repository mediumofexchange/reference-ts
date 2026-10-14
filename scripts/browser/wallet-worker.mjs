// The wallet check's command worker (check.mjs --wallet, slice 41): the library's command worker (src/browser/command.ts)
// behind a route for loopback sources. The page and its worker are served from the check's own origin; the synthetic
// node and the operator's service listen on loopback ports of their own, which a page's `fetch` reaches only where they
// allow its origin to read them. A wrapped app's native transport reaches any host as a process does; this stands in
// for it: a request to another loopback port goes through the check's server (`/via/<port>/...`), which forwards it
// unchanged to that port alone, and every other request goes as the library makes it.
import "../../src/browser/command.ts";

// Installed before any request: the library looks `fetch` up when it calls it.
const own = new URL(self.location.href), fetched = globalThis.fetch.bind(globalThis);
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol === "http:" && url.hostname === "127.0.0.1" && url.port !== own.port) {
    return fetched(`${own.origin}/via/${url.port}${url.pathname}${url.search}`, init);
  }
  return fetched(input, init);
};
