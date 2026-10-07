import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { onionProxy, proxyExempts, V3ServiceClient, V3ServiceClientError, type ServiceIdentity } from "../src/pool/v3/service-client.js";
import { LOCAL_REFERENCE } from "../src/record-venue.js";

// M12a: a holder reaches an onion service only through a loopback HTTP proxy. The check must accept exactly where
// Node's own fetch tunnels: each case runs a fresh Node process with the case's environment, which fetches an onion
// URL and reports its global dispatcher; the case's proxy here records whether a CONNECT for that host arrived.
const ONION = `${"a".repeat(55)}d.onion`, URL80 = new URL(`http://${ONION}/`), TOKEN = "11".repeat(32);
const PROXY_VARIABLES = ["http_proxy", "HTTP_PROXY", "https_proxy", "HTTPS_PROXY", "no_proxy", "NO_PROXY", "NODE_USE_ENV_PROXY", "NODE_OPTIONS"];
const CHILD = `const name = globalThis[Symbol.for("undici.globalDispatcher.1")]?.constructor?.name ?? null;
try { await fetch(process.argv[1], { signal: AbortSignal.timeout(3000) }); } catch {}
process.stdout.write(JSON.stringify({ name }));`;

let proxy: Server, port = 0;
const tunnels: string[] = [];
beforeAll(async () => {
  proxy = createServer((_, response) => response.writeHead(405).end()).on("connect", (request, socket) => {
    tunnels.push(request.url ?? ""); socket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });
  await new Promise<void>(done => proxy.listen(0, "127.0.0.1", done));
  port = (proxy.address() as { port: number }).port;
});
afterAll(() => new Promise<void>(done => proxy.close(() => done())));

/** What a fresh process with `env` does for `url`: its dispatcher's name and whether it tunnelled through this proxy. */
async function observed(env: Record<string, string>, url = URL80): Promise<{ name: string | null; tunnelled: boolean }> {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !PROXY_VARIABLES.includes(key))) as Record<string, string>;
  const before = tunnels.length;
  const out = await new Promise<string>((done, failed) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD, url.href], { env: { ...base, ...env }, stdio: ["ignore", "pipe", "ignore"] });
    let text = ""; child.stdout.on("data", chunk => { text += chunk; }); child.on("error", failed); child.on("close", () => done(text));
  });
  const host = `${url.hostname}:${url.port || "80"}`;
  return { name: (JSON.parse(out) as { name: string | null }).name, tunnelled: tunnels.slice(before).includes(host) };
}
/** `onionProxy` under `env`, with the child's dispatcher installed in name only. */
function judged(env: Record<string, string>, name: string | null, url = URL80): "accepted" | string {
  const key = Symbol.for("undici.globalDispatcher.1"), global = globalThis as Record<symbol, unknown>, held = global[key];
  global[key] = name === null ? undefined : new ({ [name]: class {} }[name]!)();
  try { onionProxy(url, env); return "accepted"; } catch (error) {
    expect(error).toBeInstanceOf(V3ServiceClientError); return (error as V3ServiceClientError).code;
  } finally { global[key] = held; }
}

describe("onion services through the environment proxy (M12a)", () => {
  const P = () => `http://127.0.0.1:${port}`;
  const cases: [string, () => Record<string, string>, boolean][] = [
    ["no proxy at all", () => ({}), false],
    ["the environment proxy and HTTP_PROXY", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P() }), true],
    ["lowercase http_proxy", () => ({ NODE_USE_ENV_PROXY: "1", http_proxy: P() }), true],
    ["credentials for Tor's stream isolation", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: `http://backing-1:x@127.0.0.1:${port}` }), true],
    ["--use-env-proxy through NODE_OPTIONS", () => ({ NODE_OPTIONS: "--use-env-proxy", HTTP_PROXY: P() }), true],
    ["NODE_USE_ENV_PROXY=true is not on", () => ({ NODE_USE_ENV_PROXY: "true", HTTP_PROXY: P() }), false],
    ["--no-use-env-proxy overrides NODE_USE_ENV_PROXY", () => ({ NODE_USE_ENV_PROXY: "1", NODE_OPTIONS: "--no-use-env-proxy", HTTP_PROXY: P() }), false],
    ["an empty http_proxy hides HTTP_PROXY", () => ({ NODE_USE_ENV_PROXY: "1", http_proxy: "", HTTP_PROXY: P() }), false],
    ["HTTPS_PROXY alone leaves http: direct", () => ({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: P() }), false],
    ["NO_PROXY=*", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: "*" }), false],
    ["NO_PROXY=onion", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: "onion" }), false],
    ["NO_PROXY=*.onion", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: "*.onion" }), false],
    ["NO_PROXY=.ONION", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: ".ONION" }), false],
    ["NO_PROXY split on whitespace", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: "localhost onion" }), false],
    ["NO_PROXY=.onion:80", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: ".onion:80" }), false],
    ["NO_PROXY=.onion:8080 leaves port 80 proxied", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: ".onion:8080" }), true],
    ["NO_PROXY=*,x is no lone star", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: "*,x" }), true],
    ["NO_PROXY=' *' is no lone star", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: " *" }), true],
    ["an empty no_proxy hides NO_PROXY=*", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), no_proxy: "", NO_PROXY: "*" }), true],
    ["NO_PROXY for a local node", () => ({ NODE_USE_ENV_PROXY: "1", HTTP_PROXY: P(), NO_PROXY: "127.0.0.1,localhost" }), true],
  ];
  // Windows' environment is case-insensitive: a child keeps one of http_proxy and HTTP_PROXY, so these cannot arise.
  const caseSensitive = new Set(["an empty http_proxy hides HTTP_PROXY", "an empty no_proxy hides NO_PROXY=*"]);
  it.each(cases.filter(([name]) => process.platform !== "win32" || !caseSensitive.has(name)))("accepts exactly where fetch tunnels: %s", async (_, env, tunnels) => {
    const seen = await observed(env());
    expect(seen.tunnelled).toBe(tunnels);
    expect(judged(env(), seen.name)).toBe(tunnels ? "accepted" : "PROXY");
  }, 15_000);

  it("refuses a proxy that is not loopback http:, though fetch would tunnel through it", () => {
    for (const proxy of ["http://10.0.0.1:9080", "http://tor.example:9080", "https://127.0.0.1:9080", "socks5://127.0.0.1:9050", "127.0.0.1:9080"]) {
      expect(judged({ HTTP_PROXY: proxy }, "EnvHttpProxyAgent")).toBe("PROXY");
    }
    for (const proxy of ["http://127.0.0.1:9080", "http://localhost:9080", "http://[::1]:9080"]) {
      expect(judged({ HTTP_PROXY: proxy }, "EnvHttpProxyAgent")).toBe("accepted");
    }
  });

  it("matches NO_PROXY as undici does", () => {
    const at = (port: string) => new URL(`http://${ONION}${port}/`);
    expect(proxyExempts(at(""), "")).toBe(false);
    expect(proxyExempts(at(""), "*")).toBe(true);
    expect(proxyExempts(at(""), "x.onion")).toBe(false);
    expect(proxyExempts(at(""), `${ONION}`)).toBe(true);
    expect(proxyExempts(at(":8080"), ".onion:80")).toBe(false);
    expect(proxyExempts(at(":8080"), ".onion:8080")).toBe(true);
  });

  it("takes no admin credential for an onion service and refuses one without a proxy before any connection", () => {
    const expected: ServiceIdentity = { operator: new Uint8Array(32).fill(1), reference: { context: LOCAL_REFERENCE, label: new Uint8Array(32).fill(2), lag: 0n } };
    expect(() => new V3ServiceClient(URL80.href, TOKEN, expected, "22".repeat(32))).toThrow("a local or onion URL and distinct 32-byte credentials required");
    for (const host of [`${"a".repeat(56)}.onion`, `${"a".repeat(55)}d.onion.`, `${"a".repeat(54)}d.onion`]) {
      expect(() => new V3ServiceClient(`http://${host}/`, TOKEN, expected)).toThrow("a local or onion URL");
    }
    // This test process runs without the environment proxy.
    try { new V3ServiceClient(URL80.href, TOKEN, expected); expect.unreachable(); } catch (error) {
      expect([(error as V3ServiceClientError).code, (error as Error).message]).toEqual(["PROXY", "an onion service needs Node's environment proxy: NODE_USE_ENV_PROXY=1 and HTTP_PROXY"]);
    }
  });
});
