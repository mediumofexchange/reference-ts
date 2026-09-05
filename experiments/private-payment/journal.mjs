// Research-only public-event storage. Callers supply verified public records,
// never note openings or spend secrets. This helper verifies no cryptography.
import { DatabaseSync } from 'node:sqlite';

export const MAX_EVENTS = 512;
function json(value) {
  return JSON.stringify(value, (_key, item) => {
    if (['undefined', 'bigint', 'function', 'symbol'].includes(typeof item) ||
        (typeof item === 'number' && !Number.isFinite(item))) throw new Error('expected JSON data');
    return item;
  });
}
function decoded(text) {
  const value = JSON.parse(text);
  if (json(value) !== text) throw new Error('noncanonical journal JSON');
  return value;
}

export class Journal {
  #db; #profile; #configHash; #checkpoint; #observed = 0n; #closed = false;
  constructor(path, configIdentity, checkpoint) {
    if (typeof path !== 'string' || !path.trim() || path === ':memory:' || path.startsWith('file:')) {
      throw new Error('a persistent filesystem path is required');
    }
    if (typeof configIdentity?.profile !== 'string' || !configIdentity.profile.length ||
        typeof configIdentity.configHash !== 'string' ||
        !/^[0-9a-f]{64}$/.test(configIdentity.configHash)) throw new Error('invalid journal identity');
    this.#profile = configIdentity.profile; this.#configHash = configIdentity.configHash;
    this.#checkpoint = checkpoint;
    this.#db = new DatabaseSync(path, { timeout: 5000 });
    try {
      this.#db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      if (this.#db.prepare('PRAGMA journal_mode').get()?.journal_mode !== 'wal' ||
          this.#db.prepare('PRAGMA synchronous').get()?.synchronous !== 2) throw new Error('durable WAL/FULL required');
      this.#transaction(() => {
        this.#db.exec(`CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1),
          profile TEXT NOT NULL, config_hash TEXT NOT NULL) STRICT;
          CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY CHECK(seq>0),
          id TEXT NOT NULL UNIQUE, command TEXT NOT NULL, response TEXT NOT NULL) STRICT;`);
        if (this.#db.prepare('SELECT id FROM identity WHERE id=1').get() === undefined) {
          if (this.#db.prepare('SELECT COUNT(*) AS n FROM events').get().n !== 0) throw new Error('missing journal identity');
          this.#db.prepare('INSERT INTO identity VALUES(1,?,?)').run(this.#profile, this.#configHash);
        }
        this.#read();
      }, true);
    } catch (error) { this.#db.close(); throw error; }
  }
  #transaction(action, write = false) {
    if (this.#closed) throw new Error('journal is closed');
    this.#db.exec(write ? 'BEGIN IMMEDIATE' : 'BEGIN');
    try {
      const result = action();
      this.#db.exec(result === false ? 'ROLLBACK' : 'COMMIT');
      return result;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* preserve original failure */ }
      throw error;
    }
  }
  #read() {
    const identity = this.#db.prepare('SELECT profile,config_hash FROM identity WHERE id=1').get();
    if (identity?.profile !== this.#profile || identity?.config_hash !== this.#configHash) throw new Error('journal identity mismatch');
    const query = this.#db.prepare('SELECT seq,id,command,response FROM events ORDER BY seq LIMIT ?');
    query.setReadBigInts(true);
    const rows = query.all(MAX_EVENTS + 1);
    if (rows.length > MAX_EVENTS) throw new Error('journal exceeds event limit');
    let sequence = 0n;
    const events = rows.map(row => {
      if (row.seq !== ++sequence) throw new Error('noncontiguous journal');
      return { id: row.id, command: decoded(row.command), response: decoded(row.response) };
    });
    if (sequence < this.#observed) throw new Error('journal was truncated');
    this.#observed = sequence;
    return { sequence, events };
  }
  snapshot() { return this.#transaction(() => this.#read()); }
  lookup(id) {
    const event = this.#transaction(() => this.#read().events.find(event => event.id === id));
    return event === undefined ? undefined : { command: event.command, response: event.response };
  }
  // true: inserted or exact prior command+response. false: stale expected tip;
  // the caller must reload and repeat verification before attempting insertion.
  append(expectedSequence, id, command, response) {
    if (typeof expectedSequence !== 'bigint' || expectedSequence < 0n ||
        typeof id !== 'string' || !id.length) throw new Error('invalid append identity');
    const commandJSON = json(command), responseJSON = json(response);
    let inserted = false;
    const result = this.#transaction(() => {
      const { sequence, events } = this.#read();
      const prior = events.find(event => event.id === id);
      if (prior !== undefined) {
        if (json(prior.command) !== commandJSON || json(prior.response) !== responseJSON) throw new Error('journal identifier conflict');
        return true;
      }
      if (sequence !== expectedSequence) return false;
      if (sequence === BigInt(MAX_EVENTS)) throw new Error('journal event limit reached');
      this.#db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(sequence + 1n, id, commandJSON, responseJSON);
      this.#checkpoint?.('stored');
      inserted = true;
      return true;
    }, true);
    if (inserted) {
      this.#observed = expectedSequence + 1n;
      this.#checkpoint?.('committed'); // May throw after durable acceptance: use lookup on retry.
    }
    return result;
  }
  close() { if (!this.#closed) { this.#db.close(); this.#closed = true; } }
}
