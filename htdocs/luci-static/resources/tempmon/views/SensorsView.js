/**
 * luci-app-tempmon — 传感器视图
 *
 * 注意路由：后端 **没有** sensors 这个服务端路由，
 * router 用 /dashboard?view=sensors 承载，刷新不会 404。
 *
 * 数据源：api_status.zones（名称数组）+ points[6]（与 zones 同序的温度数组）
 *         + api_status.alert（0 正常 / 1 警告 / 2 危险，后端权威判定）。
 *
 * 告警阈值（temp_warn 默认 75 / temp_crit 默认 85）不在任何接口里返回，
 * 因此着色沿用与后端默认值一致的展示阈值，并明确告知用户可在 UCI 配置页修改；
 * 前端不新增任何告警规则（E2 约束）。
 */

import { esc, icon, axisNum, alertLevel, fix, panel, rangeTabs, kvList, tiles } from '../core/util.js';
import { showEmpty } from '../components/Skeleton.js';

/* 这两个只是「后端默认阈值」，仅供迷你图一类的装饰性标注使用。
   逐路卡片的告警状态一律取自 status.alert：真机上的阈值完全可能被改过
   （实测这台设备是 temp_warn=60 / temp_crit=70），而任何接口都不返回它，
   所以前端拿 75/85 去判定并显示「警告 / 严重告警」等于编造事实。 */
const TEMP_WARN = 75;
const TEMP_CRIT = 85;

/** status.alert 经 alertLevel() 得到的级别 → 分区卡片着色类 */
function classOfAlert(lv) {
	return lv === 'danger' ? 'lv-danger' : (lv === 'warn' ? 'lv-warn' : '');
}

function lastPoint(ctx) {
	const st = ctx.state.status || {};
	if (Array.isArray(st.last) && st.last.length) return st.last;
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	return pts.length ? pts[pts.length - 1] : null;
}

/** 各传感器分区卡片 */
function zonesHtml(ctx) {
	const st = ctx.state.status || {};
	const zones = st.zones || [];
	const p = lastPoint(ctx);
	const temps = (p && Array.isArray(p[6])) ? p[6] : [];

	if (!zones.length && !temps.length) {
		return '<div class="tm-empty">' + icon('thermometer', 48) +
			'<div class="tm-empty-text">该设备没有可用的温度传感器</div>' +
			'<div class="tm-empty-text">/sys/class/thermal 与 collect.sh 均未读到数据</div></div>';
	}

	const n = Math.max(zones.length, temps.length);
	/* 只有「最热那一路」能给出权威状态：后端 alert 正是拿所有分区的最高温 tmax
	   与 UCI 阈值比出来的（controller: tmax >= crit → 2，>= warn → 1），
	   因此最热一路的状态与 alert 严格等价；其余各路接口无从判定，
	   只显示读数、不给结论，避免用编造的阈值给出错误的「正常/警告」。 */
	const lv = alertLevel(st.alert);
	const lvText = lv === 'danger' ? '严重告警' : (lv === 'warn' ? '警告' : '正常');
	let maxIdx = -1, maxV = -Infinity;
	for (let i = 0; i < n; i++) {
		const v = Number(temps[i]);
		if (isFinite(v) && v > maxV) { maxV = v; maxIdx = i; }
	}
	let cards = '';
	for (let i = 0; i < n; i++) {
		const name = zones[i] || ('zone' + i);
		const v = Number(temps[i]);
		const ok = isFinite(v);
		const hot = ok && i === maxIdx;
		cards += '<div class="tm-zone-card ' + (hot ? classOfAlert(lv) : '') + '">' +
			'<div class="tm-zone-name" title="' + esc(name) + '">' + esc(name) +
				(hot && n > 1 ? '（最高）' : '') + '</div>' +
			'<div class="tm-zone-val">' + (ok ? fix(v, 1) : '—') +
				(ok ? '<small>°C</small>' : '') + '</div>' +
			'<div class="tm-zone-name" style="margin:4px 0 0"' +
				(hot ? '' : ' title="后端告警只按最高温一路判定，其余各路的阈值判定接口不提供"') + '>' +
				(ok ? (hot ? lvText : '—') : '无读数') +
			'</div></div>';
	}
	return '<div class="tm-zone-grid">' + cards + '</div>';
}

/** 温度趋势图：每路一条线 */
function tempCfg(ctx) {
	const st = ctx.state.status || {};
	const zones = st.zones || [];
	const pts = (ctx.state.series && ctx.state.series.points) || [];
	const palette = window.tempmonChart ? window.tempmonChart.palette : ['var(--tm-c-orange)'];
	const count = Math.max(zones.length, 1);

	const series = [];
	for (let i = 0; i < count; i++) {
		// for-let 每次迭代都是独立绑定，闭包可安全捕获 i
		const idx = i;
		series.push({
			label: zones[idx] || ('zone' + idx),
			color: palette[idx % palette.length],
			thick: idx === 0,
			fill: idx === 0,
			get: pt => (pt[6] && pt[6][idx] != null) ? Number(pt[6][idx]) : null
		});
	}

	return {
		title: '温度趋势',
		points: pts,
		series: series,
		yFmt: (v, step) => axisNum(v, step, '°'),
		empty: '暂无温度历史数据'
	};
}

/** 告警状态汇总（E2：只展示后端判定结果，不自行推断） */
function alertHtml(ctx) {
	const st = ctx.state.status || {};
	const lv = Number(st.alert) || 0;
	const p = lastPoint(ctx);
	const zones = st.zones || [];
	const temps = (p && Array.isArray(p[6])) ? p[6] : [];

	let maxV = null, maxName = '';
	for (let i = 0; i < temps.length; i++) {
		const v = Number(temps[i]);
		if (isFinite(v) && (maxV === null || v > maxV)) { maxV = v; maxName = zones[i] || ('zone' + i); }
	}

	const meta = lv === 2
		? { cls: 'danger', badge: 'err', text: '严重告警', desc: '后端判定温度已达到严重阈值，请检查散热与负载。' }
		: lv === 1
			? { cls: 'warn', badge: 'warn', text: '警告', desc: '后端判定温度已超过警告阈值，建议关注趋势。' }
			: { cls: 'ok', badge: 'ok', text: '正常', desc: '所有传感器读数均在阈值范围内。' };

	return '<div class="tm-alert-banner ' + (lv === 2 ? 'danger' : '') + '"' +
			(lv === 0 ? ' style="border-color:var(--tm-ok-border);border-left-color:var(--tm-ok);' +
				'background:linear-gradient(90deg,var(--tm-ok-soft),transparent 70%)"' : '') + '>' +
			'<span class="tm-alert-icon" style="' + (lv === 0 ? 'color:var(--tm-ok)' : '') + '">' +
				icon(lv === 0 ? 'check' : lv === 1 ? 'warn' : 'danger', 20) + '</span>' +
			'<div class="tm-alert-text">' +
				'<div class="tm-alert-title">告警状态：' + meta.text + '</div>' +
				'<div class="tm-alert-detail">' + esc(meta.desc) + '</div>' +
			'</div>' +
			'<span class="tm-badge ' + meta.badge + '">status.alert = ' + lv + '</span>' +
		'</div>' +
		'<div style="margin-top:var(--tm-space-md)">' + tiles([
			['传感器路数', (zones.length || temps.length || 0) + ' 路'],
			['当前最高温', maxV == null ? '—' : fix(maxV, 1) + ' °C'],
			['最高温来源', esc(maxName || '—')],
			['采集状态', st.daemon ? '运行中' : '已停止']
		]) + '</div>' +
		'<div style="margin-top:var(--tm-space-md)">' + kvList([
			/* 不写具体阈值数字：接口不返回真实值，真机上完全可能被改过
			   （实测这台设备是 temp_warn=60 / temp_crit=70）。只给默认值与来源。
			   节名也按实测更正为 core —— 原先写的 @tempmon[0] 在这台设备上不存在。 */
			['警告阈值', '后端默认 ' + TEMP_WARN + ' °C · 实际值接口不返回', 'temp_warn'],
			['严重阈值', '后端默认 ' + TEMP_CRIT + ' °C · 实际值接口不返回', 'temp_crit'],
			['阈值来源', 'UCI tempmon.core.temp_warn / temp_crit'],
			['告警判定', '由后端 collect.sh / 控制器完成', 'alert']
		]) + '</div>';
}

export default {
	id: 'sensors',
	needs: ['status', 'series'],

	render(ctx) {
		const st = ctx.state.status || {};
		return '' +
			panel('传感器读数',
				'<div class="tm-panel-body" id="sen-zones">' + zonesHtml(ctx) + '</div>',
				{ subtitle: (st.zones || []).length + ' 路 · 告警状态取自后端 status.alert' }) +
			panel('温度趋势',
				'<div class="tm-panel-body"><div class="tm-chart-box" id="sen-chart" style="--tm-chart-h:320px"></div></div>',
				{
					subtitle: '点击图例可单独查看某一路',
					actions: '<div id="sen-range">' + rangeTabs(ctx.state.range, 'sen') + '</div>'
				}) +
			'<div class="tm-grid tm-grid-21">' +
				panel('告警状态', '<div class="tm-panel-body" id="sen-alert">' + alertHtml(ctx) + '</div>') +
				'<div class="tm-note">' + icon('info', 14) +
					'<span><b>阈值在哪里改？</b>告警阈值保存在 UCI 配置中' +
					'（<code>temp_warn</code> / <code>temp_crit</code>），' +
					'<a href="' + esc(ctx.configUrl()) + '" data-action="goto-config">前往参数配置页</a>修改后会由后端重启采集服务生效。' +
					'本页面的颜色分级仅用于展示，告警判定始终以后端 <code>status.alert</code> 为准，' +
					'前端不会自行新增告警规则。</span></div>' +
			'</div>';
	},

	mount(ctx) { this.paint(ctx); },
	patch(ctx) { this.paint(ctx); },

	paint(ctx) {
		const set = (sel, html) => { const el = ctx.q(sel); if (el) el.innerHTML = html; };
		set('#sen-zones', zonesHtml(ctx));
		set('#sen-alert', alertHtml(ctx));

		const el = ctx.q('#sen-chart');
		if (!el) return;
		const pts = (ctx.state.series && ctx.state.series.points) || [];
		if (pts.length) ctx.chart(el, tempCfg(ctx));
		else showEmpty(el, '暂无温度历史数据', '设备可能没有可用传感器，或采集服务未运行');
	}
};
