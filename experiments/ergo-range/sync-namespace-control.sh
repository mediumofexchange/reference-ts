#!/bin/sh
# Fixed 8 MiB rootless WSL control. No node, external traffic or host settings.
set -eu
repo=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd -P)
probe="$repo/scratch/sync-namespace-control"
for tool in timeout unshare mount umount python3; do
    command -v "$tool" >/dev/null || { echo "Missing tool: $tool" >&2; exit 1; }
done
# Refuse existing state; only this newly-created empty mountpoint is removed.
test -d "$repo/scratch"
mkdir -- "$probe"
trap 'rmdir -- "$probe"' EXIT
timeout --kill-after=2s 15s unshare --user --map-root-user --mount --net \
    --propagation private --fork /bin/sh -s -- "$probe" <<'CONTROL'
set -eu
probe=$1
mount -t tmpfs -o size=8388608,nr_inodes=32,nodev,nosuid,noexec tmpfs "$probe"
trap 'umount -- "$probe"' EXIT
python3 -I -B - "$probe" <<'PY'
import errno
import json
import os
import pathlib
import sys

path = pathlib.Path(sys.argv[1])
mapping = pathlib.Path('/proc/self/uid_map').read_text().split()
assert len(mapping) == 3 and mapping[0] == '0' and mapping[1] != '0' and mapping[2] == '1', mapping
interfaces = pathlib.Path('/proc/net/dev').read_text().splitlines()[2:]
names = []
for line in interfaces:
    name, counters = line.split(':', 1)
    name = name.strip()
    assert name in ('lo', 'tunl0', 'sit0'), name
    assert all(int(value) == 0 for value in counters.split()), line
    names.append(name)
assert 'lo' in names
mounts = [line.split() for line in pathlib.Path('/proc/mounts').read_text().splitlines()]
# The supported workspace path contains no mount-table escapes.
assert not any(c.isspace() or c == '\\' for c in str(path)), str(path)
entry, = [entry for entry in mounts if entry[1] == str(path)]
assert entry[2] == 'tmpfs' and {'nodev', 'nosuid', 'noexec'} <= set(entry[3].split(',')), entry
stat = os.statvfs(path)
capacity = stat.f_blocks * stat.f_frsize
assert capacity == 8388608, capacity
written = 0
failure = None
fd = os.open(path / 'fixed-write', os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
try:
    chunk = bytes(1048576)
    # Even an unenforced mount cannot make this control write over 9 MiB.
    for _ in range(9):
        try:
            count = os.write(fd, chunk)
            written += count
            assert count == len(chunk), count
        except OSError as exc:
            failure = exc.errno
            break
finally:
    os.close(fd)
assert failure == errno.ENOSPC and written == capacity, (failure, written)
print(json.dumps({'status': 'rootless-namespace-and-tmpfs-control-only',
    'uidMap': [int(value) for value in mapping], 'interfaces': names,
    'capacityBytes': capacity, 'writtenBytes': written, 'refusalErrno': failure,
    'limitations': ['tmpfs consumes memory/swap; not a 20 GiB disk control',
        'no connected-network accounting or node execution',
        'not a complete filesystem/process sandbox']}, sort_keys=True))
PY
CONTROL
# Namespace exit removed the mount; the parent must see its original empty dir.
test -z "$(ls -A -- "$probe")"
echo 'Parent mountpoint empty; namespace exited.'
