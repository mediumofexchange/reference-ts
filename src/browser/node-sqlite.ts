// node:sqlite's `DatabaseSync` and `StatementSync` in a browser engine (slice 39), over SQLite's own WebAssembly
// build, for the browser bundle (scripts/browser/build.mjs substitutes this module for node:sqlite). The stores are
// written against node:sqlite; this gives them the same surface with the same semantics, so one store implementation
// serves both hosts:
// - a JavaScript number binds as REAL, a bigint as INTEGER, a boolean as 0 or 1, a string as TEXT, bytes as a BLOB and
//   null as NULL; undefined, and anything else, is refused;
// - an INTEGER reads as a number, or a bigint under `readBigInts`, and a number outside the safe range is refused
//   (ERR_OUT_OF_RANGE); a REAL as a number, TEXT as a string, a BLOB as a Uint8Array copy, NULL as null;
// - a first argument that is an object binds named parameters by their bare names, the rest bind in order to the
//   anonymous ones (`?` and `?NNN`); a name the statement lacks is refused;
// - rows are objects with no prototype; a failure is an Error with code ERR_SQLITE_ERROR and SQLite's extended
//   result code (`errcode`) and its text (`errstr`), the message SQLite's own;
// - foreign keys are enforced and extended result codes reported, as node:sqlite does by default.
// The browser host keeps no database files (slice 39's stop): only `:memory:` and the anonymous temporary database
// open; any other path is refused as SQLite refuses a file it cannot open (SQLITE_CANTOPEN), so a kept file's opening
// fails visibly, as a failure of the system, never as damage to discard (replay-store.ts `systemFailure`).
// test/browser-host.test.ts and the equivalence run (vitest.browser-host.config.ts) hold it to node:sqlite's behaviour.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const sqlite3 = await sqlite3InitModule();
const { capi, wasm } = sqlite3;

/** SQLite's primary result code for a file it cannot open. */
const SQLITE_CANTOPEN = 14;

type Pointer = number;
export type SQLInputValue = null | number | bigint | string | boolean | ArrayBufferView;
export type SQLOutputValue = null | number | bigint | string | Uint8Array;

interface SqliteError extends Error { code: string; errcode: number; errstr: string }

function sqliteError(message: string, errcode: number): SqliteError {
  return Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode, errstr: capi.sqlite3_errstr(errcode) });
}
const failure = (db: Pointer): SqliteError => sqliteError(capi.sqlite3_errmsg(db), capi.sqlite3_extended_errcode(db));

/** UTF-8 or raw bytes copied into WebAssembly memory, which SQLite frees once it is done with them. */
function copied(bytes: Uint8Array): Pointer {
  const at = wasm.alloc(Math.max(1, bytes.length)) as Pointer;
  wasm.heap8u().set(bytes, at);
  return at;
}
const ENCODER = new TextEncoder();
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER), MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

export class StatementSync {
  readonly #db: Pointer;
  readonly #statement: Pointer;
  #bigints: boolean;
  readonly #live: () => void;

  /** @internal */
  constructor(db: Pointer, statement: Pointer, bigints: boolean, live: () => void) {
    this.#db = db; this.#statement = statement; this.#bigints = bigints; this.#live = live;
  }

  setReadBigInts(enabled: boolean): void { this.#bigints = enabled === true; }

  #bind(args: readonly unknown[]): void {
    this.#live();
    const s = this.#statement;
    capi.sqlite3_reset(s);
    capi.sqlite3_clear_bindings(s);
    let anonymous = args;
    const first = args[0];
    if (first !== null && typeof first === "object" && !ArrayBuffer.isView(first)) {
      anonymous = args.slice(1);
      const names = new Map<string, number>();
      for (let i = 1, count = capi.sqlite3_bind_parameter_count(s); i <= count; i++) {
        const name = capi.sqlite3_bind_parameter_name(s, i);
        if (name && name[0] !== "?") names.set(name.slice(1), i);
      }
      for (const [key, value] of Object.entries(first)) {
        const index = names.get(key);
        if (index === undefined) throw Object.assign(new Error(`Unknown named parameter '${key}'`), { code: "ERR_INVALID_STATE" });
        this.#value(index, value);
      }
    }
    let index = 1;
    for (const value of anonymous) {
      for (let name = capi.sqlite3_bind_parameter_name(s, index); name && name[0] !== "?"; name = capi.sqlite3_bind_parameter_name(s, ++index));
      this.#value(index++, value);
    }
  }

  #value(index: number, value: unknown): void {
    const s = this.#statement;
    let rc: number;
    // NULL needs no call: clear_bindings left every parameter NULL.
    if (value === null) rc = 0;
    else if (typeof value === "number") rc = capi.sqlite3_bind_double(s, index, value);
    else if (typeof value === "bigint") {
      if (value > 0x7fffffffffffffffn || value < -0x8000000000000000n) {
        throw Object.assign(new RangeError(`BigInt value is too large to bind to SQLite parameter ${index}`), { code: "ERR_INVALID_ARG_VALUE" });
      }
      rc = capi.sqlite3_bind_int64(s, index, value);
    } else if (typeof value === "boolean") rc = capi.sqlite3_bind_int(s, index, value ? 1 : 0);
    else if (typeof value === "string") {
      const bytes = ENCODER.encode(value);
      rc = capi.sqlite3_bind_text(s, index, copied(bytes), bytes.length, capi.SQLITE_WASM_DEALLOC);
    } else if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      rc = capi.sqlite3_bind_blob(s, index, copied(bytes), bytes.length, capi.SQLITE_WASM_DEALLOC);
    } else throw Object.assign(new TypeError(`Provided value cannot be bound to SQLite parameter ${index}.`), { code: "ERR_INVALID_ARG_TYPE" });
    if (rc !== 0) throw failure(this.#db);
  }

  /** One step: true at a row, false when done; a failure resets the statement and is thrown. */
  #step(): boolean {
    const rc = capi.sqlite3_step(this.#statement);
    if (rc === capi.SQLITE_ROW) return true;
    if (rc === capi.SQLITE_DONE) return false;
    const error = failure(this.#db);
    capi.sqlite3_reset(this.#statement);
    throw error;
  }

  #row(): Record<string, SQLOutputValue> {
    const s = this.#statement, row: Record<string, SQLOutputValue> = Object.create(null);
    for (let i = 0, n = capi.sqlite3_column_count(s); i < n; i++) {
      const name = capi.sqlite3_column_name(s, i) as string;
      switch (capi.sqlite3_column_type(s, i)) {
        case capi.SQLITE_INTEGER: {
          const value = BigInt(capi.sqlite3_column_int64(s, i));
          if (this.#bigints) row[name] = value;
          else if (value > MAX_SAFE || value < MIN_SAFE) {
            throw Object.assign(new RangeError(`Value is too large to be represented as a JavaScript number: ${value}`), { code: "ERR_OUT_OF_RANGE" });
          } else row[name] = Number(value);
          break;
        }
        case capi.SQLITE_FLOAT: row[name] = capi.sqlite3_column_double(s, i); break;
        case capi.SQLITE_TEXT: row[name] = capi.sqlite3_column_text(s, i) as string; break;
        case capi.SQLITE_BLOB: {
          const length = capi.sqlite3_column_bytes(s, i), at = capi.sqlite3_column_blob(s, i) as Pointer;
          row[name] = length === 0 ? new Uint8Array(0) : wasm.heap8u().slice(at, at + length);
          break;
        }
        default: row[name] = null;
      }
    }
    return row;
  }

  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    this.#bind(args);
    try { while (this.#step()); } finally { capi.sqlite3_reset(this.#statement); }
    const changes = BigInt(capi.sqlite3_changes64(this.#db)), id = BigInt(capi.sqlite3_last_insert_rowid(this.#db));
    return this.#bigints ? { changes, lastInsertRowid: id } : { changes: Number(changes), lastInsertRowid: Number(id) };
  }

  get(...args: unknown[]): Record<string, SQLOutputValue> | undefined {
    this.#bind(args);
    try { return this.#step() ? this.#row() : undefined; } finally { capi.sqlite3_reset(this.#statement); }
  }

  all(...args: unknown[]): Record<string, SQLOutputValue>[] {
    this.#bind(args);
    const rows: Record<string, SQLOutputValue>[] = [];
    try { while (this.#step()) rows.push(this.#row()); } finally { capi.sqlite3_reset(this.#statement); }
    return rows;
  }

  *iterate(...args: unknown[]): IterableIterator<Record<string, SQLOutputValue>> {
    this.#bind(args);
    try { while (this.#step()) yield this.#row(); } finally { capi.sqlite3_reset(this.#statement); }
  }
}

export interface DatabaseSyncOptions {
  readonly open?: boolean;
  readonly readOnly?: boolean;
  readonly timeout?: number;
  readonly readBigInts?: boolean;
}

export class DatabaseSync {
  #db: Pointer = 0;
  readonly #bigints: boolean;
  readonly #statements = new Set<Pointer>();

  constructor(path: string, options: DatabaseSyncOptions = {}) {
    if (typeof path !== "string") throw Object.assign(new TypeError("The \"path\" argument must be a string"), { code: "ERR_INVALID_ARG_TYPE" });
    if (options.open === false) throw new TypeError("a browser host opens a database as it is made");
    this.#bigints = options.readBigInts === true;
    // The host keeps no database files: a path is refused as SQLite refuses a file it cannot open.
    if (path !== ":memory:" && path !== "") throw sqliteError(`a browser host keeps no database files: ${path}`, SQLITE_CANTOPEN);
    const flags = options.readOnly === true ? capi.SQLITE_OPEN_READONLY : capi.SQLITE_OPEN_READWRITE | capi.SQLITE_OPEN_CREATE;
    const stack = wasm.pstack.pointer;
    try {
      const out = wasm.pstack.allocPtr() as Pointer;
      const rc = capi.sqlite3_open_v2(path, out, flags, 0);
      const db = wasm.peekPtr(out) as Pointer;
      if (rc !== 0) {
        const error = db === 0 ? sqliteError(capi.sqlite3_errstr(rc), rc) : failure(db);
        if (db !== 0) capi.sqlite3_close_v2(db);
        throw error;
      }
      this.#db = db;
    } finally { wasm.pstack.restore(stack); }
    capi.sqlite3_extended_result_codes(this.#db, 1);
    capi.sqlite3_busy_timeout(this.#db, options.timeout ?? 0);
    this.exec("PRAGMA foreign_keys = ON");
  }

  get isOpen(): boolean { return this.#db !== 0; }
  get isTransaction(): boolean { return capi.sqlite3_get_autocommit(this.#open()) === 0; }

  #open(): Pointer {
    if (this.#db === 0) throw Object.assign(new Error("database is not open"), { code: "ERR_INVALID_STATE" });
    return this.#db;
  }

  exec(sql: string): void {
    const db = this.#open();
    if (capi.sqlite3_exec(db, sql, 0, 0, 0) !== 0) throw failure(db);
  }

  prepare(sql: string): StatementSync {
    const db = this.#open(), stack = wasm.pstack.pointer;
    try {
      const out = wasm.pstack.allocPtr() as Pointer;
      if (capi.sqlite3_prepare_v2(db, sql, -1, out, 0) !== 0) throw failure(db);
      const statement = wasm.peekPtr(out) as Pointer;
      this.#statements.add(statement);
      return new StatementSync(db, statement, this.#bigints, () => { this.#open(); });
    } finally { wasm.pstack.restore(stack); }
  }

  close(): void {
    const db = this.#open();
    for (const statement of this.#statements) capi.sqlite3_finalize(statement);
    this.#statements.clear();
    this.#db = 0;
    const rc = capi.sqlite3_close_v2(db);
    if (rc !== 0) throw sqliteError(capi.sqlite3_errstr(rc), rc);
  }
}

export default { DatabaseSync, StatementSync };
