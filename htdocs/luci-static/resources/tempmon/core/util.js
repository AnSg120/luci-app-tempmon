/**
 * luci-app-tempmon — 工具层：格式化 / 统一图标系统 / 共享 widget
 *
 * A2 痛点修复：原先图标是散落在 app.js 里的内联 SVG 字符串，尺寸 24/34 混用、
 * stroke-width 不一致。这里集中为单一注册表：
 *   - 全部 viewBox="0 0 24 24"
 *   - 默认渲染尺寸 24px（可传 size 覆盖）
 *   - stroke-width 统一 2，round cap/join
 * 任何模块只允许通过 icon(name, size) 取图标，禁止再写内联 SVG。
 */

/* ================================================================= 格式化 */

/** HTML 转义，防 XSS —— 所有来自接口的字符串都必须过这里 */
export function esc(s) {
	return String(s == null ? '' : s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/** 属性转义（用于放进 HTML 属性值） */
export function escAttr(s) { return esc(s); }

/** 速率 B/s */
export function fmtRate(b) {
	b = Number(b) || 0;
	if (b >= 1048576) return (b / 1048576).toFixed(2) + ' MB/s';
	if (b >= 1024) return (b / 1024).toFixed(1) + ' KB/s';
	return b.toFixed(0) + ' B/s';
}

/** 容量，入参 kB（后端 meminfo/df 均为 kB） */
export function fmtKB(kb) {
	kb = Number(kb) || 0;
	if (kb >= 1048576) return (kb / 1048576).toFixed(2) + ' GB';
	if (kb >= 1024) return (kb / 1024).toFixed(1) + ' MB';
	return kb.toFixed(0) + ' KB';
}

/** 容量，入参 Byte（网卡累计字节用这个） */
export function fmtB(b) {
	b = Number(b) || 0;
	if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
	if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
	if (b >= 1024) return (b / 1024).toFixed(1) + ' KB';
	return b.toFixed(0) + ' B';
}

/** 频率 kHz → 可读 */
export function fmtFreq(khz) {
	khz = Number(khz) || 0;
	if (khz <= 0) return '—';
	if (khz >= 1000000) return (khz / 1000000).toFixed(2) + ' GHz';
	return (khz / 1000).toFixed(0) + ' MHz';
}

/** 运行时长（秒） */
export function fmtUp(s) {
	s = Number(s) || 0;
	if (s <= 0) return '—';
	const d = Math.floor(s / 86400);
	const h = Math.floor(s % 86400 / 3600);
	const m = Math.floor(s % 3600 / 60);
	if (d > 0) return d + ' 天 ' + h + ' 小时';
	if (h > 0) return h + ' 小时 ' + m + ' 分';
	return m + ' 分';
}

/** 毫秒 → 可读 */
export function fmtMs(ms) {
	ms = Number(ms);
	if (!isFinite(ms) || ms <= 0) return '—';
	if (ms < 1000) return Math.round(ms) + ' ms';
	return (ms / 1000).toFixed(2) + ' s';
}

/** 百分比：pct(used, total) */
export function pct(a, b) { return b > 0 ? a * 100 / b : 0; }

/**
 * E3 单位一致性：统一小数位
 * 规则：百分比/温度 1 位；负载 2 位；频率 2 位；其余按量级
 */
export function fix(v, digits = 1) {
	const n = Number(v);
	if (!isFinite(n)) return '—';
	return n.toFixed(digits);
}

/**
 * 坐标轴刻度标签：按刻度间距决定小数位。
 * 为什么需要它：真机上温度长期停在 40.0–41.x°C，5 个刻度全落在 2° 以内，
 * 若一律取整就会渲染成「39° 40° 40° 41° 41°」——重复标签，实测已出现。
 * 间距 >=1 取整，>=0.1 保留 1 位，更小保留 2 位。
 * @param {number} v      刻度值
 * @param {number} step   相邻刻度间距（chart.js 作为 yFmt 的第二参传入）
 * @param {string} [suffix] 单位后缀，如 '°' / '%' / 'M'
 */
export function axisNum(v, step, suffix) {
	const n = Number(v);
	if (!isFinite(n)) return '—';
	const s = Number(step);
	const d = !(s > 0) ? 0 : (s >= 1 ? 0 : (s >= 0.1 ? 1 : 2));
	return n.toFixed(d) + (suffix || '');
}

/** 补零 */
export function pad(n, w = 2) {
	let s = String(n);
	while (s.length < w) s = '0' + s;
	return s;
}

/** 时间戳（秒）→ 本地时间串 */
export function fmtClock(ts, withSec = true) {
	const d = new Date(ts > 1e12 ? ts : ts * 1000);
	if (isNaN(d.getTime())) return '—';
	const base = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
		' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
	return withSec ? base + ':' + pad(d.getSeconds()) : base;
}

/** “x 秒前”相对时间 */
export function fmtAgo(ts) {
	if (!ts) return '—';
	const t = ts > 1e12 ? ts / 1000 : ts;
	const diff = Math.max(0, Math.floor(Date.now() / 1000 - t));
	if (diff < 5) return '刚刚';
	if (diff < 60) return diff + ' 秒前';
	if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
	if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
	return Math.floor(diff / 86400) + ' 天前';
}

/* ================================================================== 通用 */

export function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

export function debounce(fn, delay = 250) {
	let t = null;
	return function (...args) {
		clearTimeout(t);
		t = setTimeout(() => fn.apply(this, args), delay);
	};
}

export function throttle(fn, limit = 200) {
	let last = 0, timer = null;
	return function (...args) {
		const now = Date.now();
		const remain = limit - (now - last);
		if (remain <= 0) {
			last = now;
			fn.apply(this, args);
		} else if (!timer) {
			timer = setTimeout(() => {
				last = Date.now();
				timer = null;
				fn.apply(this, args);
			}, remain);
		}
	};
}

/** rAF 节流：图表拖拽/缩放这类高频路径用它，避免同一帧重复重绘 */
export function rafThrottle(fn) {
	let queued = false, lastArgs = null;
	return function (...args) {
		lastArgs = args;
		if (queued) return;
		queued = true;
		requestAnimationFrame(() => {
			queued = false;
			fn.apply(this, lastArgs);
		});
	};
}

export function isEmpty(v) {
	if (v == null) return true;
	if (Array.isArray(v)) return v.length === 0;
	if (typeof v === 'string') return v.trim() === '';
	if (typeof v === 'object') return Object.keys(v).length === 0;
	return false;
}

/** 安全取嵌套属性 */
export function getProp(obj, path, dflt) {
	if (!obj || !path) return dflt;
	const keys = String(path).split('.');
	let cur = obj;
	for (const k of keys) {
		if (cur == null) return dflt;
		cur = cur[k];
	}
	return cur === undefined ? dflt : cur;
}

/* ================================================ 统一图标系统 (A2 修复) */

/** 图标统一尺寸常量；24 为规范尺寸 */
export const ICON_SIZE = { XS: 14, SM: 16, MD: 24, LG: 32, XL: 48 };

/** 统一线宽 */
export const ICON_STROKE = 2;

/**
 * 图标路径注册表。
 * 约定：全部基于 24x24 网格，只写内部元素，外壳由 icon() 统一生成，
 * 保证 stroke-width / linecap / linejoin 全站一致。
 */
const ICON_PATHS = {
	/* ---- 导航 ---- */
	overview: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
	cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/>',
	mem: '<rect x="2" y="6" width="20" height="12" rx="2"/><path d="M6 10v4M10 10v4M14 10v4M18 10v4"/>',
	store: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
	net: '<circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/>',
	proc: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
	gauge: '<circle cx="12" cy="12" r="9"/><path d="M12 12l4-3.5"/><path d="M12 3v2M21 12h-2M3 12h2M18.4 5.6l-1.4 1.4"/>',
	log: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/>',
	set: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',

	/* ---- 操作 ---- */
	refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
	menu: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/>',
	close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
	check: '<polyline points="20 6 9 17 4 12"/>',
	search: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
	download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
	trash: '<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
	play: '<polygon points="6 3 20 12 6 21 6 3"/>',
	stop: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
	external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
	logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>',
	chevronRight: '<polyline points="9 18 15 12 9 6"/>',
	chevronDown: '<polyline points="6 9 12 15 18 9"/>',
	panelLeft: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="3" x2="9" y2="21"/>',

	/* ---- 图表工具 ---- */
	zoomIn: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="11" y1="8" x2="11" y2="14"/><line x1="8" y1="11" x2="14" y2="11"/>',
	zoomOut: '<circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/>',
	reset: '<path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/>',
	image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>',

	/* ---- 状态/语义 ---- */
	info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
	warn: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
	danger: '<circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/>',
	thermometer: '<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>',
	activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
	clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
	database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
	wifi: '<path d="M5 12.55a11 11 0 0 1 14.08 0"/><path d="M1.42 9a16 16 0 0 1 21.16 0"/><path d="M8.53 16.11a6 6 0 0 1 6.95 0"/><line x1="12" y1="20" x2="12.01" y2="20"/>',
	arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
	arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
	eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
	eyeOff: '<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>',
	sun: '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>',
	moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
	contrast: '<circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 0 0 20z" fill="currentColor" stroke="none"/>',
	inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
	server: '<rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6.01" y2="6"/><line x1="6" y1="18" x2="6.01" y2="18"/>'
};

/**
 * 取统一图标 SVG
 * @param {string} name 图标名
 * @param {number} [size] 渲染尺寸，默认 24（规范值）
 */
export function icon(name, size) {
	const body = ICON_PATHS[name] || ICON_PATHS.info;
	const s = size || ICON_SIZE.MD;
	return '<svg class="tm-icon" viewBox="0 0 24 24" width="' + s + '" height="' + s +
		'" fill="none" stroke="currentColor" stroke-width="' + ICON_STROKE +
		'" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

/** 图标名清单（便于校验/调试） */
export function iconNames() { return Object.keys(ICON_PATHS); }

/* ======================================================= 共享 widget 片段 */

/** 时间档位定义（与后端 RANGES 对应） */
export const RANGES = [
	{ id: '1h', sec: 3600, label: '1小时' },
	{ id: '6h', sec: 21600, label: '6小时' },
	{ id: '24h', sec: 86400, label: '24小时' },
	{ id: '3d', sec: 259200, label: '3天' },
	{ id: '7d', sec: 604800, label: '7天' }
];

export function rangeSeconds(id) {
	const r = RANGES.find(x => x.id === id);
	return r ? r.sec : 3600;
}

/**
 * 时间范围切换标签组
 * data-range 供事件委托识别；同一页面可多组，用 data-group 区分
 */
export function rangeTabs(current, group) {
	const g = group ? ' data-group="' + escAttr(group) + '"' : '';
	return '<div class="tm-tabs" role="tablist"' + g + '>' +
		RANGES.map(r =>
			'<button type="button" role="tab" class="tm-tab' + (r.id === current ? ' active' : '') +
			'" data-range="' + r.id + '" aria-selected="' + (r.id === current) + '">' + r.label + '</button>'
		).join('') + '</div>';
}

/** 进度条；level: ok|warn|danger 决定配色 */
export function progressBar(percent, level) {
	const w = clamp(Number(percent) || 0, 0, 100);
	const cls = level || (w >= 90 ? 'danger' : w >= 75 ? 'warn' : 'ok');
	return '<div class="tm-progress" role="progressbar" aria-valuenow="' + w.toFixed(1) +
		'" aria-valuemin="0" aria-valuemax="100">' +
		'<div class="tm-progress-bar lv-' + cls + '" style="width:' + w.toFixed(2) + '%"></div></div>';
}

/** 键值对列表：items = [[label, valueHtml, tooltipKey?], ...] */
export function kvList(items) {
	return '<div class="tm-kv">' + items.map(it => {
		const tip = it[2] ? ' data-tip="' + escAttr(it[2]) + '"' : '';
		return '<div class="tm-kv-item"' + tip + '>' +
			'<span class="tm-kv-label">' + esc(it[0]) + (it[2] ? ' <i class="tm-tip-hint" data-tip="' + escAttr(it[2]) + '">' + icon('info', 12) + '</i>' : '') + '</span>' +
			'<span class="tm-kv-value">' + (it[1] == null ? '—' : it[1]) + '</span></div>';
	}).join('') + '</div>';
}

/** 数字图块：items = [[label, valueHtml, tipKey?], ...] */
export function tiles(items) {
	return '<div class="tm-tiles">' + items.map(it => {
		const tip = it[2] ? ' data-tip="' + escAttr(it[2]) + '"' : '';
		return '<div class="tm-tile"' + tip + '>' +
			'<div class="tm-tile-label">' + esc(it[0]) + '</div>' +
			'<div class="tm-tile-value">' + (it[1] == null ? '—' : it[1]) + '</div></div>';
	}).join('') + '</div>';
}

/**
 * 环形图（纯 SVG，无第三方库）
 * @param {Array} segs [[value, cssColor, label], ...]
 * @param {string} centerText 圆心主文本
 * @param {string} subText 圆心副文本
 */
export function donutSVG(segs, centerText, subText, size) {
	const S = size || 160;
	const cx = S / 2, cy = S / 2;
	const R = S / 2 - 18;
	const C = 2 * Math.PI * R;
	let total = 0;
	segs.forEach(s => { total += Math.max(0, Number(s[0]) || 0); });

	let out = '<svg class="tm-donut" width="' + S + '" height="' + S + '" viewBox="0 0 ' + S + ' ' + S + '" role="img">' +
		'<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="var(--tm-bg-input)" stroke-width="16"/>';

	let offset = 0;
	if (total > 0) {
		segs.forEach(s => {
			const frac = Math.max(0, Number(s[0]) || 0) / total;
			// 小于 0.2% 的扇区不画，避免出现渲染毛刺
			if (frac > 0.002) {
				out += '<circle cx="' + cx + '" cy="' + cy + '" r="' + R + '" fill="none" stroke="' + s[1] +
					'" stroke-width="16" stroke-linecap="butt" stroke-dasharray="' + (frac * C).toFixed(2) + ' ' + C.toFixed(2) +
					'" stroke-dashoffset="' + (-offset * C).toFixed(2) +
					'" transform="rotate(-90 ' + cx + ' ' + cy + ')"><title>' + esc(s[2]) + '</title></circle>';
			}
			offset += frac;
		});
	}

	out += '<text x="' + cx + '" y="' + (cy - 2) + '" text-anchor="middle" class="tm-donut-center">' + esc(centerText || '') + '</text>' +
		'<text x="' + cx + '" y="' + (cy + 18) + '" text-anchor="middle" class="tm-donut-sub">' + esc(subText || '') + '</text>' +
		'</svg>';
	return out;
}

/** 图例列表：items = [[color, label, valueHtml], ...] */
export function legendList(items) {
	return '<div class="tm-donut-legend">' + items.map(it =>
		'<div class="tm-legend-item">' +
		'<span class="tm-legend-dot" style="background:' + it[0] + '"></span>' +
		'<span>' + esc(it[1]) + '</span>' +
		'<span class="tm-legend-value">' + (it[2] == null ? '—' : it[2]) + '</span></div>'
	).join('') + '</div>';
}

/** 面板外壳；actions 为右侧按钮 HTML */
export function panel(title, bodyHtml, opts) {
	opts = opts || {};
	const actions = opts.actions ? '<div class="tm-panel-actions">' + opts.actions + '</div>' : '';
	const sub = opts.subtitle ? '<div class="tm-panel-subtitle">' + esc(opts.subtitle) + '</div>' : '';
	const id = opts.id ? ' id="' + escAttr(opts.id) + '"' : '';
	const cls = opts.className ? ' ' + opts.className : '';
	return '<section class="tm-panel' + cls + '"' + id + '>' +
		'<header class="tm-panel-header"><h2 class="tm-panel-title">' + esc(title) + '</h2>' + sub + actions + '</header>' +
		bodyHtml + '</section>';
}

/* ==================================================== 业务派生计算（复用） */

/**
 * WAN 网卡下标推断（保留原 app.js 三级回退逻辑，行为不变）
 */
export function wanIdxs(status) {
	const ifs = (status && Array.isArray(status.ifaces)) ? status.ifaces : [];
	let idx = [];
	ifs.forEach((f, i) => { if ((f.role || '') === 'WAN') idx.push(i); });
	if (!idx.length) ifs.forEach((f, i) => { if (/wan|wwan/i.test(f.name || '')) idx.push(i); });
	if (!idx.length) ifs.forEach((f, i) => {
		if (!/^br-/.test(f.name || '') && (f.role || '') !== 'LAN') idx.push(i);
	});
	return idx;
}

/** 汇总 WAN 网卡某列：k=0 下行B/s, 1 上行B/s, 2 rx累计, 3 tx累计 */
export function netTotal(point, k, status) {
	if (!point || !point[7]) return null;
	const idx = wanIdxs(status);
	let sum = 0, any = false;
	for (const i of idx) {
		const q = point[7][i];
		if (q) { sum += (Number(q[k]) || 0); any = true; }
	}
	return any ? sum : null;
}

/**
 * 从 series.points 抽取某指标序列（用于 sparkline / 图表）
 * key: cpu | mem | temp | netd | netu | iowait | load1 | store
 */
export function seriesVals(points, key, status) {
	if (!points || !points.length) return [];
	return points.map(p => {
		switch (key) {
			case 'cpu': return num(p[1]);
			case 'mem': return (p[5] && p[5][0]) ? pct(p[5][0] - p[5][2], p[5][0]) : null;
			case 'temp': return (p[6] && p[6].length) ? num(p[6][0]) : null;
			case 'netd': return netTotal(p, 0, status);
			case 'netu': return netTotal(p, 1, status);
			case 'iowait': return (p[8] && p[8].length > 2) ? num(p[8][2]) : null;
			case 'load1': return (p[4] && p[4].length) ? num(p[4][0]) : null;
			case 'store': return (p[9] && p[9][0]) ? pct(p[9][0] - p[9][1], p[9][0]) : null;
			default: return null;
		}
	});
}

function num(v) {
	const n = Number(v);
	return isFinite(n) ? n : null;
}

/**
 * 温度告警级别（纯前端展示用，阈值与后端 UCI 默认值一致）
 * 后端已给出权威 alert（0/1/2）时以 status.alert 为准，见 alertLevel()
 */
export function tempLevel(t, warn = 75, crit = 85) {
	const v = Number(t);
	if (!isFinite(v)) return 'ok';
	if (v >= crit) return 'danger';
	if (v >= warn) return 'warn';
	return 'ok';
}

/** 由 status.alert 映射到 UI 级别 */
export function alertLevel(alert) {
	if (alert === 2 || alert === '2') return 'danger';
	if (alert === 1 || alert === '1') return 'warn';
	return 'ok';
}

/** CPU 使用率级别（前端展示阈值） */
export function cpuLevel(v) {
	const n = Number(v) || 0;
	if (n >= 90) return 'danger';
	if (n >= 75) return 'warn';
	return 'ok';
}

/** 内存使用率级别 */
export function memLevel(v) {
	const n = Number(v) || 0;
	if (n >= 92) return 'danger';
	if (n >= 80) return 'warn';
	return 'ok';
}

/** 存储使用率级别 */
export function storeLevel(v) {
	const n = Number(v) || 0;
	if (n >= 92) return 'danger';
	if (n >= 80) return 'warn';
	return 'ok';
}

/** 网卡角色 → 徽章 class */
export function roleClass(iface) {
	const role = (iface && iface.role) || '';
	if (role === 'WAN') return 'wan';
	if (role === 'LAN') return 'lan';
	if (/GHz|wifi|wlan/i.test((iface && iface.label) || '')) return 'wifi';
	return 'other';
}

/** 下载文本文件（前端导出用） */
export function downloadText(content, filename, mime) {
	const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * 浮层挂载点。
 *
 * 主题变量定义在 #tm-app 上（页面跑在 LuCI 的 header/footer 外壳里，
 * 直接写 :root 会污染 LuCI 自身样式）。因此模态框、tooltip、toast 这些
 * 需要用到 var(--tm-*) 的浮层必须挂在 #tm-app 内部，挂到 document.body
 * 会拿不到变量而变成「黑底黑字」。
 * position:fixed 不受父级 flex 布局影响，所以挂这里不会错位。
 */
export function overlayHost() {
	return document.getElementById('tm-app') || document.body;
}
