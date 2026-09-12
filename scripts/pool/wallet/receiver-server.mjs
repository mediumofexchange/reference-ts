// Separate local receiver for acceptance only. TLS keys are PUBLIC fixtures.
// Pairing file models an authenticated out-of-band handoff, not discovery.
import { readFileSync, writeFileSync } from 'node:fs';
import { bytesToHex } from '@noble/hashes/utils.js';
import { PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { createWalletDeliveryServer } from '@mediumofexchange/reference/pool/wallet-delivery-http';
import { walletProfile } from './profile.mjs';

const [database, pairingFile, mode, dropReply, stopMode] = process.argv.slice(2);
const { AUTHORITY, DOMAIN, TERMS } = walletProfile(mode === 'real');
const wallet = new PoolWalletStore(database, AUTHORITY);
const request = wallet.request('invoice', TERMS.backing.name, 7n), token = wallet.deliveryToken('invoice');
const cert = readFileSync(new URL('../../../test/fixtures/wallet-tls/localhost-cert.pem', import.meta.url), 'utf8');
const key = readFileSync(new URL('../../../test/fixtures/wallet-tls/localhost-key.pem', import.meta.url), 'utf8');
const server = createWalletDeliveryServer(wallet, { cert, key });
let drop = dropReply === 'drop-once';
server.prependListener('request', (_request, response) => {
  const end = response.end;
  response.end = function(chunk, ...args) {
    if (drop && response.statusCode === 200) { drop = false; response.destroy(); return this; }
    return end.call(this, chunk, ...args);
  };
});
await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
writeFileSync(pairingFile, JSON.stringify({ domain: bytesToHex(DOMAIN),
  request: { id: request.id, backing: bytesToHex(request.backing), value: request.value.toString(), owner: request.owner.toString() },
  endpoint: `https://localhost:${server.address().port}/delivery/invoice`, token, ca: cert }), { mode: 0o600 });
process.send?.({ ready: true });
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  server.closeAllConnections();
  server.close(() => { wallet.close(); if (process.connected) process.disconnect(); });
}
process.on('message', message => { if (message === 'stop' && stopMode !== 'ignore-stop') stop(); });
process.on('disconnect', stop);
