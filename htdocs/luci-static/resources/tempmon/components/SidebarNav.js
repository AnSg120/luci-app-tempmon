/**
 * luci-app-tempmon — SidebarNav 侧边栏导航
 *
 * D2：桌面默认展开；≤1200px 自动收窄为图标栏；≤900px 变为抽屉 + 遮罩。
 * A2：图标统一走 core/util.js 的 icon()，不再内联硬编码字符串。
 * B2：分组从 router 读取（monitor / manage），修复 sensors 被错分到「管理」的问题。
 */

import { router } from '../core/router.js';
import { esc, escAttr, icon } from '../core/util.js';

/** 分组标题（顺序即渲染顺序） */
const GROUPS = [
	{ id: 'monitor', label: '监控' },
	{ id: 'manage', label: '管理' }
];

/**
 * LuCI 管理根路径。
 * 本页用 CSS 隐藏了 Argon 主题的左菜单（见 app.css 第 0 节：自建 shell 需要
 * 独占视口，否则 fixed 侧边栏会整块压住它），所以侧边栏必须自己提供回到 LuCI
 * 其他页面与退出登录的入口，否则这一页就成了没有出口的孤岛。
 * 从 TM_API.base（形如 /cgi-bin/luci/admin/tempmon）反推，不硬编码 LuCI 前缀。
 */
const API = window.TM_API || {};
const ADMIN_ROOT = String(API.base || '/cgi-bin/luci/admin/tempmon').replace(/\/tempmon\/?$/, '');

/**
 * 侧边栏底部的「LuCI」分组。
 * 用 <a> 而不是 button + data-nav：它们是真正的整页跳转，不该被 SPA 路由拦截。
 * 用 .tm-nav-item 而不是放进 .tm-sidebar-foot：后者在折叠态是
 * opacity:0 + pointer-events:none，逃生口必须在任何状态下都点得到。
 */
function luciLinks() {
	const items = [
		{ href: ADMIN_ROOT + '/status', name: 'external', label: '返回 LuCI', tip: '回到 LuCI 状态页（本页已隐藏 LuCI 左菜单）' },
		{ href: ADMIN_ROOT + '/logout', name: 'logout', label: '退出登录', tip: '退出 LuCI 登录' }
	];
	return '<div class="tm-nav-group" data-group="luci">' +
		'<div class="tm-nav-label">LuCI</div>' +
		items.map(it =>
			'<a class="tm-nav-item" href="' + escAttr(it.href) + '" title="' + escAttr(it.tip) + '">' +
			'<span class="tm-nav-icon">' + icon(it.name, 18) + '</span>' +
			'<span class="tm-nav-text">' + esc(it.label) + '</span>' +
			'</a>'
		).join('') +
		'</div>';
}

/**
 * 渲染侧边栏 HTML
 * @param {string} currentView 当前视图 id
 * @param {Object} [opts] { version, collapsed }
 */
export function renderSidebar(currentView, opts) {
	opts = opts || {};
	const collapsed = !!opts.collapsed;

	const nav = GROUPS.map(g => {
		const items = router.getViewsByGroup(g.id);
		if (!items.length) return '';
		return '<div class="tm-nav-group" data-group="' + g.id + '">' +
			'<div class="tm-nav-label">' + esc(g.label) + '</div>' +
			items.map(v =>
				'<button type="button" class="tm-nav-item' + (v.id === currentView ? ' active' : '') + '"' +
				' data-nav="' + esc(v.id) + '" title="' + esc(v.label) + '"' +
				' aria-current="' + (v.id === currentView ? 'page' : 'false') + '">' +
				'<span class="tm-nav-icon">' + icon(v.icon || 'activity', 18) + '</span>' +
				'<span class="tm-nav-text">' + esc(v.label) + '</span>' +
				'</button>'
			).join('') +
			'</div>';
	}).join('');

	return '' +
		// 初始不带 hidden：隐藏态由 CSS 的 visibility/pointer-events 承担，
		// 这样 openMobile 加 .show 时 opacity 过渡才会真正执行
		'<div class="tm-sidebar-mask" data-sidebar-mask></div>' +
		'<aside class="tm-sidebar' + (collapsed ? ' collapsed' : '') + '" id="tm-sidebar">' +
			'<div class="tm-sidebar-head">' +
				'<span class="tm-logo">' + icon('activity', 20) + '</span>' +
				'<span class="tm-brand">' +
					'<span class="tm-brand-name">TempMon</span>' +
					'<span class="tm-brand-sub">系统资源监控</span>' +
				'</span>' +
				// 桌面端折叠开关；移动端由顶栏汉堡键接管
				'<button type="button" class="tm-icon-btn tm-sidebar-toggle" data-sidebar-collapse' +
				' title="折叠侧边栏" aria-label="折叠侧边栏">' + icon('panelLeft', 16) + '</button>' +
			'</div>' +
			'<nav class="tm-nav">' + nav + luciLinks() + '</nav>' +
			(opts.version
				? '<div class="tm-sidebar-foot"><span class="tm-nav-text">v' + esc(opts.version) + '</span></div>'
				: '') +
		'</aside>';
}

/**
 * 绑定导航事件（事件委托，视图切换后无需重绑）
 * @param {HTMLElement} shell 包含侧边栏与遮罩的容器
 * @param {Function} onNavigate (viewId) => void
 * @param {Function} [onToggleCollapse] (collapsed:boolean) => void
 */
export function bindSidebar(shell, onNavigate, onToggleCollapse) {
	if (!shell) return () => {};

	const onClick = (e) => {
		const navBtn = e.target.closest && e.target.closest('[data-nav]');
		if (navBtn) {
			const id = navBtn.getAttribute('data-nav');
			closeMobile(shell);
			if (typeof onNavigate === 'function') onNavigate(id);
			return;
		}
		if (e.target.closest && e.target.closest('[data-sidebar-collapse]')) {
			toggleCollapse(shell, onToggleCollapse);
			return;
		}
		if (e.target.closest && e.target.closest('[data-sidebar-mask]')) {
			closeMobile(shell);
		}
	};

	// Esc 关闭移动端抽屉
	const onKey = (e) => {
		if (e.key === 'Escape') closeMobile(shell);
	};

	shell.addEventListener('click', onClick);
	document.addEventListener('keydown', onKey);

	return function unbind() {
		shell.removeEventListener('click', onClick);
		document.removeEventListener('keydown', onKey);
	};
}

/** 高亮当前视图（路由变化时调用，避免整块重绘侧边栏） */
export function setActive(shell, viewId) {
	if (!shell) return;
	const items = shell.querySelectorAll('[data-nav]');
	for (let i = 0; i < items.length; i++) {
		const on = items[i].getAttribute('data-nav') === viewId;
		items[i].classList.toggle('active', on);
		items[i].setAttribute('aria-current', on ? 'page' : 'false');
	}
}

/** 桌面端折叠/展开 */
export function toggleCollapse(shell, cb) {
	const sb = shell.querySelector('#tm-sidebar');
	if (!sb) return false;
	const collapsed = !sb.classList.contains('collapsed');
	sb.classList.toggle('collapsed', collapsed);
	/* 同一个类必须同步打到外层 shell（#tm-sidebar-slot）上。
	   .tm-sidebar 的父节点是 slot，而 .tm-main 的父节点是 #tm-app，两者并不同级，
	   所以 CSS 里 .tm-sidebar.collapsed ~ .tm-main 这个兄弟选择器永远匹配不上——
	   折叠后侧边栏窄了、主区却不左移，中间空出一档。
	   现改由 #tm-sidebar-slot.collapsed ~ .tm-main 承担，故这里两边都要打。 */
	if (shell !== sb) shell.classList.toggle('collapsed', collapsed);
	try { localStorage.setItem('tm-sidebar-collapsed', collapsed ? '1' : '0'); } catch (e) { /* 隐私模式忽略 */ }
	if (typeof cb === 'function') cb(collapsed);
	return collapsed;
}

/** 读取用户上次的折叠偏好 */
export function readCollapsePref() {
	try { return localStorage.getItem('tm-sidebar-collapsed') === '1'; } catch (e) { return false; }
}

/** 移动端：打开抽屉（顶栏汉堡键调用） */
export function openMobile(shell) {
	const sb = shell && shell.querySelector('#tm-sidebar');
	const mask = shell && shell.querySelector('[data-sidebar-mask]');
	if (sb) sb.classList.add('open');
	// 遮罩靠 .show 切换 opacity/visibility，不能用 hidden——那样过渡不会执行
	if (mask) { mask.hidden = false; mask.classList.add('show'); }
	document.body.classList.add('tm-sidebar-open');
}

/** 移动端：关闭抽屉 */
export function closeMobile(shell) {
	const sb = shell && shell.querySelector('#tm-sidebar');
	const mask = shell && shell.querySelector('[data-sidebar-mask]');
	if (sb) sb.classList.remove('open');
	if (mask) mask.classList.remove('show');
	document.body.classList.remove('tm-sidebar-open');
}

/** 移动端：开关切换 */
export function toggleMobile(shell) {
	const sb = shell && shell.querySelector('#tm-sidebar');
	if (!sb) return;
	if (sb.classList.contains('open')) closeMobile(shell); else openMobile(shell);
}

export default {
	renderSidebar, bindSidebar, setActive,
	toggleCollapse, readCollapsePref, openMobile, closeMobile, toggleMobile
};
