/**
 * luci-app-tempmon — 日志视图
 *
 * 保留 v3.0 全部能力：关键字搜索、6 个分类过滤、级别着色、清空日志。
 * 变化点（B5）：原先 60 条/页翻页 + 一次性塞满 DOM，
 *   现改为对**全部过滤结果**做虚拟滚动 —— 所有条目都可达，且 DOM 只保留可视行。
 *
 * 分类判定规则与原版 logCat 逐字一致，避免过滤行为回归。
 * 后端 api_logs 返回 [day, time, tag, msg]，且正则丢弃了年份；
 * 未匹配的行会是 ["","","sys",原文]。
 */

import { esc, icon, panel } from '../core/util.js';
import VirtualList, { LOGS_COLUMNS, LOGS_HEAD, logsRow } from '../components/VirtualList.js';
import { showEmpty, showError } from '../components/Skeleton.js';
import { danger as confirmDanger } from '../components/ModalConfirm.js';

const CATS = [
	['all', '全部'], ['internal', '内核'], ['system', '系统'],
	['network', '网络'], ['service', '服务'], ['other', '其他']
];

/** 跨视图切换保留过滤条件（与原版 LOGSTATE 行为一致） */
const state = { cat: 'all', q: '' };

let list = null;

/** 原版分类逻辑，原样保留 */
function logCat(line) {
	const s = ((line[2] || '') + ' ' + (line[3] || '')).toLowerCase();
	if (/kern|kernel|mtd|upgrade|hotplug/.test(s)) return 'internal';
	if (/dnsmasq|hostapd|netifd|firewall|conntrack|odhcpd|wan|lan|wwan/.test(s)) return 'network';
	if (/rpcd|uhttpd|tempmon|dropbear|cron|ntpd|system|uci/.test(s)) return 'system';
	if (/service|init|procd/.test(s)) return 'service';
	return 'other';
}

function linesOf(ctx) {
	const l = ctx.state.logs;
	if (!l) return [];
	return Array.isArray(l.lines) ? l.lines : [];
}

function filtered(ctx) {
	const q = state.q.trim().toLowerCase();
	return linesOf(ctx).filter(l => {
		if (state.cat !== 'all' && logCat(l) !== state.cat) return false;
		if (q && String(l[3] || '').toLowerCase().indexOf(q) < 0) return false;
		return true;
	});
}

/** 各分类命中数，用于在标签上显示计数 */
function catCounts(ctx) {
	const lines = linesOf(ctx);
	const out = { all: lines.length, internal: 0, system: 0, network: 0, service: 0, other: 0 };
	for (const l of lines) out[logCat(l)]++;
	return out;
}

function tabsHtml(ctx) {
	const c = catCounts(ctx);
	return '<div class="tm-tabs" id="log-cats" role="tablist">' +
		CATS.map(([id, label]) =>
			'<button type="button" role="tab" class="tm-tab' + (state.cat === id ? ' active' : '') +
			'" data-cat="' + id + '" aria-selected="' + (state.cat === id) + '">' +
			esc(label) + ' <b style="opacity:.65;font-weight:500">' + (c[id] || 0) + '</b></button>'
		).join('') + '</div>';
}

export default {
	id: 'logs',
	needs: ['status', 'logs'],

	render(ctx) {
		return panel('系统日志',
			'<div class="tm-panel-body">' +
				'<div class="tm-log-filter">' +
					'<div id="log-tabs">' + tabsHtml(ctx) + '</div>' +
					'<label class="tm-search">' + icon('search', 14) +
						'<input type="search" class="tm-input" id="log-q" placeholder="搜索日志内容…" ' +
						'value="' + esc(state.q) + '" autocomplete="off" spellcheck="false">' +
					'</label>' +
				'</div>' +
				'<div class="tm-pager" id="log-count" style="justify-content:flex-start;padding:8px 0"></div>' +
				'<div id="log-list"></div>' +
			'</div>',
			{
				subtitle: '来自 logread 最近 300 行；后端不返回年份，时间为「月 日 时:分:秒」',
				actions:
					'<button type="button" class="tm-btn" data-action="refresh-logs">' + icon('refresh', 14) + '刷新</button>' +
					'<button type="button" class="tm-btn danger" data-action="clear-logs">' + icon('trash', 14) + '清空日志</button>'
			});
	},

	mount(ctx) {
		this.paint(ctx);

		/* 分类切换 */
		const tabs = ctx.q('#log-cats');
		if (tabs) {
			tabs.addEventListener('click', (e) => {
				const b = e.target.closest('[data-cat]');
				if (!b) return;
				state.cat = b.getAttribute('data-cat');
				// 只更新标签高亮与列表，不重建整个面板（保住搜索框焦点）
				for (const el of tabs.querySelectorAll('[data-cat]')) {
					const on = el === b;
					el.classList.toggle('active', on);
					el.setAttribute('aria-selected', on ? 'true' : 'false');
				}
				this.refreshList(ctx);
			});
		}

		/* 搜索：input 即时过滤（虚拟列表下代价极低） */
		const q = ctx.q('#log-q');
		if (q) {
			q.addEventListener('input', () => {
				state.q = q.value || '';
				this.refreshList(ctx);
			});
		}

		/* 刷新 */
		const rb = ctx.q('[data-action="refresh-logs"]');
		if (rb) {
			rb.addEventListener('click', () => {
				rb.disabled = true;
				ctx.refresh({ logs: true }).then(() => { rb.disabled = false; });
			});
		}

		/* 清空日志：后端会 restart log 服务，属危险操作，必须二次确认 */
		const cb = ctx.q('[data-action="clear-logs"]');
		if (cb) {
			cb.addEventListener('click', async () => {
				const ok = await confirmDanger(
					'将重启系统日志服务并清空 logread 缓冲区，此操作不可撤销。' +
					'（不影响温度历史 CSV 数据）',
					'清空系统日志', '确定清空');
				if (!ok) return;
				cb.disabled = true;
				const res = await ctx.actions.clearLogs();
				cb.disabled = false;
				if (res && res.ok) {
					ctx.toast('日志缓冲区已清空', 'ok');
					ctx.refresh({ logs: true, status: true });
				} else {
					ctx.toast((res && res.error) || '清空失败', 'err');
				}
			});
		}
	},

	/**
	 * 重新计算过滤结果并喂给虚拟列表
	 * @param {boolean} keepScroll 后台刷新保留滚动位置；改过滤条件时回到顶部
	 */
	refreshList(ctx, keepScroll) {
		const host = ctx.q('#log-list');
		const counter = ctx.q('#log-count');
		if (!host) return;

		const rows = filtered(ctx);
		const total = linesOf(ctx).length;

		if (counter) {
			const filtering = state.cat !== 'all' || !!state.q;
			// 0 命中必须分清「本来就没日志」和「过滤条件太窄」，
			// 否则计数会和下方空态自相矛盾（空态说没有匹配，计数却说共 300 条）
			counter.innerHTML = rows.length
				? '显示 <b>' + rows.length + '</b> / ' + total + ' 条' +
				  (filtering ? ' （已过滤，虚拟滚动查看全部）' : '')
				: (filtering && total
					? '匹配 <b>0</b> / ' + total + ' 条'
					: '共 <b>' + total + '</b> 条');
		}

		if (!rows.length) {
			if (list) { list.destroy(); list = null; }
			showEmpty(host, total ? '没有匹配的日志' : '暂无日志',
				total ? '试试更换分类或清空搜索关键字' : 'logread 缓冲区为空，或采集服务未运行');
			return;
		}

		if (list && list.opts.container === host) {
			list.setItems(rows, !!keepScroll);
			return;
		}
		if (list) { list.destroy(); list = null; }

		list = new VirtualList({
			container: host,
			items: rows,
			renderRow: logsRow,
			rowHeight: 30,
			maxHeight: 480,
			overscan: 12,
			columns: LOGS_COLUMNS,
			head: LOGS_HEAD,
			minWidth: 560
		});
	},

	paint(ctx) {
		const tabs = ctx.q('#log-tabs');
		if (tabs) tabs.innerHTML = tabsHtml(ctx);
		if (ctx.state.logsError) {
			const host = ctx.q('#log-list');
			if (host) showError(host, '日志读取失败', () => ctx.refresh({ logs: true }), esc(ctx.state.logsError));
			return;
		}
		this.refreshList(ctx);
	},

	patch(ctx) {
		// 搜索框绝不重绘（重绘会丢焦点、打断用户输入）；
		// 但列表与计数必须跟上最新数据，否则「刷新」按钮等于没生效。
		const tabs = ctx.q('#log-tabs');
		if (tabs && document.activeElement !== ctx.q('#log-q')) tabs.innerHTML = tabsHtml(ctx);
		this.refreshList(ctx, true);
	},

	unmount() {
		if (list) { list.destroy(); list = null; }
	}
};
