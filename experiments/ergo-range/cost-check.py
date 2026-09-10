"""Fixed valid-fixture profiling only. No supported budget or hostile-input gate.

Run through cost-check.mjs. The original trial is replayed unchanged before a
separate, predeclared 100-million-fuel diagnostic of one transaction and its
five original scripts. Never retry, refill fuel or raise that ceiling.
"""
import ctypes
from ctypes import wintypes
import json
import pathlib
import platform
import runpy
import struct
import subprocess
import sys
import time

BASE = pathlib.Path(__file__).resolve().parent
DIAGNOSTIC_FUEL = 100_000_000
BASELINE_HASH = "6095dd9dd0ef48ce83453c62ee9968e7c93d6bbf386c20a6a907bf9b5dcee5b0"
TARGET = "745e19978f4bb6d1c0ebe4f083408f3e8474b4010a88ada07f3d1fbb7ee9ac1c"


class ProcessMemory(ctypes.Structure):
    _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
        (name, ctypes.c_size_t) for name in (
            "PeakWorkingSetSize", "WorkingSetSize", "QuotaPeakPagedPoolUsage",
            "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage", "QuotaNonPagedPoolUsage",
            "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]


kernel = ctypes.WinDLL("kernel32", use_last_error=True)
kernel.GetCurrentProcess.restype = wintypes.HANDLE
psapi = ctypes.WinDLL("psapi", use_last_error=True)
psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessMemory), wintypes.DWORD]
psapi.GetProcessMemoryInfo.restype = wintypes.BOOL


def snapshot():
    counters = ProcessMemory()
    counters.cb = ctypes.sizeof(counters)
    if counters.cb != 80 or not psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
        raise RuntimeError("Windows x64 process counters unavailable")
    if not (0 < counters.PrivateUsage <= counters.PeakPagefileUsage and
            0 < counters.WorkingSetSize <= counters.PeakWorkingSetSize):
        raise RuntimeError("inconsistent process counters")
    return {"wallNs": time.perf_counter_ns(), "cpuNs": time.process_time_ns(),
            "privateBytes": counters.PrivateUsage, "lifetimePeakCommitBytes": counters.PeakPagefileUsage,
            "workingSetBytes": counters.WorkingSetSize, "lifetimePeakWorkingSetBytes": counters.PeakWorkingSetSize}


def delta(before, after):
    return {"wallNs": after["wallNs"] - before["wallNs"],
            "processCpuNs": after["cpuNs"] - before["cpuNs"], "before": before, "after": after}


class Phases:
    def __init__(self):
        self.pending = None
        self.rows = []

    def __call__(self, event):
        now = snapshot()
        if event["event"] == "before":
            if self.pending is not None:
                raise RuntimeError("overlapping measurement phases")
            self.pending = (event, now)
            return
        if self.pending is None or self.pending[0]["phase"] != event["phase"]:
            raise RuntimeError("unpaired measurement phase")
        first, before = self.pending
        self.pending = None
        fuel = None if first["fuelRemaining"] is None or event["fuelRemaining"] is None else (
            first["fuelRemaining"] - event["fuelRemaining"])
        self.rows.append({"phase": event["phase"], "outcome": event["event"], "fuel": fuel,
                          "linearMemoryBytes": event["linearMemoryBytes"], **delta(before, now)})


def main():
    start = snapshot()
    probe = runpy.run_path(str(BASE / "metering-check.py"))
    probe["validate_engine"]()
    imported = snapshot()
    wt, require = probe["wt"], probe["require"]
    baseline_bytes = (BASE.parent.parent / "docs/ergo-metering-verification.json").read_bytes()
    require(probe["sha"](baseline_bytes) == BASELINE_HASH, "wrong baseline report")
    baseline = json.loads(baseline_bytes)
    for name, expected in baseline["engineFiles"].items():
        require(probe["sha"]((probe["ENGINE_ROOT"] / name).read_bytes()) == expected, "engine file changed")
    prepared = subprocess.run([sys.argv[1], str(BASE / "metering-fixtures.mjs")],
                              capture_output=True, check=True, timeout=10)
    require(len(prepared.stdout) <= 1024 * 1024, "fixture output budget")
    cases = json.loads(prepared.stdout)["transactions"]
    require(len(cases) == 24 and sum(len(c["expected"]["outputs"]) for c in cases) == 65, "corpus changed")
    before_engine = snapshot()
    report = {"status": "offline-decoder-cost-profile-only", "acceptanceBudgetUnchanged": True,
              "python": platform.python_version(), "os": platform.platform(), "engine": "wasmtime 48.0.0",
              "wasmSha256": probe["WASM_HASH"],
              "diagnosticFuel": DIAGNOSTIC_FUEL, "baselineFuel": probe["FUEL"],
              "budgets": {"linearMemoryBytes": probe["MEMORY"], "tableElements": probe["TABLE"],
                          "instances": 1, "memories": 1, "tables": 1, "inputBytes": 65536,
                          "jsonBytes": probe["OUTPUT"], "diagnosticAttempts": 6},
              "nativeEngineSha256": probe["DLL_HASH"], "processStart": start,
              "engineImport": delta(start, imported), "fixturePreparationAfter": before_engine,
              "baseline": [], "diagnostic": []}
    with wt.Engine(probe["engine_config"]()) as engine:
        engine_ready = snapshot()
        report["engineCreation"] = delta(before_engine, engine_ready)
        wasm = (BASE / "node_modules/ergo-lib-wasm-nodejs/ergo_lib_wasm_bg.wasm").read_bytes()
        require(probe["sha"](wasm) == probe["WASM_HASH"], "wrong decoder artifact")
        before_compile = snapshot()
        with wt.Module(engine, wasm) as module:
            compiled = snapshot()
            report["compile"] = delta(before_compile, compiled)

            def transaction(case, fuel):
                phases = Phases()
                data = bytes.fromhex(case["bytes"])
                before = snapshot()
                try:
                    actual, measurement = probe["decode"](engine, module, data, fuel, phases)
                except wt.Trap as error:
                    require(error.trap_code == wt.TrapCode.OUT_OF_FUEL, "unexpected transaction trap")
                    result = {"status": "unresolved-fuel-refusal", "acceptedOutputs": 0, **error.metering}
                else:
                    require(probe["fields"](actual) == probe["fields"](case["expected"]), "field mismatch")
                    result = {"status": "matched", "outputs": len(actual["outputs"]), **measurement}
                require(phases.pending is None, "unfinished phase")
                require(sum(row["fuel"] or 0 for row in phases.rows) == result["fuelConsumed"], "fuel phase mismatch")
                return {"fixtureId": case["expected"]["id"], "fuelBudget": fuel,
                        "inputBytes": len(data),
                        **result, "attempt": delta(before, snapshot()), "phases": phases.rows}

            require(len(baseline["transactions"]) == len(cases), "baseline count changed")
            for case, original in zip(cases, baseline["transactions"]):
                row = transaction(case, probe["FUEL"])
                require(row["fixtureId"] == original.get("id", original.get("fixtureId")), "baseline order changed")
                for field in ("status", "inputBytes", "fuelConsumed", "memoryBytes", "jsonBytes", "outputs", "acceptedOutputs", "phase"):
                    if field in original:
                        require(row[field] == original[field], f"baseline {field} changed")
                report["baseline"].append(row)
            target = next(c for c in cases if c["expected"]["id"] == TARGET)
            require(len(target["expected"]["outputs"]) == 5, "target outputs changed")
            report["diagnostic"].append(transaction(target, DIAGNOSTIC_FUEL))

            # Original committed scripts only; separate Stores identify whether
            # script parsing alone explains the high transaction parsing cost.
            for position, output in enumerate(target["expected"]["outputs"]):
                data = bytes.fromhex(output["ergoTree"])
                require(0 < len(data) <= 65536, "script input budget")
                before = snapshot()
                with probe["store_for"](engine, fuel=DIAGNOSTIC_FUEL) as store:
                    def refuse(*_args):
                        raise wt.Trap("host import refused")
                    imports = [wt.Func(store, item.type, refuse) for item in module.imports]
                    exports = wt.Instance(store, module, imports).exports(store)
                    memory = exports["memory"]
                    area = exports["__wbindgen_add_to_stack_pointer"](store, -16)
                    pointer = exports["__wbindgen_malloc"](store, len(data), 1)
                    require(0 <= pointer <= memory.data_len(store) - len(data), "script input bounds")
                    memory.write(store, data, pointer)
                    before_parse = store.get_fuel()
                    parse_fuel = None
                    phase = "ergotree_from_bytes"
                    try:
                        exports["ergotree_from_bytes"](store, area, pointer, len(data))
                        parse_fuel = before_parse - store.get_fuel()
                        require(0 <= area <= memory.data_len(store) - 16, "script return bounds")
                        obj, _err, failed = struct.unpack("<III", memory.read(store, area, area + 12))
                        require(failed == 0 and obj != 0, "script parser error")
                        phase = "ergotree_sigma_serialize_bytes"
                        exports[phase](store, area, obj)
                        ptr, length, _err, failed = struct.unpack("<IIII", memory.read(store, area, area + 16))
                        require(failed == 0 and length == len(data) and 0 <= ptr <= memory.data_len(store) - length,
                                "script serialization bounds")
                        require(bytes(memory.read(store, ptr, ptr + length)) == data, "script roundtrip mismatch")
                    except wt.Trap as error:
                        require(error.trap_code == wt.TrapCode.OUT_OF_FUEL and store.get_fuel() == 0,
                                "unexpected script trap")
                        status = "unresolved-fuel-refusal"
                    else:
                        status = "roundtrip-only"
                    report["diagnostic"].append({"scriptPosition": position, "inputBytes": len(data),
                        "sha256": probe["sha"](data), "status": status, "fuelBudget": DIAGNOSTIC_FUEL,
                        "parseFuel": parse_fuel, "lastPhase": phase,
                        "fuelConsumed": DIAGNOSTIC_FUEL - store.get_fuel(), "memoryBytes": memory.data_len(store)})
                report["diagnostic"][-1]["attempt"] = delta(before, snapshot())
    report["afterEngineClose"] = snapshot()
    require(report["acceptanceBudgetUnchanged"] and probe["FUEL"] == 10_000_000, "baseline limit changed")
    report["files"] = {name: probe["sha"]((BASE / name).read_bytes()) for name in (
        "cost-check.py", "cost-check.mjs", "cost-observer.test.py", "metering-check.py", "metering-fixtures.mjs",
        "metering-requirements.txt", "package-lock.json", "fixtures/manifest.json")}
    report["baselineReportSha256"] = BASELINE_HASH
    report["engineFiles"] = baseline["engineFiles"]
    report["limitations"] = ["Diagnostic ceiling is not an accepted transaction budget; baseline refusal remains unresolved.",
        "Memory counters and process CPU are measurements, not enforcement or a worst-case bound.",
        "Lifetime peaks include earlier phases; no per-phase allocation peak attribution or subtraction of guest memory.",
        "Python process counters omit fixture-preparation child and launcher costs; wall timings include instrumentation.",
        "Process CPU readings are quantized; a zero phase delta is not evidence of zero CPU work.",
        "Roundtripped scripts may contain opaque Unparsed representations; no script validation/equivalence claim.",
        "No hostile parser inputs, production boundary or authenticated-range evidence."]
    print(json.dumps(report, indent=2))
    return 2  # This profiling run never clears the baseline's unresolved corpus.


if __name__ == "__main__":
    sys.exit(main())
