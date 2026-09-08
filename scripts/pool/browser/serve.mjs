// Loopback-only benchmark server; expose an exact list of synthetic/cache assets.
import { createReadStream, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const browser = fileURLToPath(new URL('./', import.meta.url));
const assets = new Map();
for (const name of ['manifest.json', 'spend.json', 'vectors.json']) {
  assets.set(`/benchmark-assets/${name}`, join(root, 'scratch/pool-browser', name));
}
for (const name of ['bn254_g1.dat', 'bn254_g2.dat', 'grumpkin_g1_v2.flat.dat']) {
  assets.set(`/benchmark-assets/${name}`, join(root, 'scratch/private-payment-crs', name));
}
for (const path of assets.values()) statSync(path); // Fail before serving an incomplete preparation.
const server = await createServer({
  configFile: false, root: browser, publicDir: false,
  cacheDir: join(root, 'scratch/pool-browser/vite'),
  server: { host: '127.0.0.1', port: 4173, strictPort: true,
    fs: { strict: true, allow: [browser, join(root, 'node_modules')] },
    headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' } },
  optimizeDeps: { exclude: ['@aztec/bb.js', '@noir-lang/noir_js', '@noir-lang/acvm_js', '@noir-lang/noirc_abi'] },
  plugins: [{ name: 'benchmark-assets', configureServer(dev) {
    dev.middlewares.use((req, res, next) => {
      const path = assets.get(req.url);
      if (!path) {
        if (req.url?.startsWith('/benchmark-assets/')) { res.statusCode = 404; return res.end(); }
        return next();
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
      res.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'application/octet-stream');
      res.setHeader('Content-Length', statSync(path).size);
      res.setHeader('Cache-Control', 'no-store');
      if (req.method === 'HEAD') return res.end();
      createReadStream(path).on('error', () => res.destroy()).pipe(res);
    });
  } }],
});
await server.listen();
server.printUrls();
console.log('Synthetic proof benchmark only. For an attached Android phone: adb reverse tcp:4173 tcp:4173.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await server.close(); process.exit(0); });
