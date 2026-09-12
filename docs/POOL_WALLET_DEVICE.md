# Configured wallet device custody

Status: selected Windows qualification profile, not a qualified device or a
release gate closure. This selects deployment preconditions for the existing
[configured wallet](POOL_LOCAL_PROFILE.md) and its offline handoff. It changes
no v2 bytes, derivation, backup envelope, authority or finality rule.
Independent design and source review closed with no unresolved material finding.
The [verification record](pool-wallet-device-verification.json) pins source,
focused checks and the observed host's refusal.

## Selected boundary

Use one holder-controlled Windows 11 device, a standard local holder account,
Node 24 and one dedicated local directory on the NTFS operating-system volume.
The OS volume must be fully BitLocker encrypted with protection on, software
XTS-AES encryption, Secure Boot and TPM with a PIN. Alternate automatic unlock
paths, including TPM-only and network unlock, are outside this profile. Retain
the BitLocker recovery material under the holder's control separately from the
device; this is different from the wallet export's random 32-byte recovery key.
Provisioning or changing encryption, accounts, firmware, ACLs or power policy
needs separate authorization. The repository's probe only reads settings.

The holder, SYSTEM and trusted local administrators are the only permitted
owners/readers/writers of the dedicated directory and its files. Protect its
DACL from inherited permissions and grant inheritable holder access to new
files, including SQLite sidecars. Verify the ancestor directories cannot be
replaced by another ordinary account. The directory is not a repository,
Downloads folder, sync folder, network share, reparse point or mounted image.
Do not put unreviewed programs in the holder account. Local administrators,
the OS/firmware and software running as the holder remain trusted.

Keep the database, `-wal`, `-shm`, possible `-journal`, profile and any private
request/invitation files inside that directory. Wallet roots, receiver secrets,
both payment openings, pending proofs, delivery capabilities, TLS keys and
pairing records can occur in database pages or WAL. Freezing does not erase
them. The wallet uses WAL, FULL synchronization and in-memory SQLite temporary
sorting; its encrypted export has no plaintext staging file. These choices do
not prevent OS paging, process dumps or privileged host backups.

Keep process TEMP/TMP, paging, hibernation and crash-dump storage on the protected
OS volume; disable collection/upload of wallet-process dumps and plaintext
backups/synchronization of the wallet directory. Do not pipe private commands
through a recorded terminal, shell history, transcript or diagnostic capture.
Recovery keys enter bounded stdin from a trusted local secret source; neither
arguments nor a saved shell command may contain them. The current CLI does not
provide that secret-entry user interface. Node/OpenSSL secrets also exist in
memory. Shut down before the device leaves holder control; sleep/lock alone
does not establish the powered-off theft boundary. A PIN startup drill is
required after provisioning and significant policy changes.

This protects against another ordinary local account and powered-off device
theft under the stated OS/hardware assumptions. It does not protect against
malware as the holder, a malicious administrator, an already unlocked stolen
device, compromised recovery material, invasive hardware attacks, rollback or
cloning by a party with storage/key access. It makes no secure-erasure claim.
Delivery credential rotation cannot revoke copied spend secrets.

## Recovery record and handoff

The holder maintains one current independently trusted record outside the
active device and separate from backup-provider-controlled data. A paper record
under physical control is the minimum selected method; a wallet service or
backup provider cannot reset it. Keep the export key in a separate secure
location from the encrypted export. Never put either wallet or disk recovery
keys in the record, a report or source control.

Record the authenticated profile digest, export digest, wallet/authority label,
binary revision, source-device label, intended destination label and exact
database location (retained privately), and one of
`handoff pending`, `restore unresolved`, `active destination`, or `retired`.
Labels are local bookkeeping, not cryptographic identity. These are procedures,
not a new wallet file format or an automatically enforced state machine.

1. Quiesce holders and stop receiver listeners. Freeze/export with the existing
   custody command. Read back the exact ciphertext, retain the reported digest
   independently and mark the record `handoff pending`. Store ciphertext on a
   different physical medium from the active device. A lost reply requires
   inspection of the source and exact export retry; do not infer success from
   an output filename. If the record cannot be completed, keep the source frozen
   and resolve the handoff before restoring or accepting new work.
2. Authenticate the profile and export against the retained digests. Select
   exactly one fresh destination on another qualified device. Before invoking
   restore, mark `restore unresolved` with that destination. Restore there only.
   After a lost reply inspect that same destination's `restoredFrom` and `frozen`.
   An absent, wrong or unreadable provenance remains unresolved. An interrupted
   pre-commit restore can leave an empty database; inspect it and establish no
   restored copy became active before deliberately selecting a fresh destination.
3. After matching provenance and `frozen=false`, mark `active destination` **before any wallet
   operation or receiver restart**. The export is now historical and must not
   be used for another recovery, even if no payment is known to have completed.
   A frozen restored wallet belongs to a subsequent handoff; reconcile that
   handoff instead of activating it. A crash between the record update and first
   operation sacrifices availability
   rather than authorizing a second active copy. Keep the source frozen; do not
   restore its disk image or use an older executable to bypass its guard.
4. Reconcile saved exact submissions and inbox/fulfillment records, authenticate
   any rotated invitation independently and verify current note evidence before
   new spends. Outstanding remote work can finish after local freeze. Local
   export, receipt or an old checkpoint cannot establish current spendability.
5. A later handoff requires a new freeze/export from the active destination and
   a new current record. Mark superseded records `retired`; preserving historical
   ciphertext does not make it a current backup.

If an active destination is lost after step 3, an older export is insufficient
for safe resumption: new requests, reservations, openings or deliveries may be
missing. Recover only the intact current device/state through an independently
qualified procedure, or report unavailable/unrecoverable state. Seed-only and
continuous device-loss recovery need the successor delivery/restoration work;
this profile does not implement them. If the sole selected restore destination
is lost while its outcome is unresolved, do not activate another copy without
establishing the first cannot resume. A stolen or compromised device also needs
a spend-key compromise remedy, which v2 offline export does not supply.

## Read-only storage preflight

`scripts/pool/local/device-preflight.ps1` inspects an existing dedicated
directory without opening wallet contents, enumerating key material, modifying
ACLs or enabling encryption. It reports only stable check identifiers,
`pass`/`fail`/`unknown` and explicit evidence limits. No filenames, SIDs,
keys, protector identifiers or native exception messages enter its JSON report.

Its bounded automatic checks cover local literal paths without reparse ancestors,
NTFS OS-volume placement, complete/enabled software BitLocker encryption,
TPM+PIN protector types without alternate startup protectors, Secure Boot,
conservative owner/DACL allow lists on the directory and all immediate files,
and TEMP/TMP placement. Data-only encryption flags and more than eight
protectors are refused. Missing permissions/providers, malformed observations
or more than 128 entries yield unknown/failure, never success. Nested directories
are outside this flat layout. Only the holder SID, SYSTEM and Administrators
are accepted by the ACL check; unrecognized groups and deny entries refuse
qualification even when a more complete effective-access analysis might allow
them. Holder access and inheritance also need the actual account drill below.

This is a point-in-time partial observation, **never device qualification**.
`qualified` is always false; `automaticChecks` can be `pass`, `fail` or `unknown`.
The corresponding process exit codes are 0, 2 and 3. Run with PowerShell 7 on
Windows, using an existing pre-provisioned directory:

```powershell
pwsh -NoProfile -File scripts/pool/local/device-preflight.ps1 -Directory C:\Wallet
pwsh -NoProfile -File scripts/pool/local/device-storage-runner.test.ps1
```

Even all automatic passes leave ancestry replacement rights and hardlinks, physical backing
(including virtual disks), standard-account operation, actual TPM/PIN startup,
network-unlock policy, dump/pagefile placement, sync/backup exclusions, recovery
key custody, trusted binaries and one-active-copy discipline unestablished.
The wallet does not consume this report as authorization. A hostile or changing
host can falsify observations; race prevention is a provisioning precondition.

## Qualification drills and falsifiers

Use synthetic wallets and separate provisioned test hardware. No drill may
change this workstation's controls, shut it down or copy real wallet secrets
without separate authorization. Retain exact OS/build/runtime/probe revisions,
automatic report, private provisioning record and each observed result. Redact
account identifiers, paths and all secret input before publishing evidence.

| Drill | Required observable result | Evidence boundary |
|---|---|---|
| Adverse observations | Suspended/partial encryption, wrong volume, unknown protection, broad ACL, linked path and failed discovery cannot produce automatic pass; no report discloses a supplied secret | Synthetic evaluator/collector checks only |
| Cross-account access | Another standard account cannot list/read/write/rename the directory, DB, WAL, SHM, profile or invitations; holder can create/restart and use new sidecars | Needs provisioned accounts and ancestor/effective-access checks |
| Powered-off theft | Startup requires the holder PIN; offline test environment cannot read synthetic DB/WAL or obtain recovery material | Needs separate hardware; no proof against invasive attacks |
| Storage interruption | Existing 22 process-crash cases pass on the provisioned target; separately test power loss and full/read-only disk without losing a previously exposed accepted operation | Process exits alone do not prove power-loss durability |
| Offline handoff | Configured real-proof payment, stopped receiver, frozen export, exact digest restore, lost-reply reconciliation, credential rotation and verified change spend pass on target | Existing fixture supplies flow, not target qualification |
| Stale recovery | After activation/new request or payment, an old export is marked historical and the procedure refuses a second restore; an ambiguous lost restore stays unresolved | The CLI can still restore valid old ciphertext; procedure is not rollback detection |
| Recovery separation | With the backup medium alone no key is available; with an older/missing record no restore is authorized; use synthetic material to demonstrate retained current record and same-destination readback | Physical holder procedure; no provider or operator reset authority |

A successful ordinary-account read, automatic pass after a failed required
observation, off-volume secret spill, recovery-key disclosure, or second active
restore invalidates the corresponding boundary. Record unavailable drills as
open; do not label this device qualified from a green synthetic test suite.

The final synthetic suite passed 320 assertions, including sidecar inspection,
coercion-resistant provider values, suspended/partial protection, wrong types,
strict unique protector IDs, links, directory bounds and private-error refusal.
Independent review found PowerShell array/truthiness coercion and a regex
end-anchor accepting a final newline; scalar/typed observations and exact anchors
fix those cases. Final independent readback and the same focused suite passed.
The CI invocation regression also checks the suite's process result: its expected
invalid-input child exits 2, but the suite exits 0 only after all assertions and
cleanup pass. The original hosted run passed assertions but failed by propagating
that child's status; the regression reproduced exit 2 before the fix.
The existing development repository returned `fail`, with its directory ACL
outside the selected policy and BitLocker/PIN/Secure Boot observations `unknown`.
No key material was queried and no settings changed. This is useful refusal
evidence, not qualification of this workstation. CIM calls request five-second
timeouts; host/filesystem calls have no absolute watchdog. Operator interruption
of a stuck observation leaves qualification unavailable.

## Rationale and sources

Reuse OS volume encryption and access control rather than adding a second
database encryption/key store: encrypting only SQLite would leave paging, dumps
and key persistence unresolved. A separately encrypted data volume or container
adds unlock and spill boundaries without qualifying the current OS. Broadly
supporting every Windows ACL/backup policy would enlarge the first target.
Accept the cost of a dedicated device/account, PIN startup, manual record,
bounded flat directory and planned offline transfers. This narrows deployment;
it does not weaken open protocol entry or introduce an operator debit/reset key.

Microsoft's [BitLocker countermeasures](https://learn.microsoft.com/en-us/windows/security/operating-system-security/data-protection/bitlocker/countermeasures)
describe preboot protection and power-state limits. The
[volume provider](https://learn.microsoft.com/en-us/windows/win32/secprov/win32-encryptablevolume)
exposes status and protector types through read methods. The probe calls only
`GetConversionStatus`, `GetProtectionStatus`, `GetEncryptionMethod`,
`GetKeyProtectors` and `GetKeyProtectorType`; it never requests recovery passwords
or external keys. The
[ACL query](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.security/get-acl)
exposes security descriptors. Reviewed 2026-09-12. These are platform references,
not evidence that this machine satisfies the profile.
