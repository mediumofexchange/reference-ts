These public test-only TLS credentials authenticate `localhost` in transport
tests. The self-signed certificate is valid from 2020 through 2120 and trusted
only by explicitly passing it as the test client's CA. Never use this key for
deployment, custody, or a real payment endpoint.

`pin-ca-cert.pem` and `pin-leaf-cert.pem` use the same public test key and
are valid from September 2026 through August 2126. The self-signed CA names
`localhost`; its signed leaf has subject `alternate-leaf` and a `localhost`
subject alternative name. Ordinary TLS chain, hostname and time checks accept
the leaf when the CA is trusted. The paired client must still reject it before
sending HTTP headers or a body because the exact leaf differs from its pin.
This distinguishes certificate pinning from ordinary TLS verification.

To reproduce these public certificate roles with OpenSSL, run from the
repository root (the temporary files contain no private key):

```sh
mkdir -p scratch/pairing-pin-review
openssl req -new -x509 -sha256 -days 36500 \
  -key test/fixtures/wallet-tls/localhost-key.pem -subj /CN=localhost \
  -addext 'subjectAltName=critical,DNS:localhost' \
  -addext 'basicConstraints=critical,CA:TRUE' \
  -addext 'keyUsage=critical,digitalSignature,keyCertSign,cRLSign' \
  -addext 'extendedKeyUsage=serverAuth' -set_serial 12346 \
  -out test/fixtures/wallet-tls/pin-ca-cert.pem
openssl req -new -key test/fixtures/wallet-tls/localhost-key.pem \
  -subj /CN=alternate-leaf -out scratch/pairing-pin-review/alternate.csr
cat > scratch/pairing-pin-review/extensions.cnf <<'EOF'
subjectAltName=DNS:localhost
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
authorityKeyIdentifier=keyid,issuer
EOF
openssl x509 -req -in scratch/pairing-pin-review/alternate.csr \
  -CA test/fixtures/wallet-tls/pin-ca-cert.pem \
  -CAkey test/fixtures/wallet-tls/localhost-key.pem -set_serial 12347 \
  -days 36500 -sha256 -extfile scratch/pairing-pin-review/extensions.cnf \
  -out test/fixtures/wallet-tls/pin-leaf-cert.pem
```

These commands regenerate the test relationship, not the exact certificate
bytes, because certificate validity starts at generation time.
