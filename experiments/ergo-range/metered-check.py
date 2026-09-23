"""Finite offline probe only. Run through metered-check.mjs.

The vendored release build of sigma-rust 2f840d3 under the pinned Wasmtime 48
engine, fuel and memory metered as in metering-check.py, over the corpus and
optionally the P4 window. The ceilings are for observation, not a proposed
budget: fuel is effectively unbounded and memory is wasm32's full 4 GiB, so
each transaction shows what it costs. Only valid retained transactions run.
"""
import hashlib
import importlib.util
import json
import pathlib
import platform
import statistics
import struct
import subprocess
import sys
import time

BASE = pathlib.Path(__file__).resolve().parent
ROOT = BASE.parent.parent
_spec = importlib.util.spec_from_file_location("metering_check", BASE / "metering-check.py")
baseline = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(baseline)
wt, require, sha = baseline.wt, baseline.require, baseline.sha

WASM = BASE / "vendor/ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm"
WASM_HASH = "0d20038513c72a9daf859e3ea278735caef43305cde6bc7fb2764e8d933aa28a"
FUEL = 10**12
MEMORY = 2**32
TABLE = 4096
INPUT = 128 * 1024
OUTPUT = 1024 * 1024


def decode(engine, module, data):
    """Parse, reserialize exactly and extract JSON in one fresh Store; returns (json, measurement)."""
    require(0 < len(data) <= INPUT, "input byte limit")
    store = wt.Store(engine)
    try:
        # The release build's wasm-bindgen output declares two tables.
        store.set_limits(memory_size=MEMORY, table_elements=TABLE, instances=1, memories=1, tables=2)
        store.set_fuel(FUEL)

        def refuse_import(*_args):
            raise wt.Trap("host import refused")
        imports = []
        for item in module.imports:
            require(isinstance(item.type, wt.FuncType), "nonfunction import")
            imports.append(wt.Func(store, item.type, refuse_import))
        exports = wt.Instance(store, module, imports).exports(store)
        memory = exports["memory"]
        base_memory = memory.data_len(store)

        def measured(**extra):
            return {"fuelConsumed": FUEL - store.get_fuel(), "memoryBytes": memory.data_len(store),
                    "baseMemoryBytes": base_memory, **extra}

        def read(pointer, length, limit):
            require(0 <= length <= limit and 0 <= pointer <= memory.data_len(store) - length, "guest output bounds")
            return bytes(memory.read(store, pointer, pointer + length))
        try:
            pointer = exports["__wbindgen_malloc"](store, len(data), 1)
            require(0 <= pointer <= memory.data_len(store) - len(data), "guest input bounds")
            memory.write(store, data, pointer)
            tx, _error, failed = exports["transaction_sigma_parse_bytes"](store, pointer, len(data))
            if failed:
                return None, measured(status="refused-parse")
            pointer, length, _error, failed = exports["transaction_sigma_serialize_bytes"](store, tx)
            if failed or read(pointer, length, INPUT) != data:
                return None, measured(status="refused-noncanonical")
            pointer, length, _error, failed = exports["transaction_to_json"](store, tx)
            if failed:
                return None, measured(status="refused-json")
            text = read(pointer, length, OUTPUT)
            return json.loads(text), measured(status="decoded", jsonBytes=length)
        except wt.Trap as error:
            return None, measured(status="trap", trap=str(error.trap_code), message=str(error).splitlines()[0][:120])
    finally:
        store.close()


def week_rows(engine, module, path, expected):
    blob = path.read_bytes()
    require(sha(blob) == expected["frameSha256"], "week frame file changed")
    rows, offset = [], 0
    while offset < len(blob):
        height, position, length = struct.unpack_from("<III", blob, offset)
        tx_id = blob[offset + 12:offset + 44].hex()
        data = blob[offset + 44:offset + 44 + length]
        offset += 44 + length
        decoded, m = decode(engine, module, data)
        if decoded is not None:
            require(decoded["id"] == tx_id, f"week id mismatch at {height}/{position}")
        rows.append({"h": height, "p": position, "n": length, **m})
    require(len(rows) == expected["transactions"], "week transaction count")
    return rows


def summarize(rows):
    ok = [r for r in rows if r["status"] == "decoded"]
    per_byte = sorted(r["fuelConsumed"] / r["n"] for r in ok)
    fuel = sorted(r["fuelConsumed"] for r in ok)
    return {"transactions": len(rows), "decoded": len(ok), "notDecoded": len(rows) - len(ok),
            "fuelMax": fuel[-1], "fuelMedian": statistics.median_low(fuel),
            "fuelPerByteMax": round(per_byte[-1]), "fuelPerByteMedian": round(statistics.median(per_byte)),
            "memoryBytesMax": max(r["memoryBytes"] for r in ok), "inputBytesMax": max(r["n"] for r in rows)}


def main():
    node, week_path = sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None
    baseline.validate_engine()
    args = [node, str(BASE / "metered-cases.mjs")] + (["--week", week_path] if week_path else [])
    prepared = subprocess.run(args, capture_output=True, check=True, timeout=1800)
    cases = json.loads(prepared.stdout)
    wasm = WASM.read_bytes()
    require(sha(wasm) == WASM_HASH, "wrong decoder artifact")
    with wt.Engine(baseline.engine_config()) as engine, wt.Module(engine, wasm) as module:
        fixtures = []
        for case in cases["fixtures"]:
            data = bytes.fromhex(case["bytes"])
            decoded, m = decode(engine, module, data)
            require(decoded is not None and decoded["id"] == case["id"], f"corpus transaction {case['id']} not decoded")
            fixtures.append({"id": case["id"], "n": len(data), **m})
        week = None
        if week_path:
            start = time.perf_counter()
            rows = week_rows(engine, module, pathlib.Path(week_path), cases["week"])
            week = {**cases["week"], **summarize(rows), "seconds": round(time.perf_counter() - start)}
        imports = len(module.imports)
    corpus = summarize(fixtures)
    files = ["metered-check.py", "metered-check.mjs", "metered-cases.mjs", "metering-check.py",
             "metering-requirements.txt", "package-lock.json", "fixtures/manifest.json",
             "vendor/ergo-lib-wasm-nodejs/SHA256SUMS"]
    report = {
        "status": "offline-metered-release-probe", "python": platform.python_version(), "os": platform.platform(),
        "engine": "wasmtime 48.0.0", "nativeEngineSha256": baseline.DLL_HASH, "wasmSha256": WASM_HASH,
        "hostImports": imports, "hostImportPolicy": "all trap; no guest-memory reads or JS bridge",
        "ceilings": {"fuelPerTransaction": FUEL, "linearMemoryBytes": MEMORY, "tableElements": TABLE, "tables": 2,
                     "inputBytes": INPUT, "jsonBytes": OUTPUT,
                     "meaning": "observation ceilings, not a proposed budget; memory is wasm32's whole address space"},
        "limitations": ["Valid retained transactions only; no hostile inputs, so no bound for adversarial bytes follows.",
                        "Fuel bounds guest metered work, not CPU seconds or host compilation/callback costs.",
                        "Linear-memory/table limits are not a total process memory or RSS ceiling.",
                        "The split check shows the node's field split is not bound by the transaction id; it does not test a reader."],
        "corpus": corpus, "week": week, "split": cases["split"],
        "files": {name: sha((BASE / name).read_bytes()) for name in files},
    }
    print(json.dumps(report, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
