/**
 * luci-app-tempmon — VirtualList 虚拟滚动
 *
 * B5 痛点：api_procs / api_logs 原先一次性渲染全部 DOM 造成卡顿。
 * 这里只渲染可视区 + 上下 overscan 行，滚动时用 transform 平移窗口容器。
 *
 * 性能关键：滚动回调里先比较 [start,end] 区间，**区间没变就完全不碰 DOM**，
 * 避免低端路由器浏览器上的无谓重排/重绘。
 */

import { esc } from '../core/util.js';

export class VirtualList {
	/**
	 * @param {Object} opts
	 *   container  {HTMLElement} 挂载点（会被清空并接管）
	 *   items      {Array}       数据
	 *   renderRow  {Function}    (item, index) => HTML 字符串（一行内部内容）
	 *   rowHeight  {number}      固定行高 px
	 *   maxHeight  {number}      滚动区最大高度 px
	 *   overscan   {number}      可视区外额外渲染行数，默认 6
	 *   columns    {string}      CSS grid-template-columns（行与表头共用，保证对齐）
	 *   head       {Array<string>} 表头单元格 HTML；为空则不渲染表头
	 *   emptyHtml  {string}      空数据占位
	 *   rowClass   {Function}    (item, index) => 追加的 class
	 */
	constructor(opts) {
		this.opts = Object.assign({
			items: [],
			rowHeight: 32,
			maxHeight: 420,
			overscan: 6,
			columns: '1fr',
			head: null,
			emptyHtml: '<div class="tm-empty"><div class="tm-empty-text">暂无数据</div></div>',
			rowClass: null,
			// 窄屏下宁可横向滚动也不压扁列（D4）；0 表示不限制
			minWidth: 0
		}, opts || {});

		this.items = this.opts.items || [];
		this.renderRow = this.opts.renderRow || (() => '');
		this.start = -1;
		this.end = -1;

		this._build();
	}

	/** 构建骨架 DOM（只做一次） */
	_build() {
		const c = this.opts.container;
		if (!c) return;
		c.innerHTML = '';
		c.classList.add('tm-vlist');
		if (this.opts.minWidth) c.style.setProperty('--tm-vlist-minw', this.opts.minWidth + 'px');

		// 表头（可选），与行共用 columns 模板以严格对齐
		if (this.opts.head && this.opts.head.length) {
			this.head = document.createElement('div');
			this.head.className = 'tm-vlist-head';
			this.head.style.gridTemplateColumns = this.opts.columns;
			this.head.innerHTML = this.opts.head.map(h => '<span>' + h + '</span>').join('');
			c.appendChild(this.head);
		}

		this.scroller = document.createElement('div');
		this.scroller.className = 'tm-vlist-scroll';
		this.scroller.style.maxHeight = this.opts.maxHeight + 'px';

		this.phantom = document.createElement('div');
		this.phantom.className = 'tm-vlist-phantom';

		this.window = document.createElement('div');
		this.window.className = 'tm-vlist-window';

		this.phantom.appendChild(this.window);
		this.scroller.appendChild(this.phantom);
		c.appendChild(this.scroller);

		this._onScroll = () => this._update();
		this.scroller.addEventListener('scroll', this._onScroll, { passive: true });

		this._update(true);
	}

	/** 可视区能容纳多少行 */
	_viewportRows() {
		const h = this.scroller ? this.scroller.clientHeight : this.opts.maxHeight;
		return Math.max(1, Math.ceil((h || this.opts.maxHeight) / this.opts.rowHeight));
	}

	/**
	 * 计算并重绘可视窗口
	 * @param {boolean} force 忽略区间比较强制重绘
	 */
	_update(force) {
		if (!this.scroller) return;
		const n = this.items.length;

		if (!n) {
			this.phantom.style.height = '0px';
			this.window.innerHTML = this.opts.emptyHtml;
			this.window.style.transform = 'translateY(0px)';
			this.start = this.end = -1;
			return;
		}

		const rh = this.opts.rowHeight;
		const over = this.opts.overscan;
		const total = n * rh;
		if (this.phantom.style.height !== total + 'px') this.phantom.style.height = total + 'px';

		const vp = this._viewportRows();
		let s = Math.floor(this.scroller.scrollTop / rh) - over;
		if (s < 0) s = 0;
		let e = s + vp + over * 2;
		if (e > n) e = n;
		if (s > e) s = e;

		// 区间未变化 → 直接返回，零 DOM 操作
		if (!force && s === this.start && e === this.end) return;
		this.start = s;
		this.end = e;

		const parts = [];
		for (let i = s; i < e; i++) {
			const extra = this.opts.rowClass ? (' ' + (this.opts.rowClass(this.items[i], i) || '')) : '';
			parts.push('<div class="tm-vlist-row' + extra + '" style="height:' + rh + 'px;grid-template-columns:' + this.opts.columns + '">');
			parts.push(this.renderRow(this.items[i], i));
			parts.push('</div>');
		}
		this.window.innerHTML = parts.join('');
		this.window.style.transform = 'translateY(' + (s * rh) + 'px)';
	}

	/** 替换数据集（如日志过滤条件变化） */
	setItems(items, keepScroll) {
		this.items = items || [];
		if (!keepScroll && this.scroller) this.scroller.scrollTop = 0;
		this._update(true);
	}

	/** 数据未变但需要重绘（如主题切换） */
	refresh() { this._update(true); }

	scrollToTop() {
		if (this.scroller) { this.scroller.scrollTop = 0; this._update(true); }
	}

	get count() { return this.items.length; }

	destroy() {
		if (this.scroller && this._onScroll) {
			this.scroller.removeEventListener('scroll', this._onScroll);
		}
		if (this.opts.container) this.opts.container.innerHTML = '';
		this.scroller = this.phantom = this.window = this.head = null;
		this.items = [];
	}
}

/* ==================================================== 进程表（api_procs） */

/** 后端上限 20 条；超过阈值才启用虚拟滚动，少量数据直接渲染更省 */
export const VLIST_THRESHOLD = 60;

export const PROCS_COLUMNS = '72px minmax(0,1fr) 84px 84px 76px';
export const PROCS_HEAD = ['PID', '名称', 'CPU %', '内存 %', '状态'];

/** 兼容后端两种形态：对象 {pid,name,cpu,mem,stat} 或原始数组行 */
export function normalizeProc(r) {
	if (r && typeof r === 'object' && !Array.isArray(r) && r.pid !== undefined) {
		return {
			pid: r.pid,
			name: r.name || '',
			cpu: r.cpu !== '' && r.cpu != null ? r.cpu : '—',
			mem: r.mem !== '' && r.mem != null ? r.mem : '—',
			stat: r.stat || '—'
		};
	}
	const a = Array.isArray(r) ? r : [];
	return {
		pid: a[0] != null ? a[0] : '—',
		name: (a.slice(7) || []).join(' '),
		cpu: a[6] != null ? a[6] : '—',
		mem: '—',
		stat: a[3] || '—'
	};
}

export function procsRow(p) {
	const d = normalizeProc(p);
	let name = d.name;
	if (name.length > 64) name = name.slice(0, 63) + '…';
	const cpuNum = parseFloat(d.cpu);
	const hot = isFinite(cpuNum) && cpuNum >= 50;
	return '<span class="c-dim">' + esc(d.pid) + '</span>' +
		'<span class="c-bold c-ellipsis" title="' + esc(d.name) + '">' + esc(name) + '</span>' +
		'<span class="' + (hot ? 'c-hot' : '') + '">' + esc(d.cpu) + '</span>' +
		'<span>' + esc(d.mem) + '</span>' +
		'<span class="c-dim">' + esc(d.stat) + '</span>';
}

/** 直接渲染（少量数据走这条路径，省掉虚拟滚动开销） */
export function procsTableHtml(procs) {
	if (!procs || !procs.length) {
		return '<div class="tm-empty"><div class="tm-empty-text">暂无进程数据</div></div>';
	}
	return '<div class="tm-vlist"><div class="tm-vlist-head" style="grid-template-columns:' + PROCS_COLUMNS + '">' +
		PROCS_HEAD.map(h => '<span>' + h + '</span>').join('') + '</div>' +
		'<div class="tm-vlist-plain">' +
		procs.map(p => '<div class="tm-vlist-row" style="grid-template-columns:' + PROCS_COLUMNS + '">' + procsRow(p) + '</div>').join('') +
		'</div></div>';
}

/* ====================================================== 日志表（api_logs） */

export const LOGS_COLUMNS = '150px 76px minmax(0,1fr)';
export const LOGS_HEAD = ['时间', '级别', '内容'];

/** 后端行结构：[day, time, tag, msg]；tag 形如 "daemon.info" */
export function logLevel(tag) {
	const t = String(tag || '');
	const lv = t.indexOf('.') >= 0 ? t.split('.')[1] : t;
	return (lv || 'info').toLowerCase();
}

/**
 * 级别着色。判定规则与 v3.0 原版完全一致（不引入新分级，避免行为回归）：
 *   err/crit → 红；warn/warning → 黄；其余 → 灰
 */
export function logLevelClass(tag) {
	const lv = logLevel(tag);
	if (lv === 'err' || lv === 'crit') return 'lv-err';
	if (lv === 'warn' || lv === 'warning') return 'lv-warn';
	return 'lv-info';
}

export function logsRow(l) {
	const day = l[0] || '';
	const time = l[1] || '';
	const tag = l[2] || '';
	const msg = l[3] || '';
	return '<span class="c-dim c-nowrap">' + esc((day + ' ' + time).trim() || '—') + '</span>' +
		'<span class="' + logLevelClass(tag) + '" title="' + esc(tag) + '">' + esc(logLevel(tag)) + '</span>' +
		'<span class="c-mono c-ellipsis" title="' + esc(msg) + '">' + esc(msg) + '</span>';
}

export default VirtualList;
