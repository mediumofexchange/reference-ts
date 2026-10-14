// node:sqlite's `DatabaseSync` and `StatementSync` in a browser engine (slice 39), over SQLite's own WebAssembly
// build, for the browser bundle (scripts/browser/build.mjs substitutes this module for node:sqlite). The stores are
// written against node:sqlite; this gives them the same surface with the same semantics (Node 24.21's), so one store
// implementation serves both hosts:
// - a JavaScript number binds as REAL, a bigint as INTEGER, a boolean as 0 or 1, a string as TEXT, bytes as a BLOB and
//   null as NULL; undefined, and anything else, is refused;
// - an INTEGER reads as a number, or a bigint under `readBigInts`, and a number outside the safe range is refused
//   (ERR_OUT_OF_RANGE); a REAL as a number, TEXT as a string, a BLOB as a Uint8Array copy, NULL as null;
// - a first argument that is an object binds named parameters, by their bare names or with their prefix; a bare name
//   two prefixes share and a name the statement lacks are refused; the rest bind in order to the anonymous ones
//   (`?` and `?NNN`);
// - `run` steps once, `get` reads the first row, `all` every row; `iterate` binds at once, and running its statement
//   again invalidates it;
// - a statement is finalized when it is collected, as Node's is, or when its database closes, after which it refuses;
// - rows are objects with no prototype; a failure is an Error with code ERR_SQLITE_ERROR and SQLite's extended
//   result code (`errcode`) and its text (`errstr`), the message SQLite's own; argument and state refusals carry
//   Node's codes and messages;
// - foreign keys are enforced and extended result codes reported, as node:sqlite does by default.
// The browser host keeps no database files (slice 39's stop): only `:memory:` and the anonymous temporary database
// open, and any other path is refused as SQLite refuses a file it cannot open (SQLITE_CANTOPEN), so a kept file's opening
// fails visibly, as a failure of the system, never as damage to discard (replay-store.ts `systemFailure`). No caller
// attaches a database or vacuums into one, which would open a file in SQLite's own virtual file system.
// test/browser-host.test.ts and the equivalence run (vitest.browser-host.config.ts) hold it to node:sqlite's behaviour.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";

const sqlite3 = await sqlite3InitModule();
const { capi, wasm } = sqlite3;

/** SQLite's primary result code for a file it cannot open. */
const SQLITE_CANTOPEN = 14;

type Pointer = number;
export type SQLInputValue = null | number | bigint | string | boolean | ArrayBufferView;
export type SQLOutputValue = null | number | bigint | string | Uint8Array;
type Row = Record<string, SQLOutputValue>;

interface SqliteError extends Error { code: string; errcode: number; errstr: string }

function sqliteError(message: string, errcode: number): SqliteError {
  return Object.assign(new Error(message), { code: "ERR_SQLITE_ERROR", errcode, errstr: capi.sqlite3_errstr(errcode) });
}
const failure = (db: Pointer): SqliteError => sqliteError(capi.sqlite3_errmsg(db), capi.sqlite3_extended_errcode(db));
const invalidState = (message: string): Error => Object.assign(new Error(message), { code: "ERR_INVALID_STATE" });

/** UTF-8 or raw bytes copied into WebAssembly memory, which SQLite frees once it is done with them. */
function copied(bytes: Uint8Array): Pointer {
  const at = wasm.alloc(Math.max(1, bytes.length)) as Pointer;
  wasm.heap8u().set(bytes, at);
  return at;
}
const ENCODER = new TextEncoder();
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER), MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/** What a database shares with its statements: its handle while open, and the statements not yet finalized. */
interface Connection { db: Pointer; readonly statements: Set<Pointer> }

/** A statement no wrapper reaches any more is finalized, as Node's are when collected: without this, every prepare of
 * a long walk would hold its statement in WebAssembly memory until the database closed. */
const collected = new FinalizationRegistry<{ readonly connection: Connection; readonly statement: Pointer }>(({ connection, statement }) => {
  if (connection.db !== 0 && connection.statements.delete(statement)) capi.sqlite3_finalize(statement);
});

export class StatementSync {
  readonly #connection: Connection;
  readonly #statement: Pointer;
  #bigints: boolean;
  /** Counts the statement's executions: an iterator stands only while its own execution is the latest. */
  #execution = 0;

  /** @internal */
  constructor(connection: Connection, statement: Pointer, bigints: boolean) {
    this.#connection = connection; this.#statement = statement; this.#bigints = bigints;
  }

  setReadBigInts(enabled: boolean): void { this.#live(); this.#bigints = enabled === true; }

  #live(): Pointer {
    if (this.#connection.db === 0 || !this.#connection.statements.has(this.#statement)) throw invalidState("statement has been finalized");
    return this.#connection.db;
  }

  /** A new execution: reset, bindings cleared and the arguments bound. */
  #bind(args: readonly unknown[]): void {
    this.#live();
    const s = this.#statement;
    this.#execution++;
    capi.sqlite3_reset(s);
    capi.sqlite3_clear_bindings(s);
    let anonymous = args;
    const first = args[0];
    if (first !== null && typeof first === "object" && !ArrayBuffer.isView(first)) {
      anonymous = args.slice(1);
      // As Node: any named binding first maps the statement's bare names, refusing one two prefixes share.
      const bare = new Map<string, { readonly index: number; readonly name: string }>();
      for (let i = 1, count = capi.sqlite3_bind_parameter_count(s); i <= count; i++) {
        const name = capi.sqlite3_bind_parameter_name(s, i);
        if (!name || name[0] === "?") continue;
        const known = bare.get(name.slice(1));
        if (known !== undefined && known.name !== name) {
          throw invalidState(`Cannot create bare named parameter '${name.slice(1)}' because of conflicting names '${known.name}' and '${name}'.`);
        }
        bare.set(name.slice(1), { index: i, name });
      }
      for (const [key, value] of Object.entries(first)) {
        const index = ":$@".includes(key[0] ?? "") ? capi.sqlite3_bind_parameter_index(s, key) : bare.get(key)?.index ?? 0;
        if (index === 0) throw invalidState(`Unknown named parameter '${key}'`);
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
    if (rc !== 0) throw failure(this.#connection.db);
  }

  /** One step: true at a row, false when done; a failure resets the statement and is thrown. */
  #step(): boolean {
    const rc = capi.sqlite3_step(this.#statement);
    if (rc === capi.SQLITE_ROW) return true;
    if (rc === capi.SQLITE_DONE) return false;
    const error = failure(this.#connection.db);
    capi.sqlite3_reset(this.#statement);
    throw error;
  }

  #row(): Row {
    const s = this.#statement, row: Row = Object.create(null);
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

  /** One step, as Node's: a statement's changes are made on its first step, and rows after it are not read. */
  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint } {
    this.#bind(args);
    try { this.#step(); } finally { capi.sqlite3_reset(this.#statement); }
    const db = this.#connection.db, changes = BigInt(capi.sqlite3_changes64(db)), id = BigInt(capi.sqlite3_last_insert_rowid(db));
    return this.#bigints ? { changes, lastInsertRowid: id } : { changes: Number(changes), lastInsertRowid: Number(id) };
  }

  get(...args: unknown[]): Row | undefined {
    this.#bind(args);
    try { return this.#step() ? this.#row() : undefined; } finally { capi.sqlite3_reset(this.#statement); }
  }

  all(...args: unknown[]): Row[] {
    this.#bind(args);
    const rows: Row[] = [];
    try { while (this.#step()) rows.push(this.#row()); } finally { capi.sqlite3_reset(this.#statement); }
    return rows;
  }

  /** Bound now; each row read as the iterator is advanced, until another execution of the statement invalidates it. */
  iterate(...args: unknown[]): IterableIterator<Row> {
    this.#bind(args);
    const execution = this.#execution, self = this;
    return (function* rows(): Generator<Row, null, undefined> {
      try {
        for (;;) {
          self.#live();
          if (self.#execution !== execution) throw invalidState("iterator was invalidated");
          if (!self.#step()) return null;
          yield self.#row();
        }
      } finally {
        // An invalidated iterator leaves the newer execution as it is.
        if (self.#execution === execution && self.#connection.db !== 0 && self.#connection.statements.has(self.#statement)) capi.sqlite3_reset(self.#statement);
      }
    })();
  }
}

export interface DatabaseSyncOptions {
  readonly open?: boolean;
  readonly readOnly?: boolean;
  readonly timeout?: number;
  readonly readBigInts?: boolean;
}

export class DatabaseSync {
  readonly #connection: Connection = { db: 0, statements: new Set<Pointer>() };
  readonly #bigints: boolean;

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
      this.#connection.db = db;
    } finally { wasm.pstack.restore(stack); }
    capi.sqlite3_extended_result_codes(this.#connection.db, 1);
    capi.sqlite3_busy_timeout(this.#connection.db, options.timeout ?? 0);
    this.exec("PRAGMA foreign_keys = ON");
  }

  get isOpen(): boolean { return this.#connection.db !== 0; }
  get isTransaction(): boolean { return capi.sqlite3_get_autocommit(this.#open()) === 0; }

  #open(): Pointer {
    if (this.#connection.db === 0) throw invalidState("database is not open");
    return this.#connection.db;
  }

  exec(sql: string): void {
    const db = this.#open();
    if (capi.sqlite3_exec(db, sql, 0, 0, 0) !== 0) throw failure(db);
  }

  prepare(sql: string): StatementSync {
    const db = this.#open(), stack = wasm.pstack.pointer;
    let statement: Pointer;
    try {
      const out = wasm.pstack.allocPtr() as Pointer;
      if (capi.sqlite3_prepare_v2(db, sql, -1, out, 0) !== 0) throw failure(db);
      statement = wasm.peekPtr(out) as Pointer;
    } finally { wasm.pstack.restore(stack); }
    if (statement === 0) throw Object.assign(new TypeError("The SQL query contains no statements."), { code: "ERR_INVALID_ARG_VALUE" });
    this.#connection.statements.add(statement);
    const wrapper = new StatementSync(this.#connection, statement, this.#bigints);
    collected.register(wrapper, { connection: this.#connection, statement });
    return wrapper;
  }

  close(): void {
    const db = this.#open();
    for (const statement of this.#connection.statements) capi.sqlite3_finalize(statement);
    this.#connection.statements.clear();
    this.#connection.db = 0;
    const rc = capi.sqlite3_close_v2(db);
    if (rc !== 0) throw sqliteError(capi.sqlite3_errstr(rc), rc);
  }
}

export default { DatabaseSync, StatementSync };
