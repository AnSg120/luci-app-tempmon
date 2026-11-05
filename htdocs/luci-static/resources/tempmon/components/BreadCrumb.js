/**
 * luci-app-tempmon — BreadCrumb 面包屑（B3）
 *
 * 关键约束：链接地址必须来自 router.urlFor()。
 * 后端只注册了 dashboard|cpu|memory|storage|network|procs|logs|settings|config，
 * 直接拼 `/admin/tempmon/overview` 会在刷新时 404 —— 这个坑必须绕开。
 */

import { router } from '../core/router.js';
import { esc, icon } from '../core/util.js';

/** 分组中文名，与 SidebarNav 保持一致 */
const GROUP_LABELS = { monitor: '监控', manage: '管理' };

/**
 * 渲染面包屑 HTML
 * @param {string} viewId 当前视图 id
 * @param {Object} [opts] { root: 自定义根名称 }
 */
export function renderBreadcrumb(viewId, opts) {
	opts = opts || {};
	const view = router.getViews().find(v => v.id === viewId);
	const rootName = opts.root || 'TempMon';

	const parts = [];

	// 根节点：指向概览（overview → /dashboard，刷新不会 404）
	parts.push('<a class="tm-breadcrumb-item" href="' + esc(router.urlFor('overview')) +
		'" data-nav="overview">' + esc(rootName) + '</a>');

	if (view) {
		const gl = GROUP_LABELS[view.group];
		if (gl && view.id !== 'overview') {
			parts.push('<span class="tm-breadcrumb-group">' + esc(gl) + '</span>');
		}
		if (view.id === 'overview') {
			parts.push('<span class="tm-breadcrumb-current" aria-current="page">' + esc(view.label) + '</span>');
		} else {
			parts.push('<span class="tm-breadcrumb-current" aria-current="page">' + esc(view.label) + '</span>');
		}
	}

	return '<nav class="tm-breadcrumb" aria-label="面包屑导航">' +
		parts.join('<span class="tm-breadcrumb-sep" aria-hidden="true">' + icon('chevronRight', 12) + '</span>') +
		'</nav>';
}

/**
 * 绑定面包屑点击：拦截 <a>，改走 SPA 路由（不整页刷新）
 * @param {HTMLElement} container 含面包屑的容器（通常顶栏）
 * @param {Function} onNavigate (viewId) => void
 */
export function bindBreadcrumb(container, onNavigate) {
	if (!container) return () => {};

	const onClick = (e) => {
		const a = e.target.closest && e.target.closest('a[data-nav]');
		if (!a) return;
		e.preventDefault();
		const id = a.getAttribute('data-nav');
		if (typeof onNavigate === 'function') onNavigate(id);
		else router.navigate(id);
	};

	container.addEventListener('click', onClick);
	return () => container.removeEventListener('click', onClick);
}

/** 就地更新面包屑（路由变化时调用，避免重绘整个顶栏） */
export function updateBreadcrumb(container, viewId, opts) {
	if (!container) return;
	const nav = container.querySelector('.tm-breadcrumb');
	if (nav) nav.outerHTML = renderBreadcrumb(viewId, opts);
	else container.insertAdjacentHTML('afterbegin', renderBreadcrumb(viewId, opts));
}

export default { renderBreadcrumb, bindBreadcrumb, updateBreadcrumb };
