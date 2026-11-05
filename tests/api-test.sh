#!/bin/sh
# Re-runnable on-router API test suite for luci-app-tempmon.
# Forges a temporary LuCI session (shadow backup/restore guaranteed), then
# asserts every JSON endpoint and the dashboard page render.
#
# Usage: scp tests/api-test.sh root@<router>:/tmp/ && ssh root@<router> sh /tmp/api-test.sh

cp /etc/shadow /tmp/shadow.bak
trap 'cp /tmp/shadow.bak /etc/shadow; sync 2>/dev/null; rm -f /tmp/api-test.sh' EXIT
printf 'TempMon#2026\nTempMon#2026\n' | passwd root >/dev/null 2>&1
SID=$(ubus call session login '{"username":"root","password":"TempMon#2026"}' | jsonfilter -e '@.ubus_rpc_session')
TOKEN=$(head -c 16 /dev/urandom | md5sum | cut -d' ' -f1)
ubus call session set "{\"ubus_rpc_session\":\"$SID\",\"values\":{\"token\":\"$TOKEN\"}}" >/dev/null 2>&1
cp /tmp/shadow.bak /etc/shadow
sync 2>/dev/null

FAIL=0
HIDE_BEFORE=$(uci -q get tempmon.core.hide_items)
get() { # path, marker
	rm -f /tmp/at.out
	uclient-fetch -q -O /tmp/at.out --header="Cookie: sysauth_http=$SID" "http://127.0.0.1$1" 2>/dev/null
	if [ $? -ne 0 ]; then echo "FAIL GET $1 (http error)"; FAIL=1; return; fi
	if [ -n "$2" ] && ! grep -q "$2" /tmp/at.out; then echo "FAIL GET $1 (marker '$2' missing)"; FAIL=1; return; fi
	echo "ok   GET $1 ($(wc -c < /tmp/at.out) bytes)"
}
post() { # path, expect_ok  (double-submit nonce from /tmp/tempmon.nonce)
	rm -f /tmp/at.out
	local ntok
	ntok=$(head -n 1 /tmp/tempmon.nonce 2>/dev/null)
	local url="$1"
	case "$url" in
		*\?*) url="${url}&token=${ntok}" ;;
		*) url="${url}?token=${ntok}" ;;
	esac
	uclient-fetch -q -O /tmp/at.out --header="Cookie: sysauth_http=$SID" \
		--header="X-TM-CSRF: $ntok" \
		--post-data='x=1' "http://127.0.0.1$url" 2>/dev/null
	if [ $? -ne 0 ]; then echo "FAIL POST $1 (http error)"; FAIL=1; return; fi
	if [ "$2" = "ok" ] && ! grep -q '"ok": *true' /tmp/at.out; then
		echo "FAIL POST $1 (body: $(head -c 80 /tmp/at.out))"; FAIL=1; return; fi
	echo "ok   POST $1"
}
post_bad() { # reversible rejected-write probe: display toggle WITHOUT token
	rm -f /tmp/at.out
	uclient-fetch -q -O /tmp/at.out --header="Cookie: sysauth_http=$SID" \
		--post-data='x=1' "http://127.0.0.1/cgi-bin/luci/admin/tempmon/api_display?key=card_temp" 2>/dev/null
	if grep -q '"ok": *true' /tmp/at.out; then
		echo "FAIL CSRF rejection (display toggled without token)"; FAIL=1; return; fi
	echo "ok   CSRF rejected api_display (no token)"
}
post_nohdr() { # URL token only (custom header absent) must still succeed:
	# the 24.10 bridge does not forward X-TM-CSRF to Lua, so the header is
	# optional strengthening, not a hard requirement.
	rm -f /tmp/at.out
	local ntok
	ntok=$(head -n 1 /tmp/tempmon.nonce 2>/dev/null)
	uclient-fetch -q -O /tmp/at.out --header="Cookie: sysauth_http=$SID" \
		--post-data='x=1' "http://127.0.0.1$1&token=$ntok" 2>/dev/null
	if [ $? -ne 0 ]; then echo "FAIL POST $1 (http error)"; FAIL=1; return; fi
	if [ "$2" = "ok" ] && ! grep -q '"ok": *true' /tmp/at.out; then
		echo "FAIL POST $1 (body: $(head -c 80 /tmp/at.out))"; FAIL=1; return; fi
	echo "ok   POST $1 (token-only, header optional)"
}

B=/cgi-bin/luci/admin/tempmon
get "$B/dashboard" 'tm-app'
rm -f /tmp/at.html
uclient-fetch -q -O /tmp/at.html --header="Cookie: sysauth_http=$SID" "http://127.0.0.1$B/dashboard" 2>/dev/null
if grep -q "TM_TOKEN = '[0-9a-f]\{32\}'" /tmp/at.html; then
	echo "ok   dashboard embeds 32-hex CSRF nonce"
else
	echo "FAIL dashboard nonce missing/empty"; FAIL=1
fi
rm -f /tmp/at.html
get "$B/api_status" '"ok": *true'
get "$B/api_status" '"version"'
get "$B/api_data?range=1h" '"points"'
get "$B/api_io?range=1h" '"points"'
get "$B/api_sys" '"model"'
get "$B/api_sys" '"device"'
get "$B/api_sys" '"type"'
if grep -q '"device": *"tmpfs"' /tmp/at.out; then
	echo "FAIL mounts not filtered (tmpfs present)"; FAIL=1
else
	echo "ok   api_sys mounts filtered (no tmpfs)"
fi
get "$B/api_mem" '"total"'
get "$B/api_net" '"total"'
get "$B/api_procs" '"procs"'
get "$B/api_procs" '"pid"'
get "$B/api_procs" '"cpu"'
get "$B/api_logs" '"lines"'
get "$B/api_export" 'timestamp,'
get "$B/config" '温度告警阈值'
get "$B/config" 'temp_warn'
get "$B/dashboard" 'app.js?v=2.1.1'

post "$B/api_display?key=card_temp" ok
post "$B/api_display?key=card_temp" ok
post_bad
post_nohdr "$B/api_display?key=card_temp" ok
post "$B/api_display?key=card_temp" ok
post "$B/api_display?key=card_temp" ok
# restore the exact hide_items state seen at test start (idempotent runs)
uci -q set tempmon.core.hide_items="$HIDE_BEFORE"
uci commit tempmon
echo "--- hide_items restored to: [$HIDE_BEFORE]"

echo "--- daemon & data sanity:"
ps | grep '[c]ollect.sh' >/dev/null && echo "ok   daemon running" || { echo "FAIL daemon not running"; FAIL=1; }
[ -s /tmp/tempmon/history.log ] && echo "ok   history.log non-empty" || { echo "FAIL history empty"; FAIL=1; }
[ -s /tmp/tempmon/count.txt ] && echo "ok   count.txt present" || { echo "FAIL count.txt missing"; FAIL=1; }

rm -f /tmp/at.out
[ "$FAIL" -eq 0 ] && echo "API TESTS PASSED" || { echo "API TESTS FAILED"; exit 1; }