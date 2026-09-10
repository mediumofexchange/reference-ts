"""Finite offline feasibility only. Run through metering-check.mjs.

No hostile decoder inputs, WASI, JS object bridge, fuel refill or production API.
Every imported function traps without reading guest memory. Each transaction
gets a fresh Store, destroyed on success or refusal, with one shared fuel budget
for allocation, parse, exact reserialization and JSON extraction.
"""
import hashlib
from contextlib import contextmanager
import importlib.metadata
import json
import pathlib
import platform
import struct
import subprocess
import sys
import time

BASE = pathlib.Path(__file__).resolve().parent
ROOT = BASE.parent.parent
ENGINE_ROOT = ROOT / "scratch/metering-python"
ENGINE_DLL = ENGINE_ROOT / "wasmtime/win32-x86_64/_wasmtime.dll"
DLL_HASH = "91671331a752287c92ada8cd84cae7b572521f5a854dcc8d69cd9b3556b3c832"
if not (ENGINE_ROOT / "wasmtime/__init__.py").is_file() or not ENGINE_DLL.is_file():
    raise RuntimeError("install the pinned Windows x64 wheel into scratch/metering-python")
if hashlib.sha256(ENGINE_DLL.read_bytes()).hexdigest() != DLL_HASH:
    raise RuntimeError("wrong native engine artifact")
sys.path.insert(0, str(ENGINE_ROOT))
import wasmtime as wt

FUEL = 10_000_000
MEMORY = 16 * 1024 * 1024
TABLE = 4096
OUTPUT = 256 * 1024
WASM_HASH = "5c39a0933a07031492efbe956fb4f957da745e295a94c06efddb475d9d1db4e5"


def require(ok, message):
    if not ok:
        raise RuntimeError(message)


def sha(data):
    return hashlib.sha256(data).hexdigest()


def store_for(engine, fuel=FUEL, memory=MEMORY, table=TABLE):
    store = wt.Store(engine)
    store.set_limits(memory_size=memory, table_elements=table,
                     instances=1, memories=1, tables=1)
    store.set_fuel(fuel)
    return store


def expect_trap(fn, code):
    try:
        fn()
    except wt.Trap as error:
        require(error.trap_code == code, f"wrong trap: {error.trap_code}")
        return
    raise RuntimeError("expected trap")


def controls(engine):
    module = wt.Module(engine, '''(module
      (memory (export "memory") 1)
      (table (export "table") 1 funcref)
      (func (export "spin") (loop br 0))
      (func (export "grow") (param i32) (result i32) local.get 0 memory.grow)
      (func (export "grow_table") (param i32) (result i32)
        ref.null func local.get 0 table.grow)
      (func $recurse (export "recurse") (result i32) call $recurse i32.const 1 i32.add))''')
    observations = []
    for budget in (0, 1, 1000, 100000):
        with store_for(engine, fuel=budget) as store:
            exports = wt.Instance(store, module, []).exports(store)
            expect_trap(lambda: exports["spin"](store), wt.TrapCode.OUT_OF_FUEL)
            require(store.get_fuel() == 0, "fuel left after exhaustion")
            observations.append({"control": "spin", "fuel": budget, "remaining": 0})
    with store_for(engine, memory=2 * 65536, table=2) as store:
        exports = wt.Instance(store, module, []).exports(store)
        require(exports["grow"](store, 1) == 1, "exact memory cap refused")
        require(exports["grow"](store, 1) == -1, "memory cap bypassed")
        require(exports["grow"](store, 4096) == -1, "single large growth admitted")
        require(exports["memory"].data_len(store) == 131072, "memory changed after refusal")
        require(exports["grow_table"](store, 1) == 1, "exact table cap refused")
        require(exports["grow_table"](store, 1) == -1, "table cap bypassed")
        require(exports["table"].size(store) == 2, "table changed after refusal")
        observations.append({"control": "growth", "memoryBytes": 131072, "tableElements": 2,
                             "memoryOverCap": -1, "singleLargeGrowth": -1, "tableOverCap": -1})
    with store_for(engine) as store:
        exports = wt.Instance(store, module, []).exports(store)
        expect_trap(lambda: exports["recurse"](store), wt.TrapCode.STACK_OVERFLOW)
        observations.append({"control": "recursion", "trap": "STACK_OVERFLOW"})
    module.close()
    return observations


def decode(engine, module, data, fuel=FUEL, observe=None):
    require(0 < len(data) <= 65536, "input byte limit")
    def event(phase, state, store=None, memory=None):
        if observe is not None:
            observe({"phase": phase, "event": state,
                     "fuelRemaining": store.get_fuel() if store is not None else None,
                     "linearMemoryBytes": memory.data_len(store) if memory is not None else None})

    @contextmanager
    def attempt_store():
        store = store_for(engine, fuel=fuel)
        try:
            yield store
        finally:
            try:
                event("store-close", "before", store)
            finally:
                store.close()
            event("store-close", "after")

    event("store", "before")
    with attempt_store() as store:
        event("store", "after", store)
        def refuse_import(*_args):
            raise wt.Trap("host import refused")

        event("instantiate", "before", store)
        imports = []
        for item in module.imports:
            require(isinstance(item.type, wt.FuncType), "nonfunction import")
            imports.append(wt.Func(store, item.type, refuse_import))
        exports = wt.Instance(store, module, imports).exports(store)
        memory = exports["memory"]
        event("instantiate", "after", store, memory)

        def call(name, *args):
            event(name, "before", store, memory)
            try:
                value = exports[name](store, *args)
            except wt.Trap as error:
                event(name, "trap", store, memory)
                if error.trap_code == wt.TrapCode.OUT_OF_FUEL:
                    require(store.get_fuel() == 0, "fuel left on decoder exhaustion")
                    error.metering = {"fuelConsumed": fuel, "memoryBytes": memory.data_len(store),
                                      "phase": name}
                raise
            event(name, "after", store, memory)
            return value

        def read(pointer, length, limit):
            require(0 <= length <= limit and 0 <= pointer <= memory.data_len(store) - length,
                    "guest output bounds")
            event("copy-out", "before", store, memory)
            value = bytes(memory.read(store, pointer, pointer + length))
            event("copy-out", "after", store, memory)
            return value

        result = call("__wbindgen_add_to_stack_pointer", -16)
        pointer = call("__wbindgen_malloc", len(data), 1)
        require(0 <= pointer <= memory.data_len(store) - len(data), "guest input bounds")
        event("copy-in", "before", store, memory)
        memory.write(store, data, pointer)
        event("copy-in", "after", store, memory)
        call("transaction_sigma_parse_bytes", result, pointer, len(data))
        tx, _error, failed = struct.unpack("<III", read(result, 12, 16))
        require(failed == 0 and tx != 0, "parse refusal")
        call("transaction_sigma_serialize_bytes", result, tx)
        pointer, length, _error, failed = struct.unpack("<IIII", read(result, 16, 16))
        require(failed == 0, "serialization refusal")
        require(read(pointer, length, 65536) == data, "noncanonical transaction")
        call("transaction_to_json", result, tx)
        pointer, length, _error, failed = struct.unpack("<IIII", read(result, 16, 16))
        require(failed == 0, "JSON extraction refusal")
        output = read(pointer, length, OUTPUT)
        remaining = store.get_fuel()
        result = {"fuelConsumed": fuel - remaining, "memoryBytes": memory.data_len(store),
                  "jsonBytes": length}
    # No guest references survive Store destruction. JSON is finite trusted
    # fixture output in this slice; hostile JSON parsing remains a separate gate.
    event("json-loads", "before")
    decoded = json.loads(output)
    event("json-loads", "after")
    return decoded, result


def fields(tx):
    return {"id": tx["id"], "inputs": tx["inputs"], "dataInputs": tx["dataInputs"],
            "outputs": [{"boxId": o["boxId"], "value": int(o["value"]), "ergoTree": o["ergoTree"],
                         "assets": [{"tokenId": a["tokenId"], "amount": int(a["amount"])} for a in o["assets"]],
                         "additionalRegisters": o["additionalRegisters"],
                         "creationHeight": int(o["creationHeight"]), "transactionId": o["transactionId"],
                         "index": int(o["index"])} for o in tx["outputs"]]}


def validate_engine():
    require(pathlib.Path(wt.__file__).resolve() == (ENGINE_ROOT / "wasmtime/__init__.py").resolve(),
            "wrong loaded Python engine")
    require(pathlib.Path(wt._ffi.filename).resolve() == ENGINE_DLL.resolve() and
            pathlib.Path(wt._ffi.dll._name).resolve() == ENGINE_DLL.resolve(), "wrong loaded native engine")
    require(importlib.metadata.version("wasmtime") == "48.0.0", "wrong engine version")


def engine_config():
    config = wt.Config()
    config.consume_fuel = True
    config.wasm_threads = False
    config.wasm_multi_memory = False
    config.wasm_memory64 = False
    return config


def main():
    validate_engine()
    with wt.Engine(engine_config()) as engine:
        evidence = controls(engine)
        wasm = (BASE / "node_modules/ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm").read_bytes()
        require(sha(wasm) == WASM_HASH, "wrong decoder artifact")
        start = time.perf_counter()
        with wt.Module(engine, wasm) as module:
            compile_ms = (time.perf_counter() - start) * 1000
            prepared = subprocess.run([sys.argv[1], str(BASE / "metering-fixtures.mjs")],
                                      capture_output=True, check=True, timeout=10)
            require(len(prepared.stdout) <= 1024 * 1024, "fixture output budget")
            cases = json.loads(prepared.stdout)["transactions"]
            require(len(cases) == 24, "fixture count")
            measurements = []
            start = time.perf_counter()
            for case in cases:
                data = bytes.fromhex(case["bytes"])
                try:
                    actual, measurement = decode(engine, module, data)
                except wt.Trap as error:
                    require(error.trap_code == wt.TrapCode.OUT_OF_FUEL, "unexpected decoder trap")
                    measurements.append({"fixtureId": case["expected"]["id"], "inputBytes": len(data),
                                         "status": "unresolved-fuel-refusal", "acceptedOutputs": 0,
                                         **error.metering})
                    continue
                require(fields(actual) == fields(case["expected"]), "fixture field mismatch")
                measurements.append({"id": actual["id"], "inputBytes": len(data), "status": "matched",
                                     "outputs": len(actual["outputs"]), **measurement})
            elapsed_ms = (time.perf_counter() - start) * 1000
            # Same valid input and engine; no hostile parser mutation needed.
            expect_trap(lambda: decode(engine, module, bytes.fromhex(cases[0]["bytes"]), 1),
                        wt.TrapCode.OUT_OF_FUEL)
            require(sum(len(case["expected"]["outputs"]) for case in cases) == 65, "fixture output count")
            report = {"status": "offline-metering-feasibility-only", "python": platform.python_version(),
                      "os": platform.platform(), "engine": "wasmtime 48.0.0", "wasmSha256": WASM_HASH,
                      "budgets": {"fuelPerTransaction": FUEL, "linearMemoryBytes": MEMORY,
                                  "tableElements": TABLE, "instances": 1, "memories": 1, "tables": 1,
                                  "inputBytes": 65536, "jsonBytes": OUTPUT},
                      "controls": evidence, "lowFuelValidTransaction": "OUT_OF_FUEL",
                      "hostImports": len(module.imports), "hostImportPolicy": "all trap; no guest-memory reads or JS bridge",
                      "compileMs": compile_ms, "corpusMs": elapsed_ms, "transactions": measurements}
    matched = sum(row["status"] == "matched" for row in measurements)
    report["corpus"] = {"status": "complete" if matched == len(cases) else "unresolved",
                        "matchedTransactions": matched, "refusedTransactions": len(cases) - matched,
                        "matchedOutputs": sum(row.get("outputs", 0) for row in measurements)}
    report["nativeEngineSha256"] = DLL_HASH
    files = ["metering-check.py", "metering-check.mjs", "metering-fixtures.mjs", "metering-provenance.test.py",
             "metering-requirements.txt", "package-lock.json", "fixtures/manifest.json"]
    report["files"] = {name: sha((BASE / name).read_bytes()) for name in files}
    report["engineFiles"] = {str(p.relative_to(ROOT / "scratch/metering-python")): sha(p.read_bytes())
                             for p in sorted((ROOT / "scratch/metering-python/wasmtime").rglob("*"))
                             if p.suffix in (".py", ".dll")}
    report["limitations"] = ["Fuel bounds guest metered work, not CPU seconds or host compilation/callback costs.",
                              "Linear-memory/table limits are not a total process memory or RSS ceiling.",
                              "Fixed valid fixtures only; no hostile parser depth/count/declared-size cases.",
                              "No production engine selection, node equivalence, authenticated ranges or runtime adoption."]
    print(json.dumps(report, indent=2))
    return 0 if report["corpus"]["status"] == "complete" else 2


if __name__ == "__main__":
    sys.exit(main())
