/**
 * luci-app-tempmon — MetricCard 指标卡片
 *
 * A1：卡片按 ok / warn / danger 三态改变边框+背景+阴影（不再只改数字颜色）
 * A5：隐藏卡片按钮走事件委托（data-hide），不使用内联 onclick
 * C3：sparkline 语义着色 —— 超阈值的连续区段用 warn/danger 色叠加描边
 * A6：data-tip 交由 Tooltip 组件统一接管，提供字段解释
 */

import { esc, escAttr, icon, clamp } from '../core/util.js';

/**
 * 生成迷你趋势图 SVG（语义着色）
 *
 * 实现要点（低端设备友好）：
 *   - 只生成 1 条面积 + 1 条主线 + 每个超阈值连续区段 1 条叠加线
 *   - 不做逐点变色（那会产生成百上千个 path 节点，重绘代价过高）
 *
 * @param {Array<number|null>} values 数据序列
 * @param {Object} [opts] { height, warn, crit, color }
 */
export function sparkSVG(values, opts) {
	opts = opts || {};
	const H = opts.height || 34;
	const W = 200;
	const warn = opts.warn != null ? opts.warn : null;
	const crit = opts.crit != null ? opts.crit : null;
	const base = opts.color || 'var(--tm-accent)';

	const arr = Array.isArray(values) ? values : [];
	let n = 0, mn = Infinity, mx = -Infinity;
	for (let i = 0; i < arr.length; i++) {
		const v = Number(arr[i]);
		if (isFinite(v)) { n++; if (v < mn) mn = v; if (v > mx) mx = v; }
	}
	if (n < 2 || !isFinite(mn)) return '';

	// 阈值纳入量程，避免超阈值段被裁到画布外
	if (crit != null) mx = Math.max(mx, crit);
	if (warn != null) mx = Math.max(mx, warn);
	if (mx - mn < 1e-9) { mx += 1; mn -= 1; }

	const last = arr.length - 1 || 1;
	const X = i => (i / last) * W;
	const Y = v => H - 2 - ((v - mn) / (mx - mn)) * (H - 5);

	// 主线路径（null 处断线）
	let d = '';
	let pen = false;
	for (let i = 0; i < arr.length; i++) {
		const v = Number(arr[i]);
		if (!isFinite(v)) { pen = false; continue; }
		d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1);
		pen = true;
	}
	if (!d) return '';

	// 面积填充：用首/末有效点收口
	let firstValidX = W, lastValidX = 0;
	for (let i = 0; i < arr.length; i++) {
		if (isFinite(Number(arr[i]))) { firstValidX = X(i); break; }
	}
	for (let i = arr.length - 1; i >= 0; i--) {
		if (isFinite(Number(arr[i]))) { lastValidX = X(i); break; }
	}
	const area = d + 'L' + lastValidX.toFixed(1) + ' ' + H + 'L' + firstValidX.toFixed(1) + ' ' + H + 'Z';

	/**
	 * 收集满足谓词的连续区段并拼成 path
	 * 每段向前多取一个点，保证叠加线与主线视觉连续
	 */
	function runs(pred) {
		let out = '';
		let i = 0;
		while (i < arr.length) {
			const v = Number(arr[i]);
			if (!isFinite(v) || !pred(v)) { i++; continue; }
			let j = i;
			while (j + 1 < arr.length) {
				const nv = Number(arr[j + 1]);
				if (isFinite(nv) && pred(nv)) j++; else break;
			}
			const from = Math.max(0, i - 1);
			let seg = '';
			for (let k = from; k <= j; k++) {
				const vv = Number(arr[k]);
				if (!isFinite(vv)) continue;
				seg += (seg ? 'L' : 'M') + X(k).toFixed(1) + ' ' + Y(vv).toFixed(1);
			}
			if (seg) out += seg;
			i = j + 1;
		}
		return out;
	}

	let overlay = '';
	// 先 warn 段，再用更严重的 crit 段覆盖其上
	if (warn != null) {
		const wd = runs(v => v >= warn && (crit == null || v < crit));
		if (wd) overlay += '<path d="' + wd + '" fill="none" stroke="var(--tm-warn)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
	}
	if (crit != null) {
		const cd = runs(v => v >= crit);
		if (cd) overlay += '<path d="' + cd + '" fill="none" stroke="var(--tm-err)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>';
	}

	return '<svg class="tm-spark" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" aria-hidden="true">' +
		'<path d="' + area + '" fill="' + base + '" fill-opacity="0.12" stroke="none"/>' +
		'<path d="' + d + '" fill="none" stroke="' + base + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
		overlay +
		'</svg>';
}

/**
 * 指标卡片 HTML
 * @param {Object} cfg
 *   key       {string} 对应后端 HIDE_KEYS，用于隐藏卡片；为空则不显示隐藏按钮
 *   icon      {string} 统一图标名
 *   tone      {string} 图标底色：blue|cyan|purple|orange|green|red
 *   title     {string}
 *   value     {string|number} 已格式化的主值
 *   unit      {string} 单位（E3：单位随值展示，降低认知负担）
 *   sub       {string} 次要说明
 *   level     {string} ok|warn|danger —— 驱动卡片三态视觉
 *   spark     {Array}  趋势数据
 *   sparkOpts {Object} { warn, crit, color }
 *   tip       {string} 字段解释（A6）
 *   foot      {string} 额外底部 HTML（如进度条）
 */
export function metricCard(cfg) {
	cfg = cfg || {};
	const level = cfg.level || 'ok';
	const tipAttr = cfg.tip ? ' data-tip="' + escAttr(cfg.tip) + '"' : '';
	const hideKey = cfg.key || '';
	const cardKeyAttr = hideKey ? ' data-card-key="' + escAttr(hideKey) + '"' : '';

	const hideBtn = hideKey
		? '<button type="button" class="tm-card-hide" data-hide="' + escAttr(hideKey) +
		  '" title="隐藏此卡片" aria-label="隐藏此卡片">' + icon('eyeOff', 14) + '</button>'
		: '';

	const spark = (cfg.spark && cfg.spark.length)
		? '<div class="tm-card-spark">' + sparkSVG(cfg.spark, cfg.sparkOpts || {}) + '</div>'
		: '';

	const unit = cfg.unit ? '<small>' + esc(cfg.unit) + '</small>' : '';

	return '' +
		'<article class="tm-card tm-card--' + level + '"' + cardKeyAttr + tipAttr + '>' +
			'<header class="tm-card-header">' +
				'<span class="tm-card-icon tone-' + (cfg.tone || 'blue') + '">' + icon(cfg.icon || 'activity', 18) + '</span>' +
				'<h3 class="tm-card-title">' + esc(cfg.title || '') + '</h3>' +
				hideBtn +
			'</header>' +
			'<div class="tm-card-value">' + esc(String(cfg.value == null ? '—' : cfg.value)) + unit + '</div>' +
			spark +
			(cfg.foot ? '<div class="tm-card-foot">' + cfg.foot + '</div>' : '') +
			(cfg.sub ? '<div class="tm-card-sub">' + esc(cfg.sub) + '</div>' : '') +
		'</article>';
}

/**
 * 卡片网格：自动过滤被隐藏的卡片（由后端 status.hide 决定）
 * @param {Array}  cards  metricCard 配置数组
 * @param {Set}    hidden 已隐藏 key 集合
 * @param {string} [cols] 网格列数类名，默认 tm-grid-5
 */
export function metricCardGrid(cards, hidden, cols) {
	const set = hidden instanceof Set ? hidden : new Set();
	const visible = (cards || []).filter(c => !c.key || !set.has(c.key));

	if (!visible.length) {
		return '<div class="tm-empty">' + icon('eyeOff', 48) +
			'<div class="tm-empty-text">所有卡片都已被隐藏，可在「设置 → 显示项」中恢复</div></div>';
	}

	return '<div class="tm-grid ' + (cols || 'tm-grid-5') + '">' +
		visible.map(metricCard).join('') + '</div>';
}

/**
 * 依据百分比给出三态级别（阈值集中于此，便于统一调整）
 */
export function levelOfPercent(v, warnAt, dangerAt) {
	const n = Number(v);
	if (!isFinite(n)) return 'ok';
	if (n >= (dangerAt != null ? dangerAt : 90)) return 'danger';
	if (n >= (warnAt != null ? warnAt : 75)) return 'warn';
	return 'ok';
}

/** 卡片内嵌进度条，级别联动颜色 */
export function cardProgress(percent, level) {
	const w = clamp(Number(percent) || 0, 0, 100);
	const lv = level || levelOfPercent(w);
	return '<div class="tm-progress" role="progressbar" aria-valuenow="' + w.toFixed(1) +
		'" aria-valuemin="0" aria-valuemax="100">' +
		'<div class="tm-progress-bar lv-' + lv + '" style="width:' + w.toFixed(2) + '%"></div></div>';
}
