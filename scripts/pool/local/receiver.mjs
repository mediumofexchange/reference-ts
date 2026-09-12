// Configured invoice listener. Output is a private invitation, whose digest
// must be authenticated independently by the payer.
import assert from 'node:assert/strict';
import { PoolWalletStore } from '@mediumofexchange/reference/pool/wallet-store';
import { createWalletDeliveryServer } from '@mediumofexchange/reference/pool/wallet-delivery-http';
import { walletPairingDigest } from '@mediumofexchange/reference/pool/wallet-pairing';
import { readLocalProfile } from './profile.mjs';
import { generateWalletTls } from '../wallet/tls.mjs';
import { assertWalletPaths } from './paths.mjs';
const [database, profileFile, digest, id, port = '0', expectedGeneration] = process.argv.slice(2);
assert.ok([database, profileFile, digest, id].every(v => typeof v === 'string') && process.argv.slice(2).length <= 6 &&
  /^[A-Za-z0-9_-]{1,80}$/.test(id) && /^(0|[1-9][0-9]{0,4})$/.test(port) && Number(port) <= 65535, 'invalid receiver arguments');
assert.ok(expectedGeneration === undefined || (/^(0|[1-9][0-9]{0,19})$/.test(expectedGeneration) &&
  BigInt(expectedGeneration) < (1n << 64n) - 1n), 'invalid expected credential generation');
assertWalletPaths(database, { profileFile });
const profile = readLocalProfile(profileFile, digest);
const wallet = new PoolWalletStore(database, profile.AUTHORITY);
let server;
try {
  // Refuse a nonexistent invoice before installing credentials or listening.
  wallet.secret(id);
  const old = wallet.deliveryCredentials();
  if (expectedGeneration !== undefined) {
    assert.ok((old?.generation ?? 0n) === BigInt(expectedGeneration), 'credential generation changed; restart without rotation to inspect');
    wallet.installDeliveryCredentials(await generateWalletTls(), BigInt(expectedGeneration));
  } else if (!old) wallet.installDeliveryCredentials(await generateWalletTls(), 0n);
  server = createWalletDeliveryServer(wallet, wallet.deliveryCredentials());
  await new Promise((resolveListen, reject) => server.listen(Number(port), '127.0.0.1', resolveListen).once('error', reject));
  const invitation = wallet.deliveryInvitation(id, `https://localhost:${server.address().port}/delivery/${id}`);
  console.log('MOE_LOCAL_READY=' + JSON.stringify({ invitation, digest: walletPairingDigest(invitation), generation: wallet.deliveryCredentials().generation.toString(), port: server.address().port, pid: process.pid }));
  await new Promise(resolveStop => {
    process.once('SIGINT', resolveStop); process.once('SIGTERM', resolveStop);
    process.once('disconnect', resolveStop);
    process.on('message', message => { if (message === 'stop') resolveStop(); });
  });
} finally {
  if (server) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  wallet.close();
  if (process.connected) process.disconnect();
}
