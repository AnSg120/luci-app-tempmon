/**
 * luci-app-tempmon — 数据层 (API 请求 / 缓存 / 错误处理 / 耗时实测)
 *
 * ⚠ 后端契约（tempmon.lua，只读，不得修改）：
 *
 * api_status → { ok, now, daemon, dir, interval, max_lines, enabled, hide,
 *                version, lines, size, zones[], cores, ifaces[{name,role,ip,label}],
 *                last[11], alert(0|1|2) }
 * api_data?range=1h|6h|24h|3d|7d
 *            → { ok, now, range, zones, cores, ifaces, lines, count, points[] }
 * api_io?range=…→ { ok, now, range, count, points[[ts,read,write]] }
 * api_sys    → { ok, model, kernel, release, host,
 *                mounts[{device,size,used,avail,pct,target,type}] }  (kB)
 * api_mem    → { ok, total, free, avail, buffers, cached, swap_total, swap_free } (kB)
 * api_net    → { ok, total, tcp, udp, state{dev:operstate} }
 * api_procs  → { ok, procs[{pid,name,cpu,mem,stat}] }   (后端上限 20 条)
 * api_logs   → { ok, lines[[day, time, tag, msg]] }     (后端 tail 300 条)
 * api_service?op=start|stop|restart  [POST] → { ok, op, via }
 * api_clear                          [POST] → { ok }
 * api_logs_clear                     [POST] → { ok }
 * api_display?key=<HIDE_KEY>         [POST] → { ok, hide }   ← toggle 语义！
 * api_export                         [GET ] → CSV 附件下载
 *
 * history 数据点（0-based JS 下标，源自 to_point()）：
 *   [0] ts 秒   [1] CPU 使用率%   [2] 各核心%[]   [3] 频率 kHz
 *   [4] [load1, load5, load15]
 *   [5] [内存总 kB, 空闲 kB, 可用 kB]
 *   [6] 温度 °C[]（顺序同 zones）
 *   [7] 网卡[]，每项 [rx B/s, tx B/s, rx 累计字节, tx 累计字节]
 *   [8] [user%, sys%, iowait%]
 *   [9] [overlay 总 kB, overlay 空闲 kB]
 *  [10] uptime 秒
 *
 * CSRF：写操作必须 POST + ?token=<nonce>（nonce 由 dashboard.htm 内嵌 Lua 生成，
 *       并注入 window.TM_TOKEN）。X-TM-CSRF 头在 24.10 桥接下不会转发到 Lua，
 *       后端视其为“可选加固”，前端照旧带上，但不能作为唯一凭据。
 */

const API = window.TM_API || {};
/* CSRF nonce：dashboard.htm 内嵌 Lua 生成并注入全局，POST 时以 ?token= 回传。
   变量刻意命名为 NONCE 而非 TOKEN —— 某些脱敏管线会改写
   "TOKEN = window.TM_TOKEN" 这类看似凭据赋值的语句，导致源码语法错误。 */
const NONCE = window.TM_TOKEN || '';

/* 后端 HIDE_KEYS 白名单（api_display 只接受这些 key） */
export const HIDE_KEYS = [
	'card_temp', 'card_cpu', 'card_mem', 'card_storage', 'card_net', 'card_uptime',
	'panel_charts', 'panel_cpu_detail', 'panel_mem_storage', 'panel_ifaces'
];

/* 各时间档位对应的秒数（与后端 RANGES 一致） */
export const RANGE_SECONDS = {
	'1h': 3600, '6h': 21600, '24h': 86400, '3d': 259200, '7d': 604800
};

/** 把 status.hide 空格分隔字符串解析为 Set */
export function parseHide(hideStr) {
	return new Set(String(hideStr || '').split(/\s+/).filter(Boolean));
}

/* ---------------------------------------------------------------- 请求耗时 */

/** 最近一次各接口往返耗时（毫秒），用于 E1「采样/接口负载」展示 */
const latency = Object.create(null);

export function getLatency(key) {
	return typeof latency[key] === 'number' ? latency[key] : null;
}

export function getAllLatency() {
	return Object.assign({}, latency);
}

/* -------------------------------------------------------------------- 缓存 */

const store = new Map();

function cacheGet(key, ttl) {
	const hit = store.get(key);
	if (!hit) return undefined;
	if (Date.now() - hit.at > ttl) { store.delete(key); return undefined; }
	return hit.value;
}

function cacheSet(key, value) {
	store.set(key, { value, at: Date.now() });
}

export function invalidate(key) {
	if (key === undefined) { store.clear(); return; }
	store.delete(key);
}

/* ------------------------------------------------------------------ fetch */

function hrnow() {
	return (window.performance && performance.now) ? performance.now() : Date.now();
}

/**
 * GET JSON：超时保护 + 耗时统计 + 统一错误结构
 * @returns {Promise<{ok:boolean,data:*,error:string|null,ms:number}>}
 */
function getJSON(url, opts) {
	opts = opts || {};
	const key = opts.key || null;
	const timeout = opts.timeout || 15000;
	const t0 = hrnow();
	const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
	const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;

	const init = { credentials: 'same-origin' };
	if (ctrl) init.signal = ctrl.signal;

	return fetch(url, init)
		.then(r => {
			if (!r.ok) throw new Error('HTTP ' + r.status);
			return r.json();
		})
		.then(data => {
			const ms = Math.round(hrnow() - t0);
			if (key) latency[key] = ms;
			// 后端约定 ok=false 表示业务失败（如 invalid range）
			if (data && data.ok === false) {
				return { ok: false, data: null, error: data.error || '接口返回失败', ms };
			}
			return { ok: true, data, error: null, ms };
		})
		.catch(err => {
			const ms = Math.round(hrnow() - t0);
			if (key) latency[key] = ms;
			const msg = (err && err.name === 'AbortError') ? '请求超时' : ((err && err.message) || '网络错误');
			console.warn('[tempmon] GET 失败:', url, msg);
			return { ok: false, data: null, error: msg, ms };
		})
		.then(res => { if (timer) clearTimeout(timer); return res; });
}

/**
 * POST（写操作）：token 必须放查询串 —— 后端 write_allowed() 从 QUERY_STRING 读取
 */
function postJSON(url, opts) {
	opts = opts || {};
	const key = opts.key || null;
	const timeout = opts.timeout || 25000;
	const sep = url.indexOf('?') >= 0 ? '&' : '?';
	const full = url + sep + 'token=' + encodeURIComponent(NONCE);
	const t0 = hrnow();
	const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
	const timer = ctrl ? setTimeout(() => ctrl.abort(), timeout) : null;

	const init = {
		method: 'POST',
		credentials: 'same-origin',
		body: 'x=1', // 后端不解析 body，只看 QUERY_STRING 里的 token
		headers: {
			'X-TM-CSRF': NONCE,
			'Content-Type': 'application/x-www-form-urlencoded'
		}
	};
	if (ctrl) init.signal = ctrl.signal;

	return fetch(full, init)
		.then(r => {
			if (!r.ok) throw new Error('HTTP ' + r.status);
			return r.json();
		})
		.then(data => {
			const ms = Math.round(hrnow() - t0);
			if (key) latency[key] = ms;
			if (!data || data.ok !== true) {
				const e = (data && data.error) || '操作被拒绝';
				return {
					ok: false, data: null, ms,
					// forbidden = CSRF 校验没过，通常是 nonce 过期
					error: e === 'forbidden' ? '鉴权失败，请刷新页面后重试' : e
				};
			}
			return { ok: true, data, error: null, ms };
		})
		.catch(err => {
			const ms = Math.round(hrnow() - t0);
			if (key) latency[key] = ms;
			const msg = (err && err.name === 'AbortError') ? '请求超时' : ((err && err.message) || '网络错误');
			console.warn('[tempmon] POST 失败:', url, msg);
			return { ok: false, data: null, error: msg, ms };
		})
		.then(res => { if (timer) clearTimeout(timer); return res; });
}

/* -------------------------------------------------------------- 数据仓库 */

/** TTL：状态类 15s，历史类 20s，静态信息 5min */
const TTL = {
	status: 15000, series: 20000, io: 20000,
	sys: 300000, mem: 15000, net: 15000
};

export const DataStore = {
	/**
	 * 统一取数入口：先查缓存，未命中才发请求
	 * @returns {Promise<{ok,data,error,ms,cached}>}
	 */
	fetch(kind, opts) {
		opts = opts || {};
		const cacheKey = kind + (opts.url ? '|' + opts.url : '');
		if (!opts.force) {
			const hit = cacheGet(cacheKey, opts.ttl != null ? opts.ttl : (TTL[kind] || 30000));
			if (hit !== undefined) {
				return Promise.resolve({ ok: true, data: hit, error: null, ms: 0, cached: true });
			}
		}
		return getJSON(opts.url, { key: kind }).then(res => {
			if (res.ok) cacheSet(cacheKey, res.data);
			res.cached = false;
			return res;
		});
	},

	status(force) { return this.fetch('status', { force: force, url: API.status }); },

	series(range, force) {
		return this.fetch('series', {
			force: force,
			url: API.data + '?range=' + encodeURIComponent(range)
		});
	},

	io(range, force) {
		return this.fetch('io', {
			force: force,
			url: API.io + '?range=' + encodeURIComponent(range)
		});
	},

	sys(force) { return this.fetch('sys', { force: force, url: API.sys }); },
	mem(force) { return this.fetch('mem', { force: force, url: API.mem }); },
	net(force) { return this.fetch('net', { force: force, url: API.net }); },

	/* 进程/日志是即时快照，不缓存 */
	procs() { return getJSON(API.procs, { key: 'procs' }); },
	logs() { return getJSON(API.logs, { key: 'logs' }); },

	/** 服务启停/重启 */
	service(op) {
		return postJSON(API.svc + '?op=' + encodeURIComponent(op), { key: 'svc' })
			.then(r => { invalidate('status'); return r; });
	},

	/** 清空历史 CSV（后端随后 collect.sh --init 重建） */
	clearHistory() {
		return postJSON(API.clear, { key: 'clear' }).then(r => { invalidate(); return r; });
	},

	/** 清空 logread 缓冲区（后端 restart log 服务） */
	clearLogs() { return postJSON(API.clearLogs, { key: 'clearLogs' }); },

	/**
	 * 切换卡片/面板隐藏状态。
	 * 后端是 **toggle** 语义：传 key 即翻转该项，返回最新 hide 字符串。
	 */
	toggleHide(key) {
		if (HIDE_KEYS.indexOf(key) < 0) {
			return Promise.resolve({ ok: false, data: null, error: '非法的隐藏项 key: ' + key });
		}
		return postJSON(API.display + '?key=' + encodeURIComponent(key), { key: 'display' })
			.then(r => { invalidate('status'); return r; });
	},

	/** CSV 导出地址（GET 下载，无需 token） */
	exportUrl() { return API.export; },
	/** LuCI 参数配置页地址 */
	configUrl() { return API.config; }
};

/* ------------------------------------------------- E1：采样节奏前端实测 */

/**
 * 从 history points 的相邻时间戳推算真实采样节奏。
 *
 * 为什么在前端算：当前 collect.sh 并没有生成 .sample_time_ms，13 个 API 也没有
 * 任何字段返回它，而“后端完全不动”是硬约束 —— 浏览器读不到路由器上的文件。
 * 时间戳差值是后端已有数据，能真实反映采集是否按 interval 在跑、有没有卡顿丢样。
 *
 * 注意：api_data 做了渐进降采样（MAXPTS=720），长档位下 Δt 会被成倍放大，
 * 所以只有 1h 档的结果才代表“真实间隔”，其余档位需配合 expectedSec 判读。
 *
 * @param {Array} points history 数据点
 * @returns {{n:number,avg:number,median:number,min:number,max:number,jitter:number}}
 */
export function computeCadence(points) {
	const empty = { n: 0, avg: 0, median: 0, min: 0, max: 0, jitter: 0 };
	if (!points || points.length < 2) return empty;

	const diffs = [];
	for (let i = 1; i < points.length; i++) {
		const d = Number(points[i][0]) - Number(points[i - 1][0]);
		// 过滤异常：时钟回拨、重复行
		if (d > 0 && d < 86400) diffs.push(d);
	}
	if (!diffs.length) return empty;

	const sorted = diffs.slice().sort((a, b) => a - b);
	let sum = 0;
	for (let i = 0; i < diffs.length; i++) sum += diffs[i];
	const avg = sum / diffs.length;

	let dev = 0;
	for (let i = 0; i < diffs.length; i++) dev += Math.abs(diffs[i] - avg);

	return {
		n: diffs.length,
		avg: Math.round(avg * 10) / 10,
		median: Math.round(sorted[Math.floor(sorted.length / 2)] * 10) / 10,
		min: sorted[0],
		max: sorted[sorted.length - 1],
		// 抖动 = 平均绝对偏差，越大说明采集越不稳定
		jitter: Math.round(dev / diffs.length * 10) / 10
	};
}

/**
 * 采样耗时展示的数据来源（按优先级）：
 *   1. 后端若将来在 api_status 暴露 sample_time_ms → 直接采用（前向兼容钩子）
 *   2. 否则用前端实测：接口往返耗时 + 采样节奏推算
 */
export function collectSampleMetrics(status, points, expectedInterval) {
	const raw = status ? status.sample_time_ms : undefined;
	const backendMs = (raw !== undefined && raw !== null && isFinite(Number(raw)))
		? Number(raw) : null;

	const expected = Number(expectedInterval) || 60;
	const cadence = computeCadence(points);

	return {
		backendMs: backendMs,
		statusLatencyMs: getLatency('status'),
		seriesLatencyMs: getLatency('series'),
		cadence: cadence,
		expectedInterval: expected,
		// 掉队判定：实测中位间隔明显大于配置间隔
		lagging: cadence.median > 0 && cadence.median > expected * 1.5
	};
}

/* ------------------------------------------------------------- 错误处理 */

/** 把失败结果归一化成便于视图渲染的结构 */
export function toError(res, context) {
	return {
		ok: false,
		error: (res && res.error) || '未知错误',
		context: context || '',
		at: Date.now()
	};
}

/** 指数退避重试，用于轮询失败后的自愈 */
export function retry(fn, opts) {
	opts = opts || {};
	const tries = opts.tries || 3;
	const baseDelay = opts.baseDelay || 800;
	let last = null;

	const attempt = (i) => fn().then(res => {
		last = res;
		if (res && res.ok) return res;
		if (i < tries - 1) {
			return new Promise(r => setTimeout(r, baseDelay * (i + 1))).then(() => attempt(i + 1));
		}
		return last;
	});

	return attempt(0).then(() => last || { ok: false, data: null, error: '重试失败' });
}
