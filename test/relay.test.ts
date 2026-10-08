import { describe, expect, it } from "vitest";
import { CommandError } from "../src/cli/common.js";
import { parseRelayFile, relayAnswer, relayRefusal, relayTurns } from "../src/cli/relay.js";
import { VenueError } from "../src/venue-error.js";

// Slice 12 M12c: the served relay's turns, its listener's refusal codes and the send's checks of what a relay hands back.
describe("a served relay (slice 12 M12c)", () => {
  const code = async (work: Promise<unknown>) => { try { await work; } catch (error) { return (error as CommandError).code; } return undefined; };

  it("takes two waiting requests beside the work running, refuses a third BUSY, and drops one gone by its turn", async () => {
    let release!: () => void;
    const judged: unknown[] = [];
    const turns = relayTurns(async value => { judged.push(value); return value; });
    const held = turns.turn(() => new Promise<void>(done => { release = done; }));
    let gone = false;
    const first = turns.take("a", () => false), second = turns.take("b", () => gone);
    expect(await code(turns.take("c", () => false))).toBe("BUSY");
    gone = true; release(); await held;
    expect(await first).toBe("a");
    expect(await code(second)).toBe("GONE");
    expect(judged).toEqual(["a"]);
    // The bound is on what waits: once they have ended, requests are taken again.
    expect(await turns.take("d", () => false)).toBe("d");
  });

  it("runs after each request ends, refused or not", async () => {
    let ended = 0;
    const turns = relayTurns(async () => { throw new CommandError("EARLY", "early"); }, () => { ended++; });
    expect(await code(turns.take("a", () => false))).toBe("EARLY");
    expect(await code(turns.take("b", () => true))).toBe("GONE");
    expect(ended).toBe(2);
  });

  it("names each refusal's status: the file's own, one a later send may pass, and the relay not ready", () => {
    for (const c of ["INVALID", "VENUE", "SUBJECT", "CONFIGURATION"]) expect(relayRefusal(new CommandError(c, "x"))).toEqual({ status: 400, code: c });
    for (const c of ["EARLY", "BUDGET", "UNREPLAYED", "BUSY"]) expect(relayRefusal(new CommandError(c, "x"))).toEqual({ status: 409, code: c });
    expect(relayRefusal(new CommandError("GONE", "x"))).toEqual({ status: 503, code: "GONE" });
    // The publisher's refusals, by their codes, never their text: no resend passes the first.
    expect(relayRefusal(new VenueError("the publication does not fit one transaction", "TOO_LARGE"))).toEqual({ status: 400, code: "TOO_LARGE" });
    expect(relayRefusal(new VenueError("the publisher holds too many unsettled publications; settle it from a view", "FULL"))).toEqual({ status: 409, code: "FULL" });
    expect(relayRefusal(new VenueError("the publication does not fit one transaction"))).toEqual({ status: 503, code: "UNAVAILABLE" });
    expect(relayRefusal(new VenueError("the best chain is shorter than the clock's depth; publish once it grows"))).toEqual({ status: 503, code: "UNAVAILABLE" });
    expect(relayRefusal(new Error("node failure"))).toBeUndefined();
  });

  it("a send takes a relay file of a loopback or v3 onion URL and a 32-byte credential only", () => {
    const token = "11".repeat(32), onion = `http://${"l".repeat(55)}d.onion/`;
    expect(parseRelayFile({ url: "http://127.0.0.1:8080/", token })).toEqual({ url: "http://127.0.0.1:8080/", token });
    expect(parseRelayFile({ url: onion, token })).toEqual({ url: onion, token });
    for (const value of [null, [], { url: onion }, { url: onion, token, extra: 1 }, { url: "http://example.com/", token },
      { url: "http://localhost:1/", token }, { url: onion, token: "AA".repeat(32) }, { url: `http://${"l".repeat(56)}.onion/`, token }]) {
      expect(() => parseRelayFile(value)).toThrow(expect.objectContaining({ code: "INVALID" }));
    }
  });

  it("a send prints a relay's answer only where it names the file's record in a relay reply's shape", () => {
    const record = "ab".repeat(32), tx = "cd".repeat(32);
    expect(relayAnswer({ status: "final", record, index: "12" }, record)).toEqual({ status: "final", record, index: "12" });
    expect(relayAnswer({ status: "pending", record, transaction: tx, witnessedIndex: "3" }, record).status).toBe("pending");
    expect(relayAnswer({ status: "pending", record, transaction: null, witnessedIndex: "3" }, record).status).toBe("pending");
    for (const value of [{ status: "final", record: "ef".repeat(32), index: "12" }, { status: "final", record, index: "012" },
      { status: "final", record, index: "12", extra: true }, { status: "pending", record, transaction: "zz", witnessedIndex: "3" },
      { status: "witnessed", record, index: "1" }, null, "final"]) {
      expect(() => relayAnswer(value, record)).toThrow(expect.objectContaining({ code: "INVALID" }));
    }
  });
});
