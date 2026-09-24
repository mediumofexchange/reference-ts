// Deterministic fuel and growth metering injected into a trusted WebAssembly module, so that any engine running the
// derived module stops a call after a declared amount of guest work and refuses growth past a declared size.
//
// The input is a fixed, pinned module (the vendored decoder), not external data: an instruction or section this
// rewriter does not know makes it throw rather than guess. The derived module differs from the input only by:
// - four appended mutable globals, exported: `__meter_fuel` (i64, remaining fuel), `__meter_memory_pages` (i64,
//   linear-memory ceiling in pages), `__meter_table_elements` (i64, per-table element ceiling) and `__meter_refused`
//   (i32; 1 after a refused memory growth, 2 after a refused table growth);
// - a charge at the start of every function body and every loop body: the number of instructions of that region
//   (a loop body's instructions belong to the loop, not to the enclosing region) plus the charge's own ten
//   instructions. Only a branch to a loop label moves backwards and it re-enters that loop's charge, so each
//   instruction runs at most once per charge of its region and total fuel bounds every instruction executed;
// - memory.copy, memory.fill, memory.grow, table.grow and table.fill replaced by calls to appended helpers that
//   charge their own instructions, then their dynamic extent (bytes / 8, 8,192 per page, one per element), before
//   acting; the growth helpers return -1, as a refused growth does, when the result would exceed the ceiling.
// A charge that leaves the fuel negative executes `unreachable`, so exhaustion is a trap with the fuel global below
// zero. Branch targets in WebAssembly are structural labels, not offsets, so insertion moves no branch. Existing
// function, type, global and table indices are unchanged: every addition is appended.
const I32 = 0x7f, I64 = 0x7e, F32 = 0x7d, F64 = 0x7c, FUNCREF = 0x70, EXTERNREF = 0x6f;
const VALTYPES = new Set([I32, I64, F32, F64, FUNCREF, EXTERNREF]);
export const METER_EXPORTS = Object.freeze({ fuel: "__meter_fuel", memoryPages: "__meter_memory_pages",
  tableElements: "__meter_table_elements", refused: "__meter_refused" });
export const CHARGE_INSTRUCTIONS = 10n;
export const REFUSED_MEMORY = 1, REFUSED_TABLE = 2;

const fail = message => { throw new Error(`wasm-meter: ${message}`); };

class Reader {
  constructor(bytes, pos = 0, end = bytes.length) { this.b = bytes; this.p = pos; this.end = end; }
  byte() { if (this.p >= this.end) fail("truncated"); return this.b[this.p++]; }
  u32() {
    let result = 0, shift = 0;
    for (let i = 0; i < 5; i++) {
      const b = this.byte();
      result += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) { if (result > 0xffffffff) fail("u32 out of range"); return result; }
      shift += 7;
    }
    return fail("u32 too long");
  }
  // Signed LEB128 of at most `max` bytes, skipped: only its length matters here.
  skipSigned(max) { for (let i = 0; i < max; i++) if ((this.byte() & 0x80) === 0) return; fail("signed LEB too long"); }
  bytes(n) { if (this.p + n > this.end) fail("truncated"); const out = this.b.subarray(this.p, this.p + n); this.p += n; return out; }
}

const u32 = n => { const out = []; do { let b = n & 0x7f; n >>>= 7; if (n) b |= 0x80; out.push(b); } while (n); return out; };
const s64 = value => {
  let v = BigInt(value);
  const out = [];
  for (;;) {
    const b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) { out.push(b); return out; }
    out.push(b | 0x80);
  }
};
const vec = items => [...u32(items.length), ...items.flat()];
const name = text => { const bytes = [...Buffer.from(text, "utf8")]; return [...u32(bytes.length), ...bytes]; };

// The length of one instruction's immediates, reading from its opcode on; returns the opcode's class for the
// instrumenter. Only the opcodes of MVP, sign extension, saturating truncation, the bulk-memory and table operations
// the helpers replace, and reference types are known.
function instruction(r) {
  const op = r.byte();
  if (op === 0x02 || op === 0x03 || op === 0x04) {
    const b = r.b[r.p];
    if (b === 0x40 || VALTYPES.has(b)) r.p++; else r.skipSigned(5);
    return op === 0x03 ? "loop" : "open";
  }
  if (op === 0x05) return "else";
  if (op === 0x0b) return "end";
  if (op === 0x00 || op === 0x01 || op === 0x0f || op === 0x1a || op === 0x1b || op === 0xd1) return "plain";
  if (op === 0x0c || op === 0x0d || op === 0x10 || (op >= 0x20 && op <= 0x26) || op === 0xd2) { r.u32(); return "plain"; }
  if (op === 0x0e) { const n = r.u32(); for (let i = 0; i <= n; i++) r.u32(); return "plain"; }
  if (op === 0x11) { r.u32(); r.u32(); return "plain"; }
  if (op === 0x1c) { const n = r.u32(); for (let i = 0; i < n; i++) if (!VALTYPES.has(r.byte())) fail("select type"); return "plain"; }
  if (op >= 0x28 && op <= 0x3e) { if (r.u32() & 0x40) fail("multiple memories"); r.u32(); return "plain"; }
  if (op === 0x3f) { if (r.u32() !== 0) fail("memory index"); return "plain"; }
  if (op === 0x40) { if (r.u32() !== 0) fail("memory index"); return "memory.grow"; }
  if (op === 0x41) { r.skipSigned(5); return "plain"; }
  if (op === 0x42) { r.skipSigned(10); return "plain"; }
  if (op === 0x43) { r.bytes(4); return "plain"; }
  if (op === 0x44) { r.bytes(8); return "plain"; }
  if (op >= 0x45 && op <= 0xc4) return "plain";
  if (op === 0xd0) { if (!VALTYPES.has(r.byte())) fail("ref.null type"); return "plain"; }
  if (op === 0xfc) {
    const sub = r.u32();
    if (sub <= 7) return "plain";
    if (sub === 10) { if (r.u32() !== 0 || r.u32() !== 0) fail("memory index"); return "memory.copy"; }
    if (sub === 11) { if (r.u32() !== 0) fail("memory index"); return "memory.fill"; }
    if (sub === 15) return { kind: "table.grow", table: r.u32() };
    if (sub === 16) { r.u32(); return "plain"; }
    if (sub === 17) return { kind: "table.fill", table: r.u32() };
    return fail(`unsupported instruction 0xfc ${sub}`);
  }
  return fail(`unsupported instruction 0x${op.toString(16)}`);
}

export function meter(input) {
  const wasm = new Uint8Array(input);
  if (wasm.length < 8 || Buffer.from(wasm.subarray(0, 8)).toString("hex") !== "0061736d01000000") fail("not a version-1 module");
  const r = new Reader(wasm, 8);
  const sections = [];
  while (r.p < wasm.length) {
    const id = r.byte(), size = r.u32(), start = r.p;
    r.bytes(size);
    if (id > 12) fail(`unknown section ${id}`);
    if (id !== 0 && sections.some(s => s.id === id)) fail(`duplicate section ${id}`);
    sections.push({ id, start, end: start + size });
  }
  const section = id => sections.find(s => s.id === id);
  for (const id of [1, 3, 4, 5, 6, 7, 10]) if (!section(id)) fail(`missing section ${id}`);
  if (section(8)) fail("start section");
  if (section(12)) fail("data count section (memory.init/data.drop are not metered)");
  const reader = id => new Reader(wasm, section(id).start, section(id).end);
  const rest = rd => wasm.subarray(rd.p, rd.end);

  // Types: keep each entry's bytes and append the helpers' signatures.
  const types = reader(1);
  const typeCount = types.u32();
  const typeBytes = rest(types);
  for (let i = 0; i < typeCount; i++) {
    if (types.byte() !== 0x60) fail("non-function type");
    for (let k = 0; k < 2; k++) { const n = types.u32(); for (let j = 0; j < n; j++) if (!VALTYPES.has(types.byte())) fail("value type"); }
  }
  if (types.p !== types.end) fail("type section length");

  let importedFunctions = 0, importedGlobals = 0;
  if (section(2)) {
    const imports = reader(2);
    for (let n = imports.u32(), i = 0; i < n; i++) {
      imports.bytes(imports.u32()); imports.bytes(imports.u32());
      const kind = imports.byte();
      if (kind === 0x00) { imports.u32(); importedFunctions++; }
      else if (kind === 0x03) { if (!VALTYPES.has(imports.byte())) fail("global type"); imports.byte(); importedGlobals++; }
      else fail("only function and global imports are supported");
    }
  }
  const tables = reader(4), tableTypes = [];
  for (let n = tables.u32(), i = 0; i < n; i++) {
    const type = tables.byte();
    if (type !== FUNCREF && type !== EXTERNREF) fail("table type");
    const flag = tables.byte(); tables.u32(); if (flag === 1) tables.u32(); else if (flag !== 0) fail("table limits");
    tableTypes.push(type);
  }
  const memories = reader(5);
  if (memories.u32() !== 1) fail("exactly one defined memory");
  const functions = reader(3);
  const definedFunctions = functions.u32();
  const functionBytes = rest(functions);
  const globals = reader(6);
  const definedGlobals = globals.u32();
  const globalBytes = rest(globals);
  const exports = reader(7);
  const exportCount = exports.u32();
  const exportBytes = rest(exports);
  for (let i = 0; i < exportCount; i++) {
    const text = Buffer.from(exports.bytes(exports.u32())).toString("utf8");
    if (Object.values(METER_EXPORTS).includes(text)) fail(`export ${text} exists`);
    exports.byte(); exports.u32();
  }

  // Appended globals, then helpers: one per replaced operation and table.
  const G = { fuel: importedGlobals + definedGlobals, pages: importedGlobals + definedGlobals + 1,
    elements: importedGlobals + definedGlobals + 2, refused: importedGlobals + definedGlobals + 3 };
  const newTypes = [], helpers = [], helperIndex = new Map();
  const typeOf = (params, results) => {
    const bytes = [0x60, ...vec(params.map(p => [p])), ...vec(results.map(p => [p]))];
    let at = newTypes.findIndex(t => t.join() === bytes.join());
    if (at < 0) { newTypes.push(bytes); at = newTypes.length - 1; }
    return typeCount + at;
  };
  const check = [0x23, ...u32(G.fuel), 0x42, 0x00, 0x53, 0x04, 0x40, 0x00, 0x0b];
  // The charge is ten instructions: global.get, i64.const, i64.sub, global.set, global.get, i64.const, i64.lt_s, if,
  // unreachable, end. `cost` excludes them.
  const chargeBytes = cost => [0x23, ...u32(G.fuel), 0x42, ...s64(cost + CHARGE_INSTRUCTIONS), 0x7d, 0x24, ...u32(G.fuel), ...check];
  const charge = cost => Uint8Array.from(chargeBytes(cost));
  // fuel -= extent << shift (or >> for shiftOp 0x88), where the extent is the unsigned i32 local `extentLocal`.
  const chargeDynamic = (extentLocal, shiftOp, shift) => [0x23, ...u32(G.fuel), 0x20, ...u32(extentLocal), 0xad,
    0x42, ...s64(shift), shiftOp, 0x7d, 0x24, ...u32(G.fuel), ...check];
  // A helper first charges every instruction of its own body, counted by the same walker, so a refused growth that
  // returns early has paid too; then its dynamic extent; then acts.
  const helper = (key, params, results, rest) => {
    if (!helperIndex.has(key)) {
      const code = [...rest, 0x0b], walker = new Reader(Uint8Array.from(code));
      let own = 0n;
      while (walker.p < walker.end) { instruction(walker); own++; }
      helperIndex.set(key, importedFunctions + definedFunctions + helpers.length);
      helpers.push({ type: typeOf(params, results), body: Uint8Array.from([0x00, ...chargeBytes(own), ...code]) });
    }
    return helperIndex.get(key);
  };
  const table = t => { if (t >= tableTypes.length) fail("table index"); return t; };
  const replacement = kind => {
    if (kind === "memory.copy") return helper(kind, [I32, I32, I32], [], [...chargeDynamic(2, 0x88, 3),
      0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 10, 0, 0]);
    if (kind === "memory.fill") return helper(kind, [I32, I32, I32], [], [...chargeDynamic(2, 0x88, 3),
      0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 11, 0]);
    if (kind === "memory.grow") return helper(kind, [I32], [I32], [
      0x3f, 0, 0xad, 0x20, 0, 0xad, 0x7c, 0x23, ...u32(G.pages), 0x56,
      0x04, 0x40, 0x41, REFUSED_MEMORY, 0x24, ...u32(G.refused), 0x41, 0x7f, 0x0f, 0x0b,
      ...chargeDynamic(0, 0x86, 13), 0x20, 0, 0x40, 0]);
    if (kind.kind === "table.grow") return helper(`table.grow ${kind.table}`, [tableTypes[table(kind.table)], I32], [I32], [
      0xfc, 16, ...u32(kind.table), 0xad, 0x20, 1, 0xad, 0x7c, 0x23, ...u32(G.elements), 0x56,
      0x04, 0x40, 0x41, REFUSED_TABLE, 0x24, ...u32(G.refused), 0x41, 0x7f, 0x0f, 0x0b,
      ...chargeDynamic(1, 0x86, 0), 0x20, 0, 0x20, 1, 0xfc, 15, ...u32(kind.table)]);
    if (kind.kind === "table.fill") return helper(`table.fill ${kind.table}`, [I32, tableTypes[table(kind.table)], I32], [],
      [...chargeDynamic(2, 0x86, 0), 0x20, 0, 0x20, 1, 0x20, 2, 0xfc, 17, ...u32(kind.table)]);
    return undefined;
  };
  const cat = pieces => Buffer.concat(pieces.map(p => p instanceof Uint8Array ? p : Uint8Array.from(p)));

  // Code: two passes per body, counting each region's instructions, then emitting with charges and replacements.
  const code = reader(10);
  if (code.u32() !== definedFunctions) fail("function and code counts differ");
  const bodies = [];
  let regions = 0, replaced = 0;
  for (let f = 0; f < definedFunctions; f++) {
    const size = code.u32(), end = code.p + size, start = code.p;
    code.bytes(size);
    const body = new Reader(wasm, start, end);
    for (let n = body.u32(), i = 0; i < n; i++) { body.u32(); if (!VALTYPES.has(body.byte())) fail("local type"); }
    const localsEnd = body.p;
    const list = [], counts = [0], stack = [0];
    for (;;) {
      if (body.p >= end) fail(`function ${f} has no final end`);
      const from = body.p, kind = instruction(body);
      const region = stack.at(-1);
      counts[region]++;
      list.push({ from, to: body.p, kind });
      if (kind === "loop") { counts.push(0); list.at(-1).region = counts.length - 1; stack.push(counts.length - 1); }
      else if (kind === "open") stack.push(region);
      else if (kind === "end") { stack.pop(); if (stack.length === 0) break; }
    }
    if (body.p !== end) fail(`function ${f} continues after its final end`);
    const out = [wasm.subarray(start, localsEnd), charge(BigInt(counts[0]))];
    for (const item of list) {
      const index = replacement(item.kind);
      if (index !== undefined) { out.push([0x10, ...u32(index)]); replaced++; }
      else out.push(wasm.subarray(item.from, item.to));
      if (item.kind === "loop") out.push(charge(BigInt(counts[item.region])));
    }
    regions += counts.length;
    const emitted = cat(out);
    bodies.push(u32(emitted.length), emitted);
  }
  if (code.p !== code.end) fail("code section length");
  for (const h of helpers) bodies.push(u32(h.body.length), h.body);

  const mutable = (type, init) => [type, 0x01, ...init, 0x0b];
  const payload = {
    1: cat([u32(typeCount + newTypes.length), typeBytes, ...newTypes]),
    3: cat([u32(definedFunctions + helpers.length), functionBytes, ...helpers.map(h => u32(h.type))]),
    6: cat([u32(definedGlobals + 4), globalBytes, mutable(I64, [0x42, 0x00]), mutable(I64, [0x42, 0x00]),
      mutable(I64, [0x42, 0x00]), mutable(I32, [0x41, 0x00])]),
    7: cat([u32(exportCount + 4), exportBytes,
      ...[[METER_EXPORTS.fuel, G.fuel], [METER_EXPORTS.memoryPages, G.pages], [METER_EXPORTS.tableElements, G.elements],
        [METER_EXPORTS.refused, G.refused]].map(([text, index]) => [...name(text), 0x03, ...u32(index)])]),
    10: cat([u32(bodies.length / 2), ...bodies]),
  };
  const out = [wasm.subarray(0, 8)];
  for (const s of sections) {
    const bytes = payload[s.id] ?? wasm.subarray(s.start, s.end);
    out.push([s.id, ...u32(bytes.length)], bytes);
  }
  const derived = new Uint8Array(cat(out));
  if (!WebAssembly.validate(derived)) fail("the derived module does not validate");
  return { bytes: derived, stats: { functions: definedFunctions, regions, replaced, helpers: helpers.length } };
}
