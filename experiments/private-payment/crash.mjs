// Test worker receives preverified public command/response and dies in SQLite.
import { readFileSync } from 'node:fs';
import { Journal } from './journal.mjs';
const [db, file] = process.argv.slice(2), r = JSON.parse(readFileSync(file, 'utf8'));
const journal = new Journal(db, r.identity, phase => { if (phase === r.phase) process.exit(73); });
journal.append(BigInt(r.sequence), r.id, r.command, r.response);
journal.close();
