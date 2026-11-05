#!/bin/sh
#
# Smoke test for luci-app-tempmon's collect.sh.
#
# Runs the collector against a simulated /sys and /proc (via SYS_ROOT) plus a
# stub `uci`, so it works on any POSIX host with awk/sh — including OpenWrt
# itself, or Git Bash on Windows.
#
# Usage: sh tests/test-collect.sh

set -u

SCRIPT="$(cd "$(dirname "$0")/.." && pwd)/root/usr/libexec/tempmon/collect.sh"
STUBS="$(cd "$(dirname "$0")" && pwd)/stubs"
WORK="$(mktemp -d)"
export SYS_ROOT="$WORK/rootfs"
export TEST_DATA_DIR="$WORK/data"
export PATH="$STUBS:$PATH"

FAILED=0

note() { echo "== $1"; }
ok() { echo "   ok: $1"; }
fail() { echo "   FAIL: $1"; FAILED=1; }

check() { # description, condition...
	local desc="$1"; shift
	if "$@"; then ok "$desc"; else fail "$desc"; fi
}

trap 'rm -rf "$WORK"' EXIT

mkdir -p "$SYS_ROOT/proc" \
	 "$SYS_ROOT/proc/net" \
	 "$SYS_ROOT/sys/class/thermal/thermal_zone0" \
	 "$SYS_ROOT/sys/class/thermal/thermal_zone1" \
	 "$SYS_ROOT/sys/devices/system/cpu/cpu0/cpufreq" \
	 "$TEST_DATA_DIR"

echo "cpu-thermal" > "$SYS_ROOT/sys/class/thermal/thermal_zone0/type"
echo "52300"      > "$SYS_ROOT/sys/class/thermal/thermal_zone0/temp"
echo "wifi"       > "$SYS_ROOT/sys/class/thermal/thermal_zone1/type"
echo "48500"      > "$SYS_ROOT/sys/class/thermal/thermal_zone1/temp"
echo "1200000"    > "$SYS_ROOT/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq"

# /proc/stat layout: cpu user nice system idle iowait irq softirq steal
write_stat() { # $1=user $2=system $3=idle
	cat > "$SYS_ROOT/proc/stat" <<EOF
cpu  $1 0 $2 $3 200 0 0 0
cpu0 $1 0 $2 $3 200 0 0 0
cpu1 $1 0 $2 $3 200 0 0 0
intr 1 2 3
ctxt 1
btime 1000
processes 1
procs_running 1
EOF
}
write_stat 1000 9000 100000

echo "0.10 0.05 0.02 1/10 1000" > "$SYS_ROOT/proc/loadavg"
echo "360000.00 360000.00" > "$SYS_ROOT/proc/uptime"
cat > "$SYS_ROOT/proc/meminfo" <<EOF
MemTotal:       512000 kB
MemFree:        100000 kB
Buffers:         50000 kB
Cached:         150000 kB
MemAvailable:   280000 kB
SwapCached:          0 kB
EOF

# /proc/net/dev: two header lines + interfaces (lo must be excluded)
write_net() { # $1=eth0 rx $2=eth0 tx $3=wlan0 rx $4=wlan0 tx
	cat > "$SYS_ROOT/proc/net/dev" <<EOF
Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 100 1 0 0 0 0 0 0 100 1 0 0 0 0 0 0
  eth0: $1 5 0 0 0 0 0 0 $2 6 0 0 0 0 0 0
 wlan0: $3 7 0 0 0 0 0 0 $4 8 0 0 0 0 0 0
EOF
}
write_net 1000 2000 3000 4000

# ---------------------------------------------------------------- run & verify

note "init files"
sh "$SCRIPT" --init || { fail "--init exit code"; exit 1; }
check "zones.txt created"          test -f "$TEST_DATA_DIR/zones.txt"
check "zone names clean"           grep -q '^0 cpu-thermal ' "$TEST_DATA_DIR/zones.txt" \
	&& grep -q '^1 wifi ' "$TEST_DATA_DIR/zones.txt"
check "history.log created"        test -f "$TEST_DATA_DIR/history.log"
check "ifaces.txt created"         test -f "$TEST_DATA_DIR/ifaces.txt"
check "iface list (lo excluded)"   grep -q '^0 eth0 - - eth0$' "$TEST_DATA_DIR/ifaces.txt" \
	&& grep -q '^1 wlan0 - - wlan0$' "$TEST_DATA_DIR/ifaces.txt"
check "meta.txt has zones=2"       grep -q '^zones=2 ' "$TEST_DATA_DIR/meta.txt"
check "meta.txt has cores=2"       grep -q 'cores=2 '  "$TEST_DATA_DIR/meta.txt"
check "meta.txt has ifaces"        grep -q 'ifaces=eth0,wlan0 ' "$TEST_DATA_DIR/meta.txt"

note "first sample (baseline -> 0% usage)"
sh "$SCRIPT" --once || { fail "--once exit code"; exit 1; }
LINE1="$(tail -n 1 "$TEST_DATA_DIR/history.log")"
[ "$(echo "$LINE1" | awk -F, '{print NF}')" = "27" ] || fail "field count is $(echo "$LINE1" | awk -F, '{print NF}') (want 27: 13 base + 2 ifaces x 4 + 6 v3)"
# NOTE: fixed-string (-F) checks on purpose: MSYS regex engines mis-handle
# patterns like "^[0-9]*,[0-9.]*,71\.4,71\.4,71\.4,"
check "usage 0.0"            sh -c "echo \"$LINE1\" | grep -Fq ',0.0,0.0,0.0,1200000'"
check "freq/load/mem"        sh -c "echo \"$LINE1\" | grep -Fq ',1200000,0.10,0.05,0.02,512000,100000,280000,'"
check "zone temps 52.3,48.5" sh -c "echo \"$LINE1\" | grep -Fq ',52.3,48.5,'"
check "iface totals (rate 0 at baseline)" \
	sh -c "echo \"$LINE1\" | grep -Fq ',0,0,1000,2000,0,0,3000,4000,'"
check "v3 tail (uptime 360000)" \
	sh -c "echo \"$LINE1\" | grep -Fq ',360000'"

note "second sample (no cpu change; net counters changed)"
write_net 5000 9000 3000 4000
sh "$SCRIPT" --once || fail "--once (2nd) exit code"
LINE2="$(tail -n 1 "$TEST_DATA_DIR/history.log")"
check "usage still 0.0" sh -c "echo \"$LINE2\" | grep -Fq ',0.0,0.0,0.0,1200000'"
check "iface totals updated" \
	sh -c "echo \"$LINE2\" | grep -Fq ',5000,9000,' && echo \"$LINE2\" | grep -Fq ',3000,4000'"
R14="$(echo "$LINE2" | awk -F, '{print $14}')"
R18="$(echo "$LINE2" | awk -F, '{print $18}')"
check "eth0 rx rate > 0 (got $R14)" test "$R14" -gt 0
check "wlan0 rx rate == 0 (got $R18)" test "$R18" -eq 0

note "third sample (cpu counters changed -> 71.4%)"
# totals: prev busy+idle = 1000+9000+100000+200 = 110200 (idle 100200)
#         new  busy+idle = 2000+10000+100800+200 = 113000 (idle 101000)
# delta busy = 2800-800 = 2000 -> 2000/2800 = 71.43%
write_stat 2000 10000 100800
sh "$SCRIPT" --once || fail "--once (3rd) exit code"
LINE3="$(tail -n 1 "$TEST_DATA_DIR/history.log")"
check "usage 71.4" sh -c "echo \"$LINE3\" | grep -Fq ',71.4,71.4,71.4,1200000'"

note "rotation (max_lines=1000; keep clamps to >=1000 lines)"
rm -f "$TEST_DATA_DIR/history.log"
TEST_MAXLINES=1000 sh "$SCRIPT" --init >/dev/null
seq 1 1200 | sed 's/^/1000000000,1.0,0.0,0.0,1200000,0.1,0.1,0.1,512000,100000,280000,52.3,48.5,0,0,100,200,0,0,300,400,0.0,0.0,0.0,100000,50000,3600/' \
	>> "$TEST_DATA_DIR/history.log"
TEST_MAXLINES=1000 sh "$SCRIPT" --once || fail "--once (rotation) exit code"
N="$(wc -l < "$TEST_DATA_DIR/history.log")"
check "bounded (1000 lines, got $N)" [ "$N" -eq 1000 ]

note "fresh start (no history.log -> re-init)"
mv "$TEST_DATA_DIR/history.log" "$TEST_DATA_DIR/history.keep"
sh "$SCRIPT" --init >/dev/null
check "old log kept"      test -f "$TEST_DATA_DIR/history.keep"
check "fresh history.log" test -f "$TEST_DATA_DIR/history.log"

echo
if [ "$FAILED" -eq 0 ]; then
	echo "ALL TESTS PASSED"
else
	echo "SOME TESTS FAILED"
	exit 1
fi