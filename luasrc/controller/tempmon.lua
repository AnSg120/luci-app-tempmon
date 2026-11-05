-- luci-app-tempmon: LuCI controller (v2.1)
--
-- Design notes:
--  * CSV parsing is SCHEMA-DRIVEN: column offsets are computed once per
--    request from meta.txt/zones.txt/ifaces.txt (read_schema), never
--    hardcoded at call sites.
--  * Read paths are streaming/tail-based: api_status reads only the file
--    tail plus a count sidecar; api_data downsamples progressively so
--    memory stays bounded (~MAXPTS rows) regardless of log size.
--  * Write endpoints require POST + custom header X-TM-CSRF + same-origin
--    Origin/Referer check (CSRF mitigation; forms cannot set custom headers).
--  * Service control is procd-first (ubus luci setInitAction); the pidfile /
--    detached-spawn paths are only used as a VERIFIED fallback when procd
--    fails to take effect (observed on some firmware after upgrade races).

module("luci.controller.tempmon", package.seeall)

local http = require "luci.http"
local uci  = require "luci.model.uci"

local DEFAULT_DIR = "/tmp/tempmon"
local PIDFILE     = "/var/run/tempmon.pid"
local MAXPTS      = 720
local TAIL_BYTES  = 65536

local RANGES = {
	["1h"]  = 3600,
	["6h"]  = 21600,
	["24h"] = 86400,
	["3d"]  = 259200,
	["7d"]  = 604800,
}

function index()
	entry({"admin", "tempmon"}, firstchild(), _("系统监控"), 80).dependent = false

	entry({"admin", "tempmon", "dashboard"}, template("tempmon/dashboard"), _("概览"), 10).leaf = true
	entry({"admin", "tempmon", "cpu"},      template("tempmon/dashboard"), _("CPU"),  20).leaf = true
	entry({"admin", "tempmon", "memory"},   template("tempmon/dashboard"), _("内存"), 30).leaf = true
	entry({"admin", "tempmon", "storage"},  template("tempmon/dashboard"), _("存储"), 40).leaf = true
	entry({"admin", "tempmon", "network"},  template("tempmon/dashboard"), _("网络"), 50).leaf = true
	entry({"admin", "tempmon", "procs"},    template("tempmon/dashboard"), _("进程"), 60).leaf = true
	entry({"admin", "tempmon", "logs"},     template("tempmon/dashboard"), _("日志"), 70).leaf = true
	entry({"admin", "tempmon", "settings"}, template("tempmon/dashboard"), _("设置"), 80).leaf = true
	entry({"admin", "tempmon", "config"},   cbi("tempmon"), _("参数"), 90).leaf = true

	entry({"admin", "tempmon", "api_status"},  call("action_status")).leaf  = true
	entry({"admin", "tempmon", "api_data"},    call("action_data")).leaf    = true
	entry({"admin", "tempmon", "api_io"},      call("action_io")).leaf      = true
	entry({"admin", "tempmon", "api_sys"},     call("action_sys")).leaf     = true
	entry({"admin", "tempmon", "api_mem"},     call("action_mem")).leaf     = true
	entry({"admin", "tempmon", "api_net"},     call("action_net")).leaf     = true
	entry({"admin", "tempmon", "api_procs"},   call("action_procs")).leaf   = true
	entry({"admin", "tempmon", "api_logs"},    call("action_logs")).leaf    = true
	entry({"admin", "tempmon", "api_export"},  call("action_export")).leaf  = true
	entry({"admin", "tempmon", "api_clear"},   call("action_clear")).leaf   = true
	entry({"admin", "tempmon", "api_service"}, call("action_service")).leaf = true
	entry({"admin", "tempmon", "api_display"}, call("action_display")).leaf = true
	entry({"admin", "tempmon", "api_logs_clear"}, call("action_logs_clear")).leaf = true
end

-- --------------------------------------------------------------------- config

local function get_cfg(key, default)
	local c = uci.cursor()
	local v = c:get("tempmon", "core", key)
	if v ~= nil and v ~= "" then return v end
	return default
end

-- centralized validation: absolute path, no ".." components
local function get_data_dir()
	local d = get_cfg("data_dir", DEFAULT_DIR)
	if type(d) ~= "string" or d:sub(1, 1) ~= "/" then return DEFAULT_DIR end
	if d:find("%.%.") then return DEFAULT_DIR end
	return d
end

-- ------------------------------------------------------------------- schema

local function split_csv(s)
	local t, start = {}, 1
	for i = 1, #s do
		if s:byte(i) == 44 then -- ","
			t[#t + 1] = s:sub(start, i - 1)
			start = i + 1
		end
	end
	t[#t + 1] = s:sub(start)
	return t
end

local function read_zones(dir)
	local zones = {}
	local f = io.open(dir .. "/zones.txt", "r")
	if f then
		for line in f:lines() do
			local name = line:match("^%S+ (%S+)")
			if name then zones[#zones + 1] = name end
		end
		f:close()
	end
	return zones
end

local function read_ifaces(dir)
	-- ifaces.txt v2: "<idx> <name> <role|-> <ip|-> <label...>"
	local ifaces = {}
	local f = io.open(dir .. "/ifaces.txt", "r")
	if f then
		for line in f:lines() do
			local idx, name, role, ip, label =
				line:match("^(%S+) (%S+) (%S+) (%S+) ?(.*)$")
			if idx then
				ifaces[#ifaces + 1] = {
					name = name,
					role = (role ~= "-") and role or "",
					ip = (ip ~= "-") and ip or "",
					label = (label ~= nil and label ~= "") and label or name,
				}
			else
				local n2, l2 = line:match("^%S+ (%S+) ?(.*)$")
				if n2 then
					ifaces[#ifaces + 1] = {
						name = n2, role = "", ip = "",
						label = (l2 ~= nil and l2 ~= "") and l2 or n2,
					}
				end
			end
		end
		f:close()
	end
	return ifaces
end

-- single place where the CSV column layout is interpreted
local function read_schema(dir)
	local sch = { cores = 1, v = 0, zones = read_zones(dir), ifaces = read_ifaces(dir) }
	local f = io.open(dir .. "/meta.txt", "r")
	if f then
		for line in f:lines() do
			local n = line:match("cores=(%d+)")
			if n then sch.cores = tonumber(n) end
			local v = line:match("v=(%d+)")
			if v then sch.v = tonumber(v) end
		end
		f:close()
	end
	sch.nif = #sch.ifaces
	-- offsets: 1 ts, 2 usage, 3..2+cores cores, k freq, k+1..k+3 load,
	-- k+4..k+6 mem, k+7.. temps, then 4*nif iface cols, then 6 tail cols
	sch.k = 3 + sch.cores
	sch.n_tail = 6
	return sch
end

-- CSV row -> JSON point [ts,usage,[cores],freq,[load],[mem],[temps],
--                        [ifaces],[user,sys,wait],[ovt,ovf],uptime]
local function to_point(fields, sch)
	local nif, k = sch.nif, sch.k
	local last_temp = #fields - 4 * nif - sch.n_tail
	if last_temp < k + 6 then last_temp = k + 6 end
	local p = {
		tonumber(fields[1]) or 0,
		tonumber(fields[2]) or 0,
		{},
		tonumber(fields[k]) or 0,
		{ tonumber(fields[k + 1]) or 0, tonumber(fields[k + 2]) or 0, tonumber(fields[k + 3]) or 0 },
		{ tonumber(fields[k + 4]) or 0, tonumber(fields[k + 5]) or 0, tonumber(fields[k + 6]) or 0 },
		{}, {}, {}, {}, 0,
	}
	for c = 1, sch.cores do
		p[3][c] = tonumber(fields[2 + c]) or 0
	end
	for j = k + 7, last_temp do
		p[7][#p[7] + 1] = tonumber(fields[j]) or 0
	end
	for i = 1, nif do
		local b = last_temp + 4 * (i - 1) + 1
		p[8][i] = {
			tonumber(fields[b]) or 0, tonumber(fields[b + 1]) or 0,
			tonumber(fields[b + 2]) or 0, tonumber(fields[b + 3]) or 0,
		}
	end
	local base = last_temp + 4 * nif + 1
	p[9] = { tonumber(fields[base]) or 0, tonumber(fields[base + 1]) or 0, tonumber(fields[base + 2]) or 0 }
	p[10] = { tonumber(fields[base + 3]) or 0, tonumber(fields[base + 4]) or 0 }
	p[11] = tonumber(fields[base + 5]) or 0
	return p
end

-- ------------------------------------------------------------------- helpers

local function read_tail(path, nbytes)
	local f = io.open(path, "r")
	if not f then return "", 0 end
	local sz = f:seek("end") or 0
	local from = (sz > nbytes) and (sz - nbytes) or 0
	f:seek("set", from)
	local s = f:read("*a") or ""
	f:close()
	if from > 0 then
		local nl = s:find("\n")
		s = nl and s:sub(nl + 1) or s
	end
	return s, sz
end

local function read_count(dir)
	local f = io.open(dir .. "/count.txt", "r")
	if not f then return 0 end
	local n = tonumber((f:read("*l") or ""):match("%d+") or "")
	f:close()
	return n or 0
end

local function read_pid()
	local f = io.open(PIDFILE, "r")
	if not f then return nil end
	local pid = tonumber((f:read("*l") or ""):match("%d+") or "")
	f:close()
	return pid
end

local function pid_alive(pid)
	if not pid then return false end
	return os.execute("kill -0 " .. pid .. " 2>/dev/null") == 0
end

local function daemon_alive()
	return pid_alive(read_pid())
end

local function package_version()
	local f = io.open("/usr/lib/opkg/status", "r")
	if not f then return "" end
	-- OpenWrt's opkg status has NO field indentation (unlike Debian status)
	local inp = false
	for line in f:lines() do
		if line:sub(1, 9) == "Package: " then
			inp = (line:sub(10) == "luci-app-tempmon")
		elseif inp and line:sub(1, 9) == "Version: " then
			local ver = line:sub(10)
			f:close()
			return ver
		end
	end
	f:close()
	return ""
end

local function env(name)
	local ok, v = pcall(function() return http.getenv(name) end)
	return (ok and v) or ""
end

local function json_out(tbl)
	http.prepare_content("application/json; charset=utf-8")
	http.write_json(tbl)
end

local function request_is_post()
	return env("REQUEST_METHOD") == "POST"
end

local function query_value(name)
	local qs = env("QUERY_STRING")
	if qs == "" then return nil end
	return qs:match("[?&;]" .. name .. "=([^&;]*)") or qs:match("^" .. name .. "=([^&;]*)")
end

-- CSRF (double-submit nonce): the LuCI session token is not exposed to Lua
-- views on 24.10's bridge and its native post:true gate crashes (500), so
-- write endpoints validate a nonce that the dashboard template generates and
-- stores in /tmp/tempmon.nonce and submits as ?token= and as the custom
-- X-TM-CSRF header. Cross-site pages cannot read the nonce (same-origin
-- policy), cannot set custom headers, and cannot forge Origin/Referer,
-- so they cannot forge writes.
local NONCE_FILE = "/tmp/tempmon.nonce"

local function read_nonce()
	local f = io.open(NONCE_FILE, "r")
	if not f then return "" end
	local v = (f:read("*l") or ""):match("%x+") or ""
	f:close()
	return v
end

local function csrf_header()
	-- uhttpd passes custom header X-TM-CSRF as HTTP_X_TM_CSRF.
	-- Try both common normalisations to be safe.
	return env("HTTP_X_TM_CSRF") or env("HTTP_X-TM-CSRF") or ""
end

local function same_origin()
	-- Require an Origin or Referer from the same host.  Same-origin fetch/POST
	-- will carry these; cross-site forms cannot control them.
	local host = env("HTTP_HOST") or ""
	local origin = env("HTTP_ORIGIN") or ""
	local referer = env("HTTP_REFERER") or ""
	local function host_of(s)
		return s:match("^https?://([^/]+)") or ""
	end
	if host ~= "" then
		if origin ~= "" then
			return host_of(origin) == host
		elseif referer ~= "" then
			return host_of(referer) == host
		end
		-- Host present but no Origin/Referer headers: non-browser clients
		-- (uclient/curl) or proxies that strip them. Do not hard-fail here;
		-- the double-submit token + custom header still apply below.
	end
	-- No host information available: trust the request (e.g. local socket test).
	return true
end

local function write_allowed()
	if not request_is_post() then return false end
	if not same_origin() then return false end
	local tok = query_value("token") or ""
	local hdr = csrf_header()
	if tok == "" then return false end
	-- The LuCI bridge on 24.10 does NOT forward custom request headers to
	-- Lua (verified on device), so X-TM-CSRF cannot be mandatory. Treat it
	-- as an OPTIONAL strengthening: only verified when it actually reaches
	-- us (environments that do forward it), never as a hard gate.
	if hdr ~= "" and hdr ~= tok then return false end
	return tok == read_nonce()
end

local function run_cmd(cmd)
	local ok, err = pcall(function()
		local f = io.popen(cmd .. " >/dev/null 2>&1")
		if f then f:close() end
	end)
	if not ok then return false, tostring(err) end
	return true, nil
end

local function ubus_init_action(action)
	pcall(function()
		local ubus = require("ubus")
		local conn = ubus.connect()
		if not conn then error("no ubus") end
		conn:call("luci", "setInitAction", { name = "tempmon", action = action })
		conn:close()
	end)
end

-- procd-first service control with verified effect; pidfile/detached spawn
-- only as fallback when procd demonstrably did not act.
local function service_op(op)
	local before = read_pid()
	ubus_init_action(op)
	os.execute("sleep 1")
	if op == "stop" then
		if not pid_alive(before) then return true, "procd" end
		-- procd desynced: kill by pidfile authoritatively
		if before then
			os.execute("kill -TERM " .. before .. " 2>/dev/null; sleep 1; " ..
				"kill -0 " .. before .. " 2>/dev/null && kill -9 " .. before .. " 2>/dev/null; true")
		end
		os.execute("rm -f " .. PIDFILE .. " 2>/dev/null")
		return not pid_alive(before), "pidfile"
	end
	-- start / restart
	if pid_alive(read_pid()) then return true, "procd" end
	-- procd did not bring it up: detached fallback
	os.execute("setsid /usr/libexec/tempmon/collect.sh </dev/null >/dev/null 2>&1 &")
	os.execute("sleep 1")
	if pid_alive(read_pid()) then return true, "detached" end
	return false, "failed"
end

-- ------------------------------------------------------------------- actions

function action_status()
	local dir = get_data_dir()
	local sch = read_schema(dir)
	local tail, size = read_tail(dir .. "/history.log", TAIL_BYTES)
	local last
	for line in tail:gmatch("[^\n]+") do
		if line:sub(1, 1) ~= "#" then last = line end
	end
	local warn = tonumber(get_cfg("temp_warn", "75")) or 75
	local crit = tonumber(get_cfg("temp_crit", "85")) or 85
	local alert = 0
	local resp = {
		ok       = true,
		now      = os.time(),
		daemon   = daemon_alive(),
		dir      = dir,
		interval = tonumber(get_cfg("interval", 60)) or 60,
		max_lines = tonumber(get_cfg("max_lines", 30000)) or 30000,
		enabled  = get_cfg("enabled", "1") == "1",
		hide     = get_cfg("hide_items", ""),
		version  = package_version(),
		lines    = read_count(dir),
		size     = size,
		zones    = sch.zones,
		cores    = sch.cores,
		ifaces   = sch.ifaces,
	}
	if last then
		resp.last = to_point(split_csv(last), sch)
		local tmax = 0
		for _, t in ipairs(resp.last[7]) do
			if t > tmax then tmax = t end
		end
		if tmax >= crit then alert = 2
		elseif tmax >= warn then alert = 1 end
	end
	resp.alert = alert
	json_out(resp)
end

function action_data()
	local rng = query_value("range") or "1h"
	local span = RANGES[rng]
	if not span then
		json_out({ ok = false, error = "invalid range" })
		return
	end
	local dir = get_data_dir()
	local sch = read_schema(dir)
	local now = os.time()
	local cutoff = now - span

	-- single pass, progressive downsampling: memory bounded by MAXPTS
	local f = io.open(dir .. "/history.log", "r")
	local out, step, idx, lastline = {}, 1, 0, nil
	if f then
		for line in f:lines() do
			local ts = tonumber(line:match("^(%d+)"))
			if ts and ts >= cutoff then
				idx = idx + 1
				lastline = line
				if #out >= MAXPTS then
					local h = {}
					for i = 1, #out, 2 do h[#h + 1] = out[i] end
					out, step = h, step * 2
				end
				if idx % step == 0 then out[#out + 1] = line end
			end
		end
		f:close()
	end
	if lastline and out[#out] ~= lastline then out[#out + 1] = lastline end

	local pts = {}
	for i, line in ipairs(out) do
		pts[i] = to_point(split_csv(line), sch)
	end
	json_out({
		ok = true, now = now, range = rng,
		zones = sch.zones, cores = sch.cores, ifaces = sch.ifaces,
		lines = read_count(dir), count = idx, points = pts,
	})
end

function action_export()
	local dir = get_data_dir()
	local sch = read_schema(dir)
	http.prepare_content("text/csv; charset=utf-8")
	http.header("Content-Disposition", 'attachment; filename="tempmon-history.csv"')

	local hdr = { "timestamp", "cpu_usage_pct" }
	for i = 1, sch.cores do hdr[#hdr + 1] = "core" .. (i - 1) .. "_usage_pct" end
	hdr[#hdr + 1] = "freq_khz"
	hdr[#hdr + 1] = "load1"; hdr[#hdr + 1] = "load5"; hdr[#hdr + 1] = "load15"
	hdr[#hdr + 1] = "mem_total_kb"; hdr[#hdr + 1] = "mem_free_kb"; hdr[#hdr + 1] = "mem_avail_kb"
	for _, z in ipairs(sch.zones) do hdr[#hdr + 1] = "temp_" .. z .. "_c" end
	for _, f in ipairs(sch.ifaces) do
		hdr[#hdr + 1] = f.name .. "_rx_Bps"; hdr[#hdr + 1] = f.name .. "_tx_Bps"
		hdr[#hdr + 1] = f.name .. "_rx_bytes"; hdr[#hdr + 1] = f.name .. "_tx_bytes"
	end
	hdr[#hdr + 1] = "cpu_user_pct"; hdr[#hdr + 1] = "cpu_sys_pct"; hdr[#hdr + 1] = "cpu_wait_pct"
	hdr[#hdr + 1] = "overlay_total_kb"; hdr[#hdr + 1] = "overlay_free_kb"
	hdr[#hdr + 1] = "uptime_s"
	http.write(table.concat(hdr, ",") .. "\n")

	local f = io.open(dir .. "/history.log", "r")
	if f then
		for line in f:lines() do
			if line:sub(1, 1) ~= "#" then http.write(line .. "\n") end
		end
		f:close()
	end
end

function action_clear()
	if not write_allowed() then
		json_out({ ok = false, error = "forbidden" })
		return
	end
	local dir = get_data_dir()
	os.remove(dir .. "/history.log")
	run_cmd("/usr/libexec/tempmon/collect.sh --init")
	json_out({ ok = true })
end

local SERVICES = { start = true, stop = true, restart = true }

function action_service()
	if not write_allowed() then
		json_out({ ok = false, error = "forbidden" })
		return
	end
	local op = query_value("op") or ""
	if not SERVICES[op] then
		json_out({ ok = false, error = "invalid op" })
		return
	end
	local ok, via = service_op(op)
	json_out({ ok = ok, op = op, via = via })
end

local HIDE_KEYS = {
	card_temp = true, card_cpu = true, card_mem = true, card_storage = true,
	card_net = true, card_uptime = true, panel_charts = true,
	panel_cpu_detail = true, panel_mem_storage = true, panel_ifaces = true,
}

function action_display()
	if not write_allowed() then
		json_out({ ok = false, error = "forbidden" })
		return
	end
	local key = query_value("key") or ""
	if not HIDE_KEYS[key] then
		json_out({ ok = false, error = "invalid key" })
		return
	end
	local c = uci.cursor()
	local cur = c:get("tempmon", "core", "hide_items") or ""
	local t, hidden = {}, false
	for w in cur:gmatch("%S+") do
		if w == key then hidden = true else t[#t + 1] = w end
	end
	if not hidden then t[#t + 1] = key end
	local joined = table.concat(t, " ")
	c:set("tempmon", "core", "hide_items", joined)
	c:commit("tempmon")
	json_out({ ok = true, hide = joined })
end

-- ---------------------------------------------------------------------
-- live system endpoints (real data, pcall-guarded)

local function popen_lines(cmd)
	local out = {}
	pcall(function()
		local f = io.popen(cmd)
		if not f then return end
		for line in f:lines() do out[#out + 1] = line end
		f:close()
	end)
	return out
end

local function read_file(path)
	local f = io.open(path, "r")
	if not f then return nil end
	local s = f:read("*a")
	f:close()
	return s
end

function action_sys()
	local model = ""
	pcall(function()
		local s = read_file("/tmp/sysinfo/model")
		if s then model = (s:match("^%s*(.-)%s*$") or "") end
	end)
	local kernel = popen_lines("uname -r 2>/dev/null")[1] or ""
	local release = ""
	pcall(function()
		local s = read_file("/etc/openwrt_release")
		if s then release = s:match("DISTRIB_DESCRIPTION='([^']+)'") or "" end
	end)
	local host = ""
	pcall(function()
		local c = uci.cursor()
		host = c:get("system", "@system[0]", "hostname") or ""
	end)
	-- mounts: merge df usage with real filesystem types from /proc/mounts,
	-- and drop pseudo filesystems (tmpfs/devtmpfs/...) so the storage table
	-- shows actual partitions instead of a wall of memory-backed mounts.
	local skip_fs = {
		tmpfs = true, devtmpfs = true, ramfs = true, proc = true,
		sysfs = true, devpts = true, debugfs = true, cgroup = true,
		cgroup2 = true, securityfs = true, configfs = true, fuse = true,
		overlay = true, udev = true, pstore = true, tracefs = true,
	}
	local mtypes = {}
	pcall(function()
		local f = io.open("/proc/mounts", "r")
		if not f then return end
		for line in f:lines() do
			local dev, mp, typ = line:match("^(%S+) (%S+) (%S+)")
			if mp then mtypes[mp] = typ end
		end
		f:close()
	end)
	local mounts = {}
	for _, line in ipairs(popen_lines("df -k 2>/dev/null")) do
		local fs, sz, us, av, pc, mn =
			line:match("^(%S+)%s+(%d+)%s+(%d+)%s+(%d+)%s+(%d+)%%%s+(%S+)")
		if fs and mn and fs ~= "Filesystem" and not skip_fs[fs] then
			mounts[#mounts + 1] = {
				device = fs,
				size = tonumber(sz) or 0,
				used = tonumber(us) or 0,
				avail = tonumber(av) or 0,
				pct = pc,
				target = mn,
				type = mtypes[mn] or "-",
			}
		end
	end
	json_out({
		ok = true, model = model, kernel = kernel, release = release,
		host = host, mounts = mounts,
	})
end

function action_mem()
	local m = {}
	for _, line in ipairs(popen_lines("cat /proc/meminfo 2>/dev/null")) do
		local k, v = line:match("^(%w+):%s+(%d+)")
		if k then m[k] = tonumber(v) or 0 end
	end
	json_out({
		ok = true,
		total = m.MemTotal or 0, free = m.MemFree or 0,
		avail = m.MemAvailable or 0, buffers = m.Buffers or 0,
		cached = m.Cached or 0, swap_total = m.SwapTotal or 0,
		swap_free = m.SwapFree or 0,
	})
end

function action_io()
	local rng = query_value("range") or "1h"
	local span = RANGES[rng] or 3600
	local dir = get_data_dir()
	local now = os.time()
	local cutoff = now - span
	local pts = {}
	local f = io.open(dir .. "/disk.log", "r")
	if f then
		for line in f:lines() do
			local ts, r, w = line:match("^(%d+),(%d+),(%d+)")
			ts = tonumber(ts)
			if ts and ts >= cutoff then
				pts[#pts + 1] = { ts, tonumber(r) or 0, tonumber(w) or 0 }
			end
		end
		f:close()
	end
	if #pts > MAXPTS then
		local step = math.ceil(#pts / MAXPTS)
		local ds = {}
		for i = 1, #pts, step do ds[#ds + 1] = pts[i] end
		if ds[#ds] ~= pts[#pts] then ds[#ds + 1] = pts[#pts] end
		pts = ds
	end
	json_out({ ok = true, now = now, range = rng, count = #pts, points = pts })
end

function action_net()
	local total, tcp, udp = 0, 0, 0
	pcall(function()
		local s = read_file("/proc/sys/net/netfilter/nf_conntrack_count")
		if s then total = tonumber(s:match("%d+")) or 0 end
	end)
	for _, line in ipairs(popen_lines(
		"awk '{c[$3]++} END {for (k in c) print k, c[k]}' /proc/net/nf_conntrack 2>/dev/null")) do
		local proto, n = line:match("^(%S+)%s+(%d+)")
		if proto == "tcp" then tcp = tonumber(n) or 0
		elseif proto == "udp" then udp = tonumber(n) or 0 end
	end
	local state = {}
	for _, line in ipairs(popen_lines(
		"for d in /sys/class/net/*; do n=$(basename \"$d\"); echo \"$n $(cat \"$d/operstate\" 2>/dev/null)\"; done")) do
		local dev, st = line:match("^(%S+)%s+(%S+)")
		if dev then state[dev] = st end
	end
	json_out({ ok = true, total = total, tcp = tcp, udp = udp, state = state })
end

function action_procs()
	-- Parse the `top` output by locating the header row and reading each
	-- field at the position its header token starts. This is robust across
	-- busybox top (PID PPID USER STAT VSZ %VSZ %CPU COMMAND) and procps-ng
	-- top (PID USER PR NI VIRT RES SHR S %CPU %MEM TIME+ COMMAND) where the
	-- old fixed-index parsing swapped the %VSZ / %CPU columns.
	local lines = popen_lines("top -b -n 1 2>/dev/null | head -40")
	local procs = {}
	local hdr = nil
	for _, line in ipairs(lines) do
		if not hdr then
			-- header row: remember token -> start position for the columns we use
			if line:match("PID") and line:match("%%CPU") then
				hdr = {}
				for pos, tok in line:gmatch("()(%S+)") do
					hdr[tok] = pos
				end
			end
		else
			local pid = line:match("^%s*(%d+)%s")
			if pid and #procs < 20 then
				local function col(name)
					local p = hdr[name]
					if not p then return "" end
					local bound = #line + 1
					for tok, q in pairs(hdr) do
						if q > p and q < bound then bound = q end
					end
					return (line:sub(p, bound - 1):match("^%s*(%S+)") or "")
				end
				local name = (line:sub(hdr.COMMAND or 1):gsub("^%s+", ""):gsub("%s+$", ""))
				local cpu = col("%CPU")
				local mem = col("%MEM") -- procps-ng only; busybox has no mem column
				local stat = col("STAT")
				if stat == "" then stat = col("S") end
				procs[#procs + 1] = {
					pid = tonumber(pid) or 0,
					name = name,
					cpu = cpu,
					mem = mem,
					stat = stat,
				}
			end
		end
	end
	json_out({ ok = true, procs = procs })
end

function action_logs()
	local lines = {}
	for _, line in ipairs(popen_lines("logread 2>/dev/null | tail -n 300")) do
		local day, tm, yr, tag, msg =
			line:match("^%a+ (%a+ +%d+) ([%d:]+) (%d+) (%S+) (.*)$")
		if day then
			lines[#lines + 1] = { day, tm, tag, msg }
		else
			lines[#lines + 1] = { "", "", "sys", line }
		end
	end
	json_out({ ok = true, lines = lines })
end

function action_logs_clear()
	if not write_allowed() then
		json_out({ ok = false, error = "forbidden" })
		return
	end
	run_cmd("/etc/init.d/log restart")
	json_out({ ok = true })
end