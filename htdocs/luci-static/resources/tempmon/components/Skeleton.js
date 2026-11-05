/**
 * luci-app-tempmon — Skeleton / 状态占位（B2）
 *
 * 明确区分三种状态，取代原先只有一句「加载中…」：
 *   loading → 骨架屏（有形状，减少布局跳动）
 *   error   → 错误说明 + 重试按钮
 *   empty   → 空数据提示（后端没采到点 / 全部卡片被隐藏）
 */

import { icon } from '../core/util.js';

/* ------------------------------------------------------------ 骨架片段 */

/** 单块骨架 */
function sk(cls, style) {
	return '<div class="tm-skeleton ' + (cls || '') + '"' + (style ? ' style="' + style + '"' : '') + '></div>';
}

/** 指标卡骨架 */
export function cardSkeleton(count) {
	const n = count || 1;
	let out = '';
	for (let i = 0; i < n; i++) {
		out += '<div class="tm-card tm-card--skeleton">' +
			'<header class="tm-card-header">' + sk('tm-skeleton-icon') + sk('tm-skeleton-text short') + '</header>' +
			sk('tm-skeleton-value') +
			sk('tm-skeleton-spark') +
			sk('tm-skeleton-text medium') +
			'</div>';
	}
	return '<div class="tm-grid tm-grid-5">' + out + '</div>';
}

/** 面板骨架（含标题条与内容区） */
export function panelSkeleton(opts) {
	opts = opts || {};
	const rows = opts.rows || 3;
	let body = '';
	for (let i = 0; i < rows; i++) {
		const w = i % 3 === 2 ? 'medium' : 'long';
		body += sk('tm-skeleton-text ' + w);
	}
	return '<section class="tm-panel tm-panel--skeleton">' +
		'<header class="tm-panel-header">' + sk('tm-skeleton-text short') + '</header>' +
		'<div class="tm-skeleton-body">' + body + '</div></section>';
}

/** 图表骨架 */
export function chartSkeleton(height) {
	return '<section class="tm-panel tm-panel--skeleton">' +
		'<header class="tm-panel-header">' + sk('tm-skeleton-text short') + '</header>' +
		'<div class="tm-skeleton-chart" style="height:' + (height || 280) + 'px"></div></section>';
}

/** 表格骨架 */
export function tableSkeleton(rows, cols) {
	const r = rows || 5, c = cols || 4;
	let out = '';
	for (let i = 0; i < r; i++) {
		let cells = '';
		for (let j = 0; j < c; j++) cells += sk('tm-skeleton-cell');
		out += '<div class="tm-skeleton-row">' + cells + '</div>';
	}
	return '<div class="tm-skeleton-table">' + out + '</div>';
}

/**
 * 概览页整页骨架（卡片 + 两张图表 + 面板）
 */
export function overviewSkeleton() {
	return cardSkeleton(5) +
		'<div class="tm-grid tm-grid-2">' + chartSkeleton(280) + chartSkeleton(280) + '</div>' +
		panelSkeleton({ rows: 4 });
}

/* ------------------------------------------------------------- 状态展示 */

/** 加载态：骨架优先，无法确定结构时退化为 spinner */
export function loadingHtml(type) {
	switch (type) {
		case 'overview': return overviewSkeleton();
		case 'cards': return cardSkeleton(4);
		case 'chart': return chartSkeleton();
		case 'panel': return panelSkeleton();
		case 'table': return tableSkeleton();
		default:
			return '<div class="tm-loading"><span class="tm-spinner" aria-hidden="true"></span>' +
				'<span>正在加载数据…</span></div>';
	}
}

/** 错误态（含重试按钮） */
export function errorHtml(message, detail) {
	return '<div class="tm-state tm-state--error">' +
		'<span class="tm-state-icon">' + icon('danger', 40) + '</span>' +
		'<div class="tm-state-title">' + (message || '数据加载失败') + '</div>' +
		(detail ? '<div class="tm-state-detail">' + detail + '</div>' : '') +
		'<button type="button" class="tm-btn primary" data-action="retry">' + icon('refresh', 14) + '重试</button>' +
		'</div>';
}

/** 空数据态 */
export function emptyHtml(message, hint) {
	return '<div class="tm-state tm-state--empty">' +
		'<span class="tm-state-icon">' + icon('inbox', 40) + '</span>' +
		'<div class="tm-state-title">' + (message || '暂无数据') + '</div>' +
		(hint ? '<div class="tm-state-detail">' + hint + '</div>' : '') +
		'</div>';
}

/* ------------------------------------------------------------- 命令式 API */

/** 在容器内显示加载态 */
export function showLoading(container, type) {
	if (!container) return;
	container.innerHTML = loadingHtml(type);
}

/** 在容器内显示错误态，并把 data-action="retry" 绑到 onRetry */
export function showError(container, message, onRetry, detail) {
	if (!container) return;
	container.innerHTML = errorHtml(message, detail);
	const btn = container.querySelector('[data-action="retry"]');
	if (btn && typeof onRetry === 'function') {
		btn.addEventListener('click', function once() {
			btn.disabled = true;
			btn.textContent = '重试中…';
			onRetry();
		});
	}
}

/** 在容器内显示空数据态 */
export function showEmpty(container, message, hint) {
	if (!container) return;
	container.innerHTML = emptyHtml(message, hint);
}

export default {
	cardSkeleton, panelSkeleton, chartSkeleton, tableSkeleton, overviewSkeleton,
	loadingHtml, errorHtml, emptyHtml, showLoading, showError, showEmpty
};
