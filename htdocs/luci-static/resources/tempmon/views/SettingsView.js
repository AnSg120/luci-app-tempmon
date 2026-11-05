/**
 * luci-app-tempmon — 设置视图
 *
 * 功能清单（含 v3.0 原有项 + 需求新增项）：
 *   1. 采集服务 启动/停止/重启（api_service?op=）
 *   2. 运行参数展示：状态 / 采样间隔 / 记录条数 / 数据目录 / 文件大小 / 上限 / 版本
 *   3. 数据操作：导出历史 CSV（api_export）、清空历史（api_clear，二次确认）
 *   4. 显示项：10 个 HIDE_KEYS 的勾选框，走 api_display 的 toggle 语义
 *   5. 外观：深色 / 浅色 / 自动 三态主题（A4，替代不可靠的背景亮度探测）
 *   6. E1 采样耗时面板：前端实测（见下方说明）
 *   7. 前往 LuCI 参数配置页
 *
 * ── 关于 E1「采样耗时」的诚实说明 ────────────────────────────────
 * 需求要求读取后端 .sample_time_ms 显示平均采样耗时，但：
 *   · collect.sh 中没有任何 elapsed/%N/.sample 相关代码（grep 无匹配）
 *   · 13 个 API 也都不返回该字段
 * 而「后端完全不动」是硬约束，浏览器无法读取路由器上的文件。
 * 因此这里改为**前端实测**，并且如果后端将来真的暴露 sample_time_ms，
 * collectSampleMetrics() 会优先采用它（前向兼容钩子已留好）。
 * 展示的三项都是真实可验证的数据：采样节奏（相邻时间戳差）、接口往返耗时、
 * 以及由 MAXPTS=720 抽稀带来的判读限制。
 */

import { esc, icon, fix, fmtKB, fmtMs, kvList, panel, tiles } from '../core/util.js';
import { HIDE_KEYS, collectSampleMetrics } from '../core/dataStore.js';
import { themeCtrl, THEME_MODES } from '../core/themeCtrl.js';
import { danger as confirmDanger } from '../components/ModalConfirm.js';

/** HIDE_KEYS 的中文标签（顺序即展示顺序） */
const HIDE_LABELS = {
	card_temp: '温度卡片',
	card_cpu: 'CPU 卡片',
	card_mem: '内存卡片',
	card_storage: '存储卡片',
	card_net: '网络卡片',
	card_uptime: '运行时长卡片',
	panel_charts: '概览 · 趋势图表面板',
	panel_cpu_detail: '概览 · CPU 明细面板',
	panel_mem_storage: '概览 · 内存与存储面板',
	panel_ifaces: '概览 · 网络接口面板'
};

/* ------------------------------------------------------------ 各区块 HTML */

function serviceHtml(ctx) {
	const d = ctx.state.status || {};
	const sys = ctx.state.sys || {};
	const on = !!d.daemon;
	return '<div class="tm-panel-body">' +
		'<div class="tm-btn-group" style="margin-bottom:var(--tm-space-md)">' +
			'<button type="button" class="tm-btn primary" data-action="svc" data-op="start"' + (on ? ' disabled' : '') + '>' +
				icon('play', 14) + '启动</button>' +
			'<button type="button" class="tm-btn danger" data-action="svc" data-op="stop"' + (on ? '' : ' disabled') + '>' +
				icon('stop', 14) + '停止</button>' +
			'<button type="button" class="tm-btn" data-action="svc" data-op="restart"' + (on ? '' : ' disabled') + '>' +
				icon('refresh', 14) + '重启</button>' +
			'<span class="tm-badge ' + (on ? 'ok' : 'err') + '" style="align-self:center">' +
				'<span class="tm-dot ' + (on ? '' : 'off') + '"></span>' + (on ? '运行中' : '已停止') + '</span>' +
		'</div>' +
		kvList([
			['主机名', esc(sys.host || '—')],
			['设备型号', esc(sys.model || '—')],
			['系统版本', esc(sys.release || '—')],
			['内核', esc(sys.kernel || '—')],
			['采样间隔', (d.interval != null ? d.interval : '—') + ' 秒', 'interval'],
			['记录条数', (d.lines != null ? d.lines : '—') + ' 条', 'lines'],
			['保留上限', (d.max_lines != null ? d.max_lines : '—') + ' 条（滚动淘汰）'],
			['数据目录', esc(d.dir || '—')],
			['文件大小', d.size != null ? fmtKB(d.size) : '—', 'size'],
			['启用状态', d.enabled ? '已启用（开机自启）' : '未启用'],
			['插件版本', esc(d.version || (window.TM_VERSION || '—')), 'version']
		]) +
		'<div class="tm-note" style="margin-top:var(--tm-space-md)">' + icon('info', 14) +
			'<span>采样间隔、温度阈值等参数保存在 UCI 中，请前往 ' +
			'<a href="' + esc(ctx.configUrl()) + '" data-action="goto-config">LuCI 参数配置页</a> 修改，' +
			'保存后后端会自动重启采集服务。</span></div>' +
		'</div>';
}

function dataOpsHtml(ctx) {
	const d = ctx.state.status || {};
	return '<div class="tm-panel-body">' +
		'<div class="tm-btn-group">' +
			'<a class="tm-btn" href="' + esc(ctx.exportUrl()) + '" target="_blank" rel="noopener">' +
				icon('download', 14) + '导出历史 CSV</a>' +
			'<button type="button" class="tm-btn danger" data-action="clear-history">' +
				icon('trash', 14) + '清空历史记录</button>' +
		'</div>' +
		'<div class="tm-note warn" style="margin-top:var(--tm-space-md)">' + icon('warn', 14) +
			'<span>清空会调用 <code>collect.sh --init</code> 重建数据文件，' +
			'旧数据保留在路由器的 <code>history.*.old</code> 归档中。' +
			'当前共 ' + (d.lines != null ? d.lines : '—') + ' 条记录' +
			(d.size != null ? ('，占用 ' + fmtKB(d.size)) : '') + '。</span></div>' +
		'</div>';
}

/** 显示项：10 个 HIDE_KEYS 勾选框 */
function displayHtml(ctx) {
	const hidden = ctx.state.hidden;
	const boxes = HIDE_KEYS.map(k => {
		const off = hidden.has(k);
		return '<label class="tm-checkbox-label">' +
			'<input type="checkbox" data-hide-toggle="' + esc(k) + '"' + (off ? '' : ' checked') + '>' +
			'<span>' + esc(HIDE_LABELS[k] || k) + '</span>' +
			(off ? '<span class="tm-badge warn" style="margin-left:auto">已隐藏</span>' : '') +
			'</label>';
	}).join('');

	return '<div class="tm-panel-body">' +
		'<div class="tm-checkboxes">' + boxes + '</div>' +
		'<div class="tm-note" style="margin-top:var(--tm-space-md)">' + icon('eye', 14) +
			'<span>勾选 = 显示，取消 = 隐藏。状态写入 UCI（<code>hide_items</code>），' +
			'刷新页面后依然生效。也可以直接把鼠标移到卡片上，点右上角的眼睛图标快速隐藏。</span></div>' +
		'</div>';
}

/** 外观：主题三态 */
function themeHtml() {
	const cur = themeCtrl.getMode();
	const actual = themeCtrl.getActualMode();
	const opts = [THEME_MODES.DARK, THEME_MODES.LIGHT, THEME_MODES.AUTO];
	return '<div class="tm-panel-body">' +
		'<div class="tm-form-row">' +
			'<span class="tm-form-label">主题</span>' +
			'<div class="tm-tabs" role="tablist">' +
				opts.map(m => '<button type="button" role="tab" class="tm-tab' + (cur === m ? ' active' : '') +
					'" data-theme="' + m + '" aria-selected="' + (cur === m) + '">' +
					themeCtrl.getModeLabel(m) + '</button>').join('') +
			'</div>' +
			'<span class="tm-badge mute">当前实际：' + esc(actual === 'light' ? '浅色' : '深色') + '</span>' +
		'</div>' +
		'<div class="tm-form-hint">' +
			'「自动」跟随系统的 prefers-color-scheme。旧版通过探测背景亮度来判断主题，' +
			'在 LuCI 自带主题下经常误判，现已改为显式的手动开关 + 系统偏好，' +
			'选择会记住在浏览器本地。顶栏的图标按钮可在三种模式间快速循环。' +
		'</div>' +
		'</div>';
}

/** E1：采样耗时 / 节奏面板（前端实测） */
function sampleHtml(ctx) {
	const d = ctx.state.status || {};
	const pts = (ctx.state.series1h && ctx.state.series1h.points) || [];
	const m = collectSampleMetrics(d, pts, d.interval);
	const c = m.cadence || {};

	const backendRow = m.backendMs != null
		? ['后端单次采样耗时', fmtMs(m.backendMs), 'sample_time_ms']
		: ['后端单次采样耗时', '后端未提供该字段', 'sample_time_ms'];

	return '<div class="tm-panel-body">' +
		tiles([
			['实测采样间隔（中位）', c.median ? fix(c.median, 1) + ' s' : '—', 'measured_interval'],
			['配置间隔', (d.interval != null ? d.interval : '—') + ' s', 'interval'],
			['接口耗时 status', fmtMs(m.statusLatencyMs), 'api_latency'],
			['接口耗时 series', fmtMs(m.seriesLatencyMs), 'api_latency']
		]) +
		'<div style="margin-top:var(--tm-space-md)">' + kvList([
			backendRow,
			['实测平均间隔', c.avg ? fix(c.avg, 1) + ' s' : '—', 'measured_interval'],
			['实测最小 / 最大', (c.min ? fix(c.min, 1) : '—') + ' / ' + (c.max ? fix(c.max, 1) : '—') + ' s'],
			['间隔抖动', c.jitter != null ? fix(c.jitter, 1) + ' s' : '—', 'jitter'],
			['参与统计的间隔数', (c.n || 0) + ' 个'],
			['采集是否掉队', m.lagging ? '<span class="tm-badge warn">是（明显慢于配置间隔）</span>'
				: '<span class="tm-badge ok">否</span>']
		]) + '</div>' +
		(m.lagging
			? '<div class="tm-note warn" style="margin-top:var(--tm-space-md)">' + icon('warn', 14) +
			  '<span>实测间隔明显大于配置的 ' + (d.interval || '—') + ' 秒，' +
			  '通常意味着采样脚本被系统负载拖慢，或存储写入变慢。' +
			  '可以适当调大采样间隔以减轻压力。</span></div>'
			: '') +
		'<div class="tm-note" style="margin-top:var(--tm-space-md)">' + icon('info', 14) +
			'<span><b>这些数字是怎么来的？</b>' +
			'后端目前没有输出单次采样耗时，而本次重构不允许改动后端，' +
			'所以这里用浏览器能拿到的真实数据做实测：' +
			'<b>采样间隔</b>取自历史数据中相邻两个时间戳之差，' +
			'<b>接口耗时</b>取自浏览器发出请求到收到响应的往返时间。' +
			'若将来后端补上 <code>.sample_time_ms</code>，本页会自动优先显示后端值。' +
			'<br><b>判读限制：</b>后端最多保留 720 个点，超出后会抽稀，' +
			'因此这里固定用「1 小时」档位的数据计算 —— 只有该档位的间隔才等于真实采样间隔。</span></div>' +
		'</div>';
}

/* ------------------------------------------------------------------ 视图 */

export default {
	id: 'settings',
	// series1h：固定拉 1 小时档，用于 E1 的采样节奏实测（见文件头说明）
	// sys：主机名 / 型号 / 系统版本 / 内核
	needs: ['status', 'series1h', 'sys'],

	render(ctx) {
		return '' +
			'<div class="tm-grid tm-grid-2">' +
				panel('采集服务', '<div id="set-service">' + serviceHtml(ctx) + '</div>') +
				panel('数据操作', '<div id="set-data">' + dataOpsHtml(ctx) + '</div>') +
			'</div>' +
			panel('采样耗时与节奏', '<div id="set-sample">' + sampleHtml(ctx) + '</div>',
				{ subtitle: '前端实测：采样间隔来自历史时间戳差，接口耗时来自浏览器往返时间' }) +
			panel('显示项', '<div id="set-display">' + displayHtml(ctx) + '</div>',
				{ subtitle: '控制概览页哪些卡片与面板可见' }) +
			panel('外观', themeHtml(), { subtitle: '主题偏好保存在浏览器本地' });
	},

	/**
	 * 首次挂载：直接走 paint()，事件绑定只保留一份实现（见 rebind* 系列）。
	 * 所有监听器都带 __bound 标记，innerHTML 重绘后新节点会重新绑定，
	 * 不会出现「重绘后按钮点了没反应」或「同一按钮绑多次」的问题。
	 */
	mount(ctx) { this.paint(ctx); },

	/** 轮询时只刷新服务状态与采样指标，不动勾选框（避免打断用户操作） */
	patch(ctx) {
		const set = (sel, html) => { const el = ctx.q(sel); if (el) el.innerHTML = html; };
		const active = document.activeElement;
		if (!active || !active.hasAttribute || !active.hasAttribute('data-hide-toggle')) {
			set('#set-service', serviceHtml(ctx));
			// 服务按钮的事件是绑在旧节点上的，重画后需要重绑
			this.rebindService(ctx);
		}
		set('#set-sample', sampleHtml(ctx));
		set('#set-data', dataOpsHtml(ctx));
		this.rebindData(ctx);
	},

	paint(ctx) {
		const set = (sel, html) => { const el = ctx.q(sel); if (el) el.innerHTML = html; };
		set('#set-service', serviceHtml(ctx));
		set('#set-data', dataOpsHtml(ctx));
		set('#set-sample', sampleHtml(ctx));
		set('#set-display', displayHtml(ctx));
		this.rebindService(ctx);
		this.rebindData(ctx);
		this.rebindDisplay(ctx);
		this.rebindTheme(ctx);
	},

	paintTheme(ctx) {
		// 主题区块整体重绘即可（无输入控件，不会丢焦点）
		const panels = ctx.root.querySelectorAll('.tm-panel');
		const last = panels[panels.length - 1];
		if (!last) return;
		const body = last.querySelector('.tm-panel-body');
		if (body) {
			const wrap = document.createElement('div');
			wrap.innerHTML = themeHtml();
			body.replaceWith(wrap.firstElementChild);
			this.rebindTheme(ctx);
		}
	},

	/* 重绘后需要重新绑定（innerHTML 替换会丢掉监听器） */
	rebindService(ctx) {
		const svcBtns = ctx.root.querySelectorAll('[data-action="svc"]');
		for (const b of svcBtns) {
			if (b.__bound) continue;
			b.__bound = true;
			b.addEventListener('click', async () => {
				const op = b.getAttribute('data-op');
				if (op === 'stop') {
					const ok = await confirmDanger(
						'停止后将不再采集新的数据点，历史图表会停在最后一次采样。',
						'停止采集服务', '确定停止');
					if (!ok) return;
				}
				const all = ctx.root.querySelectorAll('[data-action="svc"]');
				for (const x of all) x.disabled = true;
				const res = await ctx.actions.service(op);
				if (res && res.ok) {
					ctx.toast('服务' + (op === 'start' ? '已启动' : op === 'stop' ? '已停止' : '已重启'), 'ok');
				} else {
					ctx.toast((res && res.error) || '操作失败', 'err');
				}
				await ctx.refresh({ status: true, series: true });
			});
		}
	},

	rebindData(ctx) {
		const clearBtn = ctx.q('[data-action="clear-history"]');
		if (!clearBtn || clearBtn.__bound) return;
		clearBtn.__bound = true;
		clearBtn.addEventListener('click', async () => {
			const ok = await confirmDanger(
				'将清空全部历史采样数据（当前 ' + ((ctx.state.status && ctx.state.status.lines) || 0) + ' 条）。' +
				'旧数据保留在 history.*.old 归档中。此操作不可撤销。',
				'清空历史记录', '确定清空');
			if (!ok) return;
			clearBtn.disabled = true;
			const res = await ctx.actions.clearHistory();
			clearBtn.disabled = false;
			if (res && res.ok) {
				ctx.toast('历史记录已清空', 'ok');
				ctx.refresh({ status: true, series: true, force: true });
			} else {
				ctx.toast((res && res.error) || '清空失败', 'err');
			}
		});
	},

	rebindDisplay(ctx) {
		const boxes = ctx.root.querySelectorAll('[data-hide-toggle]');
		for (const box of boxes) {
			if (box.__bound) continue;
			box.__bound = true;
			box.addEventListener('change', async () => {
				const key = box.getAttribute('data-hide-toggle');
				box.disabled = true;
				const res = await ctx.actions.toggleHide(key);
				box.disabled = false;
				if (res && res.ok) {
					ctx.syncHide(res.data && res.data.hide);
					ctx.toast((box.checked ? '已显示 ' : '已隐藏 ') + (HIDE_LABELS[key] || key), 'ok');
					this.paint(ctx);
				} else {
					box.checked = !box.checked;
					ctx.toast((res && res.error) || '设置失败', 'err');
				}
			});
		}
	},

	rebindTheme(ctx) {
		const btns = ctx.root.querySelectorAll('[data-theme]');
		for (const b of btns) {
			if (b.__bound) continue;
			b.__bound = true;
			b.addEventListener('click', () => {
				themeCtrl.setMode(b.getAttribute('data-theme'));
				this.paintTheme(ctx);
			});
		}
	}
};
