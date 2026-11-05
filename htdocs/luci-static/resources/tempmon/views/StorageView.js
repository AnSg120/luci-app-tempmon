/**
 * luci-app-tempmon — 存储视图
 *
 * 数据源：
 *   api_sys.mounts  [{device,size,used,avail,pct,target,type}]，单位 kB
 *                   ⚠ pct 是字符串（Lua 只做了 %d+ 捕获没 tonumber），必须 parseFloat
 *   api_data.points[9] = [overlayTotalKB, overlayFreeKB]  根分区趋势
 *   api_io.points      = [[ts, readKB, writeKB]]           磁盘读写速率
 */

import { esc, icon, axisNum, fix, fmtKB, pct, kvList, panel, rangeTabs, tiles } from '../core/util.js';
import { metricCardGrid, cardProgress } from '../components/MetricCard.js';
import { showEmpty } from '../components/Skeleton.js';

const num = v => { const n = Number(v); return isFinite(n) ? n : null; };
const storeLevel = v => { const n = Number(v) || 0; return n >= 92 ? 'danger' : n >= 80 ? 'warn' : 'ok'; };

/** 根分区数据：优先采样点，退回 mounts 里的 /overlay 或 / */
function overlayOf(ctx) {
	const st = ctx.state.status || {};
	const p = (st.last && st.last.length) ? st.last : null;
	if (p && p[9] && p[9][0]) {
		const total = Number(p[9][0]), free = Number(p[9][1]);
		return { total, free, used: total - free, pctv: pct(total - free, total), from: '采样点' };
	}
	const mounts = (ctx.state.sys && ctx.state.sys.mounts) || [];
	const hit = mounts.find(m => m.target === '/overlay') || mounts.find(m => m.target === '/') || mounts[0];
	if (hit) {
		const total = Number(hit.size) || 0, avail = Number(hit.avail) || 0;
		return { total, free: avail, used: total - avail, pctv: pct(total - avail, total), from: hit.target };
	}
	return null;
}

function cardsHtml(ctx) {
	const ov = overlayOf(ctx);
	const mounts = (ctx.state.sys && ctx.state.sys.mounts) || [];
	const io = (ctx.state.io && ctx.state.io.points) || [];

	// 最近一段的平均读写速率，作为卡片的即时值
	let rSum = 0, wSum = 0, n = 0;
	const tail = io.slice(-10);
	for (const row of tail) {
		const r = Number(row[1]), w = Number(row[2]);
		if (isFinite(r) && isFinite(w)) { rSum += r; wSum += w; n++; }
	}
	const rAvg = n ? rSum / n : null;
	const wAvg = n ? wSum / n : null;

	// tmpfs 总容量（内存盘），路由器上 /tmp 通常是 tmpfs
	const tmpfs = mounts.filter(m => /tmpfs|ramfs/i.test(m.type || ''));
	let tmpTotal = 0, tmpUsed = 0;
	for (const m of tmpfs) { tmpTotal += Number(m.size) || 0; tmpUsed += Number(m.used) || 0; }

	const cards = [];
	if (ov) {
		cards.push({
			icon: 'store', tone: 'cyan', title: '根分区占用',
			value: fix(ov.pctv, 1), unit: '%', level: storeLevel(ov.pctv),
			sub: fmtKB(ov.used) + ' / ' + fmtKB(ov.total) + ' · 来源 ' + ov.from,
			foot: cardProgress(ov.pctv), tip: 'store_overlay'
		});
		cards.push({
			icon: 'check', tone: 'green', title: '根分区剩余',
			value: fmtKB(ov.free), unit: '', level: ov.free < 10240 ? 'warn' : 'ok',
			sub: ov.free < 10240 ? '空间偏低，可能影响配置保存' : '空间充足',
			tip: 'store_avail'
		});
	} else {
		cards.push({
			icon: 'store', tone: 'cyan', title: '根分区占用',
			value: '—', unit: '', level: 'ok', sub: '未读到分区信息', tip: 'store_overlay'
		});
	}

	cards.push({
		icon: 'arrowDown', tone: 'blue', title: '磁盘读取',
		value: rAvg == null ? '—' : fmtKB(rAvg) + '/s', unit: '', level: 'ok',
		sub: '近 ' + tail.length + ' 次采样均值', tip: '磁盘读取速率（来自 api_io）'
	});
	cards.push({
		icon: 'arrowUp', tone: 'orange', title: '磁盘写入',
		value: wAvg == null ? '—' : fmtKB(wAvg) + '/s', unit: '',
		// 闪存写入过快会加速损耗，给个提示色
		level: (wAvg != null && wAvg > 512) ? 'warn' : 'ok',
		sub: '持续高写入会加速闪存损耗', tip: '磁盘写入速率（来自 api_io）'
	});
	cards.push({
		icon: 'database', tone: 'purple', title: '挂载点',
		value: String(mounts.length), unit: '个', level: 'ok',
		sub: tmpfs.length ? ('其中 ' + tmpfs.length + ' 个为内存盘') : '—',
		tip: 'mount_type'
	});
	cards.push({
		icon: 'mem', tone: 'green', title: '内存盘占用',
		value: tmpTotal > 0 ? fix(pct(tmpUsed, tmpTotal), 1) : '—',
		unit: tmpTotal > 0 ? '%' : '', level: tmpTotal > 0 ? storeLevel(pct(tmpUsed, tmpTotal)) : 'ok',
		sub: tmpTotal > 0 ? (fmtKB(tmpUsed) + ' / ' + fmtKB(tmpTotal)) : '无 tmpfs 挂载',
		tip: 'tmpfs 存放在内存中，重启即清空'
	});

	return metricCardGrid(cards, ctx.state.hidden, 'tm-grid-3');
}

/** 根分区使用率趋势 */
function overlayCfg(ctx) {
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return {
		title: '根分区使用率',
		points: pts,
		series: [{
			label: '已用 %', color: 'var(--tm-c-cyan)', thick: true, fill: true,
			get: p => (p[9] && p[9][0]) ? pct(p[9][0] - p[9][1], p[9][0]) : null
		}],
		yFmt: (v, step) => axisNum(v, step, '%'),
		empty: '暂无历史数据'
	};
}

/** 磁盘 IO 速率（api_io 的点结构是 [ts, read, write]，与 history 不同） */
function ioCfg(ctx) {
	const pts = (ctx.state.io && ctx.state.io.points) || [];
	return {
		title: '磁盘读写',
		points: pts,
		series: [
			{ label: '读取', color: 'var(--tm-c-blue)', thick: true, fill: true, get: r => num(r[1]) },
			{ label: '写入', color: 'var(--tm-c-orange)', thick: true, fill: true, get: r => num(r[2]) }
		],
		yFmt: (v, step) => (v >= 1024
			? axisNum(v / 1024, step / 1024, 'M')
			: axisNum(v, step, 'K')),
		yZero: true,
		empty: '暂无磁盘 IO 数据'
	};
}

/** 挂载点表格（D4：外层 wrapper 横向滚动，窄屏不挤压） */
function mountsHtml(ctx) {
	const mounts = (ctx.state.sys && ctx.state.sys.mounts) || [];
	if (!mounts.length) return '<div class="tm-empty"><span class="tm-empty-text">未读到挂载信息</span></div>';

	const rows = mounts.map(m => {
		// pct 后端给的是字符串，必须 parseFloat
		const pv = parseFloat(m.pct);
		const pvv = isFinite(pv) ? pv : (Number(m.size) ? pct(Number(m.used), Number(m.size)) : 0);
		const lv = storeLevel(pvv);
		const isMem = /tmpfs|ramfs/i.test(m.type || '');
		return '<tr>' +
			'<td class="bold">' + esc(m.target || '—') + '</td>' +
			'<td class="dim">' + esc(m.device || '—') + '</td>' +
			'<td><span class="tm-badge ' + (isMem ? 'info' : 'mute') + '" data-tip="mount_type">' + esc(m.type || '—') + '</span></td>' +
			'<td class="num">' + fmtKB(m.size) + '</td>' +
			'<td class="num">' + fmtKB(m.used) + '</td>' +
			'<td class="num">' + fmtKB(m.avail) + '</td>' +
			'<td style="min-width:120px">' +
				'<div style="display:flex;align-items:center;gap:8px">' +
					cardProgress(pvv, lv) +
					'<span class="tm-mono" style="width:44px;text-align:right;color:var(--tm-' +
						(lv === 'danger' ? 'err' : lv === 'warn' ? 'warn' : 'text-1') + ')">' + fix(pvv, 1) + '%</span>' +
				'</div>' +
			'</td></tr>';
	}).join('');

	return '<div class="tm-table-wrapper"><table class="tm-table">' +
		'<thead><tr>' +
			'<th>挂载点</th><th>设备</th><th>类型</th>' +
			'<th class="num">容量</th><th class="num">已用</th><th class="num">可用</th><th>使用率</th>' +
		'</tr></thead><tbody>' + rows + '</tbody></table></div>';
}

function summaryHtml(ctx) {
	const ov = overlayOf(ctx);
	const mounts = (ctx.state.sys && ctx.state.sys.mounts) || [];
	let total = 0, used = 0;
	for (const m of mounts) { total += Number(m.size) || 0; used += Number(m.used) || 0; }

	const items = [
		['挂载点数量', mounts.length + ' 个'],
		['容量合计', total > 0 ? fmtKB(total) : '—'],
		['已用合计', total > 0 ? fmtKB(used) : '—']
	];
	if (ov) items.push(['根分区剩余', fmtKB(ov.free), 'store_avail']);

	return tiles(items) + '<div style="margin-top:var(--tm-space-md)">' + kvList([
		['历史点数', (ctx.state.status && ctx.state.status.lines != null) ? ctx.state.status.lines : '—', 'lines'],
		['历史文件占用', (ctx.state.status && ctx.state.status.size) ? fmtKB(ctx.state.status.size) : '—', 'size'],
		['数据目录', esc((ctx.state.status && ctx.state.status.dir) || '—')]
	]) + '</div>';
}

export default {
	id: 'storage',
	needs: ['status', 'series', 'sys', 'io'],

	render(ctx) {
		return '' +
			'<div id="st-cards">' + cardsHtml(ctx) + '</div>' +
			panel('存储趋势',
				'<div class="tm-panel-body">' +
					'<div class="tm-grid tm-grid-2">' +
						'<div class="tm-chart-box" id="st-chart-overlay"></div>' +
						'<div class="tm-chart-box" id="st-chart-io"></div>' +
					'</div>' +
				'</div>',
				{
					subtitle: '左：根分区使用率　右：磁盘读写速率',
					actions: '<div id="st-range">' + rangeTabs(ctx.state.range, 'st') + '</div>'
				}) +
			panel('挂载点',
				'<div class="tm-panel-body tight" id="st-mounts">' + mountsHtml(ctx) + '</div>',
				{ subtitle: '数据来自 df 输出；tmpfs 为内存盘，重启即清空' }) +
			'<div class="tm-grid tm-grid-21">' +
				panel('汇总', '<div class="tm-panel-body" id="st-summary">' + summaryHtml(ctx) + '</div>') +
				'<div class="tm-note">' + icon('warn', 14) +
					'<span><b>根分区写满的后果</b>：OpenWrt 的配置保存在 overlay 分区，' +
					'一旦写满会出现「配置保存失败、插件安装中断、服务无法启动」等问题，' +
					'且通常不会主动报警。建议把使用率长期控制在 80% 以内，' +
					'并定期清理 /tmp 之外的日志与缓存文件。</span></div>' +
			'</div>';
	},

	mount(ctx) { this.paint(ctx); },
	patch(ctx) { this.paint(ctx); },

	paint(ctx) {
		const set = (sel, html) => { const el = ctx.q(sel); if (el) el.innerHTML = html; };
		set('#st-cards', cardsHtml(ctx));
		set('#st-mounts', mountsHtml(ctx));
		set('#st-summary', summaryHtml(ctx));

		const o = ctx.q('#st-chart-overlay');
		const i = ctx.q('#st-chart-io');
		const hasSeries = !!((ctx.state.series && ctx.state.series.points) || []).length;
		const hasIo = !!((ctx.state.io && ctx.state.io.points) || []).length;
		if (o) { hasSeries ? ctx.chart(o, overlayCfg(ctx)) : showEmpty(o, '暂无历史数据'); }
		if (i) { hasIo ? ctx.chart(i, ioCfg(ctx)) : showEmpty(i, '暂无磁盘 IO 数据'); }
	}
};
