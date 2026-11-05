#!/bin/sh
# config-page check with the exact primitives used by api-test.sh
cp /etc/shadow /tmp/sh.bak
trap 'cp /tmp/sh.bak /etc/shadow' EXIT
printf 'TempMon#2026\nTempMon#2026\n' | passwd root >/dev/null 2>&1
SID=$(ubus call session login '{"username":"root","password":"TempMon#2026"}' | jsonfilter -e '@.ubus_rpc_session')
cp /tmp/sh.bak /etc/shadow

FAIL=0
get() {
	rm -f /tmp/at.out
	uclient-fetch -q -O /tmp/at.out --header="Cookie: sysauth_http=$SID" "http://127.0.0.1$1" 2>/dev/null
	if [ $? -ne 0 ]; then echo "FAIL GET $1 (http error)"; FAIL=1; return; fi
	if [ -n "$2" ] && ! grep -q "$2" /tmp/at.out; then echo "FAIL GET $1 (marker '$2' missing)"; FAIL=1; return; fi
	echo "ok   GET $1 ($(wc -c < /tmp/at.out) bytes)"
}

B=/cgi-bin/luci/admin/tempmon
get "$B/config" '温度告警阈值'
get "$B/config" 'temp_warn'
get "$B/dashboard" 'app.js?v=2.1.1'
get "$B/dashboard" 'theme.css?v=2.1.1'
[ "$FAIL" -eq 0 ] && echo "CONFIG CHECK PASSED" || { echo "CONFIG CHECK FAILED"; exit 1; }