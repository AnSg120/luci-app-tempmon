/**
 * luci-app-tempmon — CPU 视图
 *
 * 内容：使用率多序列趋势（总量 / user / sys / iowait）、负载曲线、
 *       每核负载条、频率与负载明细。
 * 数据源：api_status.last + api_data.points（p[1] 总量、p[2] 每核、
 *         p[3] 频率 kHz、p[4] 负载、p[8] user/sys/iowait）。
 */

import {
	esc, icon, axisNum, fix, fmtFreq, fmtUp, kvList, panel, rangeTabs, tiles
} from '../core/util.js';
import { metricCardGrid, cardProgress } from '../components/MetricCard.js';
import { showEmpty } from '../components/Skeleton.js';

const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
const cpuLevel = v => { const n = Number(v) || 0; return n >= 90 ? 'danger' : n >= 75 ? 'warn' : 'ok'; };

function lastPoint(ctx) {
	const s = ctx.state.status;
	if (s && Array.isArray(s.last) && s.last.length) return s.last;
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return pts.length ? pts[pts.length - 1] : null;
}

function cardsHtml(ctx) {
	const p = lastPoint(ctx);
	const st = ctx.state.status || {};
	// model / kernel 在 api_sys 上，api_status 里没有（容易踩的坑）
	const sys = ctx.state.sys || {};
	if (!p) return '<div class="tm-empty"><span class="tm-empty-text">暂无采样数据</span></div>';

	const split = Array.isArray(p[8]) ? p[8] : [];
	const load = Array.isArray(p[4]) ? p[4] : [];
	const cores = Array.isArray(p[2]) ? p[2] : [];

	// 找出最忙的核心，单核长期打满往往意味着单线程瓶颈
	let hotIdx = -1, hotVal = -1;
	for (let i = 0; i < cores.length; i++) {
		const v = Number(cores[i]) || 0;
		if (v > hotVal) { hotVal = v; hotIdx = i; }
	}

	return metricCardGrid([
		{
			icon: 'cpu', tone: 'blue', title: 'CPU 总使用率',
			value: fix(p[1], 1), unit: '%', level: cpuLevel(p[1]),
			sub: (st.cores || cores.length || '—') + ' 核' + (sys.model ? ' · ' + esc(sys.model) : ''),
			tip: 'cpu'
		},
		{
			icon: 'activity', tone: 'green', title: '用户态',
			value: fix(split[0], 1), unit: '%', level: 'ok',
			sub: '普通进程消耗', tip: 'cpu_user'
		},
		{
			icon: 'server', tone: 'purple', title: '内核态',
			value: fix(split[1], 1), unit: '%', level: cpuLevel(split[1]),
			sub: '系统调用 / 中断', tip: 'cpu_sys'
		},
		{
			icon: 'database', tone: 'orange', title: 'IO 等待',
			value: fix(split[2], 1), unit: '%',
			// iowait 高说明卡在存储而不是算力，单独给更敏感的阈值
			level: (Number(split[2]) || 0) >= 30 ? 'danger' : (Number(split[2]) || 0) >= 15 ? 'warn' : 'ok',
			sub: '磁盘瓶颈指标', tip: 'cpu_iowait'
		},
		{
			icon: 'gauge', tone: 'cyan', title: '当前频率',
			value: fmtFreq(p[3]), unit: '', level: 'ok',
			sub: '温控或节能可能导致降频', tip: 'cpu_freq'
		},
		{
			icon: 'proc', tone: 'red', title: '负载 (1m)',
			value: fix(load[0], 2), unit: '',
			// 负载与核心数比较才有意义
			level: (st.cores && Number(load[0]) > st.cores * 1.5) ? 'danger'
				: (st.cores && Number(load[0]) > st.cores) ? 'warn' : 'ok',
			sub: hotIdx >= 0 ? ('最忙 Core' + hotIdx + ' ' + fix(hotVal, 1) + '%') : '—',
			tip: 'load_avg'
		}
	], ctx.state.hidden, 'tm-grid-3');
}

/** CPU 使用率多序列图 */
function usageCfg(ctx) {
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return {
		title: 'CPU 使用率',
		points: pts,
		series: [
			{ label: '总使用率', color: 'var(--tm-c-blue)', thick: true, fill: true, get: p => num(p[1]) },
			{ label: '用户态', color: 'var(--tm-c-green)', get: p => (p[8] ? num(p[8][0]) : null) },
			{ label: '内核态', color: 'var(--tm-c-purple)', get: p => (p[8] ? num(p[8][1]) : null) },
			{ label: 'IO 等待', color: 'var(--tm-c-orange)', dashed: true, get: p => (p[8] && p[8].length > 2 ? num(p[8][2]) : null) }
		],
		yFmt: (v, step) => axisNum(v, step, '%'),
		empty: '暂无历史数据'
	};
}

/** 负载曲线图 */
function loadCfg(ctx) {
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return {
		title: '系统负载',
		points: pts,
		series: [
			{ label: '1 分钟', color: 'var(--tm-c-red)', thick: true, fill: true, get: p => (p[4] ? num(p[4][0]) : null) },
			{ label: '5 分钟', color: 'var(--tm-c-orange)', get: p => (p[4] ? num(p[4][1]) : null) },
			{ label: '15 分钟', color: 'var(--tm-c-yellow)', dashed: true, get: p => (p[4] ? num(p[4][2]) : null) }
		],
		yFmt: v => (Math.round(v * 100) / 100).toString(),
		yZero: true,
		empty: '暂无负载数据'
	};
}

/** 每核负载条 */
function coresHtml(ctx) {
	const p = lastPoint(ctx);
	const cores = (p && Array.isArray(p[2])) ? p[2] : [];
	if (!cores.length) {
		return '<div class="tm-note">' + icon('info', 14) +
			'<span>该设备的 /proc/stat 未提供每核明细，只有汇总数据。</span></div>';
	}
	return cores.map((c, i) => {
		const v = Number(c) || 0;
		return '<div class="tm-core-row">' +
			'<span class="tm-core-name">Core' + i + '</span>' +
			cardProgress(v, cpuLevel(v)) +
			'<span class="tm-core-val">' + fix(v, 1) + '%</span></div>';
	}).join('');
}

function detailHtml(ctx) {
	const p = lastPoint(ctx);
	const st = ctx.state.status || {};
	const sys = ctx.state.sys || {};
	if (!p) return emptyNote('暂无采样数据');

	const split = Array.isArray(p[8]) ? p[8] : [];
	const load = Array.isArray(p[4]) ? p[4] : [];
	const idle = (p[1] != null) ? (100 - Number(p[1])) : null;

	return tiles([
		['空闲', fix(idle, 1) + ' %', 'cpu_idle'],
		['频率', fmtFreq(p[3]), 'cpu_freq'],
		['负载 1m', fix(load[0], 2), 'load_avg'],
		['负载 5m', fix(load[1], 2)],
		['负载 15m', fix(load[2], 2)],
		['运行时长', fmtUp(p[10]), 'uptime']
	]) + '<div style="margin-top:var(--tm-space-md)">' + kvList([
		['设备型号', esc(sys.model || '—'), 'model'],
		['核心数', st.cores != null ? st.cores : '—'],
		['内核版本', esc(sys.kernel || '—'), 'kernel'],
		['主机名', esc(sys.host || '—')],
		['采集间隔', (st.interval || '—') + ' 秒', 'interval']
	]) + '</div>';
}

function emptyNote(msg) {
	return '<div class="tm-empty"><span class="tm-empty-text">' + esc(msg) + '</span></div>';
}

export default {
	id: 'cpu',
	needs: ['status', 'series', 'sys'],

	render(ctx) {
		return '' +
			'<div id="cpu-cards">' + cardsHtml(ctx) + '</div>' +
			panel('使用率与负载趋势',
				'<div class="tm-panel-body">' +
					'<div class="tm-grid tm-grid-2">' +
						'<div class="tm-chart-box" id="cpu-chart-usage"></div>' +
						'<div class="tm-chart-box" id="cpu-chart-load"></div>' +
					'</div>' +
				'</div>',
				{
					subtitle: '点击图例可开关序列',
					actions: '<div id="cpu-range">' + rangeTabs(ctx.state.range, 'cpu') + '</div>'
				}) +
			'<div class="tm-grid tm-grid-21">' +
				panel('每核负载', '<div class="tm-panel-body" id="cpu-cores">' + coresHtml(ctx) + '</div>',
					{ subtitle: '判断负载是否集中在单线程' }) +
				panel('明细', '<div class="tm-panel-body" id="cpu-detail">' + detailHtml(ctx) + '</div>') +
			'</div>';
	},

	mount(ctx) { this.paint(ctx); },
	patch(ctx) { this.paint(ctx); },

	paint(ctx) {
		const set = (sel, html) => { const el = ctx.q(sel); if (el) el.innerHTML = html; };
		set('#cpu-cards', cardsHtml(ctx));
		set('#cpu-cores', coresHtml(ctx));
		set('#cpu-detail', detailHtml(ctx));

		const pts = (ctx.state.series && ctx.state.series.points) || [];
		const u = ctx.q('#cpu-chart-usage');
		const l = ctx.q('#cpu-chart-load');
		if (pts.length) {
			if (u) ctx.chart(u, usageCfg(ctx));
			if (l) ctx.chart(l, loadCfg(ctx));
		} else {
			if (u) showEmpty(u, '暂无历史数据', '采集服务启动后约 1 分钟开始出图');
			if (l) showEmpty(l, '暂无负载数据');
		}
	}
};
