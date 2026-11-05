#!/usr/bin/env python3
"""Build an installable OpenWrt .ipk for luci-app-tempmon WITHOUT an SDK.

The package contains only scripts/Lua/static files (no compiled code), so the
ipk can be assembled directly. Since OpenWrt 24.x, the .ipk format is a single
outer gzip tar (checked against a real 24.10.6 feed package):

    ipk (outer tar.gz)
    ├── ./debian-binary       "2.0\\n"
    ├── ./data.tar.gz         ./usr/... ./etc/...  (filesystem payload)
    └── ./control.tar.gz      ./control, ./conffiles

Directories are laid out exactly like the luci.mk build would install them:
    root/   -> /
    luasrc/ -> /usr/lib/lua/luci/
    htdocs/ -> /www/
"""
import argparse
import gzip
import hashlib
import io
import os
import re
import sys
import tarfile
import time

PKG = "luci-app-tempmon"
ARCH = "all"
DEPENDS = "libc, luci-base"
LICENSE = "GPL-2.0-only"
MAINTAINER = "luci-app-tempmon contributors"
DESCRIPTION = (
    "luci-app-tempmon v1.0.0 首发正式版，界面重构，PC与移动端自适应，"
    "修复A/B/C/D/E原有体验痛点，稳定采集硬件温度，支持历史曲线查看。"
)
# FIXED_MTIME 在 VERSION 之后由 _build_mtime() 算出（= 构建时刻）。
# 它既不能是常量、也不能钉死在过去某一年，理由见该函数的 docstring。

HERE = os.path.dirname(os.path.abspath(__file__))


def read_makefile_var(name):
    """Single source of truth for the package version is ../Makefile."""
    mk = open(os.path.join(HERE, "..", "Makefile"), encoding="utf-8").read()
    m = re.search(r"^%s:=(\S+)" % re.escape(name), mk, flags=re.M)
    if not m:
        raise SystemExit("cannot read %s from Makefile" % name)
    return m.group(1)


VERSION = "%s-%s" % (read_makefile_var("PKG_VERSION"), read_makefile_var("PKG_RELEASE"))
RELEASE_DIR = os.path.join(HERE, "..", "release")


def _build_mtime():
    """tar 条目时间戳 = 构建时刻。

    这个值会原样成为安装后文件的 mtime，也就是 uhttpd 发出的 Last-Modified，
    并参与 ETag（uhttpd 的 ETag 形如 "<size-hex>-<size-hex>-<mtime-hex>"）。

    关键前提（实测 OpenWrt 24.10.6 / uhttpd）：静态资源的响应头里**只有**
    ETag + Last-Modified，**不发 Cache-Control / Expires**。这时浏览器改用
    RFC 7234 的启发式新鲜期，Chrome 与 Firefox 都取
        (Date - Last-Modified) * 10%
    作为「不发任何请求、直接用本地缓存」的时长。

    两个踩过的坑，都表现为「升级后前端白屏 / 新旧模块混用」：
      * 常量 1700000000（2023-11-14）：所有版本 Last-Modified 与 ETag 都相同，
        内部 import 永远命中 304，结果是「新 app.js 配旧 core 模块」。
      * 版本号映射到 2023 年附近（2.2.0-1 用的 1702020001 = 2023-12-08）：
        ETag 确实随版本变了，但 Date - Last-Modified 高达约 1062 天，
        启发式新鲜期约 106 天。dashboard.htm 里那三个引用带 ?v= 能绕过，
        而约 60 处内部 import（./core/util.js 这类）不带查询串，浏览器
        在这 106 天里连条件请求都不发 —— 新 app.js 调旧 util.js 里不存在的
        导出，直接 SyntaxError，整页空白。

    用构建时刻则 Date - Last-Modified ≈ 0，启发式新鲜期归零：浏览器每次都带
    If-None-Match 重验证，未变的文件回 304（几十字节），变了的回 200。
    代价是失去字节级可复现构建——但三个 gzip 头的 mtime 本来就在用
    time.time()，可复现性早已不存在，此处没有实际损失。
    """
    return int(time.time())


FIXED_MTIME = _build_mtime()

POSTINST = """#!/bin/sh
# clear LuCI dispatcher caches so new pages/menus register immediately
[ -n "${IPKG_INSTROOT}" ] && exit 0
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
/etc/init.d/uhttpd restart 2>/dev/null
# (re)start the collector: the running daemon loses its script inode on upgrade
if [ -x /etc/init.d/tempmon ]; then
	/etc/init.d/tempmon enable 2>/dev/null
	/etc/init.d/tempmon restart 2>/dev/null
fi
exit 0
"""

PRERM = """#!/bin/sh
[ -n "${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/tempmon stop 2>/dev/null
/etc/init.d/tempmon disable 2>/dev/null
rm -f /tmp/luci-indexcache /tmp/luci-indexcache.* 2>/dev/null
rm -rf /tmp/luci-modulecache 2>/dev/null
exit 0
"""

EXEC_PREFIXES = ("etc/init.d/", "usr/libexec/")


def walk_payload(root):
    """Yield (arcname, abspath, isdir) mirroring an OpenWrt 'root/' tree."""
    for cur, dirs, files in os.walk(root):
        rel = os.path.relpath(cur, root)
        if rel != ".":
            yield "./" + rel.replace(os.sep, "/"), None, True
        for name in sorted(files):
            abspath = os.path.join(cur, name)
            arc = "./" + os.path.relpath(abspath, root).replace(os.sep, "/")
            yield arc, abspath, False


def payload_dirs_mapping():
    """Map source dirs to destination prefixes (luci.mk conventions)."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    return [
        (os.path.join(root, "root"), "/"),
        (os.path.join(root, "luasrc"), "/usr/lib/lua/luci/"),
        (os.path.join(root, "htdocs"), "/www/"),
    ]


def make_data_tar_gz(items):
    """items: list of (dest_path, abspath_or_None, isdir). Returns gz bytes."""
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.USTAR_FORMAT) as tf:
        for dest, abspath, isdir in items:
            if isdir:
                ti = tarfile.TarInfo("." + dest)
                ti.type = tarfile.DIRTYPE
                ti.mode = 0o755
            else:
                ti = tarfile.TarInfo("." + dest)
                ti.size = os.path.getsize(abspath)
                rel = dest.lstrip("/")
                ti.mode = 0o755 if rel.startswith(EXEC_PREFIXES) else 0o644
            ti.mtime = FIXED_MTIME
            ti.uid = 0
            ti.gid = 0
            ti.uname = "root"
            ti.gname = "root"
            if isdir:
                tf.addfile(ti)
            else:
                with open(abspath, "rb") as f:
                    tf.addfile(ti, f)
    return buf.getvalue()


def make_control_tar_gz(installed_size_kb):
    control = (
        "Package: %s\n"
        "Version: %s\n"
        "Depends: %s\n"
        "License: %s\n"
        "Section: luci\n"
        "Architecture: %s\n"
        "Maintainer: %s\n"
        "Installed-Size: %d\n"
        "Description: %s\n"
    ) % (PKG, VERSION, DEPENDS, LICENSE, ARCH, MAINTAINER,
         installed_size_kb, DESCRIPTION)
    conffiles = "/etc/config/tempmon\n"

    files = {
        "./control": control.encode(),
        "./conffiles": conffiles.encode(),
        "./postinst": POSTINST.encode(),
        "./prerm": PRERM.encode(),
    }
    modes = {
        "./control": 0o644,
        "./conffiles": 0o644,
        "./postinst": 0o755,
        "./prerm": 0o755,
    }
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.USTAR_FORMAT) as tf:
        d = tarfile.TarInfo("./")
        d.type = tarfile.DIRTYPE
        d.mode = 0o755
        d.mtime = FIXED_MTIME
        d.uid = 0
        d.gid = 0
        d.uname = "root"
        d.gname = "root"
        tf.addfile(d)
        for name, data in sorted(files.items()):
            ti = tarfile.TarInfo(name)
            ti.size = len(data)
            ti.mode = modes[name]
            ti.mtime = FIXED_MTIME
            ti.uid = 0
            ti.gid = 0
            ti.uname = "root"
            ti.gname = "root"
            tf.addfile(ti, io.BytesIO(data))
    return buf.getvalue()


def write_ipk(out_path, members):
    """members: list of (name, bytes) -> single outer tar.gz (OpenWrt 24.x
    ipk layout: ./debian-binary, ./data.tar.gz, ./control.tar.gz)."""
    with tarfile.open(out_path, "w:gz", format=tarfile.USTAR_FORMAT) as tf:
        for name, data in members:
            ti = tarfile.TarInfo("./" + name)
            ti.size = len(data)
            ti.mode = 0o644
            ti.mtime = FIXED_MTIME
            ti.uid = 0
            ti.gid = 0
            ti.uname = "root"
            ti.gname = "root"
            tf.addfile(ti, io.BytesIO(data))


def main():
    ap = argparse.ArgumentParser(description="build luci-app-tempmon ipk")
    ap.add_argument("-o", "--output", default=None, help="output ipk path")
    ap.add_argument("--list", action="store_true", help="list payload instead of building")
    args = ap.parse_args()

    mapping = payload_dirs_mapping()

    if args.list:
        for src, prefix in mapping:
            for arc, abspath, isdir in walk_payload(src):
                if isdir:
                    print(f"DIR  {prefix}{arc[2:]}")
                else:
                    print(f"FILE {prefix}{arc[2:]}")
        return 0

    # collect payload
    items = []  # (dest, abspath, isdir)
    total_bytes = 0
    for src, prefix in mapping:
        if not os.path.isdir(src):
            print(f"warning: missing source dir {src}", file=sys.stderr)
            continue
        for arc, abspath, isdir in walk_payload(src):
            dest = prefix + arc[2:]
            items.append((dest, abspath, isdir))
            if not isdir:
                total_bytes += os.path.getsize(abspath)
    installed_size_kb = max(1, (total_bytes + 1023) // 1024)

    data_tgz = make_data_tar_gz(items)
    control_tgz = make_control_tar_gz(installed_size_kb)
    debian_binary = b"2.0\n"

    os.makedirs(RELEASE_DIR, exist_ok=True)
    out = args.output or os.path.join(
        RELEASE_DIR, f"{PKG}_{VERSION}_{ARCH}.ipk"
    )
    write_ipk(out, [
        ("debian-binary", debian_binary),
        ("data.tar.gz", data_tgz),
        ("control.tar.gz", control_tgz),
    ])

    print(f"wrote {out} ({os.path.getsize(out)} bytes)")
    print(f"payload: {len(items)} entries, {total_bytes} bytes "
          f"(Installed-Size {installed_size_kb} KB)")
    sha = hashlib.sha256(open(out, "rb").read()).hexdigest()
    print(f"sha256sum: {sha}")
    return 0


if __name__ == "__main__":
    sys.exit(main())