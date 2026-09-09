// Fixed offline cases only; invoke through contained-check.ps1, never directly.
import assert from "node:assert/strict";
const name = process.argv[2];
const emit = (value) => console.log(JSON.stringify(value));
switch (name) {
  case "startup": emit({ node: process.version }); break;
  case "memory": {
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 8192 });
    let pages = 1;
    try {
      while (pages < 8192) { memory.grow(16); pages += 16; }
      throw new Error("Memory control unexpectedly reached 512 MiB");
    } catch (error) {
      assert(error instanceof RangeError);
      assert(pages < 8177, "refusal must precede declared WASM maximum");
      emit({ status: "allocation-refused", committedWasmBytes: pages * 65536 });
    }
    break;
  }
  case "cpu": while (true) {} // Only the external job can end this control.
  case "wall": await new Promise(() => { setInterval(() => {}, 1000); }); break;
  case "output": {
    const { writeSync } = await import("node:fs");
    const block = Buffer.alloc(4096, 0x78);
    while (true) writeSync(1, block);
  }
  case "descendant": {
    const { spawnSync } = await import("node:child_process");
    const result = spawnSync(process.execPath, ["-e", "process.exit(0)"], { windowsHide: true, timeout: 1000 });
    assert(result.error || result.status !== 0, "second process must not run successfully");
    emit({ status: "descendant-refused" });
    break;
  }
  case "corpus": await import("./decoder-cases.mjs"); break;
  default: throw new Error("Unknown fixed case");
}
