/**
 * luci-app-tempmon — 进程视图
 *
 * 后端 api_procs 最多返回 20 条，但按需求 B5 一律走虚拟滚动：
 * 只渲染可视区行，DOM 节点数与数据量解耦，后端将来放宽上限也不会卡。
 *
 * 兼容两种返回形态：对象 {pid,name,cpu,mem,stat} 与原始数组行。
 */

import { esc, icon, fix, panel, tiles } from '../core/util.js';
import VirtualList, { PROCS_COLUMNS, PROCS_HEAD, procsRow, normalizeProc, procsTableHtml }
	from '../components/VirtualList.js';
import { showEmpty, showError } from '../components/Skeleton.js';

let list = null;

function rowsOf(ctx) {
	const raw = (ctx.state.procs && ctx.state.procs.procs) || ctx.state.procsList || [];
	return Array.isArray(raw) ? raw : [];
}

function summaryHtml(ctx) {
	const rows = rowsOf(ctx).map(normalizeProc);
	if (!rows.length) {
		return tiles([['进程数', '0'], ['CPU 最高', '—'], ['总占用', '—']]);
	}
	let cpuSum = 0, top = rows[0], topV = -1;
	for (const r of rows) {
		const v = parseFloat(r.cpu);
		if (isFinite(v)) {
			cpuSum += v;
			if (v > topV) { topV = v; top = r; }
		}
	}
	return tiles([
		['返回条数', rows.length + ' 条'],
		['CPU 最高', esc(String(top.name).slice(0, 18)) + ' · ' + (isFinite(topV) ? fix(topV, 1) + '%' : '—')],
		['列表 CPU 合计', fix(cpuSum, 1) + ' %'],
		['数据源', 'api_procs']
	]);
}

export default {
	id: 'procs',
	needs: ['status', 'procs'],

	render(ctx) {
		return '' +
			panel('资源占用排行',
				'<div class="tm-panel-body" id="proc-summary">' + summaryHtml(ctx) + '</div>' +
				'<div class="tm-panel-body tight" style="padding-top:0">' +
					'<div id="proc-list"></div>' +
				'</div>',
				{
					// 排序由后端 top 快照决定，前端不重排；措辞不能承诺前端行为
					subtitle: '由后端按 CPU 占用返回，单次最多 20 条',
					actions: '<button type="button" class="tm-btn" data-action="refresh-procs">' +
						icon('refresh', 14) + '刷新</button>'
				}) +
			'<div class="tm-note">' + icon('info', 14) +
				'<span><b>关于数值口径</b>：这里的 CPU% 来自 top/ps 的单次快照，' +
				'与概览页基于 /proc/stat 差值算出的总使用率不是同一口径，' +
				'数值可能有出入；进程列表用于定位「谁在占资源」，总量以概览页为准。' +
				'状态列 S=睡眠、R=运行、D=不可中断（通常在等 IO）、Z=僵尸。</span></div>';
	},

	mount(ctx) {
		this.buildList(ctx);
		const btn = ctx.q('[data-action="refresh-procs"]');
		if (btn) {
			btn.addEventListener('click', () => {
				btn.disabled = true;
				const old = btn.innerHTML;
				btn.innerHTML = icon('refresh', 14) + '刷新中…';
				ctx.refresh({ procs: true }).then(() => {
					btn.disabled = false;
					btn.innerHTML = old;
				});
			});
		}
	},

	/** 构建/更新虚拟列表 */
	buildList(ctx) {
		const host = ctx.q('#proc-list');
		if (!host) return;

		const rows = rowsOf(ctx);
		const sum = ctx.q('#proc-summary');
		if (sum) sum.innerHTML = summaryHtml(ctx);

		if (!rows.length) {
			if (list) { list.destroy(); list = null; }
			showEmpty(host, '暂无进程数据', '可能是采集进程未运行，或 top/ps 不可用');
			return;
		}

		// 复用已有实例：只换数据，不重建 DOM 结构，且保留用户当前滚动位置
		if (list && list.opts.container === host) {
			list.setItems(rows, true);
			return;
		}
		if (list) { list.destroy(); list = null; }

		try {
			list = new VirtualList({
				container: host,
				items: rows,
				renderRow: procsRow,
				rowHeight: 38,
				maxHeight: 460,
				overscan: 8,
				columns: PROCS_COLUMNS,
				head: PROCS_HEAD,
				// 窄屏下保持列宽，靠横向滚动而不是压扁内容（D4）
				minWidth: 520
			});
		} catch (e) {
			// 兜底：虚拟列表异常时退回普通表格，功能不丢
			console.error('[tempmon] 进程虚拟列表初始化失败，退回普通表格:', e);
			host.innerHTML = procsTableHtml(rows);
		}
	},

	patch(ctx) { this.buildList(ctx); },

	unmount() {
		if (list) { list.destroy(); list = null; }
	}
};
