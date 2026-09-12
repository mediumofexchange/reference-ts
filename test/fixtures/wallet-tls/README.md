These public test-only TLS credentials authenticate `localhost` in transport
tests. The self-signed certificate is valid from 2020 through 2120 and trusted
only by explicitly passing it as the test client's CA. Never use this key for
deployment, custody, or a real payment endpoint.
