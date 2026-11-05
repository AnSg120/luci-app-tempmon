/**
 * luci-app-tempmon — 系统概览视图
 *
 * 保留 v3.0 全部信息与交互，并按新架构重排：
 *   - 6 张指标卡（各自带 HIDE_KEYS，可单独隐藏）
 *   - 图表面板（panel_charts）：温度趋势 + CPU/负载趋势
 *   - CPU 明细（panel_cpu_detail）：每核负载、user/sys/iowait、频率
 *   - 内存与存储（panel_mem_storage）：环形图 + 明细
 *   - 网络接口（panel_ifaces）
 *
 * 数据全部来自既有接口，未新增任何后端字段：
 *   api_status.last 为最新一个采样点，与 history points 同构。
 */

import {
	esc, icon, axisNum, fmtRate, fmtKB, fmtB, fmtUp, fmtFreq, fix, pct,
	rangeTabs, kvList, donutSVG, legendList, panel,
	seriesVals, netTotal, wanIdxs, roleClass,
	cpuLevel, memLevel, storeLevel, alertLevel
} from '../core/util.js';
import { metricCardGrid, cardProgress, sparkSVG } from '../components/MetricCard.js';
import { showEmpty } from '../components/Skeleton.js';

/* 展示阈值（纯前端着色用；后端告警仍以 status.alert 为准） */
const TEMP_WARN = 75;
const TEMP_CRIT = 85;

/* ------------------------------------------------------------ 区块构建器 */

/** 最新采样点：优先 status.last，回退到 history 末点 */
function lastPoint(ctx) {
	const s = ctx.state.status;
	if (s && Array.isArray(s.last) && s.last.length) return s.last;
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return pts.length ? pts[pts.length - 1] : null;
}

/** 6 张指标卡 */
function cardsHtml(ctx) {
	const st = ctx.state.status || {};
	const p = lastPoint(ctx);
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	const hidden = ctx.state.hidden;
	const zones = st.zones || [];

	// 温度取各路最大值（最能反映风险）
	let tempMax = null, tempZone = '';
	if (p && Array.isArray(p[6])) {
		for (let i = 0; i < p[6].length; i++) {
			const v = Number(p[6][i]);
			if (isFinite(v) && (tempMax === null || v > tempMax)) {
				tempMax = v;
				tempZone = zones[i] || ('zone' + i);
			}
		}
	}

	const memP = (p && p[5] && p[5][0]) ? pct(p[5][0] - p[5][2], p[5][0]) : null;
	const stP = (p && p[9] && p[9][0]) ? pct(p[9][0] - p[9][1], p[9][0]) : null;
	const down = p ? netTotal(p, 0, st) : null;
	const up = p ? netTotal(p, 1, st) : null;
	const cpu = p ? Number(p[1]) : null;

	const alertLv = alertLevel(st.alert);

	const cards = [
		{
			key: 'card_temp',
			icon: 'thermometer',
			tone: alertLv === 'danger' ? 'red' : alertLv === 'warn' ? 'orange' : 'green',
			title: '最高温度',
			value: tempMax == null ? '—' : fix(tempMax, 1),
			unit: '°C',
			// 后端 alert 是权威告警信号，前端只做展示，不另立规则
			level: alertLv,
			/* 副标题绝不能写具体阈值数字：temp_warn / temp_crit 不由任何接口返回，
			   真机上完全可能被改过——实测这台设备是 60/70，而这里曾硬写「阈值 75/85°C」，
			   等于当着用户的面报错参数。改为直接转述后端判定结果，
			   因为 alert 正是后端用真实阈值算出来的。 */
			sub: tempMax == null ? '未读到传感器'
				: (tempZone + ' · 后端判定：' + (alertLv === 'danger' ? '严重' : alertLv === 'warn' ? '警告' : '正常')),
			spark: seriesVals(pts, 'temp', st),
			sparkOpts: { warn: TEMP_WARN, crit: TEMP_CRIT, color: 'var(--tm-c-orange)' },
			tip: '传感器温度（°C）。告警级别取自后端 status.alert，前端不额外增加规则。' +
				'迷你图里的橙/红区段按后端默认阈值 ' + TEMP_WARN + '/' + TEMP_CRIT + '°C 标注，仅供参考：' +
				'真实阈值存在 UCI（tempmon.core.temp_warn / temp_crit），任何接口都不返回它。'
		},
		{
			key: 'card_cpu',
			icon: 'cpu',
			tone: 'blue',
			title: 'CPU 使用率',
			value: cpu == null ? '—' : fix(cpu, 1),
			unit: '%',
			level: cpuLevel(cpu),
			sub: (p && p[4] && p[4].length)
				? ('负载 ' + fix(p[4][0], 2) + ' / ' + fix(p[4][1], 2) + ' / ' + fix(p[4][2], 2))
				: (st.cores ? (st.cores + ' 核') : ''),
			spark: seriesVals(pts, 'cpu', st),
			sparkOpts: { warn: 75, crit: 90, color: 'var(--tm-c-blue)' },
			tip: 'CPU 总使用率，由相邻两次 /proc/stat 差值算出。负载为 1/5/15 分钟平均值。'
		},
		{
			key: 'card_mem',
			icon: 'mem',
			tone: 'purple',
			title: '内存占用',
			value: memP == null ? '—' : fix(memP, 1),
			unit: '%',
			level: memLevel(memP),
			sub: (p && p[5]) ? (fmtKB(p[5][0] - p[5][2]) + ' / ' + fmtKB(p[5][0])) : '',
			foot: memP == null ? '' : cardProgress(memP),
			spark: seriesVals(pts, 'mem', st),
			sparkOpts: { warn: 80, crit: 92, color: 'var(--tm-c-purple)' },
			tip: '已用内存 = 总量 − MemAvailable。MemAvailable 含可回收缓存，比 MemFree 更能反映真实压力。'
		},
		{
			key: 'card_storage',
			icon: 'store',
			tone: 'cyan',
			title: '根分区占用',
			value: stP == null ? '—' : fix(stP, 1),
			unit: '%',
			level: storeLevel(stP),
			sub: (p && p[9]) ? ('剩余 ' + fmtKB(p[9][1])) : '',
			foot: stP == null ? '' : cardProgress(stP),
			spark: seriesVals(pts, 'store', st),
			sparkOpts: { warn: 80, crit: 92, color: 'var(--tm-c-cyan)' },
			tip: 'OverlayFS 根分区使用率。写满会导致配置无法保存、服务异常，需重点关注。'
		},
		{
			key: 'card_net',
			icon: 'net',
			tone: 'green',
			title: 'WAN 下行',
			value: down == null ? '—' : fmtRate(down),
			unit: '',
			level: 'ok',
			sub: '上行 ' + (up == null ? '—' : fmtRate(up)),
			spark: seriesVals(pts, 'netd', st),
			sparkOpts: { color: 'var(--tm-c-green)' },
			tip: 'WAN 口实时速率，由所有 role=WAN 的接口累加得到。累计流量见「网络」页。'
		},
		{
			key: 'card_uptime',
			icon: 'clock',
			tone: 'orange',
			title: '运行时长',
			value: (p && p[10]) ? fmtUp(p[10]) : '—',
			unit: '',
			level: st.daemon ? 'ok' : 'warn',
			sub: '采集' + (st.daemon ? '运行中' : '已停止') +
				' · ' + (st.lines != null ? st.lines : pts.length) + ' 点' +
				' · 间隔 ' + (st.interval || '—') + 's',
			tip: '系统连续运行时长。采集进程停止后不再写入新数据，图表会停在最后一次采样。'
		}
	];

	return metricCardGrid(cards, hidden, 'tm-grid-3');
}

/** 图表面板：温度 + CPU（panel_charts） */
function chartsHtml(ctx) {
	const st = ctx.state.status || {};
	const zones = st.zones || [];
	return panel('趋势图表',
		'<div class="tm-panel-body">' +
			'<div class="tm-grid tm-grid-2">' +
				'<div class="tm-chart-box" id="ov-chart-temp"></div>' +
				'<div class="tm-chart-box" id="ov-chart-cpu"></div>' +
			'</div>' +
		'</div>',
		{
			id: 'panel-charts',
			// 缩放/平移/复位的操作提示由图表工具栏自己给出（触屏下还会自动隐藏），
			// 副标题再写一遍就是同一句话在同一屏出现两次
			subtitle: zones.length ? (zones.length + ' 路传感器') : '',
			actions: '<div id="ov-range-tabs">' + rangeTabs(ctx.state.range, 'ov') + '</div>'
		});
}

/** 温度图配置 */
function tempChartCfg(ctx) {
	const st = ctx.state.status || {};
	const zones = st.zones || [];
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	const palette = window.tempmonChart ? window.tempmonChart.palette : ['var(--tm-c-orange)'];

	const series = (zones.length ? zones : [0]).map((z, i) => ({
		label: typeof z === 'string' ? z : ('zone' + i),
		color: palette[i % palette.length],
		thick: i === 0,
		fill: i === 0,
		get: (p) => (p[6] && p[6][i] != null) ? Number(p[6][i]) : null
	}));

	return {
		title: '温度趋势',
		points: pts,
		series: series,
		yFmt: (v, step) => axisNum(v, step, '°'),
		empty: '暂无温度数据（设备可能没有可用传感器）'
	};
}

/** CPU 图配置：总使用率 + iowait */
function cpuChartCfg(ctx) {
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return {
		title: 'CPU 趋势',
		points: pts,
		series: [
			{ label: 'CPU 使用率', color: 'var(--tm-c-blue)', thick: true, fill: true, get: p => num(p[1]) },
			{
				label: 'IO 等待', color: 'var(--tm-c-orange)', dashed: true,
				get: p => (p[8] && p[8].length > 2) ? num(p[8][2]) : null
			}
		],
		yFmt: (v, step) => axisNum(v, step, '%'),
		empty: '暂无历史数据'
	};
}

function num(v) { const n = Number(v); return isFinite(n) ? n : null; }

/** CPU 明细面板（panel_cpu_detail） */
function cpuDetailHtml(ctx) {
	const st = ctx.state.status || {};
	const p = lastPoint(ctx);
	if (!p) return '<div class="tm-panel-body">' + emptyBlock('暂无采样数据') + '</div>';

	const cores = Array.isArray(p[2]) ? p[2] : [];
	const split = Array.isArray(p[8]) ? p[8] : [];

	let bars = '';
	if (cores.length) {
		bars = cores.map((c, i) => {
			const v = Number(c) || 0;
			const lv = cpuLevel(v);
			return '<div class="tm-core-row">' +
				'<span class="tm-core-name">Core' + i + '</span>' +
				cardProgress(v, lv) +
				'<span class="tm-core-val">' + fix(v, 1) + '%</span></div>';
		}).join('');
	} else {
		bars = '<div class="tm-note">' + icon('info', 14) +
			'<span>该设备未提供每核数据（/proc/stat 只有汇总行）。</span></div>';
	}

	return '<div class="tm-panel-body">' +
		'<div class="tm-grid tm-grid-21">' +
			'<div>' + bars + '</div>' +
			'<div>' + kvList([
				['用户态', fix(split[0], 1) + ' %', 'cpu_user'],
				['内核态', fix(split[1], 1) + ' %', 'cpu_sys'],
				['IO 等待', fix(split[2], 1) + ' %', 'cpu_iowait'],
				['当前频率', fmtFreq(p[3]), 'cpu_freq'],
				['负载 (1m)', fix(p[4] && p[4][0], 2), 'load_avg'],
				['负载 (5m)', fix(p[4] && p[4][1], 2)],
				['负载 (15m)', fix(p[4] && p[4][2], 2)],
				['核心数', st.cores != null ? st.cores : (cores.length || '—')]
			]) + '</div>' +
		'</div></div>';
}

/** 内存与存储面板（panel_mem_storage） */
function memStorageHtml(ctx) {
	const mem = ctx.state.mem;
	const p = lastPoint(ctx);

	let memBlock;
	if (mem && mem.total) {
		const total = Number(mem.total);
		const free = Number(mem.free) || 0;
		const avail = Number(mem.avail) || 0;
		const buffers = Number(mem.buffers) || 0;
		const cached = Number(mem.cached) || 0;
		// used = total - avail；再拆出 buffers/cached，剩余为真正被进程占用
		const used = Math.max(0, total - avail);
		const apps = Math.max(0, used - buffers - cached);

		memBlock = '<div class="tm-donut-container">' +
			donutSVG([
				[apps, 'var(--tm-c-purple)', '应用占用'],
				[buffers, 'var(--tm-c-blue)', 'Buffers'],
				[cached, 'var(--tm-c-cyan)', 'Cached'],
				[avail, 'var(--tm-ok)', '可用']
			], fix(pct(used, total), 1) + '%', '已用 / ' + fmtKB(total)) +
			legendList([
				['var(--tm-c-purple)', '应用占用', fmtKB(apps)],
				['var(--tm-c-blue)', 'Buffers', fmtKB(buffers)],
				['var(--tm-c-cyan)', 'Cached', fmtKB(cached)],
				['var(--tm-ok)', '可用 (Avail)', fmtKB(avail)],
				['var(--tm-text-3)', '完全空闲 (Free)', fmtKB(free)]
			]) + '</div>';
	} else if (p && p[5]) {
		const total = Number(p[5][0]), avail = Number(p[5][2]), free = Number(p[5][1]);
		const used = Math.max(0, total - avail);
		memBlock = '<div class="tm-donut-container">' +
			donutSVG([[used, 'var(--tm-c-purple)', '已用'], [avail, 'var(--tm-ok)', '可用']],
				fix(pct(used, total), 1) + '%', '已用 / ' + fmtKB(total)) +
			legendList([
				['var(--tm-c-purple)', '已用', fmtKB(used)],
				['var(--tm-ok)', '可用 (Avail)', fmtKB(avail)],
				['var(--tm-text-3)', '完全空闲 (Free)', fmtKB(free)]
			]) + '</div>';
	} else {
		memBlock = emptyBlock('暂无内存数据');
	}

	// 存储：优先用最新采样点里的 overlay，再补 api_sys 的挂载表
	let storeBlock;
	if (p && p[9] && p[9][0]) {
		const total = Number(p[9][0]), free = Number(p[9][1]);
		const used = total - free;
		const pv = pct(used, total);
		storeBlock = '<div class="tm-tile-value" style="font-size:var(--tm-font-size-2xl)">' + fix(pv, 1) +
				'<small style="font-size:var(--tm-font-size-xs);color:var(--tm-text-3)"> % 根分区</small></div>' +
			'<div style="margin:8px 0 12px">' + cardProgress(pv, storeLevel(pv)) + '</div>' +
			kvList([
				['总容量', fmtKB(total)],
				['已用', fmtKB(used)],
				['剩余', fmtKB(free), 'store_avail']
			]);
	} else {
		storeBlock = emptyBlock('暂无存储数据');
	}

	return '<div class="tm-panel-body">' +
		'<div class="tm-grid tm-grid-2">' +
			'<div>' + memBlock + '</div>' +
			'<div>' + storeBlock + '</div>' +
		'</div></div>';
}

/** 网卡面板（panel_ifaces） */
function ifacesHtml(ctx) {
	const st = ctx.state.status || {};
	const ifs = st.ifaces || [];
	const p = lastPoint(ctx);
	if (!ifs.length) return '<div class="tm-panel-body">' + emptyBlock('未发现网络接口') + '</div>';

	// WAN 下标集合，用于标注“计入汇总”的接口
	const wanSet = new Set(wanIdxs(st));

	const rows = ifs.map((f, i) => {
		const q = (p && p[7] && p[7][i]) ? p[7][i] : null;
		const rx = q ? Number(q[0]) || 0 : null;
		const tx = q ? Number(q[1]) || 0 : null;
		const rxB = q ? Number(q[2]) || 0 : null;
		const txB = q ? Number(q[3]) || 0 : null;
		const rc = roleClass(f);
		return '<div class="tm-iface-row">' +
			'<div class="tm-iface-name">' +
				'<span class="tm-role ' + rc + '">' + esc(f.role || rc) + '</span>' +
				'<span class="nm">' + esc(f.name) + '</span>' +
				(wanSet.has(i) ? '<span class="tm-badge info" data-tip="该接口计入概览页的 WAN 速率汇总">汇总</span>' : '') +
			'</div>' +
			'<div class="tm-iface-ip">' + esc(f.ip || '—') + '</div>' +
			'<div class="tm-iface-stats">' +
				'<span class="down"><i>↓</i>' + (rx == null ? '—' : fmtRate(rx)) + '</span>' +
				'<span class="up"><i>↑</i>' + (tx == null ? '—' : fmtRate(tx)) + '</span>' +
				'<span data-tip="net_rx_total"><i>累计收</i>' + (rxB == null ? '—' : fmtB(rxB)) + '</span>' +
				'<span data-tip="net_tx_total"><i>累计发</i>' + (txB == null ? '—' : fmtB(txB)) + '</span>' +
			'</div>' +
			'</div>';
	}).join('');

	return '<div class="tm-panel-body tight">' + rows + '</div>';
}

function emptyBlock(msg) {
	return '<div class="tm-empty"><span class="tm-empty-text">' + esc(msg) + '</span></div>';
}

/* ---------------------------------------------------------------- 视图定义 */

export default {
	id: 'overview',

	/** 声明数据依赖，app.js 据此并行拉取 */
	needs: ['status', 'series', 'mem'],

	render(ctx) {
		const hidden = ctx.state.hidden;
		const parts = [];

		parts.push('<div id="ov-cards">' + cardsHtml(ctx) + '</div>');

		if (!hidden.has('panel_charts')) {
			parts.push('<div id="ov-charts-wrap" data-panel-key="panel_charts">' + chartsHtml(ctx) + '</div>');
		}
		if (!hidden.has('panel_cpu_detail')) {
			parts.push('<div id="ov-cpu-wrap" data-panel-key="panel_cpu_detail">' +
				panel('CPU 明细', '<div id="ov-cpu-detail">' + cpuDetailHtml(ctx) + '</div>',
					{ actions: hideBtn('panel_cpu_detail') }) + '</div>');
		}
		if (!hidden.has('panel_mem_storage')) {
			parts.push('<div id="ov-mem-wrap" data-panel-key="panel_mem_storage">' +
				panel('内存与存储', '<div id="ov-mem-storage">' + memStorageHtml(ctx) + '</div>',
					{ actions: hideBtn('panel_mem_storage') }) + '</div>');
		}
		if (!hidden.has('panel_ifaces')) {
			parts.push('<div id="ov-iface-wrap" data-panel-key="panel_ifaces">' +
				panel('网络接口', '<div id="ov-ifaces">' + ifacesHtml(ctx) + '</div>',
					{ subtitle: '实时速率与累计流量', actions: hideBtn('panel_ifaces') }) + '</div>');
		}

		return parts.join('');
	},

	mount(ctx) { this.paint(ctx); },

	/** 轮询时只重画动态区块，图表容器不动 → 实例复用、缩放状态保留 */
	patch(ctx) { this.paint(ctx); },

	paint(ctx) {
		const set = (sel, html) => {
			const el = ctx.q(sel);
			if (el) el.innerHTML = html;
		};

		set('#ov-cards', cardsHtml(ctx));

		const pts = (ctx.state.series && ctx.state.series.points) || [];
		if (pts.length) {
			const t = ctx.q('#ov-chart-temp');
			const c = ctx.q('#ov-chart-cpu');
			if (t) ctx.chart(t, tempChartCfg(ctx));
			if (c) ctx.chart(c, cpuChartCfg(ctx));
		} else {
			const t = ctx.q('#ov-chart-temp');
			const c = ctx.q('#ov-chart-cpu');
			if (t) showEmpty(t, '暂无历史数据', '采集服务启动后约 1 分钟开始出图');
			if (c) showEmpty(c, '暂无历史数据');
		}

		set('#ov-cpu-detail', cpuDetailHtml(ctx));
		set('#ov-mem-storage', memStorageHtml(ctx));
		set('#ov-ifaces', ifacesHtml(ctx));
	}
};

/** 面板级隐藏按钮（与卡片隐藏走同一个后端 toggle 接口） */
function hideBtn(key) {
	return '<button type="button" class="tm-icon-btn" data-hide="' + key + '"' +
		' title="隐藏此面板" aria-label="隐藏此面板" data-tip="hide_card">' + icon('eyeOff', 16) + '</button>';
}
