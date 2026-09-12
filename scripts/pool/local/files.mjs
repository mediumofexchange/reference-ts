// Replace a local evidence/ledger file only after its complete bytes are flushed.
// This is not directory-fsync assurance or a backup/rollback protection scheme.
import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, openSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
export function replaceLocalFile(path, bytes) {
  const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  const descriptor = openSync(temporary, 'wx', 0o600);
  let closed = false;
  try {
    writeFileSync(descriptor, bytes); fsyncSync(descriptor); closeSync(descriptor); closed = true;
    renameSync(temporary, path);
  } finally {
    if (!closed) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}
