// node:sqlite's `DatabaseSync` and `StatementSync` in a browser engine (slice 39), over SQLite's own WebAssembly
// build, for the browser bundle (scripts/browser/build.mjs substitutes this module for node:sqlite). The stores are
// written against node:sqlite; this gives them the same surface with the same semantics (Node 24.21's), so one store
// implementation serves both hosts:
// - a JavaScript number binds as REAL, a bigint as INTEGER, a boolean as 0 or 1, a string as TEXT, bytes as a BLOB and
//   null as NULL; undefined, and anything else, is refused;
// - an INTEGER reads as a number, or a bigint under `readBigInts`, and a number outside the safe range is refused
//   (ERR_OUT_OF_RANGE); a REAL as a number, TEXT as a string, a BLOB as a Uint8Array copy, NULL as null;
// - a first argument that is an object binds named parameters (`?NNN` among them), by their bare names or with their
//   prefix; a bare name two prefixes share and a name the statement lacks are refused; the rest bind in order to the
//   anonymous ones (`?` and `?NNN`);
// - `run` steps once, `get` reads the first row, `all` every row; `iterate` binds at once, reads lazily, goes on past a
//   row it could not read, and is invalidated when its statement runs again;
// - rows are objects with no prototype; a failure is an Error with code ERR_SQLITE_ERROR and SQLite's extended
//   result code (`errcode`) and its text (`errstr`), the message SQLite's own; argument and state refusals carry
//   Node's codes and messages;
// - foreign keys are enforced and extended result codes reported, as node:sqlite does by default.
// A `StatementSync` holds no SQLite statement of its own: each execution takes one, compiled from the same text, from
// its connection's pool and returns it when done, so memory follows the distinct texts in use and the executions in
// flight, not the statement objects a walk has made, whether or not the engine has collected them yet.
// A database path opens on the worker's file pool once it is mounted (files.ts, sqlite-files.ts: slice 40), with a
// write-ahead log as on Node. Before that the host keeps no database files (slice 39): only `:memory:` and the
// anonymous temporary database open, and any other path is refused as SQLite refuses a file it cannot open
// (SQLITE_CANTOPEN), so a kept file's opening fails visibly, as a failure of the system, never as damage to discard
// (replay-store.ts `systemFailure`). No caller attaches a database or vacuums into one.
// test/browser-host.test.ts and the equivalence run (vitest.browser-host.config.ts) hold it to node:sqlite's behaviour.
import sqlite3InitModule from "@sqlite.org/sqlite-wasm";
import { isMounted } from "./files.js";
import { installFilesVfs } from "./sqlite-files.js";

const sqlite3 = await sqlite3InitModule();
const { capi, wasm } = sqlite3;

/** SQLite's primary result code for a file it cannot open. */
const SQLITE_CANTOPEN = 14;
/** Compiled statements a connection keeps idle for reuse, the least recently used text's dropped first, and of one text. */
const IDLE_STATEMENTS = 256, IDLE_PER_TEXT = 4;

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
const argumentType = (message: string): TypeError => Object.assign(new TypeError(message), { code: "ERR_INVALID_ARG_TYPE" });

/** UTF-8 or raw bytes copied into WebAssembly memory, which SQLite frees once it is done with them. */
function copied(bytes: Uint8Array): Pointer {
  const at = wasm.alloc(Math.max(1, bytes.length)) as Pointer;
  wasm.heap8u().set(bytes, at);
  return at;
}
const ENCODER = new TextEncoder();
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER), MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
const ITERATOR = Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())) as object;

/** A connection's handle while open, and its compiled statements: idle ones by text, and those an execution holds. */
interface Connection {
  db: Pointer;
  readonly idle: Map<string, Pointer[]>;
  idleCount: number;
  readonly busy: Set<Pointer>;
}

/** A compiled statement for `sql`, idle or new; the caller returns it with `release`. */
function acquire(connection: Connection, sql: string): Pointer {
  const idle = connection.idle.get(sql);
  if (idle !== undefined && idle.length > 0) {
    connection.idleCount--;
    const statement = idle.pop()!;
    connection.busy.add(statement);
    return statement;
  }
  return compile(connection, sql);
}

/** A newly compiled statement for `sql`, held as `acquire`'s are. */
function compile(connection: Connection, sql: string): Pointer {
  const db = connection.db, stack = wasm.pstack.pointer;
  let statement: Pointer;
  try {
    const out = wasm.pstack.allocPtr() as Pointer;
    if (capi.sqlite3_prepare_v2(db, sql, -1, out, 0) !== 0) throw failure(db);
    statement = wasm.peekPtr(out) as Pointer;
  } finally { wasm.pstack.restore(stack); }
  if (statement === 0) throw Object.assign(new TypeError("The SQL query contains no statements."), { code: "ERR_INVALID_ARG_VALUE" });
  connection.busy.add(statement);
  return statement;
}

/** A statement back to its connection's pool, reset with its bindings cleared; nothing once the connection closed. */
function release(connection: Connection, sql: string, statement: Pointer): void {
  if (connection.db === 0 || !connection.busy.delete(statement)) return;
  capi.sqlite3_reset(statement);
  capi.sqlite3_clear_bindings(statement);
  const idle = connection.idle.get(sql) ?? [];
  connection.idle.delete(sql);
  connection.idle.set(sql, idle);
  // Every prepare compiles, so one text's idle copies are bounded too.
  if (idle.length >= IDLE_PER_TEXT) { capi.sqlite3_finalize(statement); return; }
  idle.push(statement);
  connection.idleCount++;
  for (const [text, statements] of connection.idle) {
    if (connection.idleCount <= IDLE_STATEMENTS) break;
    while (statements.length > 0 && connection.idleCount > IDLE_STATEMENTS) { capi.sqlite3_finalize(statements.shift()!); connection.idleCount--; }
    if (statements.length === 0) connection.idle.delete(text);
  }
}

/** An iteration's statement, returned to the pool if the iterator is abandoned and collected while the connection lives. */
interface Held { statement: Pointer; released: boolean }
const abandoned = new FinalizationRegistry<{ readonly connection: Connection; readonly sql: string; readonly held: Held }>(({ connection, sql, held }) => {
  if (!held.released) { held.released = true; release(connection, sql, held.statement); }
});

export class StatementSync {
  readonly #connection: Connection;
  readonly #sql: string;
  #bigints: boolean;
  /** Counts the statement's executions: an iterator stands only while its own execution is the latest. */
  #execution = 0;
  /** Ends the latest iteration's hold on its statement: a new execution resets the old cursor, as Node's does. */
  #iteration: (() => void) | undefined;

  /** @internal */
  constructor(connection: Connection, sql: string, bigints: boolean) {
    this.#connection = connection; this.#sql = sql; this.#bigints = bigints;
  }

  setReadBigInts(enabled: boolean): void {
    this.#live();
    if (typeof enabled !== "boolean") throw argumentType("The \"readBigInts\" argument must be a boolean.");
    this.#bigints = enabled;
  }

  #live(): void {
    if (this.#connection.db === 0) throw invalidState("statement has been finalized");
  }

  /** A new execution on a statement from the pool, bound to `args`; the caller releases it. */
  #start(args: readonly unknown[]): Pointer {
    this.#live();
    this.#execution++;
    this.#iteration?.();
    this.#iteration = undefined;
    const statement = acquire(this.#connection, this.#sql);
    try { this.#bind(statement, args); } catch (error) { release(this.#connection, this.#sql, statement); throw error; }
    return statement;
  }

  #bind(s: Pointer, args: readonly unknown[]): void {
    let anonymous = args;
    const first = args[0];
    if (first !== null && typeof first === "object" && !ArrayBuffer.isView(first)) {
      anonymous = args.slice(1);
      // As Node: any named binding first maps the statement's bare names, `?NNN` too, refusing one two prefixes share.
      const bare = new Map<string, { readonly index: number; readonly name: string }>();
      for (let i = 1, count = capi.sqlite3_bind_parameter_count(s); i <= count; i++) {
        const name = capi.sqlite3_bind_parameter_name(s, i);
        if (!name || name.length < 2) continue;
        const known = bare.get(name.slice(1));
        if (known !== undefined && known.name !== name) {
          throw invalidState(`Cannot create bare named parameter '${name.slice(1)}' because of conflicting names '${known.name}' and '${name}'.`);
        }
        bare.set(name.slice(1), { index: i, name });
      }
      for (const [key, value] of Object.entries(first)) {
        const index = ":$@?".includes(key[0] ?? "") ? capi.sqlite3_bind_parameter_index(s, key) : bare.get(key)?.index ?? 0;
        if (index === 0) throw invalidState(`Unknown named parameter '${key}'`);
        this.#value(s, index, value);
      }
    }
    let index = 1;
    for (const value of anonymous) {
      for (let name = capi.sqlite3_bind_parameter_name(s, index); name && name[0] !== "?"; name = capi.sqlite3_bind_parameter_name(s, ++index));
      this.#value(s, index++, value);
    }
  }

  #value(s: Pointer, index: number, value: unknown): void {
    let rc: number;
    // NULL needs no call: clear_bindings left every parameter NULL.
    if (value === null) rc = 0;
    else if (typeof value === "number") rc = capi.sqlite3_bind_double(s, index, value);
    else if (typeof value === "bigint") {
      if (value > 0x7fffffffffffffffn || value < -0x8000000000000000n) {
        throw Object.assign(new TypeError("BigInt value is too large to bind."), { code: "ERR_INVALID_ARG_VALUE" });
      }
      rc = capi.sqlite3_bind_int64(s, index, value);
    } else if (typeof value === "boolean") rc = capi.sqlite3_bind_int(s, index, value ? 1 : 0);
    else if (typeof value === "string") {
      const bytes = ENCODER.encode(value);
      rc = capi.sqlite3_bind_text(s, index, copied(bytes), bytes.length, capi.SQLITE_WASM_DEALLOC);
    } else if (ArrayBuffer.isView(value)) {
      const bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
      rc = capi.sqlite3_bind_blob(s, index, copied(bytes), bytes.length, capi.SQLITE_WASM_DEALLOC);
    } else throw argumentType(`Provided value cannot be bound to SQLite parameter ${index}.`);
    if (rc !== 0) throw failure(this.#connection.db);
  }

  /** One step: true at a row, false when done; a failure resets the statement and is thrown. */
  #step(s: Pointer): boolean {
    const rc = capi.sqlite3_step(s);
    if (rc === capi.SQLITE_ROW) return true;
    if (rc === capi.SQLITE_DONE) return false;
    const error = failure(this.#connection.db);
    capi.sqlite3_reset(s);
    throw error;
  }

  #row(s: Pointer): Row {
    const row: Row = Object.create(null);
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
    const s = this.#start(args), db = this.#connection.db;
    try {
      this.#step(s);
      // Counted once the statement completes, as Node's are: a RETURNING statement's changes land at its reset.
      capi.sqlite3_reset(s);
      const changes = BigInt(capi.sqlite3_changes64(db)), id = BigInt(capi.sqlite3_last_insert_rowid(db));
      return this.#bigints ? { changes, lastInsertRowid: id } : { changes: Number(changes), lastInsertRowid: Number(id) };
    } finally { release(this.#connection, this.#sql, s); }
  }

  get(...args: unknown[]): Row | undefined {
    const s = this.#start(args);
    try { return this.#step(s) ? this.#row(s) : undefined; } finally { release(this.#connection, this.#sql, s); }
  }

  all(...args: unknown[]): Row[] {
    const s = this.#start(args), rows: Row[] = [];
    try { while (this.#step(s)) rows.push(this.#row(s)); } finally { release(this.#connection, this.#sql, s); }
    return rows;
  }

  /** Bound now; each row read as the iterator is advanced, until another execution of the statement invalidates it. */
  iterate(...args: unknown[]): IterableIterator<Row> {
    const held: Held = { statement: this.#start(args), released: false }, execution = this.#execution;
    const connection = this.#connection, sql = this.#sql, self = this;
    const finish = (): void => { if (!held.released) { held.released = true; release(connection, sql, held.statement); } };
    const iterator = Object.assign(Object.create(ITERATOR) as IterableIterator<Row>, {
      next(): IteratorResult<Row, null> {
        if (connection.db === 0) throw invalidState("statement has been finalized");
        if (self.#execution !== execution) { finish(); throw invalidState("iterator was invalidated"); }
        if (held.released) return { done: true, value: null };
        let more: boolean;
        try { more = self.#step(held.statement); } catch (error) { finish(); throw error; }
        if (!more) { finish(); return { done: true, value: null }; }
        return { done: false, value: self.#row(held.statement) };
      },
      return(): IteratorResult<Row, null> {
        finish();
        return { done: true, value: null };
      },
      [Symbol.iterator]() { return iterator; },
    });
    this.#iteration = finish;
    abandoned.register(iterator, { connection, sql, held });
    return iterator;
  }
}

export interface DatabaseSyncOptions {
  readonly open?: boolean;
  readonly readOnly?: boolean;
  readonly timeout?: number;
  readonly readBigInts?: boolean;
}

export class DatabaseSync {
  readonly #connection: Connection = { db: 0, idle: new Map(), idleCount: 0, busy: new Set() };
  readonly #bigints: boolean;

  constructor(path: string, options: DatabaseSyncOptions = {}) {
    if (typeof path !== "string") throw argumentType("The \"path\" argument must be a string");
    if (options.open === false) throw new TypeError("a browser host opens a database as it is made");
    this.#bigints = options.readBigInts === true;
    // Before the file pool is mounted the host keeps no database files: a path is refused as SQLite refuses a file it
    // cannot open.
    const file = path !== ":memory:" && path !== "";
    if (file && !isMounted()) throw sqliteError(`a browser host keeps no database files until its file pool is mounted: ${path}`, SQLITE_CANTOPEN);
    const flags = options.readOnly === true ? capi.SQLITE_OPEN_READONLY : capi.SQLITE_OPEN_READWRITE | capi.SQLITE_OPEN_CREATE;
    const stack = wasm.pstack.pointer;
    try {
      const out = wasm.pstack.allocPtr() as Pointer;
      const rc = capi.sqlite3_open_v2(path, out, flags, file ? installFilesVfs(sqlite3) : 0);
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
    // Node's SQLite makes a new database's pages 4096 bytes, the WebAssembly build's default 8192: Node's, as a kept
    // file's page digest groups its pages (replay-store.ts). A database with pages keeps its own.
    if (options.readOnly !== true) this.exec("PRAGMA page_size = 4096");
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
    if (typeof sql !== "string") throw argumentType("The \"sql\" argument must be a string.");
    if (capi.sqlite3_exec(db, sql, 0, 0, 0) !== 0) throw failure(db);
  }

  /** Compiled now, against the schema as it stands, so a statement SQLite refuses is refused here, as Node's is; then
   * kept idle for an execution. */
  prepare(sql: string): StatementSync {
    this.#open();
    if (typeof sql !== "string") throw argumentType("The \"sql\" argument must be a string.");
    release(this.#connection, sql, compile(this.#connection, sql));
    return new StatementSync(this.#connection, sql, this.#bigints);
  }

  close(): void {
    const db = this.#open(), { idle, busy } = this.#connection;
    for (const statements of idle.values()) for (const statement of statements) capi.sqlite3_finalize(statement);
    for (const statement of busy) capi.sqlite3_finalize(statement);
    idle.clear(); busy.clear();
    this.#connection.idleCount = 0;
    this.#connection.db = 0;
    const rc = capi.sqlite3_close_v2(db);
    if (rc !== 0) throw sqliteError(capi.sqlite3_errstr(rc), rc);
  }
}

export default { DatabaseSync, StatementSync };
