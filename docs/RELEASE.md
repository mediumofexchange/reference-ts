# Release record

How a release of `@mediumofexchange/reference` is built, reproduced and installed so that its installed code is exactly
what its commit builds and tests ([release gates](PRODUCTION_REQUIREMENTS.md#release-gates); slice 13 M13a,
[decision](../decisions/2026-10.md#2026-10-07--pin-a-releases-install-to-the-tested-tree-with-an-install-lock-and-rebuild-it-byte-identically-on-two-systems-slice-13-m13a)).
Nothing is published: a public release needs separate authority.

## Building and recording

From a clean checkout of the commit, with the Node 24 release CI uses (the record names Node's and npm's versions):

```
npm ci
npm run build
npm run check:package
```

`check:package` (`scripts/check-package.mjs` over `scripts/release.mjs`) leaves four files in `scratch/release/`:

| File | Is |
|---|---|
| `mediumofexchange-reference-<version>.tgz` | The package as `npm pack` writes it: built modules, the six compiled relations, README and licence |
| `package.json`, `package-lock.json` | The install lock: the tarball by its SHA-512 integrity and each runtime entry of the checkout's lockfile, at its version, integrity and place |
| `release-record.json` | The commit built and whether its tree was clean; the tarball's size, entry count, SHA-256 and integrity; the install lock's SHA-256; the checkout lockfile's SHA-256; the specification pins the shipped constructions name; Node's and npm's versions |

Before writing the record it installs from the install lock with `npm ci`, checks npm's own record of what it placed
(`node_modules/.package-lock.json`): each installed entry is the pinned one and every pinned entry for this system is
there, optional ones included. It then runs the installed package's imports and its `moe` bin. A record made from a
tree with changes says `clean: false` and matches no commit. In a pull request's CI the commit is the merge commit
checked out. CI does this on Linux and Windows and its `reproducible-release` job compares the
two records: one commit must give the same tarball bytes, install lock and pins on both systems. The pool-v3 command
drill installs the commands it runs the same way.

## Installing

Copy the tarball, `package.json` and `package-lock.json` into an empty directory and run there:

```
npm ci --ignore-scripts
node <checkout of the commit>/scripts/release.mjs --verify <that directory>
```

`npm ci` refuses a tarball or required registry entry whose bytes fail their integrity (`EINTEGRITY`), and npm's
cache, keyed by integrity, serves only the pinned bytes. It drops an optional entry that fails its integrity silently
and exits 0 (the native `msgpackr-extract` builds; `msgpackr` then runs its JavaScript path). `--verify` refuses that
install: it requires every pinned entry for this system's `os` and `cpu` in npm's record of what it placed. The
commands are then `node node_modules/@mediumofexchange/reference/dist/cli/moe.js` (or `npx moe` in that directory). The package's own
`dependencies` are exact versions, so a library consumer that resolves the package itself gets the tested direct
dependencies, but their dependencies float within their ranges; only the install lock pins the whole tree.

## Limits

- Reproduction is checked for one Node and npm release at a time on two systems; another npm can pack other bytes.
  Compare against a record made with the toolchain it names.
- Registry entries are fetched from `registry.npmjs.org` or a mirror serving the same integrity; their availability is
  assumed, not provided.
- Install scripts are not run. The native `msgpackr-extract` builds are locked as optional per-system entries.
- `--verify` reads npm's record of what it placed, not the files on disk: npm checks integrity as it extracts, and
  changes made after the install are outside this record. It judges `os` and `cpu`; an entry naming a `libc` refuses.
- A shipped `npm-shrinkwrap.json` did not pin a tarball install (npm 11.19, 2026-10-07), so the pin travels as the
  install lock. A registry publication would need a shrinkwrap and an install check of its own; none is made.
