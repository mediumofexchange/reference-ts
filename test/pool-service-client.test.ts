import { afterEach, describe, expect, it } from "vitest";
import { createServer, type RequestListener, type Server } from "node:http";
import { PoolServiceClient } from "../src/pool/service-client.js";
import { POOL_SERVICE_PROFILE } from "../src/pool/service-wire.js";

const TOKEN = "11".repeat(32);
const empty = { version: 1, profile: POOL_SERVICE_PROFILE, highestSignedSequence: "0", evidence: "omitted" };
const servers: Server[] = [];
async function endpoint(handler: RequestListener): Promise<string> {
  const server = createServer(handler); servers.push(server);
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
});

describe("bounded local pool service client", () => {
  it("accepts an explicit omitted-evidence summary and keeps credentials out of serialization", async () => {
    const url = await endpoint((request, response) => {
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify(empty));
    });
    const client = new PoolServiceClient(url, TOKEN);
    expect(await client.view()).toEqual(empty);
    expect(JSON.stringify(client)).not.toContain(TOKEN);
    for (const invalid of ["https://127.0.0.1/", "http://example.com/", `${url}path`, `${url}?token=x`, "http://user:pass@127.0.0.1/"]) {
      expect(() => new PoolServiceClient(invalid, TOKEN)).toThrow();
    }
  });
  it("refuses redirects without contacting the destination", async () => {
    let contacted = false;
    const target = await endpoint((_, response) => { contacted = true; response.end("unexpected"); });
    const url = await endpoint((_, response) => { response.writeHead(302, { location: target }); response.end(); });
    await expect(new PoolServiceClient(url, TOKEN).view()).rejects.toThrow();
    expect(contacted).toBe(false);
  });
  it("bounds declared and chunked response bodies before parsing", async () => {
    for (const declared of [false, true]) {
      const url = await endpoint((_, response) => {
        response.setHeader("content-type", "application/json");
        if (declared) response.setHeader("content-length", "65537");
        else response.flushHeaders();
        response.end(" ".repeat(65537));
      });
      await expect(new PoolServiceClient(url, TOKEN).view()).rejects.toThrow("response too large");
    }
  });
  it("rejects malformed UTF-8, wrong profile, impossible counters and unexpected encodings", async () => {
    for (const value of [Buffer.from([0xff]), Buffer.from(JSON.stringify({ ...empty, profile: "other" })),
      Buffer.from(JSON.stringify({ ...empty, highestSignedSequence: "18446744073709551616" })),
      Buffer.from(JSON.stringify({ ...empty, highestSignedSequence: "1" }))]) {
      const url = await endpoint((_, response) => { response.setHeader("content-type", "application/json"); response.end(value); });
      await expect(new PoolServiceClient(url, TOKEN).view()).rejects.toThrow();
    }
    const encoded = await endpoint((_, response) => { response.setHeader("content-type", "application/json"); response.setHeader("content-encoding", "br"); response.end(); });
    await expect(new PoolServiceClient(encoded, TOKEN).view()).rejects.toThrow();
  });
  it("aborts a real server that stalls after sending headers", async () => {
    const url = await endpoint((_, response) => { response.setHeader("content-type", "application/json"); response.flushHeaders(); });
    const started = Date.now();
    await expect(new PoolServiceClient(url, TOKEN).view()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(14000);
  }, 15000);
});
