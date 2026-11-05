-- luci-app-tempmon: UCI configuration form

local uci = require "luci.model.uci"

local m = Map("tempmon", translate("系统监控 - 设置"),
	translate("配置采样与记录参数。保存并应用后会自动重启采集服务。"))

local s = m:section(NamedSection, "core", "core", translate("采集设置"))
s.addremove = false

local enabled = s:option(Flag, "enabled", translate("启用记录"),
	translate("关闭后采集进程将停止采样，历史数据保留。"))

local show_status = s:option(MultiValue, "hide_items", translate("自定义隐藏项"),
	translate("勾选的卡片将在概览页隐藏，未勾选则显示。"))
show_status:value("card_temp", translate("温度卡"))
show_status:value("card_cpu", translate("CPU 卡"))
show_status:value("card_mem", translate("内存卡"))
show_status:value("card_storage", translate("存储卡"))
show_status:value("card_net", translate("网络流量卡"))
show_status:value("card_uptime", translate("运行时间卡"))
show_status.delimiter = " "

local interval = s:option(Value, "interval", translate("采样间隔（秒）"),
	translate("每次采样的间隔时间。默认 60 秒，最小 5 秒。"))
interval.datatype = "uinteger"
interval.rmempty = false
interval.validate = function(self, value, section)
	local n = tonumber(value)
	if not n or n < 5 then
		return nil, translate("采样间隔必须是不小于 5 的正整数")
	end
	return tostring(n)
end

local data_dir = s:option(Value, "data_dir", translate("数据目录"),
	translate("默认 /tmp/tempmon 存于内存（重启后清空，不伤 Flash）。") ..
	translate("若改为 Flash 上的目录（如 /etc/tempmon），数据可跨重启保留，但请注意 Flash 写入寿命。"))
data_dir.rmempty = false
data_dir.validate = function(self, value, section)
	if type(value) ~= "string" or value:sub(1, 1) ~= "/" then
		return nil, translate("数据目录必须是绝对路径")
	end
	if value:find("..", 1, true) then
		return nil, translate("数据目录不能包含父目录引用 '..'")
	end
	return value
end

local max_lines = s:option(Value, "max_lines", translate("最多保留记录条数"),
	translate("超过该条数时自动轮转，仅保留最新的一半。默认 30000 条（60 秒间隔约 20 天）。"))
max_lines.datatype = "uinteger"
max_lines.rmempty = false
max_lines.validate = function(self, value, section)
	local n = tonumber(value)
	if not n or n < 1000 then
		return nil, translate("最多保留记录条数不能小于 1000")
	end
	return tostring(n)
end

local temp_warn = s:option(Value, "temp_warn", translate("温度告警阈值（°C）"),
	translate("最高温度达到该值时顶栏显示「温度偏高」并写 syslog。默认 75。"))
temp_warn.datatype = "uinteger"
temp_warn.rmempty = false

local temp_crit = s:option(Value, "temp_crit", translate("温度严重阈值（°C）"),
	translate("最高温度达到该值时顶栏显示「温度告警」并写 syslog。默认 85。"))
temp_crit.datatype = "uinteger"
temp_crit.rmempty = false

-- Cross-field validation: warn must be strictly lower than crit.
function s:validate(section)
	local c = uci.cursor()
	local w = tonumber(c:get("tempmon", "core", "temp_warn")) or 75
	local c2 = tonumber(c:get("tempmon", "core", "temp_crit")) or 85
	if w >= c2 then
		return nil, translate("温度告警阈值必须小于温度严重阈值")
	end
	return true
end

local apply = luci.http.formvalue("cbi.apply")
if apply then
	luci.sys.call("/etc/init.d/tempmon restart >/dev/null 2>&1")
end

return m