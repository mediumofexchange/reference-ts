// SQLite's files on the browser host's file pool (slice 40): a VFS over files.ts for node-sqlite.ts, so a database
// path opens there with the files node-fs.ts reads (replay-store.ts digests a kept file's pages and log as SQLite
// leaves them), and with what a write-ahead log needs:
// - shared memory (the log's index) in the worker's WebAssembly memory, one per database file, shared by every
//   connection of the worker and dropped with the last, so a log is recovered from the file as after a restart;
// - file and shared-memory locks among the worker's connections, with SQLite's own unix semantics, so two connections
//   of one worker exclude each other as two of one Node process do. Another worker holds no member of the pool
//   (files.ts), so these are all the locks there are.
// Temporary files (a statement journal, `temp_store=FILE`) take an anonymous member, freed at their close.
import * as files from "./files.js";
import type { Member } from "./files.js";

type Pointer = number;
/* eslint-disable @typescript-eslint/no-explicit-any -- SQLite's WebAssembly build is untyped here, as node-sqlite.ts uses it. */
type Sqlite3 = any;

export const FILES_VFS = "moe-files";

const SECTOR = 4096;
const SHM_UNLOCK = 1, SHM_LOCK = 2, SHM_SHARED = 4, SHM_EXCLUSIVE = 8, SHM_LOCKS = 8;
const LOCK_NONE = 0, LOCK_SHARED = 1, LOCK_RESERVED = 2, LOCK_PENDING = 3, LOCK_EXCLUSIVE = 4;
/** SQLITE_FCNTL_HAS_MOVED, and SQLITE_IOCAP_POWERSAFE_OVERWRITE, which unix reports by default. */
const FCNTL_HAS_MOVED = 20, POWERSAFE_OVERWRITE = 0x1000;

/** A file lock's holders among the worker's connections, as unix's per-inode lock. */
interface FileLock { readonly shared: Set<Pointer>; reserved: Pointer; pending: Pointer; exclusive: Pointer }
/** A database's shared memory: its regions, the connections mapping it, and its eight locks. */
interface Shared { readonly regions: Pointer[]; readonly users: Set<Pointer>; readonly readers: number[]; readonly writer: Pointer[] }
interface Open {
  readonly member: Member;
  readonly path: string | undefined;
  readonly flags: number;
  level: number;
  /** The shared-memory locks this connection holds: bit i shared, bit 8 + i exclusive. */
  shmHeld: number;
}

export function installFilesVfs(sqlite3: Sqlite3): string {
  const { capi, wasm } = sqlite3;
  if (capi.sqlite3_vfs_find(FILES_VFS)) return FILES_VFS;
  const opens = new Map<Pointer, Open>();
  const locks = new Map<Member, FileLock>();
  const shared = new Map<Member, Shared>();
  let lastError: unknown;

  const lockOf = (member: Member): FileLock => {
    let lock = locks.get(member);
    if (lock === undefined) locks.set(member, lock = { shared: new Set(), reserved: 0, pending: 0, exclusive: 0 });
    return lock;
  };
  /** SQLite's code for a failure: a full pool or disk as SQLITE_FULL, any other as `code`. */
  const failed = (error: unknown, code: number): number => {
    lastError = error;
    const name = (error as { code?: string; name?: string }).code ?? (error as { name?: string }).name;
    return name === "ENOSPC" || name === "QuotaExceededError" ? capi.SQLITE_FULL : code;
  };
  const fileOf = (pFile: Pointer): Open => {
    const open = opens.get(pFile);
    if (open === undefined) throw new Error("an unknown SQLite file");
    return open;
  };

  const io = {
    xClose(pFile: Pointer): number {
      const open = opens.get(pFile);
      if (open === undefined) return 0;
      try {
        opens.delete(pFile);
        const lock = locks.get(open.member);
        if (lock !== undefined) {
          lock.shared.delete(pFile);
          if (lock.reserved === pFile) lock.reserved = 0;
          if (lock.pending === pFile) lock.pending = 0;
          if (lock.exclusive === pFile) lock.exclusive = 0;
        }
        if ((open.flags & capi.SQLITE_OPEN_DELETEONCLOSE) !== 0 && open.path !== undefined && files.lookup(open.path) === open.member) files.unlink(open.path);
        files.closed(open.member);
        if (open.member.opens <= 0) locks.delete(open.member);
        return 0;
      } catch (error) { return failed(error, capi.SQLITE_IOERR_CLOSE); }
    },
    xRead(pFile: Pointer, pDest: Pointer, n: number, offset: bigint | number): number {
      try {
        const target = wasm.heap8u().subarray(Number(pDest), Number(pDest) + n);
        const got = files.read(fileOf(pFile).member, target, Number(offset));
        if (got < n) { target.fill(0, got); return capi.SQLITE_IOERR_SHORT_READ; }
        return 0;
      } catch (error) { return failed(error, capi.SQLITE_IOERR_READ); }
    },
    xWrite(pFile: Pointer, pSource: Pointer, n: number, offset: bigint | number): number {
      try {
        const wrote = files.write(fileOf(pFile).member, wasm.heap8u().subarray(Number(pSource), Number(pSource) + n), Number(offset));
        return wrote === n ? 0 : capi.SQLITE_FULL;
      } catch (error) { return failed(error, capi.SQLITE_IOERR_WRITE); }
    },
    xTruncate(pFile: Pointer, size: bigint | number): number {
      try { files.truncate(fileOf(pFile).member, Number(size)); return 0; } catch (error) { return failed(error, capi.SQLITE_IOERR_TRUNCATE); }
    },
    xSync(pFile: Pointer, _flags: number): number {
      try { files.flush(fileOf(pFile).member); return 0; } catch (error) { return failed(error, capi.SQLITE_IOERR_FSYNC); }
    },
    xFileSize(pFile: Pointer, pSize: Pointer): number {
      try { wasm.poke64(pSize, BigInt(files.size(fileOf(pFile).member))); return 0; } catch (error) { return failed(error, capi.SQLITE_IOERR_FSTAT); }
    },
    // File locks, as unix's among one process's connections (os_unix.c unixLock): a connection whose lock is not the
    // file's strongest is refused where that lock is pending or stronger, or where it asks for more than a shared
    // lock; a reserved lock is one connection's; an exclusive one passes through pending until no other shared lock
    // is held.
    xLock(pFile: Pointer, level: number): number {
      const open = fileOf(pFile), lock = lockOf(open.member);
      if (open.level >= level) return 0;
      const strongest = lock.exclusive !== 0 ? LOCK_EXCLUSIVE : lock.pending !== 0 ? LOCK_PENDING : lock.reserved !== 0 ? LOCK_RESERVED
        : lock.shared.size > 0 ? LOCK_SHARED : LOCK_NONE;
      if (open.level !== strongest && (strongest >= LOCK_PENDING || level > LOCK_SHARED)) return capi.SQLITE_BUSY;
      if (level === LOCK_SHARED) { lock.shared.add(pFile); open.level = LOCK_SHARED; return 0; }
      if (level === LOCK_RESERVED) { lock.reserved = pFile; open.level = LOCK_RESERVED; return 0; }
      // EXCLUSIVE (SQLite asks for no other level here): pending first, so no new shared lock starts meanwhile.
      lock.pending = pFile; open.level = LOCK_PENDING;
      for (const holder of lock.shared) if (holder !== pFile) return capi.SQLITE_BUSY;
      lock.exclusive = pFile; open.level = LOCK_EXCLUSIVE;
      return 0;
    },
    xUnlock(pFile: Pointer, level: number): number {
      const open = fileOf(pFile), lock = lockOf(open.member);
      if (open.level <= level) return 0;
      if (lock.reserved === pFile) lock.reserved = 0;
      if (lock.pending === pFile) lock.pending = 0;
      if (lock.exclusive === pFile) lock.exclusive = 0;
      if (level === LOCK_NONE) lock.shared.delete(pFile);
      open.level = level;
      return 0;
    },
    xCheckReservedLock(pFile: Pointer, pOut: Pointer): number {
      const lock = lockOf(fileOf(pFile).member);
      wasm.poke32(pOut, lock.reserved !== 0 || lock.pending !== 0 || lock.exclusive !== 0 ? 1 : 0);
      return 0;
    },
    // A file removed or renamed under an open connection has moved, as unix reports it: closing that connection then
    // neither checkpoints nor deletes the log, which another file of the same name may now own.
    xFileControl(pFile: Pointer, op: number, pArg: Pointer): number {
      if (op !== FCNTL_HAS_MOVED) return capi.SQLITE_NOTFOUND;
      try {
        const open = fileOf(pFile);
        wasm.poke32(pArg, open.path !== undefined && files.lookup(open.path) !== open.member ? 1 : 0);
        return 0;
      } catch (error) { return failed(error, capi.SQLITE_IOERR_FSTAT); }
    },
    xSectorSize(_pFile: Pointer): number { return SECTOR; },
    // As unix's default (Node's SQLite), so a write-ahead log is laid out as Node's is.
    xDeviceCharacteristics(_pFile: Pointer): number { return POWERSAFE_OVERWRITE; },
    xShmMap(pFile: Pointer, region: number, size: number, extend: number, pp: Pointer): number {
      try {
        const open = fileOf(pFile);
        let memory = shared.get(open.member);
        if (memory === undefined) shared.set(open.member, memory = { regions: [], users: new Set(), readers: new Array(SHM_LOCKS).fill(0), writer: new Array(SHM_LOCKS).fill(0) });
        memory.users.add(pFile);
        if (memory.regions[region] === undefined && extend === 0) { wasm.pokePtr(pp, 0); return 0; }
        while (memory.regions.length <= region) {
          const at = wasm.alloc(size) as Pointer;
          wasm.heap8u().fill(0, at, at + size);
          memory.regions.push(at);
        }
        wasm.pokePtr(pp, memory.regions[region]);
        return 0;
      } catch (error) { return failed(error, capi.SQLITE_IOERR_SHMMAP); }
    },
    // Shared-memory locks, as unix's among one process's connections.
    xShmLock(pFile: Pointer, offset: number, n: number, flags: number): number {
      const open = fileOf(pFile), memory = shared.get(open.member);
      if (memory === undefined) return capi.SQLITE_IOERR_SHMLOCK;
      const range = Array.from({ length: n }, (_, i) => offset + i);
      const holds = (bit: number) => (open.shmHeld & (1 << bit)) !== 0;
      if ((flags & SHM_UNLOCK) !== 0) {
        for (const i of range) {
          if ((flags & SHM_SHARED) !== 0 && holds(i)) { memory.readers[i]!--; open.shmHeld &= ~(1 << i); }
          if ((flags & SHM_EXCLUSIVE) !== 0 && holds(SHM_LOCKS + i)) { memory.writer[i] = 0; open.shmHeld &= ~(1 << (SHM_LOCKS + i)); }
        }
        return 0;
      }
      if ((flags & SHM_LOCK) === 0) return capi.SQLITE_MISUSE;
      if ((flags & SHM_SHARED) !== 0) {
        for (const i of range) if (memory.writer[i] !== 0 && memory.writer[i] !== pFile) return capi.SQLITE_BUSY;
        for (const i of range) if (!holds(i)) { memory.readers[i]!++; open.shmHeld |= 1 << i; }
        return 0;
      }
      for (const i of range) {
        if ((memory.writer[i] !== 0 && memory.writer[i] !== pFile) || memory.readers[i]! - (holds(i) ? 1 : 0) > 0) return capi.SQLITE_BUSY;
      }
      for (const i of range) { memory.writer[i] = pFile; open.shmHeld |= 1 << (SHM_LOCKS + i); }
      return 0;
    },
    xShmBarrier(_pFile: Pointer): void { /* one thread: every write is seen */ },
    xShmUnmap(pFile: Pointer, _delete: number): number {
      const open = fileOf(pFile), memory = shared.get(open.member);
      if (memory === undefined) return 0;
      for (let i = 0; i < SHM_LOCKS; i++) {
        if ((open.shmHeld & (1 << i)) !== 0) memory.readers[i]!--;
        if (memory.writer[i] === pFile) memory.writer[i] = 0;
      }
      open.shmHeld = 0;
      memory.users.delete(pFile);
      // The last connection's unmapping drops the index: the next opening rebuilds it from the log, as after a restart.
      if (memory.users.size === 0) { for (const at of memory.regions) wasm.dealloc(at); shared.delete(open.member); }
      return 0;
    },
  };
  const ioMethods = new capi.sqlite3_io_methods();
  ioMethods.$iVersion = 2;
  sqlite3.vfs.installVfs({ io: { struct: ioMethods, methods: io } });

  const name = (zName: Pointer): string => files.normal(wasm.cstrToJs(zName));
  const methods = {
    xOpen(_pVfs: Pointer, zName: Pointer, pFile: Pointer, flags: number, pOutFlags: Pointer): number {
      try {
        let member: Member, path: string | undefined;
        if (zName === 0 || wasm.peek8(zName) === 0) member = files.anonymous();
        else {
          path = name(zName);
          const there = files.lookup(path);
          if (there !== undefined && (flags & capi.SQLITE_OPEN_EXCLUSIVE) !== 0) return capi.SQLITE_CANTOPEN;
          if (there === undefined && (flags & capi.SQLITE_OPEN_CREATE) === 0) return capi.SQLITE_CANTOPEN;
          member = there ?? files.create(path, false);
        }
        files.opened(member);
        opens.set(pFile, { member, path, flags, level: LOCK_NONE, shmHeld: 0 });
        const file = new capi.sqlite3_file(pFile);
        file.$pMethods = ioMethods.pointer;
        file.dispose();
        if (pOutFlags !== 0) wasm.poke32(pOutFlags, flags);
        return 0;
      } catch (error) { return failed(error, capi.SQLITE_CANTOPEN); }
    },
    xDelete(_pVfs: Pointer, zName: Pointer, _syncDir: number): number {
      try {
        const path = name(zName);
        if (files.lookup(path) === undefined) return capi.SQLITE_IOERR_DELETE_NOENT;
        files.unlink(path);
        return 0;
      } catch (error) { return failed(error, capi.SQLITE_IOERR_DELETE); }
    },
    xAccess(_pVfs: Pointer, zName: Pointer, _flags: number, pOut: Pointer): number {
      try {
        const path = name(zName);
        wasm.poke32(pOut, files.lookup(path) !== undefined || files.isDirectory(path) ? 1 : 0);
        return 0;
      } catch (error) { return failed(error, capi.SQLITE_IOERR_ACCESS); }
    },
    xFullPathname(_pVfs: Pointer, zName: Pointer, nOut: number, pOut: Pointer): number {
      const bytes = new TextEncoder().encode(`${name(zName)}\0`);
      if (bytes.length > nOut) return capi.SQLITE_CANTOPEN;
      wasm.heap8u().set(bytes, pOut);
      return 0;
    },
    xRandomness(_pVfs: Pointer, n: number, pOut: Pointer): number {
      crypto.getRandomValues(wasm.heap8u().subarray(pOut, pOut + n));
      return n;
    },
    xSleep(_pVfs: Pointer, _microseconds: number): number { return 0; },
    xCurrentTime(_pVfs: Pointer, pOut: Pointer): number { wasm.poke(pOut, 2440587.5 + Date.now() / 864e5, "double"); return 0; },
    xCurrentTimeInt64(_pVfs: Pointer, pOut: Pointer): number { wasm.poke(pOut, 210866760000000n + BigInt(Date.now()), "i64"); return 0; },
    xGetLastError(_pVfs: Pointer, nOut: number, pOut: Pointer): number {
      const message = new TextEncoder().encode(`${String((lastError as Error | undefined)?.message ?? "")}`.slice(0, Math.max(0, nOut - 1)));
      wasm.heap8u().set([...message, 0], pOut);
      return 0;
    },
  };
  const vfs = new capi.sqlite3_vfs();
  vfs.$iVersion = 2;
  vfs.$szOsFile = capi.sqlite3_file.structInfo.sizeof;
  vfs.$mxPathname = 1024;
  vfs.$zName = wasm.allocCString(FILES_VFS);
  sqlite3.vfs.installVfs({ vfs: { struct: vfs, methods } });
  return FILES_VFS;
}
