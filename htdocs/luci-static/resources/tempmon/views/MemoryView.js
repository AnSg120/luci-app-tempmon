/**
 * luci-app-tempmon — 内存视图
 *
 * 数据源：api_mem（total/free/avail/buffers/cached/swap_*，单位 kB）
 *         + api_data.points[5] = [总量, 空闲, 可用]（kB）用于趋势。
 *
 * 重点解释 MemAvailable 与 MemFree 的区别（A6）：路由器上 MemFree 常年很低
 * 是正常的，因为内核把空闲内存拿去做页缓存了；真正能判断压力的是 MemAvailable。
 */

import { esc, icon, axisNum, fix, fmtKB, pct, kvList, panel, rangeTabs, donutSVG, legendList } from '../core/util.js';
import { metricCardGrid, cardProgress } from '../components/MetricCard.js';
import { showEmpty } from '../components/Skeleton.js';

const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
const memLevel = v => { const n = Number(v) || 0; return n >= 92 ? 'danger' : n >= 80 ? 'warn' : 'ok'; };

function cardsHtml(ctx) {
	const m = ctx.state.mem;
	const st = ctx.state.status || {};
	const p = (st.last && st.last.length) ? st.last : null;

	// api_mem 优先；不可用时退回采样点里的三元组
	const total = m && m.total ? Number(m.total) : (p && p[5] ? Number(p[5][0]) : 0);
	const free = m && m.free != null ? Number(m.free) : (p && p[5] ? Number(p[5][1]) : 0);
	const avail = m && m.avail != null ? Number(m.avail) : (p && p[5] ? Number(p[5][2]) : 0);
	const buffers = m ? Number(m.buffers) || 0 : 0;
	const cached = m ? Number(m.cached) || 0 : 0;
	const swapTotal = m ? Number(m.swap_total) || 0 : 0;
	const swapFree = m ? Number(m.swap_free) || 0 : 0;

	if (!total) return '<div class="tm-empty"><span class="tm-empty-text">暂无内存数据</span></div>';

	const used = Math.max(0, total - avail);
	const usedPct = pct(used, total);
	const swapUsed = Math.max(0, swapTotal - swapFree);
	const swapPct = swapTotal > 0 ? pct(swapUsed, swapTotal) : 0;

	return metricCardGrid([
		{
			icon: 'mem', tone: 'purple', title: '内存占用',
			value: fix(usedPct, 1), unit: '%', level: memLevel(usedPct),
			sub: fmtKB(used) + ' / ' + fmtKB(total),
			foot: cardProgress(usedPct), tip: 'mem_used'
		},
		{
			icon: 'check', tone: 'green', title: '可用 (Avail)',
			value: fmtKB(avail), unit: '', level: 'ok',
			sub: '新进程还能拿到 ' + fix(pct(avail, total), 1) + '%',
			tip: 'mem_available'
		},
		{
			icon: 'inbox', tone: 'cyan', title: '完全空闲 (Free)',
			value: fmtKB(free), unit: '', level: 'ok',
			sub: '这个值偏低是正常的', tip: 'mem_free'
		},
		{
			icon: 'database', tone: 'blue', title: 'Buffers',
			value: fmtKB(buffers), unit: '', level: 'ok',
			sub: '块设备缓冲，可回收', tip: 'mem_buffers'
		},
		{
			icon: 'store', tone: 'orange', title: 'Cached',
			value: fmtKB(cached), unit: '', level: 'ok',
			sub: '页缓存，加速文件读取', tip: 'mem_cached'
		},
		{
			icon: 'activity', tone: swapTotal > 0 && swapPct > 50 ? 'red' : 'green', title: 'Swap 使用',
			value: swapTotal > 0 ? fmtKB(swapUsed) : '未启用',
			unit: swapTotal > 0 ? (' / ' + fmtKB(swapTotal)) : '',
			level: swapTotal > 0 ? (swapPct >= 80 ? 'danger' : swapPct >= 40 ? 'warn' : 'ok') : 'ok',
			sub: swapTotal > 0
				? ('已用 ' + fix(swapPct, 1) + '%')
				: '路由器通常不配置交换分区',
			foot: swapTotal > 0 ? cardProgress(swapPct) : '',
			tip: 'swap_free'
		}
	], ctx.state.hidden, 'tm-grid-3');
}

/** 使用率趋势（%） */
function usageCfg(ctx) {
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return {
		title: '内存使用率',
		points: pts,
		series: [{
			label: '已用 %', color: 'var(--tm-c-purple)', thick: true, fill: true,
			get: p => (p[5] && p[5][0]) ? pct(p[5][0] - p[5][2], p[5][0]) : null
		}],
		yFmt: (v, step) => axisNum(v, step, '%'),
		empty: '暂无历史数据'
	};
}

/** Avail vs Free（MB）：直观展示两者差距 */
function composeCfg(ctx) {
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return {
		title: '可用与空闲',
		points: pts,
		series: [
			{ label: '可用 Avail', color: 'var(--tm-c-green)', thick: true, fill: true, get: p => (p[5] ? num(p[5][2]) / 1024 : null) },
			{ label: '空闲 Free', color: 'var(--tm-c-cyan)', dashed: true, get: p => (p[5] ? num(p[5][1]) / 1024 : null) }
		],
		yFmt: (v, step) => axisNum(v, step, 'M'),
		yZero: true,
		empty: '暂无历史数据'
	};
}

function donutHtml(ctx) {
	const m = ctx.state.mem;
	const st = ctx.state.status || {};
	const p = (st.last && st.last.length) ? st.last : null;
	const total = m && m.total ? Number(m.total) : (p && p[5] ? Number(p[5][0]) : 0);
	if (!total) return '<div class="tm-empty"><span class="tm-empty-text">暂无内存数据</span></div>';

	const avail = m && m.avail != null ? Number(m.avail) : (p && p[5] ? Number(p[5][2]) : 0);
	const buffers = m ? Number(m.buffers) || 0 : 0;
	const cached = m ? Number(m.cached) || 0 : 0;
	const used = Math.max(0, total - avail);
	// 应用占用 = 已用 − buffers − cached（cached 有一部分本就计入 avail，取正即可）
	const apps = Math.max(0, used - buffers - cached);

	return '<div class="tm-donut-container">' +
		donutSVG([
			[apps, 'var(--tm-c-purple)', '应用占用'],
			[buffers, 'var(--tm-c-blue)', 'Buffers'],
			[cached, 'var(--tm-c-cyan)', 'Cached'],
			[avail, 'var(--tm-ok)', '可用']
		], fix(pct(used, total), 1) + '%', '已用 / ' + fmtKB(total), 180) +
		legendList([
			['var(--tm-c-purple)', '应用占用', fmtKB(apps) + ' · ' + fix(pct(apps, total), 1) + '%'],
			['var(--tm-c-blue)', 'Buffers', fmtKB(buffers)],
			['var(--tm-c-cyan)', 'Cached', fmtKB(cached)],
			['var(--tm-ok)', '可用 Avail', fmtKB(avail) + ' · ' + fix(pct(avail, total), 1) + '%']
		]) + '</div>';
}

function detailHtml(ctx) {
	const m = ctx.state.mem;
	const st = ctx.state.status || {};
	const p = (st.last && st.last.length) ? st.last : null;
	const total = m && m.total ? Number(m.total) : (p && p[5] ? Number(p[5][0]) : 0);
	if (!total) return '<div class="tm-empty"><span class="tm-empty-text">暂无数据</span></div>';

	const free = m && m.free != null ? Number(m.free) : (p && p[5] ? Number(p[5][1]) : 0);
	const avail = m && m.avail != null ? Number(m.avail) : (p && p[5] ? Number(p[5][2]) : 0);
	const buffers = m ? Number(m.buffers) || 0 : 0;
	const cached = m ? Number(m.cached) || 0 : 0;
	const swapTotal = m ? Number(m.swap_total) || 0 : 0;
	const swapFree = m ? Number(m.swap_free) || 0 : 0;
	const used = Math.max(0, total - avail);

	return kvList([
		['总量 MemTotal', fmtKB(total) + ' (' + total + ' kB)', 'mem_total'],
		['已用（总量−可用）', fmtKB(used) + ' · ' + fix(pct(used, total), 1) + '%', 'mem_used'],
		['可用 MemAvailable', fmtKB(avail) + ' · ' + fix(pct(avail, total), 1) + '%', 'mem_available'],
		['空闲 MemFree', fmtKB(free) + ' · ' + fix(pct(free, total), 1) + '%', 'mem_free'],
		['Buffers', fmtKB(buffers), 'mem_buffers'],
		['Cached', fmtKB(cached), 'mem_cached'],
		['Swap 总量', swapTotal > 0 ? fmtKB(swapTotal) : '未启用', 'swap_total'],
		['Swap 剩余', swapTotal > 0 ? fmtKB(swapFree) : '未启用', 'swap_free']
	]);
}

export default {
	id: 'memory',
	needs: ['status', 'series', 'mem'],

	render(ctx) {
		return '' +
			'<div id="mem-cards">' + cardsHtml(ctx) + '</div>' +
			panel('内存趋势',
				'<div class="tm-panel-body">' +
					'<div class="tm-grid tm-grid-2">' +
						'<div class="tm-chart-box" id="mem-chart-usage"></div>' +
						'<div class="tm-chart-box" id="mem-chart-compose"></div>' +
					'</div>' +
				'</div>',
				{
					subtitle: '右图对比 Avail 与 Free，差距越大说明缓存利用越充分',
					actions: '<div id="mem-range">' + rangeTabs(ctx.state.range, 'mem') + '</div>'
				}) +
			'<div class="tm-grid tm-grid-21">' +
				panel('构成', '<div class="tm-panel-body" id="mem-donut">' + donutHtml(ctx) + '</div>') +
				panel('明细', '<div class="tm-panel-body" id="mem-detail">' + detailHtml(ctx) + '</div>',
					{ subtitle: '单位统一为 kB 换算后的可读值' }) +
			'</div>' +
			'<div class="tm-note">' + icon('info', 14) +
				'<span><b>怎么判断内存吃紧？</b>看 <b>MemAvailable</b>，不要看 MemFree。' +
				'Linux 会主动把空闲内存用作页缓存来加速文件读写，所以 MemFree 常年偏低是健康表现；' +
				'MemAvailable 已经把「可回收的缓存」算进去了，它才是新进程真正能拿到的内存。' +
				'只有当 Swap 开始被持续使用、或 MemAvailable 逼近 0 时才需要担心。</span></div>';
	},

	mount(ctx) { this.paint(ctx); },
	patch(ctx) { this.paint(ctx); },

	paint(ctx) {
		const set = (sel, html) => { const el = ctx.q(sel); if (el) el.innerHTML = html; };
		set('#mem-cards', cardsHtml(ctx));
		set('#mem-donut', donutHtml(ctx));
		set('#mem-detail', detailHtml(ctx));

		const pts = (ctx.state.series && ctx.state.series.points) || [];
		const u = ctx.q('#mem-chart-usage');
		const c = ctx.q('#mem-chart-compose');
		if (pts.length) {
			if (u) ctx.chart(u, usageCfg(ctx));
			if (c) ctx.chart(c, composeCfg(ctx));
		} else {
			if (u) showEmpty(u, '暂无历史数据');
			if (c) showEmpty(c, '暂无历史数据');
		}
	}
};
