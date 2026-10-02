import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { POOL_V3_MANIFEST, RELATIONS } from "../src/pool/v3/configuration.js";
import { adoptedPrograms, ProgramError } from "../src/pool/v3/programs.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const shipped = (): { [name: string]: { [field: string]: unknown } } =>
  JSON.parse(readFileSync(new URL("../src/pool/v3/programs.json", import.meta.url), "utf8") as string);
/** The next read of the shipped file returns `text`. */
const serve = (text: string): void => { vi.mocked(readFileSync).mockReturnValueOnce(text); };
const refusal = (code: ProgramError["code"], message: string) => {
  let error: unknown;
  try { adoptedPrograms(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(ProgramError);
  expect(error).toMatchObject({ code, message });
};

describe("the package's shipped relations, pool-v3 §11.4", () => {
  afterEach(() => { vi.mocked(readFileSync).mockClear(); });

  it("are the manifest's six relations by bytecode identity, each with its compiler version and ABI, fresh per call", () => {
    const programs = adoptedPrograms();
    expect(Object.keys(programs)).toEqual([...RELATIONS]);
    for (const name of RELATIONS) {
      const program = programs[name];
      expect(Object.keys(program).sort()).toEqual(["abi", "bytecode", "noir_version"]);
      expect(createHash("sha256").update(Buffer.from(program.bytecode, "base64")).digest("hex")).toBe(POOL_V3_MANIFEST.circuits[name].bytecode);
      expect(program.noir_version.startsWith(`${POOL_V3_MANIFEST.toolchain["@noir-lang/noir_wasm"]}+`)).toBe(true);
    }
    expect(Object.isFrozen(programs) && Object.isFrozen(programs.spend)).toBe(true);
    const abi = programs.spend.abi as { parameters: unknown[] };
    abi.parameters.length = 0;
    expect((adoptedPrograms().spend.abi as { parameters: unknown[] }).parameters.length).toBeGreaterThan(0);
  });

  it("refuses an unreadable or malformed file as MISSING", () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); });
    refusal("MISSING", "the package's compiled relations cannot be read");
    serve("{\"issue\":");
    refusal("MISSING", "the package's compiled relations cannot be read");
  });

  it("refuses another relation's bytecode in a relation's place, though both take 15 public inputs", () => {
    const programs = shipped();
    serve(JSON.stringify({ ...programs, spend: programs.burn }));
    refusal("IDENTITY", "the shipped spend bytecode is not the configuration's");
  });

  it("refuses a missing or extra relation, an array, or a relation with fields beyond its three", () => {
    const programs = shipped(), { request: _request, ...five } = programs;
    serve(JSON.stringify(five));
    refusal("IDENTITY", "the shipped relation set is not the configuration's");
    serve(JSON.stringify({ ...programs, extra: programs.issue }));
    refusal("IDENTITY", "the shipped relation set is not the configuration's");
    serve(JSON.stringify(RELATIONS.map(name => programs[name])));
    refusal("IDENTITY", "the shipped relation set is not the configuration's");
    // The compiler's debug fields carry the compiling machine's paths; the package ships none.
    serve(JSON.stringify({ ...programs, issue: { ...programs.issue, debug_symbols: "" } }));
    refusal("IDENTITY", "the shipped issue artifact is not the configuration's");
    serve(JSON.stringify({ ...programs, issue: [programs.issue] }));
    refusal("IDENTITY", "the shipped issue artifact is not the configuration's");
  });

  it("refuses another compiler's version, an ABI that is no object, and bytecode that is not canonical base64", () => {
    const programs = shipped(), spend = programs.spend!;
    serve(JSON.stringify({ ...programs, spend: { ...spend, noir_version: "1.0.0-beta.25+40d6574f" } }));
    refusal("IDENTITY", "the shipped spend compiler is not the configuration's");
    for (const abi of [null, [], "abi"]) {
      serve(JSON.stringify({ ...programs, spend: { ...spend, abi } }));
      refusal("IDENTITY", "the shipped spend ABI is not the configuration's");
    }
    // The same decoded bytes under another spelling: the identity would match, the one decoding would not.
    for (const bytecode of [`${spend.bytecode as string}\n`, `${spend.bytecode as string}=`, ` ${spend.bytecode as string}`, 7]) {
      serve(JSON.stringify({ ...programs, spend: { ...spend, bytecode } }));
      refusal("IDENTITY", "the shipped spend bytecode is not the configuration's");
    }
  });
});
