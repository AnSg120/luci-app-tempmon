/**
 * luci-app-tempmon — 网络视图
 *
 * 数据源：
 *   api_status.ifaces  [{name, role, ip, label}]   接口清单与角色
 *   api_data.points[7] [[rxRate, txRate, rxBytes, txBytes], ...]  与 ifaces 同序
 *   api_net            {total, tcp, udp, state:{dev:operstate}}   连接数与链路状态
 *
 * 概览卡片与图表的“WAN 汇总”口径与 v3.0 一致：
 *   role=WAN → 名称匹配 wan/wwan → 非 br- 且非 LAN，三级回退（见 util.wanIdxs）。
 */

import { esc, icon, axisNum, fix, fmtRate, fmtB, kvList, panel, rangeTabs, tiles } from '../core/util.js';
import { metricCardGrid } from '../components/MetricCard.js';
import { showEmpty } from '../components/Skeleton.js';

const num = v => { const n = Number(v); return isFinite(n) ? n : null; };

function lastPoint(ctx) {
	const st = ctx.state.status || {};
	if (Array.isArray(st.last) && st.last.length) return st.last;
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return pts.length ? pts[pts.length - 1] : null;
}

function cardsHtml(ctx) {
	const st = ctx.state.status || {};
	const net = ctx.state.net || {};
	const p = lastPoint(ctx);
	const ifs = st.ifaces || [];

	let down = null, up = null, rxB = null, txB = null;
	if (p && Array.isArray(p[7])) {
		const idxs = [];
		ifs.forEach((f, i) => { if ((f.role || '') === 'WAN') idxs.push(i); });
		if (!idxs.length) ifs.forEach((f, i) => { if (/wan|wwan/i.test(f.name || '')) idxs.push(i); });
		if (!idxs.length) ifs.forEach((f, i) => { if (!/^br-/.test(f.name || '') && (f.role || '') !== 'LAN') idxs.push(i); });

		let d = 0, u = 0, rb = 0, tb = 0, any = false;
		for (const i of idxs) {
			const q = p[7][i];
			if (!q) continue;
			d += Number(q[0]) || 0; u += Number(q[1]) || 0;
			rb += Number(q[2]) || 0; tb += Number(q[3]) || 0;
			any = true;
		}
		if (any) { down = d; up = u; rxB = rb; txB = tb; }
	}

	// 链路状态统计：up / down
	const state = net.state || {};
	const devs = Object.keys(state);
	let upCount = 0;
	for (const k of devs) if (String(state[k]).toLowerCase() === 'up') upCount++;

	return metricCardGrid([
		{
			icon: 'arrowDown', tone: 'cyan', title: 'WAN 下行',
			value: down == null ? '—' : fmtRate(down), unit: '', level: 'ok',
			sub: down == null ? '未识别到 WAN 接口' : '实时接收速率', tip: 'net_rx'
		},
		{
			icon: 'arrowUp', tone: 'green', title: 'WAN 上行',
			value: up == null ? '—' : fmtRate(up), unit: '', level: 'ok',
			sub: '实时发送速率', tip: 'net_tx'
		},
		{
			icon: 'download', tone: 'blue', title: '累计接收',
			value: rxB == null ? '—' : fmtB(rxB), unit: '', level: 'ok',
			sub: '自计数器清零起', tip: 'net_rx_total'
		},
		{
			icon: 'external', tone: 'purple', title: '累计发送',
			value: txB == null ? '—' : fmtB(txB), unit: '', level: 'ok',
			sub: '自计数器清零起', tip: 'net_tx_total'
		},
		{
			icon: 'net', tone: 'orange', title: 'TCP 连接',
			value: net.tcp != null ? net.tcp : '—', unit: '条',
			level: (Number(net.tcp) || 0) > 300 ? 'warn' : 'ok',
			sub: 'UDP ' + (net.udp != null ? net.udp : '—') + ' 条',
			tip: 'net_tcp'
		},
		{
			icon: 'wifi', tone: 'green', title: '链路状态',
			value: devs.length ? (upCount + '/' + devs.length) : '—', unit: devs.length ? 'up' : '',
			level: (devs.length && upCount === 0) ? 'danger' : (devs.length && upCount < devs.length) ? 'warn' : 'ok',
			sub: ifs.length + ' 个受监控接口', tip: 'net_state'
		}
	], ctx.state.hidden, 'tm-grid-3');
}

/** 吞吐趋势：下行 / 上行 */
function throughputCfg(ctx) {
	const st = ctx.state.status || {};
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return {
		title: 'WAN 吞吐',
		points: pts,
		series: [
			{
				label: '下行', color: 'var(--tm-c-cyan)', thick: true, fill: true,
				get: p => { const v = netSum(p, 0, st); return v == null ? null : v / 1024; }
			},
			{
				label: '上行', color: 'var(--tm-c-green)', thick: true, fill: true,
				get: p => { const v = netSum(p, 1, st); return v == null ? null : v / 1024; }
			}
		],
		yFmt: (v, step) => (v >= 1024
			? axisNum(v / 1024, step / 1024, 'M')
			: axisNum(v, step, 'K')),
		yZero: true,
		empty: '暂无网络数据'
	};
}

/** 按接口分别画速率（多接口设备用这个图分辨是谁在跑流量） */
function perIfaceCfg(ctx) {
	const st = ctx.state.status || {};
	const ifs = st.ifaces || [];
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	const palette = window.tempmonChart ? window.tempmonChart.palette : ['var(--tm-c-cyan)'];

	const series = [];
	ifs.forEach((f, i) => {
		series.push({
			label: (f.name || ('if' + i)) + ' ↓',
			color: palette[i % palette.length],
			get: p => (p[7] && p[7][i]) ? num(p[7][i][0]) / 1024 : null
		});
		series.push({
			label: (f.name || ('if' + i)) + ' ↑',
			color: palette[i % palette.length],
			dashed: true,
			get: p => (p[7] && p[7][i]) ? num(p[7][i][1]) / 1024 : null
		});
	});

	return {
		title: '各接口速率',
		points: pts,
		series: series,
		yFmt: (v, step) => (v >= 1024
			? axisNum(v / 1024, step / 1024, 'M')
			: axisNum(v, step, 'K')),
		yZero: true,
		empty: '暂无接口数据'
	};
}

function netSum(p, k, st) {
	if (!p || !Array.isArray(p[7])) return null;
	const ifs = (st && st.ifaces) || [];
	const idxs = [];
	ifs.forEach((f, i) => { if ((f.role || '') === 'WAN') idxs.push(i); });
	if (!idxs.length) ifs.forEach((f, i) => { if (/wan|wwan/i.test(f.name || '')) idxs.push(i); });
	if (!idxs.length) ifs.forEach((f, i) => { if (!/^br-/.test(f.name || '') && (f.role || '') !== 'LAN') idxs.push(i); });
	let sum = 0, any = false;
	for (const i of idxs) {
		const q = p[7][i];
		if (q) { sum += Number(q[k]) || 0; any = true; }
	}
	return any ? sum : null;
}

/** 接口明细表 */
function ifaceTableHtml(ctx) {
	const st = ctx.state.status || {};
	const ifs = st.ifaces || [];
	const net = ctx.state.net || {};
	const state = net.state || {};
	const p = lastPoint(ctx);
	if (!ifs.length) return '<div class="tm-empty"><span class="tm-empty-text">未发现网络接口</span></div>';

	const rows = ifs.map((f, i) => {
		const q = (p && p[7] && p[7][i]) ? p[7][i] : null;
		const rx = q ? Number(q[0]) || 0 : null;
		const tx = q ? Number(q[1]) || 0 : null;
		const rxB = q ? Number(q[2]) || 0 : null;
		const txB = q ? Number(q[3]) || 0 : null;
		// operstate 优先取 api_net.state，退回接口自带标记
		const op = String(state[f.name] != null ? state[f.name] : (f.state || '')).toLowerCase();
		const isUp = op === 'up' || op === 'unknown' || op === '';
		const roleCls = (f.role === 'WAN') ? 'wan' : (f.role === 'LAN') ? 'lan'
			: (/wifi|wlan|GHz/i.test((f.label || '') + (f.name || '')) ? 'wifi' : 'other');

		return '<tr>' +
			'<td class="bold">' + esc(f.name) + '</td>' +
			'<td><span class="tm-role ' + roleCls + '">' + esc(f.role || roleCls) + '</span></td>' +
			'<td class="dim">' + esc(f.ip || '—') + '</td>' +
			'<td><span class="tm-badge ' + (isUp ? 'ok' : 'err') + '" data-tip="net_state">' +
				(isUp ? 'up' : (op || 'down')) + '</span></td>' +
			'<td class="num" style="color:var(--tm-c-cyan)">' + (rx == null ? '—' : fmtRate(rx)) + '</td>' +
			'<td class="num" style="color:var(--tm-c-green)">' + (tx == null ? '—' : fmtRate(tx)) + '</td>' +
			'<td class="num dim">' + (rxB == null ? '—' : fmtB(rxB)) + '</td>' +
			'<td class="num dim">' + (txB == null ? '—' : fmtB(txB)) + '</td>' +
			'<td class="dim">' + esc(f.label || '—') + '</td>' +
			'</tr>';
	}).join('');

	return '<div class="tm-table-wrapper"><table class="tm-table">' +
		'<thead><tr>' +
			'<th>接口</th><th>角色</th><th>IP</th><th>链路</th>' +
			'<th class="num">下行</th><th class="num">上行</th>' +
			'<th class="num">累计收</th><th class="num">累计发</th><th>说明</th>' +
		'</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function connHtml(ctx) {
	const net = ctx.state.net || {};
	const st = ctx.state.status || {};
	const ifs = st.ifaces || [];
	const state = net.state || {};
	const down = Object.keys(state).filter(k => String(state[k]).toLowerCase() === 'down');

	return tiles([
		['连接总数', net.total != null ? net.total : '—', 'net_tcp'],
		['TCP', net.tcp != null ? net.tcp : '—'],
		['UDP', net.udp != null ? net.udp : '—'],
		['接口数', ifs.length]
	]) + '<div style="margin-top:var(--tm-space-md)">' + kvList([
		['链路 down 的接口', down.length ? esc(down.join(', ')) : '无', 'net_state'],
		['WAN 接口', esc(ifs.filter(f => f.role === 'WAN').map(f => f.name).join(', ') || '未识别'), 'iface_role'],
		['数据口径', '速率 B/s，累计 Byte']
	]) + '</div>';
}

export default {
	id: 'network',
	needs: ['status', 'series', 'net'],

	render(ctx) {
		return '' +
			'<div id="net-cards">' + cardsHtml(ctx) + '</div>' +
			panel('吞吐趋势',
				'<div class="tm-panel-body">' +
					'<div class="tm-grid tm-grid-2">' +
						'<div class="tm-chart-box" id="net-chart-wan"></div>' +
						'<div class="tm-chart-box" id="net-chart-iface"></div>' +
					'</div>' +
				'</div>',
				{
					subtitle: '左：WAN 汇总　右：各接口分线（虚线为上行）',
					actions: '<div id="net-range">' + rangeTabs(ctx.state.range, 'net') + '</div>'
				}) +
			panel('接口明细',
				'<div class="tm-panel-body tight" id="net-table">' + ifaceTableHtml(ctx) + '</div>',
				{ subtitle: '累计值自网卡计数器清零起算，重启后归零' }) +
			panel('连接与链路', '<div class="tm-panel-body" id="net-conn">' + connHtml(ctx) + '</div>');
	},

	mount(ctx) { this.paint(ctx); },
	patch(ctx) { this.paint(ctx); },

	paint(ctx) {
		const set = (sel, html) => { const el = ctx.q(sel); if (el) el.innerHTML = html; };
		set('#net-cards', cardsHtml(ctx));
		set('#net-table', ifaceTableHtml(ctx));
		set('#net-conn', connHtml(ctx));

		const pts = (ctx.state.series && ctx.state.series.points) || [];
		const w = ctx.q('#net-chart-wan');
		const f = ctx.q('#net-chart-iface');
		if (pts.length) {
			if (w) ctx.chart(w, throughputCfg(ctx));
			if (f) ctx.chart(f, perIfaceCfg(ctx));
		} else {
			if (w) showEmpty(w, '暂无网络数据', '采集服务启动后约 1 分钟开始出图');
			if (f) showEmpty(f, '暂无接口数据');
		}
	}
};
