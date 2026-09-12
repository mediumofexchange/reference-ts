import { spawn } from 'node:child_process';
import { createPublicKey, X509Certificate } from 'node:crypto';

const MAX_OPENSSL_OUTPUT_BYTES = 1024 * 1024;
const OPENSSL_TIMEOUT_MS = 15_000;

function opensslCandidates() {
  const configured = process.env.MOE_OPENSSL?.trim();
  if (configured) return [configured];
  if (process.platform !== 'win32') return ['openssl'];
  return [
    'openssl',
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  ];
}

function collect(stream, chunks, state, child) {
  stream.on('data', chunk => {
    state.bytes += chunk.length;
    if (state.bytes > MAX_OPENSSL_OUTPUT_BYTES) {
      state.outputExceeded = true;
      child.kill('SIGKILL');
      return;
    }
    chunks.push(chunk);
  });
}

async function runOpenSsl(executable) {
  const args = [
    'req', '-new', '-newkey', 'rsa:2048', '-noenc', '-x509', '-sha256', '-days', '30',
    '-keyout', '-',
    '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=critical,DNS:localhost',
    '-addext', 'basicConstraints=critical,CA:FALSE',
    '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
    '-addext', 'extendedKeyUsage=serverAuth',
  ];

  return new Promise(resolve => {
    const child = spawn(executable, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = [], stderr = [];
    const state = { bytes: 0, outputExceeded: false, timedOut: false };
    let spawnError;
    const timer = setTimeout(() => {
      state.timedOut = true;
      child.kill('SIGKILL');
    }, OPENSSL_TIMEOUT_MS);
    timer.unref();

    collect(child.stdout, stdout, state, child);
    collect(child.stderr, stderr, state, child);
    child.on('error', error => { spawnError = error; });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({
        code,
        signal,
        spawnError,
        outputExceeded: state.outputExceeded,
        timedOut: state.timedOut,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}

function credentialsFrom(output) {
  const pattern = /-----BEGIN (PRIVATE KEY|CERTIFICATE)-----\r?\n(?:[A-Za-z0-9+/=]+\r?\n)+-----END \1-----/g;
  const blocks = [...output.matchAll(pattern)];
  if (blocks.length !== 2 || output.replace(pattern, '').trim() !== '') {
    throw new Error('OpenSSL returned an unexpected credential encoding');
  }
  const keyBlock = blocks.find(match => match[1] === 'PRIVATE KEY');
  const certBlock = blocks.find(match => match[1] === 'CERTIFICATE');
  if (!keyBlock || !certBlock) throw new Error('OpenSSL returned incomplete credentials');
  return { key: keyBlock[0].replaceAll('\r\n', '\n') + '\n', cert: certBlock[0].replaceAll('\r\n', '\n') + '\n' };
}

function validateCertificate(privateKey, certificate) {
  const parsed = new X509Certificate(certificate);
  if (parsed.checkHost('localhost') !== 'localhost' || parsed.subjectAltName !== 'DNS:localhost') {
    throw new Error('OpenSSL generated a certificate for an unexpected hostname');
  }
  if (parsed.ca || parsed.issuer !== parsed.subject || !parsed.verify(parsed.publicKey)) {
    throw new Error('OpenSSL generated an invalid self-signed leaf certificate');
  }
  if (!parsed.keyUsage?.includes('1.3.6.1.5.5.7.3.1')) {
    throw new Error('OpenSSL generated a certificate without server authentication usage');
  }

  const privatePublic = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  const certificatePublic = parsed.publicKey.export({ type: 'spki', format: 'der' });
  const modulusLength = parsed.publicKey.asymmetricKeyDetails?.modulusLength;
  if (!privatePublic.equals(certificatePublic)
      || parsed.publicKey.asymmetricKeyType !== 'rsa'
      || !Number.isSafeInteger(modulusLength)
      || modulusLength < 2048) {
    throw new Error('OpenSSL certificate does not match the generated RSA private key');
  }
}

export async function generateWalletTls() {
  let missingExecutable;
  for (const executable of opensslCandidates()) {
    const result = await runOpenSsl(executable);
    if (result.spawnError?.code === 'ENOENT') {
      missingExecutable = result.spawnError;
      continue;
    }
    if (result.spawnError) throw result.spawnError;
    if (result.timedOut) throw new Error('OpenSSL certificate generation timed out');
    if (result.outputExceeded) throw new Error('OpenSSL certificate generation exceeded its output limit');
    if (result.code !== 0) {
      throw new Error(`OpenSSL certificate generation failed (${result.signal ?? `exit ${result.code}`})`);
    }

    const credentials = credentialsFrom(result.stdout);
    validateCertificate(credentials.key, credentials.cert);
    return credentials;
  }

  throw new Error('OpenSSL executable was not found', { cause: missingExecutable });
}
