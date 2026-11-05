/**
 * luci-app-tempmon — 前端入口 v1.0.0（原生 ES Module，无打包、无第三方依赖）
 *
 * 本文件只做「装配与调度」，不含业务渲染逻辑：
 *   · 搭建外壳（侧边栏 / 顶栏 / 面包屑 / 内容区 / Toast）
 *   · 路由：history pushState（B3）
 *   · 数据：按视图 needs 声明并行拉取 + 缓存 + 失败重试（B2）
 *   · 渲染：view.render() → view.mount()；轮询走 view.patch() 增量更新（B1）
 *   · 主题：手动三态切换（A4）
 *   · 全局告警横幅（E2）、最后更新时间（E4）
 *
 * 后端 13 个 API、collect.sh、CSV 格式一律未改动；
 * 所有字段口径见 core/dataStore.js 头部注释。
 *
 * 加载顺序（dashboard.htm）：
 *   <script src="chart.js?v=1.0.0">            ← 经典脚本，挂 window.tempmonChart
 *   <script type="module" src="app.js?v=1.0.0"> ← 本文件，模块图从这里展开
 */

import { router } from './core/router.js';
import { DataStore, parseHide, HIDE_KEYS } from './core/dataStore.js';
import { themeCtrl } from './core/themeCtrl.js';
import { icon, esc, fmtAgo, rangeSeconds, overlayHost, alertLevel } from './core/util.js';

import { renderSidebar, bindSidebar, setActive, readCollapsePref, openMobile, closeMobile, toggleMobile }
	from './components/SidebarNav.js';
import { renderBreadcrumb, bindBreadcrumb, updateBreadcrumb } from './components/BreadCrumb.js';
import { bindTooltips, hideTooltip } from './components/Tooltip.js';
import { showModal } from './components/ModalConfirm.js';
import { overviewSkeleton, cardSkeleton, chartSkeleton, tableSkeleton, panelSkeleton, showEmpty, loadingHtml }
	from './components/Skeleton.js';

import OverviewView from './views/Overview.js';
import CpuView from './views/CpuView.js';
import MemoryView from './views/MemoryView.js';
import StorageView from './views/StorageView.js';
import NetworkView from './views/NetworkView.js';
import ProcsView from './views/ProcsView.js';
import SensorsView from './views/SensorsView.js';
import LogsView from './views/LogsView.js';
import SettingsView from './views/SettingsView.js';

/* ================================================================ 常量 */

const API = window.TM_API || {};
/* window.TM_VERSION 是 dashboard.htm 内联 Lua 从 opkg status 读出的**包**版本；
   万一读不到就退回前端资源版本号，与 ?v= 保持一致，
   这样侧边栏至少不会显示成空。 */
const VERSION = window.TM_VERSION || '1.0.0';

const VIEWS = {
	overview: OverviewView,
	cpu: CpuView,
	memory: MemoryView,
	storage: StorageView,
	network: NetworkView,
	procs: ProcsView,
	sensors: SensorsView,
	logs: LogsView,
	settings: SettingsView
};

/** 数据键 → 取数函数。series1h 固定拉 1 小时档，供 E1 采样节奏实测使用 */
const LOADERS = {
	status:   force => DataStore.status(force),
	series:   force => DataStore.series(S.range, force),
	series1h: force => DataStore.series('1h', force),
	io:       force => DataStore.io(S.range, force),
	sys:      force => DataStore.sys(force),
	mem:      force => DataStore.mem(force),
	net:      force => DataStore.net(force),
	procs:    () => DataStore.procs(),
	logs:     () => DataStore.logs()
};

/** 状态数据是全局依赖（隐藏项、告警、接口清单都在里面），任何视图失败都要先拿到它 */
const ALWAYS = ['status'];

/* ================================================================ 状态 */

const S = {
	view: 'overview',
	range: '1h',
	status: null,
	series: null,
	series1h: null,
	io: null,
	sys: null,
	mem: null,
	net: null,
	procs: null,
	logs: null,
	hidden: new Set(),
	errors: {},          // key → 错误文案
	loading: new Set(),
	lastUpdate: 0,       // 最近一次成功拿到 status 的时间戳（秒）
	alertDismissed: false,
	booted: false
};

/* DOM 引用 */
let app, sidebar, mainEl, topbarEl, contentEl, alertSlot, viewRoot, toastHost;
let clockTimer = null, pollTimer = null, pollMs = 60000;

/* ============================================================== 外壳搭建 */

function buildShell() {
	app = document.getElementById('tm-app');
	if (!app) return false;

	app.innerHTML =
		/* 遮罩不在这里建：renderSidebar() 会在 #tm-sidebar-slot 内部输出一个
		   .tm-sidebar-mask，openMobile/closeMobile 也是从 slot 里 querySelector 取它。
		   这里再建一个只会多出一个永远 hidden、谁也不碰的死元素。 */
		'<div id="tm-sidebar-slot"></div>' +
		'<div class="tm-main">' +
			'<header class="tm-topbar">' +
				'<div class="tm-topbar-left">' +
					'<button type="button" class="tm-icon-btn tm-menu-btn" data-sidebar-open ' +
						'aria-label="打开菜单" title="菜单">' + icon('menu', 20) + '</button>' +
					'<h1 class="tm-page-title" id="tm-page-title">系统概览</h1>' +
					'<div id="tm-breadcrumb-slot"></div>' +
				'</div>' +
				'<div class="tm-topbar-right">' +
					'<span class="tm-updated" id="tm-updated" data-tip="最后更新时间"></span>' +
					'<span class="tm-status-pill" id="tm-status-pill" data-tip="daemon">' +
						'<span class="tm-dot off"></span><span class="txt">检测中</span>' +
					'</span>' +
					'<button type="button" class="tm-icon-btn" id="tm-refresh" aria-label="刷新数据" title="刷新数据">' +
						icon('refresh', 18) + '</button>' +
					'<button type="button" class="tm-icon-btn" id="tm-theme" aria-label="切换主题" title="切换主题"></button>' +
				'</div>' +
			'</header>' +
			'<main class="tm-content">' +
				'<div id="tm-alert-slot"></div>' +
				'<div class="tm-view" id="tm-view"></div>' +
			'</main>' +
			'<footer class="tm-footer" id="tm-footer"></footer>' +
		'</div>';

	sidebar = app.querySelector('#tm-sidebar-slot');
	mainEl = app.querySelector('.tm-main');
	topbarEl = app.querySelector('.tm-topbar');
	contentEl = app.querySelector('.tm-content');
	alertSlot = app.querySelector('#tm-alert-slot');
	viewRoot = app.querySelector('#tm-view');

	// Toast 容器：必须挂在 #tm-app 内部，否则拿不到主题变量
	toastHost = document.createElement('div');
	toastHost.className = 'tm-toast';
	overlayHost().appendChild(toastHost);

	paintSidebar();
	paintBreadcrumb();
	paintFooter();
	paintThemeBtn();
	return true;
}

function paintSidebar() {
	// readCollapsePref() 在未设置过时返回 false，因此这里的语义是：
	// 用户显式折叠过 → 折叠；否则 ≤1200px（平板/小笔记本）自动折叠（D2）
	const collapsed = readCollapsePref() || window.innerWidth <= 1200;
	sidebar.innerHTML = renderSidebar(S.view, { version: VERSION, collapsed: collapsed });
	/* renderSidebar 只把 collapsed 打在内部的 <aside id="tm-sidebar"> 上，
	   外层 slot 必须同步一份：主区左边距由兄弟选择器
	   #tm-sidebar-slot.collapsed ~ .tm-main 承担，少了它首屏就是折叠态时
	   侧边栏已经窄了、主区却还留在 220px 处，中间空出一档。 */
	sidebar.classList.toggle('collapsed', collapsed);
}

function paintBreadcrumb() {
	const slot = app.querySelector('#tm-breadcrumb-slot');
	if (slot) slot.innerHTML = renderBreadcrumb(S.view);
}

function paintFooter() {
	const f = app.querySelector('#tm-footer');
	if (!f) return;
	/* 版本号统一读 VERSION（包版本优先、前端资源版本兜底），
	   不再手写死数字，避免与 Makefile 脱钩 */
	f.innerHTML = 'TempMon v' + esc(VERSION) +
		' · 前端 v' + esc(VERSION) + '（原生 ES Module） · 数据目录 ' + esc((S.status && S.status.dir) || '/tmp/tempmon') +
		' · <a href="' + esc(DataStore.configUrl() || '#') + '">参数配置</a>';
}

function paintThemeBtn() {
	const b = app.querySelector('#tm-theme');
	if (!b) return;
	const mode = themeCtrl.getMode();
	b.innerHTML = themeCtrl.getThemeIcon(mode);
	b.title = '主题：' + themeCtrl.getModeLabel(mode) + '（点击切换）';
	b.setAttribute('aria-label', b.title);
}

/* ============================================================== Toast */

function toast(msg, type, ttl) {
	type = type || 'info';
	ttl = ttl || 3200;
	if (!toastHost) return;
	const iconName = type === 'ok' ? 'check' : type === 'err' ? 'danger' : type === 'warn' ? 'warn' : 'info';
	const el = document.createElement('div');
	el.className = 'tm-toast-item ' + type;
	el.innerHTML = icon(iconName, 16) + '<span>' + esc(msg) + '</span>';
	toastHost.appendChild(el);

	// 最多同时 4 条，超出移除最旧的，避免刷屏
	while (toastHost.children.length > 4) toastHost.removeChild(toastHost.firstChild);

	setTimeout(() => {
		el.classList.add('is-out');
		setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 200);
	}, ttl);
}

/* ============================================================ 数据装载 */

/**
 * 并行拉取指定数据键。
 * 单个键失败不会中断整体：错误记录在 S.errors，由视图决定降级展示。
 */
function load(keys, force) {
	const uniq = Array.from(new Set(ALWAYS.concat(keys || [])));
	S.loading = new Set(uniq);

	const jobs = uniq.map(k => {
		const fn = LOADERS[k];
		if (!fn) return Promise.resolve();
		return fn(force).then(res => {
			if (res && res.ok) {
				S[k] = res.data;
				delete S.errors[k];
				if (k === 'status') onStatus(res.data);
			} else {
				S.errors[k] = (res && res.error) || '请求失败';
				// 已有旧数据时保留，只提示；完全没数据才算致命
				if (S[k] == null) S[k] = null;
			}
		}).catch(err => {
			S.errors[k] = (err && err.message) || '未知错误';
		});
	});

	return Promise.all(jobs).then(() => { S.loading.clear(); });
}

/** status 到手后同步派生状态 */
function onStatus(st) {
	S.hidden = parseHide(st.hide || '');
	S.lastUpdate = Date.now();
	// 轮询周期跟随后端配置的采样间隔，但不低于 15s、不高于 5min
	const iv = Number(st.interval) || 60;
	pollMs = Math.min(300000, Math.max(15000, iv * 1000));
	updateStatusPill();
	updateUpdated();
	updateAlert();
	schedulePoll();
}

function updateStatusPill() {
	const pill = app.querySelector('#tm-status-pill');
	if (!pill) return;
	const st = S.status || {};
	const lv = alertLevel(st.alert);
	const dotCls = !st.daemon ? 'off' : lv === 'danger' ? 'err' : lv === 'warn' ? 'warn' : '';
	pill.innerHTML = '<span class="tm-dot ' + dotCls + '"></span>' +
		'<span class="txt">' + (st.daemon ? (lv === 'danger' ? '告警' : lv === 'warn' ? '警告' : '采集中') : '已停止') + '</span>';
	pill.setAttribute('data-tip', st.daemon
		? ('采集进程运行中，间隔 ' + (st.interval || '—') + ' 秒；告警级别 status.alert=' + (st.alert || 0))
		: '采集进程未运行，不会有新数据写入。可在「设置」页启动。');
}

/** E4：右上角「最后更新时间」指示（每秒由时钟刷新） */
function updateUpdated() {
	const el = app.querySelector('#tm-updated');
	if (!el) return;
	if (!S.lastUpdate) { el.innerHTML = ''; return; }
	const d = new Date(S.lastUpdate);
	const hh = String(d.getHours()).padStart(2, '0');
	const mm = String(d.getMinutes()).padStart(2, '0');
	const ss = String(d.getSeconds()).padStart(2, '0');
	el.innerHTML = '<b>' + hh + ':' + mm + ':' + ss + '</b> 更新 · ' + esc(fmtAgo(S.lastUpdate));
	el.setAttribute('data-tip',
		'最近一次成功从后端取到数据的时间。秒数持续增长且明显超过采样间隔，' +
		'说明请求失败或采集进程已停止。');
}

/* ======================================================= E2 告警横幅 */

function updateAlert() {
	if (!alertSlot) return;
	const st = S.status || {};
	const lv = Number(st.alert) || 0;

	if (lv === 0 || S.alertDismissed || !st.daemon) {
		if (alertSlot.innerHTML) alertSlot.innerHTML = '';
		// 采集停了也是一种需要用户知道的状态，但它不是温度告警，单独提示
		if (st.daemon === false && S.booted) {
			alertSlot.innerHTML = bannerHtml('warn', '采集服务已停止',
				'不会有新的数据点写入，图表停留在最后一次采样。可前往「设置」页重新启动。', false);
			bindBannerClose();
		}
		return;
	}

	const zones = st.zones || [];
	const p = (Array.isArray(st.last) && st.last.length) ? st.last : null;
	let maxV = null, maxName = '';
	if (p && Array.isArray(p[6])) {
		for (let i = 0; i < p[6].length; i++) {
			const v = Number(p[6][i]);
			if (isFinite(v) && (maxV === null || v > maxV)) { maxV = v; maxName = zones[i] || ('zone' + i); }
		}
	}

	const danger = lv === 2;
	alertSlot.innerHTML = bannerHtml(
		danger ? 'danger' : 'warn',
		danger ? '温度严重告警' : '温度警告',
		(maxV == null ? '后端判定温度已超过阈值' : ('当前最高 ' + maxV.toFixed(1) + ' °C（' + maxName + '）')) +
			' · 告警级别 status.alert=' + lv + ' · 阈值在 UCI 中配置，前端不另立规则',
		true);
	bindBannerClose();
}

function bannerHtml(cls, title, detail, closable) {
	const ico = cls === 'danger' ? 'danger' : cls === 'warn' ? 'warn' : 'info';
	return '<div class="tm-alert-banner ' + (cls === 'danger' ? 'danger' : '') + '" role="status">' +
		'<span class="tm-alert-icon">' + icon(ico, 20) + '</span>' +
		'<div class="tm-alert-text">' +
			'<div class="tm-alert-title">' + esc(title) + '</div>' +
			'<div class="tm-alert-detail">' + esc(detail) + '</div>' +
		'</div>' +
		'<button type="button" class="tm-btn tm-btn-xs" data-nav="sensors">' + icon('gauge', 14) + '查看详情</button>' +
		(closable ? '<button type="button" class="tm-alert-close" data-alert-close aria-label="关闭提示">' +
			icon('close', 16) + '</button>' : '') +
		'</div>';
}

function bindBannerClose() {
	const b = alertSlot.querySelector('[data-alert-close]');
	if (!b) return;
	b.addEventListener('click', () => {
		S.alertDismissed = true;
		alertSlot.innerHTML = '';
	});
}

/* ============================================================== 视图调度 */

function currentView() { return VIEWS[S.view] || OverviewView; }

/** 组装传给视图的上下文。phase 决定图表是否播放过渡动画 */
function ctxFor(phase) {
	const animate = phase !== 'poll';
	return {
		state: S,
		root: viewRoot,
		phase: phase,
		animate: animate,
		q: sel => viewRoot.querySelector(sel),
		chart: (el, cfg) => drawChart(el, cfg, animate),
		setRange: id => setRange(id),
		refresh: opts => refresh(opts),
		toast: (msg, type) => toast(msg, type),
		confirm: opts => showModal(opts),
		toggleHide: key => toggleHide(key),
		syncHide: str => { S.hidden = parseHide(str || ''); },
		exportUrl: () => DataStore.exportUrl(),
		configUrl: () => DataStore.configUrl(),
		actions: {
			service: op => DataStore.service(op),
			clearHistory: () => DataStore.clearHistory(),
			clearLogs: () => DataStore.clearLogs(),
			toggleHide: key => DataStore.toggleHide(key)
		}
	};
}

/**
 * 画图统一入口：
 *   · 轮询（animate=false）→ 复用实例、不播动画、**保留用户的缩放/平移状态**（B1）
 *   · 初次/切档（animate=true）→ draw() 复用实例并播放淡入 + 描边动画（C4）
 */
function drawChart(el, cfg, animate) {
	const lib = window.tempmonChart;
	if (!el) return null;
	if (!lib) {
		showEmpty(el, '图表组件未加载', 'chart.js 未能载入，请刷新页面；其余数据不受影响');
		return null;
	}
	const inst = lib.get(el);
	if (inst && !animate) {
		inst.setConfig(cfg, { animate: false, resetView: false });
		return inst;
	}
	return lib.draw(el, cfg);
}

/**
 * 回收已脱离 DOM 的图表实例。
 *
 * 为什么必须做：chart.js 把所有实例留在模块级 instances[] 里，而全量重渲染
 * （切页 / 切档位 / 切主题）会用 innerHTML 整体替换视图 DOM，旧容器连同其
 * SVG、ResizeObserver、动画定时器就变成不可达但被引用的垃圾。60s 轮询下
 * 这会持续累积——低端路由器上几十分钟就能感觉到卡顿，属于硬性性能约束。
 */
function pruneCharts() {
	const lib = window.tempmonChart;
	if (lib && lib.prune) { try { lib.prune(); } catch (e) { /* 图表库缺席时忽略 */ } }
}

/**
 * 替换视图根节点的 HTML，并立刻做两件收尾：
 *   1. 隐藏悬浮提示——旧元素被移除后不会再触发 mouseout，
 *      tooltip 层挂在 #tm-app 上不随视图销毁，会永久停在屏幕上；
 *   2. 回收被丢弃的图表实例（见 pruneCharts 说明）。
 * 所有「全量重渲染」都必须走这里，不要直接写 viewRoot.innerHTML。
 */
function setViewHtml(html) {
	hideTooltip();
	viewRoot.innerHTML = html;
	pruneCharts();
}

/** 视图对应的骨架屏（B2：区分「加载中」与「无数据」） */
function skeletonFor(viewId) {
	switch (viewId) {
		case 'overview':  return overviewSkeleton();
		case 'cpu':
		case 'memory':
		case 'storage':
		case 'network':
		case 'sensors':   return cardSkeleton(3) + chartSkeleton(280) + panelSkeleton({ rows: 3 });
		case 'procs':
		case 'logs':      return panelSkeleton({ rows: 2 }) + tableSkeleton(8, 5);
		case 'settings':  return panelSkeleton({ rows: 4 }) + panelSkeleton({ rows: 3 });
		default:          return loadingHtml('overview');
	}
}

/**
 * 切换视图：更新外壳 → 骨架屏 → 拉数据 → 渲染 → mount
 * @param {string} viewId
 * @param {string} phase 'nav' | 'initial'
 */
async function showView(viewId, phase) {
	const view = VIEWS[viewId] || OverviewView;
	S.view = view.id || viewId;

	// 外壳同步（标题 / 面包屑 / 侧边栏高亮）
	setActive(sidebar, S.view);
	updateBreadcrumb(app.querySelector('#tm-breadcrumb-slot'), S.view);
	const t = app.querySelector('#tm-page-title');
	if (t) t.textContent = labelOf(S.view);

	setViewHtml(skeletonFor(S.view));
	document.title = labelOf(S.view) + ' · TempMon';

	// 卸载旧视图（清理虚拟列表等持有的资源）
	const prev = VIEWS[S.prevView || ''];
	if (prev && prev !== view && prev.unmount) { try { prev.unmount(ctxFor('nav')); } catch (e) {} }
	S.prevView = S.view;

	await load(view.needs, false);

	// 致命错误：连 status 都拿不到，整个视图无从渲染
	if (S.errors.status && !S.status) {
		setViewHtml('');
		showErrorInto(viewRoot, S.errors.status, () => showView(S.view, 'nav'));
		return;
	}

	const ctx = ctxFor(phase || 'nav');
	try {
		setViewHtml(view.render(ctx));
		if (view.mount) view.mount(ctx);
	} catch (err) {
		console.error('[tempmon] 视图渲染失败:', S.view, err);
		setViewHtml('');
		showErrorInto(viewRoot, '页面渲染出错：' + ((err && err.message) || err), () => showView(S.view, 'nav'));
		return;
	}

	// 局部数据失败：不整页报错，只在页面顶部提示一次
	const partial = Object.keys(S.errors).filter(k => k !== 'status' && S.errors[k]);
	if (partial.length && phase !== 'poll') {
		toast('部分数据获取失败：' + partial.join('、'), 'warn', 4200);
	}
	S.booted = true;
}

function showErrorInto(container, message, onRetry) {
	container.innerHTML = '<div class="tm-panel"><div class="tm-panel-body">' +
		'<div class="tm-state tm-state--error">' +
			'<div class="tm-state-icon">' + icon('danger', 40) + '</div>' +
			'<div class="tm-state-title">数据加载失败</div>' +
			'<div class="tm-state-detail">' + esc(message) + '</div>' +
			'<button type="button" class="tm-btn primary" data-action="retry">' + icon('refresh', 14) + '重试</button>' +
		'</div></div></div>';
	const btn = container.querySelector('[data-action="retry"]');
	if (btn) {
		btn.addEventListener('click', () => {
			btn.disabled = true;
			btn.innerHTML = icon('refresh', 14) + '重试中…';
			onRetry();
		});
	}
}

function labelOf(viewId) {
	const list = router.getViews();
	for (const v of list) if (v.id === viewId) return v.label;
	return '系统概览';
}

/* ============================================================ 交互动作 */

/** 时间档位切换：重新拉 series/io，然后整视图重绘以播放图表过渡（C4） */
async function setRange(id) {
	if (!rangeSeconds(id) || id === S.range) return;
	S.range = id;
	// 立刻把标签高亮切过去，避免等待期间没有反馈
	for (const b of viewRoot.querySelectorAll('[data-range]')) {
		b.classList.toggle('active', b.getAttribute('data-range') === id);
	}
	await load(['series', 'io'], true);
	const view = currentView();
	const ctx = ctxFor('range');
	try {
		setViewHtml(view.render(ctx));
		if (view.mount) view.mount(ctx);
	} catch (err) {
		console.error('[tempmon] 切换档位后渲染失败:', err);
	}
}

/** 刷新：拉数据 → 走 patch 增量更新（不重建图表实例，缩放状态保留） */
async function refresh(opts) {
	opts = opts || {};
	const view = currentView();
	let keys = (view.needs || []).slice();
	for (const k of Object.keys(LOADERS)) if (opts[k]) keys.push(k);
	await load(keys, !!opts.force);
	const ctx = ctxFor('poll');
	try {
		if (view.patch) view.patch(ctx);
		else if (view.mount) view.mount(ctx);
	} catch (err) {
		console.error('[tempmon] 增量刷新失败:', err);
	}
	updateAlert();
	updateStatusPill();
	return { ok: !S.errors.status };
}

/** 卡片/面板隐藏：走后端 toggle，成功后以后端返回值为准 */
async function toggleHide(key) {
	if (HIDE_KEYS.indexOf(key) < 0) return;
	const res = await DataStore.toggleHide(key);
	if (res && res.ok) {
		S.hidden = parseHide((res.data && res.data.hide) || '');
		// 重新拉一次 status，保证 hide 字符串与后端 UCI 一致
		await load(['status'], true);
		const view = currentView();
		const ctx = ctxFor('nav');
		try {
			setViewHtml(view.render(ctx));
			if (view.mount) view.mount(ctx);
		} catch (err) {
			console.error('[tempmon] 切换显示项后渲染失败:', err);
		}
		toast((S.hidden.has(key) ? '已隐藏 ' : '已显示 ') + key, 'ok', 2000);
	} else {
		toast((res && res.error) || '设置失败', 'err');
	}
}

/* ============================================================ 轮询与时钟 */

function schedulePoll() {
	if (pollTimer) clearTimeout(pollTimer);
	pollTimer = setTimeout(async () => {
		pollTimer = null;
		// 页面不可见时不轮询，省电省流量（低端路由器友好）
		if (document.hidden) { schedulePoll(); return; }
		await refresh({});
		schedulePoll();
	}, pollMs);
}

function startClock() {
	if (clockTimer) clearInterval(clockTimer);
	clockTimer = setInterval(() => { updateUpdated(); }, 1000);
}

/* ============================================================ 全局事件 */

function bindGlobal() {
	/* 侧边栏：导航 / 折叠 / 遮罩 / Esc */
	/* 第三个参数是「折叠态已经变了」的回调，不是「请去折叠」的触发器。
	   bindSidebar 内部命中 [data-sidebar-collapse] 时**已经**调用过 toggleCollapse，
	   并把这个回调当作 cb 传进去；这里原先又调了一次 toggleCollapse，于是一次点击
	   变成「折叠 → 立刻展开」，净效果为零，表现就是按钮完全没反应。
	   折叠后的收尾工作全由别处承担，所以回调可以整个省略：
	     主区左边距 → CSS 的 #tm-sidebar-slot.collapsed ~ .tm-main
	     图表重排   → chart.js 内部的 ResizeObserver */
	bindSidebar(sidebar, viewId => {
		closeMobile(sidebar);
		if (viewId !== S.view) router.navigate(viewId);
	});

	const menuBtn = app.querySelector('[data-sidebar-open]');
	if (menuBtn) menuBtn.addEventListener('click', () => toggleMobile(sidebar));

	/* 面包屑 */
	bindBreadcrumb(app.querySelector('#tm-breadcrumb-slot'), viewId => router.navigate(viewId));

	/* 顶栏刷新 */
	const rb = app.querySelector('#tm-refresh');
	if (rb) {
		rb.addEventListener('click', async () => {
			rb.disabled = true;
			rb.classList.add('is-spinning');
			await refresh({ force: true });
			rb.classList.remove('is-spinning');
			rb.disabled = false;
			toast('已刷新', 'ok', 1600);
		});
	}

	/* 主题切换（三态循环：深色 → 浅色 → 自动） */
	const tb = app.querySelector('#tm-theme');
	if (tb) {
		tb.addEventListener('click', () => {
			const mode = themeCtrl.toggleMode();
			paintThemeBtn();
			toast('主题：' + themeCtrl.getModeLabel(mode), 'info', 1800);
		});
	}
	themeCtrl.onThemeChange(() => {
		paintThemeBtn();
		// 图表颜色取自 CSS 变量，主题变了需要重画一遍才能生效
		const view = currentView();
		if (view && viewRoot && viewRoot.children.length) {
			const ctx = ctxFor('nav');
			try {
				setViewHtml(view.render(ctx));
				if (view.mount) view.mount(ctx);
			} catch (e) { console.warn('[tempmon] 主题切换后重绘失败:', e); }
		}
	});

	/* 内容区事件委托：档位切换 / 卡片隐藏 / 导航 / 重试 */
	viewRoot.addEventListener('click', (e) => {
		const rangeBtn = e.target.closest('[data-range]');
		if (rangeBtn) { setRange(rangeBtn.getAttribute('data-range')); return; }

		const hideBtn = e.target.closest('[data-hide]');
		if (hideBtn) { toggleHide(hideBtn.getAttribute('data-hide')); return; }

		const navBtn = e.target.closest('[data-nav]');
		if (navBtn) { e.preventDefault(); router.navigate(navBtn.getAttribute('data-nav')); return; }
	});

	/* 告警横幅里的「查看详情」按钮（在 alertSlot，不在 viewRoot） */
	alertSlot.addEventListener('click', (e) => {
		const navBtn = e.target.closest('[data-nav]');
		if (navBtn) { e.preventDefault(); router.navigate(navBtn.getAttribute('data-nav')); }
	});

	/* Tooltip 全局委托（A6：字段解释） */
	bindTooltips(document);

	/* 路由变化 */
	router.onRouteChange((view, prev, userNav) => {
		S.alertDismissed = false;   // 换页后重新允许告警横幅出现
		showView(view, userNav ? 'nav' : 'initial');
	});

	/* 浏览器前进/后退由 router 内部的 popstate 监听统一处理，
	   它会以 userNav=false 回调 onRouteChange —— 这里不能再挂一个 popstate，
	   否则一次后退会触发两轮渲染。 */

	/* 从后台切回前台立刻刷新一次，避免看到过期数据 */
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden && S.booted) refresh({});
	});

	/* 窗口尺寸跨过布局阈值时重建侧边栏形态（D2）。
	   两个阈值都要盯：900px 决定抽屉，1200px 决定自动折叠 */
	let lastMode = layoutMode();
	window.addEventListener('resize', () => {
		const m = layoutMode();
		if (m === lastMode) return;
		const wasDrawer = lastMode === 'drawer';
		lastMode = m;

		paintSidebar();
		/* 这里不需要、也不能再调 bindSidebar()。
		   paintSidebar() 只替换 sidebar.innerHTML，slot 元素本身没被换掉，
		   而 bindSidebar 用的是事件委托（监听挂在 slot 上，点击时才 closest() 找目标），
		   所以委托天然存活。重复调用只会往 slot 上再挂一份 click、往 document 上
		   再挂一份 keydown，每跨一次断点就多一份，一次点击触发 N 次 toggle。
		   原先这里还照抄了 bindGlobal 里那个嵌套 toggleCollapse 的写法，
		   等于两处叠加，折叠按钮彻底不可能生效。 */
		setActive(sidebar, S.view);

		// 离开抽屉模式必须收掉遮罩，否则桌面端会残留一层半透明蒙版
		if (wasDrawer && m !== 'drawer') closeMobile(sidebar);
	}, { passive: true });
}

/**
 * 布局形态，与 app.css 的断点严格一致：
 *   ≤900px   drawer   抽屉 + 遮罩，主区不留左边距
 *   ≤1200px  compact  侧边栏自动折叠为图标条
 *   其余     desktop  侧边栏展开
 */
function layoutMode() {
	const w = window.innerWidth;
	if (w <= 900) return 'drawer';
	if (w <= 1200) return 'compact';
	return 'desktop';
}

/* ================================================================= 启动 */

async function boot() {
	if (!buildShell()) {
		console.error('[tempmon] 找不到 #tm-app 容器');
		return;
	}

	// 主题：先应用偏好，再监听系统变化（A4）
	themeCtrl.init(app);
	paintThemeBtn();

	bindGlobal();

	router.init();
	startClock();

	// 注意 getCurrentView() 返回的是视图定义对象，不是字符串
	const initial = router.getCurrentView().id;
	await showView(initial, 'initial');

	updateStatusPill();
	paintFooter();
}

if (document.readyState === 'loading') {
	document.addEventListener('DOMContentLoaded', boot);
} else {
	boot();
}
