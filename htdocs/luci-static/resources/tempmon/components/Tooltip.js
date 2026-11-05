/**
 * luci-app-tempmon — Tooltip 悬浮提示（A6 字段解释）
 *
 * 设计取舍：
 *   - 全站只创建 **一个** 浮层元素，通过 `data-tip` 属性 + 事件委托驱动。
 *     避免给每个卡片/表格单元都挂一份 DOM 与监听器（低端路由器内存友好）。
 *   - 委托挂在 #tm-app 上，视图重渲染后无需重新绑定。
 *   - 移动端没有 hover，用 touchstart 显示、点击别处或 2.5s 后自动隐藏。
 */

import { esc, clamp, overlayHost } from '../core/util.js';

/* ---------------------------------------------------------- 字段解释字典 */

/**
 * 后端字段/术语的中文解释。
 * key 与模板里 data-tip 的取值一致；也供 kvList() 直接引用。
 */
export const FIELD_DESCRIPTIONS = {
	/* 温度 */
	temp: '传感器温度（°C）。多路传感器时以第一路为主展示，告警级别取各路最高。',
	temp_zone: '温度分区名称，来自 /sys/class/thermal 或 collect.sh 采集到的 zone。',
	temp_warn: '告警阈值：温度达到该值进入「警告」状态（默认 75°C），可在设置中修改。',
	temp_crit: '严重阈值：温度达到该值进入「危险」状态（默认 85°C），可在设置中修改。',

	/* CPU */
	cpu: 'CPU 总使用率（%）。由相邻两次采样 /proc/stat 的差值算出，比瞬时值更平滑。',
	cpu_user: '用户态占用（%）：普通进程消耗的时间片。',
	cpu_sys: '内核态占用（%）：系统调用、中断处理等内核工作。',
	cpu_iowait: 'IO 等待（%）：CPU 空闲但仍有磁盘 IO 未完成。该值持续偏高通常意味着存储是瓶颈，而不是 CPU。',
	cpu_idle: '空闲（%）。',
	cpu_freq: '当前 CPU 频率。路由器可能因温控或节能降频，频率下降会连带影响吞吐。',
	cpu_core: '单核使用率（%）。多核设备上可据此判断负载是否集中在单线程。',
	load_avg: '系统平均负载：1/5/15 分钟内处于可运行+不可中断状态的平均进程数。'
		+ '与 CPU 使用率不同，它把「等 IO 的进程」也算进去；'
		+ '经验值：负载 ≈ 核心数 表示刚好满载，持续超过核心数说明已经在排队。',

	/* 内存 */
	mem_total: '物理内存总量（MemTotal）。',
	mem_free: '完全空闲的内存（MemFree）。Linux 会尽量把内存用作缓存，所以这个值偏小是正常的。',
	mem_available: '可用内存（MemAvailable）：内核估算的「在不触发交换的前提下，新进程还能拿到多少内存」。'
		+ '它 = 空闲 + 可回收的缓存/缓冲区，**判断内存是否吃紧应该看这个值，而不是 MemFree**。',
	mem_used: '已用内存 = 总量 − 可用内存。这是最能反映真实压力的口径。',
	mem_buffers: '块设备缓冲区（Buffers），可被回收。',
	mem_cached: '页缓存（Cached），加速文件读取，内存紧张时可被回收。',
	swap_total: '交换分区总量。路由器通常没有 swap，显示为 0 属正常。',
	swap_free: '剩余交换空间。该值持续下降说明物理内存已长期不足。',

	/* 存储 */
	store_overlay: 'OverlayFS 根分区使用率。路由器固件与已安装软件包都写在这里，**写满会导致配置无法保存、服务异常**。',
	store_used: '已用空间。',
	store_avail: '剩余可用空间。',
	mount_pct: '挂载点使用率（%）。来自 df 输出。',
	mount_type: '文件系统类型。tmpfs 为内存盘（重启即清空），overlay/jffs2 为闪存。',

	/* 网络 */
	net_rx: '下行速率（接收，B/s）。',
	net_tx: '上行速率（发送，B/s）。',
	net_rx_total: '自网卡计数器清零以来的累计接收字节数，重启后归零。',
	net_tx_total: '累计发送字节数。',
	net_tcp: '当前 TCP 连接总数（含 TIME_WAIT）。',
	net_state: '网卡链路状态：up 已连通 / down 未插网线或未启用。',
	iface_role: '接口角色，由后端根据 UCI 网络配置判定（WAN / LAN / WiFi）。速率汇总默认只统计 WAN 口。',

	/* 系统 */
	uptime: '系统连续运行时长，重启后归零。',
	daemon: '采集守护进程状态。停止后不再写入新的历史数据，图表会停在最后一次采样。',
	interval: '采集间隔（秒）。间隔越小曲线越细腻，但闪存写入与 CPU 开销也越高。',
	lines: '当前历史 CSV 中保存的采样点数。后端上限 720 行，超出后滚动淘汰最旧数据。',
	size: '历史数据文件占用空间。',
	version: '本插件版本号。',
	model: '设备型号，取自 /proc/cpuinfo 的 Hardware/Model 字段。',
	kernel: '内核版本。升级固件后此值会变化，可用来确认是否已重启到新内核。',
	host: '主机名（UCI system.@system[0].hostname），局域网内以此名字访问设备。',
	sample_time_ms: '单次采样耗时（毫秒）。该字段需要后端写入 .sample_time_ms 才会显示；'
		+ '当前后端未提供，页面展示的是「前端实测」的采样间隔与接口响应耗时。',
	measured_interval: '前端实测采样间隔：由历史数据中相邻两个时间戳之差统计得出。'
		+ '注意后端最多保留 720 点，超出后会抽稀，因此仅「1小时」档位能真实反映采集间隔。',
	api_latency: '接口响应耗时：浏览器发出请求到收到响应的往返时间，反映路由器当前负载与网络状况。',
	jitter: '采样间隔抖动（平均绝对偏差）。该值明显偏大说明采集被系统负载拖慢了。',

	/* 日志 */
	log_level: '日志级别，由 logread 输出的 facility.level 解析得到。err/crit 标红，warn/warning 标黄，其余灰色。',

	/* 通用 */
	hide_card: '隐藏此卡片。状态保存在 UCI 配置里，刷新后依然生效；可在「设置 → 显示项」恢复。',
	alert: '告警状态由后端根据温度阈值判定：0 正常 / 1 警告 / 2 危险。前端只做展示，不额外增加告警规则。'
};

/** 取字段解释，找不到时返回空串（调用方据此决定是否渲染提示图标） */
export function getFieldDescription(key) {
	if (!key) return '';
	return FIELD_DESCRIPTIONS[key] || '';
}

/* -------------------------------------------------------------- 浮层实现 */

let layer = null;      // 全站唯一浮层
let current = null;    // 当前触发元素
let showTimer = 0;
let hideTimer = 0;
let bound = false;

const SHOW_DELAY = 260;   // 悬停多久后出现，避免鼠标划过时闪烁
const HIDE_DELAY = 120;   // 移出后延迟隐藏，允许鼠标移入浮层（如可选中文字）
const TOUCH_HOLD = 2500;  // 移动端自动隐藏

function ensureLayer() {
	if (layer && layer.isConnected) return layer;
	layer = document.createElement('div');
	layer.className = 'tm-tip-layer';
	layer.id = 'tm-tip-layer';
	layer.setAttribute('role', 'tooltip');
	layer.style.display = 'none';
	// 挂到 #tm-app 内才能继承主题变量；定位用 fixed，故不受父级布局影响
	overlayHost().appendChild(layer);
	return layer;
}

/** 从事件目标向上找带 data-tip 的元素 */
function findTarget(node) {
	let n = node;
	let guard = 0;
	while (n && n !== document.body && guard++ < 12) {
		if (n.nodeType === 1 && n.hasAttribute && n.hasAttribute('data-tip')) return n;
		n = n.parentNode;
	}
	return null;
}

/** 解析 data-tip：既支持直接写文案，也支持写字段 key 走字典 */
function resolveText(el) {
	const raw = el.getAttribute('data-tip') || '';
	if (!raw) return '';
	if (FIELD_DESCRIPTIONS[raw]) return FIELD_DESCRIPTIONS[raw];
	// data-tip-key 显式指定字典键
	const k = el.getAttribute('data-tip-key');
	if (k && FIELD_DESCRIPTIONS[k]) return FIELD_DESCRIPTIONS[k];
	return raw;
}

function place(target) {
	if (!layer || !current) return;
	const r = target.getBoundingClientRect();
	const tw = layer.offsetWidth;
	const th = layer.offsetHeight;
	const gap = 8;

	// 默认放在上方；上方放不下就翻到下方
	let top = r.top - th - gap;
	if (top < 8) top = r.bottom + gap;
	if (top + th > window.innerHeight - 8) top = Math.max(8, window.innerHeight - th - 8);

	let left = r.left + r.width / 2 - tw / 2;
	left = clamp(left, 8, Math.max(8, window.innerWidth - tw - 8));

	// 浮层为 position:fixed，坐标即视口坐标，不叠加滚动偏移
	layer.style.top = Math.round(top) + 'px';
	layer.style.left = Math.round(left) + 'px';
}

function show(target) {
	const text = resolveText(target);
	if (!text) return;
	const L = ensureLayer();
	current = target;
	L.innerHTML = esc(text);
	L.style.display = 'block';
	L.classList.add('is-on');
	place(target);
	target.setAttribute('aria-describedby', 'tm-tip-layer');
}

function hide() {
	clearTimeout(showTimer);
	clearTimeout(hideTimer);
	showTimer = hideTimer = 0;
	if (layer) {
		layer.style.display = 'none';
		layer.classList.remove('is-on');
	}
	if (current) {
		current.removeAttribute('aria-describedby');
		current = null;
	}
}

/**
 * 绑定全站委托。app.js 启动时调用一次即可。
 * @param {HTMLElement} [root] 委托根节点，默认 document
 */
export function bindTooltips(root) {
	if (bound) return () => {};
	bound = true;
	const host = root || document;

	const onOver = (e) => {
		const t = findTarget(e.target);
		if (!t || t === current) return;
		hide();
		showTimer = setTimeout(() => show(t), SHOW_DELAY);
	};

	const onOut = (e) => {
		const t = findTarget(e.target);
		if (!t) return;
		// 移到浮层自身或子元素上时不隐藏
		if (e.relatedTarget && layer && (e.relatedTarget === layer || layer.contains(e.relatedTarget))) return;
		clearTimeout(showTimer);
		hideTimer = setTimeout(hide, HIDE_DELAY);
	};

	// 移动端：点一下显示，2.5s 后自动消失
	const onTouch = (e) => {
		const t = findTarget(e.target);
		if (!t) { hide(); return; }
		hide();
		show(t);
		clearTimeout(hideTimer);
		hideTimer = setTimeout(hide, TOUCH_HOLD);
	};

	const onScrollOrResize = () => { if (current) hide(); };

	host.addEventListener('mouseover', onOver);
	host.addEventListener('mouseout', onOut);
	host.addEventListener('touchstart', onTouch, { passive: true });
	window.addEventListener('scroll', onScrollOrResize, true);
	window.addEventListener('resize', onScrollOrResize);

	return function unbind() {
		host.removeEventListener('mouseover', onOver);
		host.removeEventListener('mouseout', onOut);
		host.removeEventListener('touchstart', onTouch);
		window.removeEventListener('scroll', onScrollOrResize, true);
		window.removeEventListener('resize', onScrollOrResize);
		bound = false;
	};
}

/** 主动为某元素显示提示（供键盘焦点等场景调用） */
export function showFor(target) {
	if (!target) return;
	hide();
	show(target);
}

/** 主动隐藏 */
export function hideTooltip() { hide(); }

/**
 * 生成带提示图标的小控件（用于表格/键值对标签后）
 * @param {string} key FIELD_DESCRIPTIONS 的键，或直接写文案
 */
export function tipIcon(key, size) {
	const text = FIELD_DESCRIPTIONS[key] || key || '';
	if (!text) return '';
	return '<i class="tm-tip-hint" data-tip="' + esc(text).replace(/"/g, '&quot;') +
		'" tabindex="0" aria-label="字段说明">' +
		'<svg viewBox="0 0 24 24" width="' + (size || 12) + '" height="' + (size || 12) +
		'" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
		'<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>' +
		'</svg></i>';
}

export default { bindTooltips, getFieldDescription, FIELD_DESCRIPTIONS, tipIcon, showFor, hideTooltip };
