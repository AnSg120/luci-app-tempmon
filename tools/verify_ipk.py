#!/usr/bin/env python3
"""Verify the assembled ipk (OpenWrt 24.x format): outer tar.gz containing
./debian-binary, ./data.tar.gz, ./control.tar.gz; check inner contents/modes."""
import io
import os
import re
import sys
import tarfile

HERE = os.path.dirname(os.path.abspath(__file__))
_mk = open(os.path.join(HERE, "..", "Makefile"), encoding="utf-8").read()
EXPECTED = (
    re.search(r"^PKG_VERSION:=(\S+)", _mk, flags=re.M).group(1) + "-" +
    re.search(r"^PKG_RELEASE:=(\S+)", _mk, flags=re.M).group(1))
VERSION = EXPECTED or "0.0-0"

path = sys.argv[1] if len(sys.argv) > 1 else f'release/luci-app-tempmon_{VERSION}_all.ipk'

outer = tarfile.open(path, mode='r:gz')
names = outer.getnames()
print('outer entries:', names)
assert set(names) == {'./debian-binary', './data.tar.gz', './control.tar.gz'}, names

deb = outer.extractfile('./debian-binary').read()
assert deb == b'2.0\n', f'bad debian-binary: {deb!r}'

def read_member(tf, name):
    return tf.extractfile(name).read()

control_tgz = read_member(outer, './control.tar.gz')
control_tf = tarfile.open(fileobj=io.BytesIO(control_tgz), mode='r:gz')
print('control.tar.gz entries:', control_tf.getnames())
c = control_tf.extractfile('./control').read().decode()
print('--- control ---')
print(c)
assert 'Package: luci-app-tempmon' in c
assert 'Version: ' + VERSION in c
assert './postinst' in control_tf.getnames() and './prerm' in control_tf.getnames()
assert 'Architecture: all' in c
assert 'Depends: libc, luci-base' in c

data_tgz = read_member(outer, './data.tar.gz')
data_tf = tarfile.open(fileobj=io.BytesIO(data_tgz), mode='r:gz')
print('data.tar.gz entries:', len(data_tf.getnames()))
must = {
    './etc/config/tempmon': 0o644,
    './etc/init.d/tempmon': 0o755,
    './usr/libexec/tempmon/collect.sh': 0o755,
    './usr/lib/lua/luci/controller/tempmon.lua': 0o644,
    './usr/lib/lua/luci/model/cbi/tempmon.lua': 0o644,
    './usr/lib/lua/luci/view/tempmon/dashboard.htm': 0o644,
    './www/luci-static/resources/tempmon/app.js': 0o644,
    './www/luci-static/resources/tempmon/app.css': 0o644,
    './www/luci-static/resources/tempmon/theme.css': 0o644,
    './www/luci-static/resources/tempmon/chart.js': 0o644,
}
for name, mode in must.items():
    ti = data_tf.getmember(name)
    assert ti is not None, f'missing {name}'
    got = ti.mode & 0o777
    assert got == mode, f'{name}: mode {oct(got)} != {oct(mode)}'
    print(f'ok  {name}  {oct(got)}')

print('ipk verification PASSED')