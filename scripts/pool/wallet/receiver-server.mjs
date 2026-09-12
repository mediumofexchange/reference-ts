// Separate local receiver. The harness models independent digest authentication
// through parent-owned IPC; the invitation file is never a source of trust.
import { writeFileSync } from 'node:fs';
import { PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { createWalletDeliveryServer } from '@mediumofexchange/reference/pool/wallet-delivery-http';
import { walletProfile } from './profile.mjs';
import { generateWalletTls } from './tls.mjs';
import { walletPairingDigest } from '@mediumofexchange/reference/pool/wallet-pairing';

const [database, pairingFile, mode, dropReply, stopMode, port = '0', rotate] = process.argv.slice(2);
const { AUTHORITY, DOMAIN, TERMS } = walletProfile(mode === 'real');
const wallet = new PoolWalletStore(database, AUTHORITY);
wallet.request('invoice', TERMS.backing.name, 7n);
const old = wallet.deliveryCredentials();
if (!old || rotate === 'rotate') wallet.installDeliveryCredentials(await generateWalletTls(), old?.generation ?? 0n);
const server = createWalletDeliveryServer(wallet, wallet.deliveryCredentials());
let drop = dropReply === 'drop-once';
server.prependListener('request', (_request, response) => {
  const end = response.end;
  response.end = function(chunk, ...args) {
    if (drop && response.statusCode === 200) { drop = false; response.destroy(); return this; }
    return end.call(this, chunk, ...args);
  };
});
await new Promise((resolve, reject) => server.listen(Number(port), '127.0.0.1', resolve).once('error', reject));
const invitation = wallet.deliveryInvitation('invoice', `https://localhost:${server.address().port}/delivery/invoice`);
writeFileSync(pairingFile, invitation, { mode: 0o600 });
process.send?.({ ready: true, port: server.address().port, digest: walletPairingDigest(invitation) });
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  server.closeAllConnections();
  server.close(() => { wallet.close(); if (process.connected) process.disconnect(); });
}
process.on('message', message => { if (message === 'stop' && stopMode !== 'ignore-stop') stop(); });
process.on('disconnect', stop);
