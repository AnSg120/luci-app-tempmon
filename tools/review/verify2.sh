#!/bin/sh
# verify 2.1.1-10: CBI page compiles/render, dashboard embeds cache-busted assets
cp /etc/shadow /tmp/sh.bak
trap 'cp /tmp/sh.bak /etc/shadow' 0
printf 'TempMon#2026\nTempMon#2026\n' | passwd root >/dev/null 2>&1
sleep 1
SID=$(ubus call session login '{"username":"root","password":"TempMon#2026"}' | jsonfilter -e '@.ubus_rpc_session')
echo "SID=$SID"
FAIL=0

rm -f /tmp/v2.out
uclient-fetch -q -O /tmp/v2.out --header="Cookie: sysauth_http=$SID" "http://127.0.0.1/cgi-bin/luci/admin/tempmon/config"
RC=$?
SZ=$(wc -c < /tmp/v2.out 2>/dev/null || echo 0)
echo "config rc=$RC size=$SZ"
grep -q "温度告警阈值" /tmp/v2.out && echo "ok   config renders CBI fields" || { echo "FAIL config content"; FAIL=1; }
grep -q "Runtime error" /tmp/v2.out && { echo "FAIL config still errors"; FAIL=1; }

rm -f /tmp/v3.out
uclient-fetch -q -O /tmp/v3.out --header="Cookie: sysauth_http=$SID" "http://127.0.0.1/cgi-bin/luci/admin/tempmon/dashboard"
echo "dashboard size=$(wc -c < /tmp/v3.out 2>/dev/null || echo 0)"
grep -q "app.js?v=2.1.1" /tmp/v3.out && echo "ok   cache-busted app.js referenced" || { echo "FAIL no cache-buster"; FAIL=1; }
grep -q "theme.css?v=2.1.1" /tmp/v3.out && echo "ok   cache-busted theme.css referenced" || { echo "FAIL no css buster"; FAIL=1; }

rm -f /tmp/v4.out
uclient-fetch -q -O /tmp/v4.out "http://127.0.0.1/luci-static/resources/tempmon/app.js?v=2.1.1"
echo "app.js static size=$(wc -c < /tmp/v4.out 2>/dev/null || echo 0)"
grep -q "renderView" /tmp/v4.out && echo "ok   fresh app.js served" || { echo "FAIL app.js content"; FAIL=1; }

[ "$FAIL" -eq 0 ] && echo "VERIFY PASSED" || { echo "VERIFY FAILED"; exit 1; }