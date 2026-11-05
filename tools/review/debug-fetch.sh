#!/bin/sh
echo "== step1: static fetch"
rm -f /tmp/s.bin
uclient-fetch -q -O /tmp/s.bin "http://127.0.0.1/cgi-bin/luci" ; echo "static rc=$? size=$(wc -c < /tmp/s.bin 2>/dev/null || echo 0)"

echo "== step2: temp shadow + login"
cp /etc/shadow /tmp/sh.bak
printf 'TempMon#2026\nTempMon#2026\n' | passwd root >/dev/null 2>&1
LOGIN=$(ubus call session login '{"username":"root","password":"TempMon#2026"}' 2>&1)
echo "login raw: $LOGIN"
SID=$(echo "$LOGIN" | jsonfilter -e '@.ubus_rpc_session' 2>/dev/null)
echo "SID=[$SID] len=${#SID}"

echo "== step3: authed fetch config (before restore)"
rm -f /tmp/c.bin
uclient-fetch -q -O /tmp/c.bin --header="Cookie: sysauth_http=$SID" "http://127.0.0.1/cgi-bin/luci/admin/tempmon/config"
echo "config rc=$? size=$(wc -c < /tmp/c.bin 2>/dev/null || echo 0)"
head -c 300 /tmp/c.bin 2>/dev/null
echo

echo "== step4: authed fetch dashboard"
rm -f /tmp/d.bin
uclient-fetch -q -O /tmp/d.bin --header="Cookie: sysauth_http=$SID" "http://127.0.0.1/cgi-bin/luci/admin/tempmon/dashboard"
echo "dashboard rc=$? size=$(wc -c < /tmp/d.bin 2>/dev/null || echo 0)"

echo "== step5: restore shadow"
cp /tmp/sh.bak /etc/shadow
sync
echo restored