/**
 * luci-app-tempmon — ModalConfirm 模态确认框（A5）
 *
 * 替代原生 window.confirm：原生弹窗在 LuCI 页面里风格突兀，且会阻塞主线程。
 *
 * 特性：
 *   - 返回 Promise<boolean>，可 await
 *   - 同一时刻只允许一个弹窗，后来的排队（避免叠层导致焦点混乱）
 *   - Esc / 点击遮罩 = 取消；确认按钮自动聚焦；Tab 焦点在弹窗内循环
 *   - type: confirm | danger | warning | info，图标与主按钮配色随之变化
 */

import { esc, icon, overlayHost } from '../core/util.js';

const queue = [];
let active = null;

const TYPE_META = {
	confirm: { icon: 'info', tone: 'info', title: '确认操作', ok: '确认' },
	danger: { icon: 'danger', tone: 'err', title: '危险操作', ok: '确定执行' },
	warning: { icon: 'warn', tone: 'warn', title: '请注意', ok: '我知道了' },
	info: { icon: 'info', tone: 'info', title: '提示', ok: '确定' }
};

/**
 * 打开确认框
 * @param {Object} opts
 *   title       标题
 *   message     正文（纯文本，会被转义）
 *   html        正文（允许 HTML，优先于 message；仅用于内部可信内容）
 *   confirmText 确认按钮文案
 *   cancelText  取消按钮文案
 *   type        confirm | danger | warning | info
 *   hideCancel  只保留一个按钮（等价于 alert）
 * @returns {Promise<boolean>}
 */
export function showModal(opts) {
	return new Promise((resolve) => {
		queue.push({ opts: opts || {}, resolve });
		if (!active) next();
	});
}

function next() {
	const item = queue.shift();
	if (!item) { active = null; return; }
	active = item;
	open(item);
}

function open(item) {
	const o = item.opts;
	const meta = TYPE_META[o.type] || TYPE_META.confirm;

	const overlay = document.createElement('div');
	overlay.className = 'tm-modal-overlay';
	overlay.setAttribute('role', 'presentation');

	const body = o.html != null ? o.html : esc(o.message || '');

	overlay.innerHTML =
		'<div class="tm-modal tm-modal--' + meta.tone + '" role="dialog" aria-modal="true" aria-label="' + esc(o.title || meta.title) + '">' +
			'<header class="tm-modal-header">' +
				'<span class="tm-modal-icon tone-' + meta.tone + '">' + icon(meta.icon, 20) + '</span>' +
				'<h3 class="tm-modal-title">' + esc(o.title || meta.title) + '</h3>' +
				'<button type="button" class="tm-icon-btn tm-modal-close" data-act="cancel" aria-label="关闭">' + icon('close', 16) + '</button>' +
			'</header>' +
			'<div class="tm-modal-body">' + body + '</div>' +
			'<footer class="tm-modal-footer">' +
				(o.hideCancel ? '' : '<button type="button" class="tm-btn" data-act="cancel">' + esc(o.cancelText || '取消') + '</button>') +
				'<button type="button" class="tm-btn ' + (meta.tone === 'err' ? 'danger' : 'primary') + '" data-act="ok">' +
					esc(o.confirmText || meta.ok) + '</button>' +
			'</footer>' +
		'</div>';

	// 挂到 #tm-app 内部才能继承主题 CSS 变量（见 util.overlayHost 注释）
	overlayHost().appendChild(overlay);

	// 记录触发前的焦点，关闭后还原（无障碍）
	const prevFocus = document.activeElement;
	let done = false;

	function finish(result) {
		if (done) return;
		done = true;
		overlay.classList.add('is-closing');
		document.removeEventListener('keydown', onKey, true);
		// 等出场动画结束再移除；动画被禁用时也能正常清理
		setTimeout(() => {
			if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
			document.body.classList.remove('tm-modal-open');
			if (prevFocus && prevFocus.focus) { try { prevFocus.focus(); } catch (e) { /* ignore */ } }
			item.resolve(result);
			active = null;
			next();
		}, 160);
	}

	function onKey(e) {
		if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); return; }
		if (e.key === 'Enter') {
			// Enter 直接确认，但焦点在取消键上时除外
			if (document.activeElement && document.activeElement.getAttribute('data-act') === 'cancel') return;
			e.preventDefault();
			finish(true);
			return;
		}
		// Tab 焦点陷阱
		if (e.key === 'Tab') {
			const f = overlay.querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
			if (!f.length) return;
			const first = f[0], last = f[f.length - 1];
			if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
			else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
		}
	}

	overlay.addEventListener('click', (e) => {
		const act = e.target.closest && e.target.closest('[data-act]');
		if (act) {
			finish(act.getAttribute('data-act') === 'ok');
			return;
		}
		// 点击遮罩空白处 = 取消（危险操作也允许，避免误触卡死）
		if (e.target === overlay) finish(false);
	});

	document.addEventListener('keydown', onKey, true);
	document.body.classList.add('tm-modal-open');

	// 默认聚焦主按钮；危险操作聚焦取消，降低误删风险
	const target = overlay.querySelector(meta.tone === 'err' && !o.hideCancel ? '[data-act="cancel"]' : '[data-act="ok"]');
	if (target) setTimeout(() => { try { target.focus(); } catch (e) { /* ignore */ } }, 30);

	// 暴露给外部强制关闭（如路由跳转）
	item.close = () => finish(false);
}

/** 关闭当前弹窗（路由切换等场景调用，防止遗留遮罩） */
export function closeActive() {
	if (active && typeof active.close === 'function') active.close();
}

/* ------------------------------------------------------------- 语义封装 */

/** 普通确认 */
export function confirm(message, title) {
	return showModal({ type: 'confirm', title: title || '确认操作', message });
}

/** 危险操作（清空历史、清空日志等）：红色按钮 + 默认聚焦取消 */
export function danger(message, title, confirmText) {
	return showModal({ type: 'danger', title: title || '危险操作', message, confirmText: confirmText || '确定执行' });
}

/** 警告提示（单按钮） */
export function warning(message, title) {
	return showModal({ type: 'warning', title: title || '请注意', message, hideCancel: true, confirmText: '知道了' });
}

/** 信息提示（单按钮），用于替代 alert */
export function alertBox(message, title) {
	return showModal({ type: 'info', title: title || '提示', message, hideCancel: true, confirmText: '确定' });
}

export default {
	show: showModal,
	confirm,
	danger,
	warning,
	alert: alertBox,
	closeActive
};
