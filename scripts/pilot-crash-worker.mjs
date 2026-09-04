// Acceptance-test worker: abrupt process termination, without store.close().
import { readFileSync } from 'node:fs';
import { PilotStore } from '@mediumofexchange/reference/pilot-store';
import { hex } from '@mediumofexchange/reference/pilot-wire';
const [database, keyFile, configFile, commandFile, phase] = process.argv.slice(2);
const key = JSON.parse(readFileSync(keyFile, 'utf8'));
const config = JSON.parse(readFileSync(configFile, 'utf8'));
const command = JSON.parse(readFileSync(commandFile, 'utf8'));
const store = new PilotStore(database, hex(key.secret, 32, 32), hex(config.venue, 32, 32), at => {
  if (at === phase) process.exit(71);
});
console.log(JSON.stringify(store.execute(command)));
store.close();
