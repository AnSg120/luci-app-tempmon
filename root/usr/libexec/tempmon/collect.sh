#!/bin/sh
#
# tempmon collector (luci-app-tempmon)
#
# Periodically samples:
#   - CPU/SoC temperatures  (/sys/class/thermal/thermal_zone*/temp)
#   - CPU utilization total + per core (/proc/stat deltas)
#   - CPU frequency          (/sys/devices/system/cpu/cpu0/cpufreq/*_cur_freq)
#   - load average           (/proc/loadavg)
#   - memory usage           (/proc/meminfo)
# and appends one CSV line per sample to <data_dir>/history.log
#
# Usage:
#   collect.sh              run the sampling loop (started by /etc/init.d/tempmon)
#   collect.sh --init       (re)create meta files / headers, keep existing history
#
# Data layout: kept in <data_dir>, default /tmp/tempmon (RAM).
#   zones.txt      "index name path" per thermal zone (column order reference)
#   meta.txt       "zones=N cores=N interval=M"
#   history.log    CSV lines, rotated when line count exceeds max_lines
#   .cpu_prev      previous /proc/stat snapshot (delta computation state)

PROG=tempmon
PIDFILE="/var/run/$PROG.pid"
DEFAULT_DIR="/tmp/tempmon"

# Test hook: point SYS_ROOT at a fake root that provides /sys and /proc so the
# collector can be smoke-tested on a non-Linux host (see tests/test-collect.sh).
SYS_ROOT="${SYS_ROOT:-}"

INTERVAL=60
MAXLINES=30000
WARN=75
CRIT=85
CORES=1
SLEEPPID=""
DATA_DIR="$DEFAULT_DIR"

log() {
	[ -x /usr/bin/logger ] && logger -t "$PROG" "$1" 2>/dev/null
	return 0
}

uci_get() {
	local v
	v="$(uci -q get "tempmon.core.$1")"
	[ -n "$v" ] && echo "$v" || echo "$2"
}

refresh_config() {
	local interval maxlines
	interval="$(uci_get interval 60)"
	maxlines="$(uci_get max_lines 30000)"
	WARN="$(uci_get temp_warn 75)"
	CRIT="$(uci_get temp_crit 85)"
	case "$interval" in ''|*[!0-9]*) interval=60 ;; esac
	case "$maxlines" in ''|*[!0-9]*) maxlines=30000 ;; esac
	[ "$interval" -lt 5 ] && interval=5
	[ "$maxlines" -lt 1000 ] && maxlines=1000
	INTERVAL=$interval
	MAXLINES=$maxlines
}

# ------------------------------------------------------------------ init phase

core_count() {
	local c
	c="$(grep -Ec '^cpu[0-9]+ ' "$SYS_ROOT/proc/stat" 2>/dev/null)"
	[ -z "$c" ] || [ "$c" -eq 0 ] 2>/dev/null && c=1
	echo "$c"
}

zones_init() {
	local idx z n
	idx=0
	: > "$DATA_DIR/zones.txt"
	for z in "$SYS_ROOT"/sys/class/thermal/thermal_zone*; do
		[ -e "$z/temp" ] || continue
		# keep only safe name chars (strips trailing newline/CR/etc. too)
		n="$(cat "$z/type" 2>/dev/null | tr -cd 'A-Za-z0-9_.-')"
		[ -n "$n" ] || n="$(basename "$z")"
		echo "$idx $n $z" >> "$DATA_DIR/zones.txt"
		idx=$((idx + 1))
	done
}

meta_write() {
	local z c i ifs
	z="$(wc -l < "$DATA_DIR/zones.txt" 2>/dev/null || echo 0)"
	c="$(core_count)"
	i="$(uci_get interval 60)"
	ifs="$(awk '{ printf "%s%s", (NR > 1 ? "," : ""), $2 }' "$DATA_DIR/ifaces.txt" 2>/dev/null)"
	echo "zones=$z cores=$c ifaces=$ifs v=3 interval=$i" > "$DATA_DIR/meta.txt"
}

ifaces_init() {
	local idx n label freq band role ip
	idx=0
	: > "$DATA_DIR/ifaces.txt"
	# role map: device -> uppercased network interface section name (WAN/LAN/...)
	uci -q show network 2>/dev/null | awk -F= -v q="'" \
		'/\.device=|\.ifname=/ {
			split($1, a, ".");
			val = $2; gsub(q, "", val);
			n = split(val, vs, " ");
			for (i = 1; i <= n; i++) if (vs[i] != "") print vs[i], toupper(a[2]);
		}' > "$DATA_DIR/.roles" 2>/dev/null
	# ipv4 map: device -> first address
	ip -4 -o addr 2>/dev/null | awk \
		'{ dev = $2; sub(/@.*/, "", dev); split($4, a, "/");
		   if (!(dev in seen)) { seen[dev] = 1; print dev, a[1] } }' \
		> "$DATA_DIR/.ips" 2>/dev/null
	for n in $(awk -F: 'NR > 2 { gsub(/ /, "", $1); if ($1 != "" && $1 != "lo") print $1 }' \
	         "$SYS_ROOT/proc/net/dev" 2>/dev/null); do
		label="$n"
		role="$(awk -v d="$n" '$1 == d { print $2; exit }' "$DATA_DIR/.roles" 2>/dev/null)"
		ip="$(awk -v d="$n" '$1 == d { print $2; exit }' "$DATA_DIR/.ips" 2>/dev/null)"
		[ -n "$role" ] || role="-"
		[ -n "$ip" ] || ip="-"
		if [ -x /usr/bin/iwinfo ]; then
			freq="$(iwinfo "$n" info 2>/dev/null | grep -oE '[0-9]+\.[0-9]+ GHz' | head -n 1)"
			if [ -n "$freq" ]; then
				band="${freq%%.*}"
				case "$band" in
					2) label="$n (2.4GHz)" ;;
					5) label="$n (5GHz)" ;;
					6) label="$n (6GHz)" ;;
					*) label="$n ($freq)" ;;
				esac
			fi
		fi
		echo "$idx $n $role $ip $label" >> "$DATA_DIR/ifaces.txt"
		idx=$((idx + 1))
	done
}

history_init() {
	meta_write
	{
		echo "# tempmon history v1"
		echo "# $(cat "$DATA_DIR/meta.txt")"
		echo "# ts,usage,core0..coreN,freq_khz,load1,load5,load15,mem_total_kb,mem_free_kb,mem_avail_kb,zone temps (C)"
	} > "$DATA_DIR/history.log"
}

init_all() {
	local old
	mkdir -p "$DATA_DIR" 2>/dev/null || exit 1
	[ -f "$DATA_DIR/zones.txt" ] || zones_init
	# ifaces.txt carries role/ip/label metadata -> refresh on every start
	ifaces_init

	if [ -f "$DATA_DIR/history.log" ]; then
		# if the zone/core layout changed since last start, archive the old
		# log (its CSV columns would no longer line up) and start fresh
		[ -f "$DATA_DIR/meta.txt" ] || meta_write
		old="$(cat "$DATA_DIR/meta.txt")"
		meta_write
		if [ "$(cat "$DATA_DIR/meta.txt")" != "$old" ]; then
			mv "$DATA_DIR/history.log" \
				"$DATA_DIR/history.$(date +%s 2>/dev/null).old" 2>/dev/null
			history_init
		fi
	else
		history_init
	fi
}

# ------------------------------------------------------------------ sampling

sample() {
	local ts temps raw t usage corelist c i l1 l5 l15 mt mf ma mline rest freq p n keep
	local netstats line label upct spct wpct ovline ovt ovf up_s
	local cur cr cw dr dw dt dn pts pr pw tmax lvl prev
	ts="$(date +%s 2>/dev/null || echo 0)"

	# -- zone temperatures (column order = zones.txt)
	temps=""
	tmax=""
	while read -r idx name path; do
		raw="$(cat "$path/temp" 2>/dev/null)"
		t="$(awk -v r="$raw" 'BEGIN { if (r ~ /^-?[0-9]+$/) printf "%.1f", r / 1000; else print "" }')"
		if [ -n "$t" ]; then
			tmax="$(awk -v a="$tmax" -v b="$t" 'BEGIN { print (a == "" || b + 0 > a + 0) ? b : a }')"
		fi
		temps="$temps,$t"
	done < "$DATA_DIR/zones.txt"
	temps="${temps#?}"

	# -- temperature alert, edge-triggered syslog (0 ok / 1 warn / 2 crit)
	lvl="$(awk -v t="$tmax" -v w="$WARN" -v c="$CRIT" \
		'BEGIN { if (t == "") print 0; else if (t + 0 >= c + 0) print 2; else if (t + 0 >= w + 0) print 1; else print 0 }')"
	prev="$(cat "$DATA_DIR/.alert_state" 2>/dev/null)"
	if [ "$lvl" != "$prev" ]; then
		echo "$lvl" > "$DATA_DIR/.alert_state"
		if [ "$lvl" = "0" ]; then
			log "temperature back to normal (${tmax}C)"
		else
			log "temperature alert level $lvl (max ${tmax}C)"
		fi
	fi

	# -- CPU usage (total + per core), as delta since the previous sample.
	#    .cpu_prev always holds the previous RAW /proc/stat cpu snapshot
	corelist=""
	awk '/^cpu/ { print }' "$SYS_ROOT/proc/stat" > "$DATA_DIR/.stat_raw"
	if [ -s "$DATA_DIR/.cpu_prev" ]; then
		awk '
			NR == FNR {
				tot = 0
				for (i = 2; i <= NF; i++) tot += $i
				pt[$1] = tot
				pi[$1] = $(5) + $(6)
				pu[$1] = $(2) + $(3)
				ps[$1] = $(4) + $(7) + $(8)
				pw[$1] = $(6)
				next
			}
			/^cpu/ {
				tot = 0
				for (i = 2; i <= NF; i++) tot += $i
				idle = $(5) + $(6)
				dt = tot - pt[$1]
				di = idle - pi[$1]
				use = (dt > 0) ? (dt - di) * 100.0 / dt : 0
				if ($1 == "cpu") {
					du = ($(2) + $(3)) - pu[$1]
					ds = ($(4) + $(7) + $(8)) - ps[$1]
					dw = $(6) - pw[$1]
					up = (dt > 0) ? du * 100.0 / dt : 0
					sp = (dt > 0) ? ds * 100.0 / dt : 0
					wp = (dt > 0) ? dw * 100.0 / dt : 0
					printf "%s %.1f %.1f %.1f %.1f\n", $1, use, up, sp, wp
				} else {
					printf "%s %.1f\n", $1, use
				}
			}
		' "$DATA_DIR/.cpu_prev" "$DATA_DIR/.stat_raw" > "$DATA_DIR/.cpu_new"
		usage=""
		upct="0.0"; spct="0.0"; wpct="0.0"
		while read -r key use a b c; do
			if [ "$key" = "cpu" ]; then
				usage="$use"
				upct="$a"; spct="$b"; wpct="$c"
			else
				corelist="$corelist,$use"
			fi
		done < "$DATA_DIR/.cpu_new"
		corelist="${corelist#?}"
	else
		# first sample: report 0% usage, baseline is taken from .stat_raw
		usage="0.0"
		upct="0.0"; spct="0.0"; wpct="0.0"
		c="$(core_count)"
		i=0
		while [ "$i" -lt "$c" ]; do
			corelist="$corelist,0.0"
			i=$((i + 1))
		done
		corelist="${corelist#?}"
	fi
	mv "$DATA_DIR/.stat_raw" "$DATA_DIR/.cpu_prev"

	# keep the per-core column count stable across CPU hotplug events
	# (pad missing cores with empty fields, drop surplus ones)
	corelist="$(printf '%s\n' "$corelist" | awk -F, -v n="$CORES" \
		'{ for (i = 1; i <= n; i++) printf "%s%s", (i > 1 ? "," : ""), $i; printf "\n" }')"

	# -- CPU frequency (kHz); modern kernels expose cpufreq under
#    /sys/devices/system/cpu/cpufreq/policy0/, older ones under cpu0/cpufreq/
	freq=""
	for p in "$SYS_ROOT"/sys/devices/system/cpu/cpufreq/policy0/scaling_cur_freq \
	         "$SYS_ROOT"/sys/devices/system/cpu/cpufreq/policy0/cpuinfo_cur_freq \
	         "$SYS_ROOT"/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq \
	         "$SYS_ROOT"/sys/devices/system/cpu/cpu0/cpufreq/cpuinfo_cur_freq; do
		[ -f "$p" ] || continue
		freq="$(cat "$p" 2>/dev/null)"
		[ -n "$freq" ] && break
	done

	# -- load average
	set -- $(cat "$SYS_ROOT/proc/loadavg" 2>/dev/null)
	l1=$1; l5=$2; l15=$3
	[ -z "$l1" ] && l1=0
	[ -z "$l5" ] && l5=0
	[ -z "$l15" ] && l15=0

	# -- memory (kB). MemAvailable preferred; fall back to Free+Buffers+Cached
	mline="$(awk -F: '
		/^MemTotal:/    { mt = $2 }
		/^MemFree:/     { mf = $2 }
		/^Buffers:/     { bu = $2 }
		/^Cached:/      { ca = $2 }
		/^MemAvailable:/ { ma = $2 }
		END {
			mt += 0; mf += 0; bu += 0; ca += 0
			if (ma == "") ma = mf + bu + ca; else ma += 0
			printf "%d %d %d\n", mt, mf, ma
		}' "$SYS_ROOT/proc/meminfo" 2>/dev/null)"
	mt="${mline%% *}"
	rest="${mline#* }"
	mf="${rest%% *}"
	ma="${rest#* }"
	[ -z "$mt" ] && mt=0
	[ -z "$mf" ] && mf=0
	[ -z "$ma" ] && ma=0

	# -- network interfaces: RX/TX rate (B/s) + cumulative bytes.
	#    column order = ifaces.txt; prev snapshot in .net_prev (colon separated)
	netstats=""
	if [ -s "$DATA_DIR/ifaces.txt" ]; then
		[ -f "$DATA_DIR/.net_prev" ] || : > "$DATA_DIR/.net_prev"
		# NOTE: FILENAME-based split (NR==FNR breaks when the prev file is empty)
		awk -F: -v now="$ts" -v pf="$DATA_DIR/.net_prev" '
			FILENAME == pf {
				if (FNR == 1) { pts = $2 + 0; next }
				pr[$1] = $2 + 0
				pt[$1] = $3 + 0
				next
			}
			FNR > 2 {
				name = $1
				gsub(/ /, "", name)
				if (name == "" || name == "lo") next
				split($2, a, " ")
				rx = a[1] + 0
				tx = a[9] + 0
				if (name in pr) {
					dt = now - pts
					if (dt < 1) dt = 1
					r = (rx - pr[name]) / dt
					t = (tx - pt[name]) / dt
					if (r < 0) r = 0
					if (t < 0) t = 0
					printf "%s %.0f %.0f %d %d\n", name, r, t, rx, tx
				} else {
					printf "%s 0 0 %d %d\n", name, rx, tx
				}
			}
		' "$DATA_DIR/.net_prev" "$SYS_ROOT/proc/net/dev" > "$DATA_DIR/.net_calc"
		echo "ts:$ts" > "$DATA_DIR/.net_new"
		while read -r idx name label; do
			line="$(grep -m1 "^$name " "$DATA_DIR/.net_calc" 2>/dev/null)"
			if [ -n "$line" ]; then
				set -- $line
				netstats="$netstats,$2,$3,$4,$5"
				echo "$name:$4:$5" >> "$DATA_DIR/.net_new"
			else
				netstats="$netstats,,,,"
				echo "$name:0:0" >> "$DATA_DIR/.net_new"
			fi
		done < "$DATA_DIR/ifaces.txt"
		netstats="${netstats#?}"
		mv "$DATA_DIR/.net_new" "$DATA_DIR/.net_prev"
	fi
	[ -n "$netstats" ] && netstats=",$netstats"

	# -- CPU split (user/sys/wait %), storage (overlay kB), uptime (s)
	ovline="$(df -k "$SYS_ROOT/overlay" 2>/dev/null | awk 'NR==2 {print $2, $4}')"
	if [ -z "$ovline" ]; then
		ovline="$(df -k /overlay 2>/dev/null | awk 'NR==2 {print $2, $4}')"
	fi
	if [ -z "$ovline" ]; then
		ovline="$(df -k / 2>/dev/null | awk 'NR==2 {print $2, $4}')"
	fi
	ovt="${ovline%% *}"
	ovf="${ovline#* }"
	[ -z "$ovt" ] && ovt=0
	[ -z "$ovf" ] && ovf=0
	up_s="$(cut -d' ' -f1 "$SYS_ROOT/proc/uptime" 2>/dev/null | cut -d. -f1)"
	[ -z "$up_s" ] && up_s=0

	# -- append sample
	echo "$ts,$usage,$corelist,$freq,$l1,$l5,$l15,$mt,$mf,$ma,$temps$netstats,$upct,$spct,$wpct,$ovt,$ovf,$up_s" \
		>> "$DATA_DIR/history.log"

	# -- disk IO (B/s) into a separate ring log (keeps history schema stable)
	if [ -r "$SYS_ROOT/proc/diskstats" ]; then
		cur="$(awk '$3 ~ /^(sd[a-z]+|vd[a-z]+|mmcblk[0-9]+|nvme[0-9]+n[0-9]+|mtdblock[0-9]+)$/ { r += $6; w += $10 } END { printf "%d %d", r, w }' \
			"$SYS_ROOT/proc/diskstats" 2>/dev/null)"
		cr=${cur%% *}; cw=${cur##* }
		dr=0; dw=0
		if [ -s "$DATA_DIR/.disk_prev" ]; then
			read -r pts pr pw < "$DATA_DIR/.disk_prev"
			dt=$((ts - pts)); [ "$dt" -lt 1 ] && dt=1
			dr=$(( (cr - pr) * 512 / dt )); [ "$dr" -lt 0 ] && dr=0
			dw=$(( (cw - pw) * 512 / dt )); [ "$dw" -lt 0 ] && dw=0
		fi
		echo "$ts $cr $cw" > "$DATA_DIR/.disk_prev"
		echo "$ts,$dr,$dw" >> "$DATA_DIR/disk.log"
		dn=$(wc -l < "$DATA_DIR/disk.log" 2>/dev/null || echo 0)
		if [ "$dn" -gt 6000 ]; then
			tail -n 3000 "$DATA_DIR/disk.log" > "$DATA_DIR/.d.tmp" 2>/dev/null
			mv "$DATA_DIR/.d.tmp" "$DATA_DIR/disk.log" 2>/dev/null
		fi
	fi

	# -- rotate when exceeding max_lines (keep the newest half)
	n="$(wc -l < "$DATA_DIR/history.log" 2>/dev/null || echo 0)"
	echo "$n" > "$DATA_DIR/count.txt"
	if [ "$n" -gt "$MAXLINES" ]; then
		keep=$((MAXLINES / 2))
		[ "$keep" -lt 1000 ] && keep=1000
		tail -n "$keep" "$DATA_DIR/history.log" > "$DATA_DIR/.h.tmp" 2>/dev/null
		mv "$DATA_DIR/.h.tmp" "$DATA_DIR/history.log" 2>/dev/null
		echo "$keep" > "$DATA_DIR/count.txt"
	fi
}

# ---------------------------------------------------------------------- main

run() {
	echo $$ > "$PIDFILE" 2>/dev/null
	CORES="$(core_count)"
	log "collector started (pid $$, interval=${INTERVAL}s, dir=$DATA_DIR, max_lines=$MAXLINES, cores=$CORES)"
	while :; do
		refresh_config
		if [ "$(uci_get enabled 1)" != "1" ]; then
			log "disabled in config, idling"
			# background sleep + wait: keeps the TERM trap responsive
			sleep 600 &
			SLEEPPID=$!
			wait $SLEEPPID
			continue
		fi
		sample
		sleep "$INTERVAL" &
		SLEEPPID=$!
		wait $SLEEPPID
	done
}

case "$1" in
	--init)
		DATA_DIR="$(uci_get data_dir "$DEFAULT_DIR")"
		init_all
		exit 0
		;;
	--once)
		# run a single sample and exit (used by tests and manual debugging)
		DATA_DIR="$(uci_get data_dir "$DEFAULT_DIR")"
		init_all
		refresh_config
		CORES="$(core_count)"
		sample
		exit 0
		;;
	--help|-h)
		echo "usage: collect.sh [--init|--once]"
		exit 0
		;;
esac

DATA_DIR="$(uci_get data_dir "$DEFAULT_DIR")"
case "$DATA_DIR" in
	''|/*) ;;
	*) DATA_DIR="$DEFAULT_DIR" ;;
esac
# Reject paths with parent-dir references (matches Lua get_data_dir validation)
case "$DATA_DIR" in
	*..*) DATA_DIR="$DEFAULT_DIR" ;;
esac

trap 'rm -f "$PIDFILE" 2>/dev/null; [ -n "$SLEEPPID" ] && kill "$SLEEPPID" 2>/dev/null; exit 0' TERM INT
init_all
run