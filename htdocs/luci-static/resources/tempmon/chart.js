/*
 * tempmon chart v1.0.0 — 自研 SVG 图表库（在原 v3.0 内核上增强，非重写）
 *
 * 保留：CSS 变量驱动配色、平滑曲线、面积填充、悬停十字线、图例开关、
 *       cfg.series[].get(point) 取值契约、window.tempmonChart.draw() 入口签名
 *
 * 新增（对应需求 C）：
 *   C1 鼠标滚轮缩放 X 轴 + 拖拽平移（含触摸单指平移 / 双指捏合）
 *   C2 Y 轴动态留白：按变异系数决定 padding，刻度取“整齐数”但不撑大定义域，
 *      从根本上消除极端尖峰造成的大片空白
 *   C4 切换时间范围淡入 + 线条描绘动画，禁止生硬替换
 *   C5 十字光标吸附最近数据点 + 多系列完整 tooltip + 可点击图例开关
 *   C6 导出 PNG（克隆 SVG 并内联计算样式，解决 CSS 变量在 <img> 中不解析）
 *   B1 update(points) 增量刷新：保留缩放/平移视窗，不重建外壳、不播动画
 *
 * 性能：后端 api_data 上限 720 行；仍内置分桶降采样（min/max 保尖峰）作为安全网。
 *       高频交互统一走 requestAnimationFrame 节流，一帧最多重绘一次。
 */
'use strict';

(function (global) {
	var NS = 'http://www.w3.org/2000/svg';

	var PALETTE = [
		'var(--tm-c-blue)', 'var(--tm-c-cyan)', 'var(--tm-c-purple)', 'var(--tm-c-orange)',
		'var(--tm-c-green)', 'var(--tm-c-red)', 'var(--tm-c-pink)', 'var(--tm-c-indigo)'
	];

	/* X 轴刻度候选步长（秒）：1分 → 7天 */
	var TIME_STEPS = [60, 300, 600, 900, 1800, 3600, 7200, 14400, 21600, 43200, 86400, 172800, 604800];

	var instances = [];
	var uidSeq = 0;

	/* ------------------------------------------------------------ 基础工具 */

	function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
	function pad2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }

	function esc(s) {
		return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
			.replace(/>/g, '&gt;').replace(/"/g, '&quot;');
	}

	function el(tag, attrs, parent) {
		var e = document.createElementNS(NS, tag);
		if (attrs) for (var k in attrs) if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
		if (parent) parent.appendChild(e);
		return e;
	}

	/** 时间刻度文本：按“当前视窗跨度”而非总跨度决定格式，缩放后依然合理 */
	function fmtTime(ts, span) {
		var d = new Date(ts * 1000);
		if (span <= 86400) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
		return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
	}

	/** 选出合适的 X 轴时间步长并生成对齐刻度 */
	function timeTicks(t0, t1, maxTicks) {
		var span = t1 - t0;
		var step = TIME_STEPS[TIME_STEPS.length - 1];
		for (var i = 0; i < TIME_STEPS.length; i++) {
			if (span / TIME_STEPS[i] <= maxTicks) { step = TIME_STEPS[i]; break; }
		}
		var out = [], guard = 0;
		if (step >= 86400) {
			// 天级：对齐本地零点，避免 UTC 对齐把刻度推到 08:00
			var days = Math.max(1, Math.round(step / 86400));
			var d = new Date(t0 * 1000);
			d.setHours(0, 0, 0, 0);
			var cur = d.getTime() / 1000;
			while (cur < t0 && guard++ < 400) cur += days * 86400;
			guard = 0;
			while (cur <= t1 && guard++ < 400) { out.push(cur); cur += days * 86400; }
		} else {
			var start = Math.ceil(t0 / step) * step;
			for (var t = start; t <= t1 && guard++ < 400; t += step) out.push(t);
		}
		if (!out.length) out = [t0, (t0 + t1) / 2, t1];
		return { ticks: out, step: step };
	}

	/** 1 / 2 / 5 × 10^k 的“整齐数” */
	function niceNum(x, round) {
		if (!(x > 0)) return 1;
		var exp = Math.floor(Math.log(x) / Math.LN10);
		var f = x / Math.pow(10, exp);
		var nf;
		if (round) {
			if (f < 1.5) nf = 1; else if (f < 3) nf = 2; else if (f < 7) nf = 5; else nf = 10;
		} else {
			if (f <= 1) nf = 1; else if (f <= 2) nf = 2; else if (f <= 5) nf = 5; else nf = 10;
		}
		return nf * Math.pow(10, exp);
	}

	/** 在 [min,max] 内生成整齐刻度，但不扩张定义域（C2 的关键） */
	function axisTicks(min, max, maxTicks) {
		var range = max - min;
		if (!(range > 0)) return [min];
		var step = niceNum(range / Math.max(1, maxTicks), true);
		var out = [], guard = 0;
		var t = Math.ceil(min / step) * step;
		for (; t <= max + step * 1e-9 && guard++ < 64; t += step) {
			out.push(Math.abs(t) < step * 1e-9 ? 0 : t);
		}
		if (!out.length) out = [min, max];
		return out;
	}

	/* 把 var(--x) 解析成真实颜色。导出 PNG 时必须这样做：
	   SVG 塞进 <img> 后脱离文档，CSS 变量不再继承，否则导出全透明 */
	var probe = null;
	function resolveColor(c) {
		if (typeof c !== 'string') return '#888888';
		if (c.indexOf('var(') !== 0) return c;
		var host = document.getElementById('tm-app') || document.body || document.documentElement;
		if (!probe || probe.parentNode !== host) {
			if (probe && probe.parentNode) probe.parentNode.removeChild(probe);
			probe = document.createElement('span');
			probe.style.display = 'none';
			host.appendChild(probe);
		}
		probe.style.color = c;
		return global.getComputedStyle(probe).color || '#888888';
	}

	function cssVar(name, fallback) {
		var host = document.getElementById('tm-app') || document.documentElement;
		var v = global.getComputedStyle(host).getPropertyValue(name);
		return (v && v.trim()) || fallback;
	}

	/* ------------------------------------------------------------- 图表类 */

	function Chart(container, cfg) {
		this.id = ++uidSeq;
		this.c = container;
		this.cfg = cfg || {};
		this.series = [];

		/* 视窗：[0,1] 表示占全量时间范围的比例，缩放/平移只改这两个数 */
		this.viewFrom = 0;
		this.viewTo = 1;

		this.padL = 56;
		this.padR = 14;
		this.padT = 16;
		this.padB = 30;
		this.yTickCount = 5;
		this.xTickCount = 6;

		this._valsKey = null;
		this._vals = [];
		this._sorted = true;
		this._raf = 0;
		this._drag = null;
		this._pinch = null;
		this._geom = null;
		this._dots = [];
		this._linePaths = [];

		container.__tmChart = this;
		instances.push(this);

		this._shell();
		this.setConfig(cfg, { animate: false, resetView: true });
	}

	/** 外壳只建一次：绘图区 / 图例 / 工具条，避免每次重绘重建 DOM */
	Chart.prototype._shell = function () {
		var c = this.c;
		c.innerHTML = '';
		c.classList.add('tm-chart');

		this.plot = document.createElement('div');
		this.plot.className = 'tm-chart-plot';

		this.svg = el('svg', { class: 'tm-chart-svg' });
		this.svg.style.display = 'block';
		this.plot.appendChild(this.svg);

		this.tip = document.createElement('div');
		this.tip.className = 'tm-chart-tip';
		this.tip.style.display = 'none';
		this.plot.appendChild(this.tip);

		this.empty = document.createElement('div');
		this.empty.className = 'tm-chart-empty';
		this.empty.style.display = 'none';

		this.legend = document.createElement('div');
		this.legend.className = 'tm-chart-legend';

		this.bar = document.createElement('div');
		this.bar.className = 'tm-chart-toolbar';

		c.appendChild(this.plot);
		c.appendChild(this.empty);
		c.appendChild(this.legend);
		c.appendChild(this.bar);

		this._bind();
		this._observe();
	};

	/** 交互事件只绑定一次（挂在 plot 上，重绘 svg 内容不会丢监听） */
	Chart.prototype._bind = function () {
		var self = this;
		var p = this.plot;

		/* --- 滚轮缩放 X 轴（C1），以光标位置为锚点 --- */
		p.addEventListener('wheel', function (e) {
			if (!self._hasData()) return;
			e.preventDefault();
			var r = p.getBoundingClientRect();
			var iw = Math.max(1, self.w - self.padL - self.padR);
			var fx = clamp((e.clientX - r.left - self.padL) / iw, 0, 1);
			self._zoomAt(fx, e.deltaY < 0 ? 1.18 : 1 / 1.18);
			self._scheduleRender();
		}, { passive: false });

		/* --- 鼠标拖拽平移（C1） --- */
		p.addEventListener('mousedown', function (e) {
			if (!self._hasData() || e.button !== 0) return;
			self._drag = { x: e.clientX, from: self.viewFrom, to: self.viewTo, moved: false };
			p.classList.add('is-grabbing');
			e.preventDefault();
		});

		global.addEventListener('mousemove', function (e) {
			if (!self._drag) return;
			var iw = Math.max(1, self.w - self.padL - self.padR);
			var dx = e.clientX - self._drag.x;
			if (Math.abs(dx) > 2) self._drag.moved = true;
			var span = self._drag.to - self._drag.from;
			var dFrac = -dx / iw * span;
			self._setWindow(self._drag.from + dFrac, self._drag.to + dFrac);
			self._scheduleRender();
		});

		global.addEventListener('mouseup', function () {
			if (!self._drag) return;
			self._drag = null;
			p.classList.remove('is-grabbing');
		});

		/* --- 悬停十字线 + tooltip（C5） --- */
		p.addEventListener('mousemove', function (e) {
			if (self._drag) { self._hideTip(); return; }
			self._hover(e.clientX, e.clientY);
		});
		p.addEventListener('mouseleave', function () { self._hideTip(); });

		/* --- 双击复位 --- */
		p.addEventListener('dblclick', function () { self.resetView(); });

		/* --- 触摸：单指平移 / 双指捏合缩放 --- */
		p.addEventListener('touchstart', function (e) {
			if (!self._hasData()) return;
			if (e.touches.length === 1) {
				self._drag = { x: e.touches[0].clientX, from: self.viewFrom, to: self.viewTo, moved: false, touch: true };
			} else if (e.touches.length === 2) {
				self._drag = null;
				self._pinch = {
					d: Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1,
					from: self.viewFrom, to: self.viewTo
				};
			}
		}, { passive: true });

		p.addEventListener('touchmove', function (e) {
			if (self._pinch && e.touches.length === 2) {
				if (e.cancelable) e.preventDefault();
				var d = Math.abs(e.touches[0].clientX - e.touches[1].clientX) || 1;
				self.viewFrom = self._pinch.from;
				self.viewTo = self._pinch.to;
				self._zoomAt(0.5, d / self._pinch.d);
				self._scheduleRender();
			} else if (self._drag && self._drag.touch && e.touches.length === 1) {
				var iw = Math.max(1, self.w - self.padL - self.padR);
				var dx = e.touches[0].clientX - self._drag.x;
				// 横向意图明显时才接管，避免和页面纵向滚动打架
				if (Math.abs(dx) > 6) {
					if (e.cancelable) e.preventDefault();
					var span = self._drag.to - self._drag.from;
					var dFrac = -dx / iw * span;
					self._setWindow(self._drag.from + dFrac, self._drag.to + dFrac);
					self._scheduleRender();
				}
			}
		}, { passive: false });

		p.addEventListener('touchend', function () {
			self._drag = null;
			self._pinch = null;
			self._hideTip();
		});
	};

	/** 尺寸自适应：优先 ResizeObserver，退化到 window.resize */
	Chart.prototype._observe = function () {
		var self = this;
		this._measure();
		if (typeof ResizeObserver !== 'undefined') {
			this._ro = new ResizeObserver(function () {
				var w = self.plot.clientWidth || self.c.clientWidth || 600;
				if (Math.abs(w - self.w) > 1) { self._measure(); self._scheduleRender(); }
			});
			this._ro.observe(this.plot);
		}
	};

	Chart.prototype._measure = function () {
		this.w = this.plot.clientWidth || this.c.clientWidth || 600;
		// 高度优先取容器实际高度（CSS 已按断点设定），否则用 cfg.height
		this.h = this.plot.clientHeight || this.cfg.height || 280;
		// 窄屏收紧左边距，把空间让给绘图区（D 布局诉求）
		this.padL = this.w < 420 ? 40 : 56;
		this.xTickCount = this.w < 520 ? 4 : 6;
	};

	Chart.prototype._hasData = function () {
		return !!(this.cfg.points && this.cfg.points.length);
	};

	/* ------------------------------------------------------- 配置与数据 */

	/**
	 * 换配置（切换时间范围走这里）
	 * @param {Object} cfg
	 * @param {Object} [opts] { animate, resetView }
	 */
	Chart.prototype.setConfig = function (cfg, opts) {
		opts = opts || {};
		var prevSig = this._seriesSig();
		this.cfg = cfg || {};
		this._valsKey = null; // 数据集变了，强制重新抽取

		this.series = (this.cfg.series || []).map(function (s, i) {
			return {
				label: s.label,
				color: s.color || PALETTE[i % PALETTE.length],
				dashed: !!s.dashed,
				thick: !!s.thick,
				smooth: s.smooth !== false,
				fill: !!s.fill,
				get: s.get,
				visible: s.hidden ? false : true
			};
		});

		if (opts.resetView) { this.viewFrom = 0; this.viewTo = 1; }
		this._measure();
		this._buildLegend(prevSig !== this._seriesSig());
		this.render({ animate: !!opts.animate });
	};

	/**
	 * 增量刷新（B1）：采集到新点后调用。
	 * 不重建外壳、不播动画、保留当前缩放/平移视窗。
	 */
	Chart.prototype.update = function (points) {
		if (!this.cfg) return;
		this.cfg.points = points || [];
		this._valsKey = null;
		// 视窗贴着右边缘时保持贴边，让新数据自然“流进来”
		if (this.viewTo >= 0.999) this.viewTo = 1;
		this._measure();
		this.render({ animate: false });
	};

	Chart.prototype._seriesSig = function () {
		if (!this.series) return '';
		return this.series.map(function (s) { return s.label + '|' + s.color; }).join(',');
	};

	/** 抽取所有系列的数值并缓存（同一数据集只做一次 O(n) 遍历） */
	Chart.prototype._extract = function () {
		var pts = this.cfg.points || [];
		if (this._valsKey === pts && this._vals.length === this.series.length) return;

		this._vals = [];
		for (var s = 0; s < this.series.length; s++) {
			var get = this.series[s].get;
			var out = new Array(pts.length);
			for (var i = 0; i < pts.length; i++) {
				var v = typeof get === 'function' ? get(pts[i]) : null;
				v = Number(v);
				out[i] = isFinite(v) ? v : null;
			}
			this._vals.push(out);
		}

		// 二分查找要求时间升序；不满足则退化为全量扫描
		this._sorted = true;
		for (var k = 1; k < pts.length; k++) {
			if (Number(pts[k][0]) < Number(pts[k - 1][0])) { this._sorted = false; break; }
		}
		this._valsKey = pts;
	};

	/** 第一个 ts >= t 的下标 */
	Chart.prototype._lowerBound = function (t) {
		var pts = this.cfg.points;
		var lo = 0, hi = pts.length;
		while (lo < hi) {
			var mid = (lo + hi) >> 1;
			if (Number(pts[mid][0]) < t) lo = mid + 1; else hi = mid;
		}
		return lo;
	};

	/** 当前视窗对应的时间区间与点下标区间 */
	Chart.prototype._window_ = function () {
		var pts = this.cfg.points;
		var n = pts.length;
		var ft0 = Number(pts[0][0]);
		var ft1 = Number(pts[n - 1][0]);
		if (!(ft1 > ft0)) ft1 = ft0 + 1;

		var span = ft1 - ft0;
		var vt0 = ft0 + this.viewFrom * span;
		var vt1 = ft0 + this.viewTo * span;
		if (!(vt1 > vt0)) vt1 = vt0 + 1;

		var i0 = 0, i1 = n - 1;
		if (this._sorted) {
			i0 = clamp(this._lowerBound(vt0) - 1, 0, n - 1);
			i1 = clamp(this._lowerBound(vt1), 0, n - 1);
			if (i1 < i0) i1 = i0;
		}
		return { ft0: ft0, ft1: ft1, vt0: vt0, vt1: vt1, i0: i0, i1: i1, n: n };
	};

	/** 缩放：以视窗内 fx 比例处为锚点 */
	Chart.prototype._zoomAt = function (fx, factor) {
		var span = this.viewTo - this.viewFrom;
		var anchor = this.viewFrom + span * fx;
		// 最小视窗：至少保留 12 个采样点，或总范围的 0.5%
		var n = (this.cfg.points || []).length || 1;
		var minSpan = Math.max(12 / n, 0.005);
		var newSpan = clamp(span / factor, minSpan, 1);
		var from = anchor - newSpan * fx;
		this._setWindow(from, from + newSpan);
	};

	/** 设置视窗并夹紧到 [0,1]，保持跨度不变 */
	Chart.prototype._setWindow = function (from, to) {
		var span = to - from;
		if (from < 0) { from = 0; to = span; }
		if (to > 1) { to = 1; from = 1 - span; }
		this.viewFrom = clamp(from, 0, 1);
		this.viewTo = clamp(to, this.viewFrom + 1e-6, 1);
	};

	Chart.prototype.resetView = function () {
		this.viewFrom = 0;
		this.viewTo = 1;
		this.render({ animate: false });
	};

	Chart.prototype.isZoomed = function () {
		return this.viewFrom > 1e-4 || this.viewTo < 1 - 1e-4;
	};

	/** rAF 节流渲染：一帧内多次请求只画一次 */
	Chart.prototype._scheduleRender = function () {
		var self = this;
		if (this._raf) return;
		this._raf = requestAnimationFrame(function () {
			self._raf = 0;
			self.render({ animate: false });
		});
	};

	/* ------------------------------------------------------------- 渲染 */

	Chart.prototype.render = function (opts) {
		opts = opts || {};
		var self = this;
		var cfg = this.cfg;
		var pts = cfg.points || [];
		var svg = this.svg;
		if (!svg) return;

		// 清空 svg 内容（保留元素本身，减少 DOM 结构抖动）
		while (svg.firstChild) svg.removeChild(svg.firstChild);
		this._hideTip();

		if (!pts.length) {
			this.plot.style.display = 'none';
			this.empty.style.display = '';
			this.empty.innerHTML = '<div class="tm-empty">' +
				'<div class="tm-empty-text">' + esc(cfg.empty || '暂无数据') + '</div></div>';
			this.bar.innerHTML = '';
			return;
		}
		this.plot.style.display = '';
		this.empty.style.display = 'none';

		this._extract();
		var W = this._window_();
		var w = this.w, h = this.h;
		var iw = Math.max(10, w - this.padL - this.padR);
		var ih = Math.max(10, h - this.padT - this.padB);

		svg.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
		svg.setAttribute('width', w);
		svg.setAttribute('height', h);

		var X = function (ts) { return self.padL + (ts - W.vt0) / (W.vt1 - W.vt0) * iw; };

		/* --- Y 轴定义域：只统计可视系列在视窗内的值（C2） --- */
		var vmin = Infinity, vmax = -Infinity, si, i;
		for (si = 0; si < this.series.length; si++) {
			if (!this.series[si].visible) continue;
			var vals = this._vals[si];
			if (!vals) continue;
			for (i = W.i0; i <= W.i1; i++) {
				var v = vals[i];
				if (v == null) continue;
				if (v < vmin) vmin = v;
				if (v > vmax) vmax = v;
			}
		}
		if (!isFinite(vmin) || !isFinite(vmax)) { vmin = 0; vmax = 1; }
		if (vmin === vmax) { vmin -= 1; vmax += 1; }

		var ys = this._yScale(vmin, vmax);
		var Y = function (val) { return self.padT + (ys.max - val) / (ys.max - ys.min) * ih; };

		/* --- 裁剪区：平移时曲线不会溢出到坐标轴外 --- */
		var clipId = 'tmclip' + this.id;
		var defs = el('defs', null, svg);
		var cp = el('clipPath', { id: clipId }, defs);
		el('rect', { x: this.padL, y: this.padT - 2, width: iw, height: ih + 4 }, cp);

		/* --- 网格与坐标轴 --- */
		var gGrid = el('g', { class: 'tm-chart-grid' }, svg);
		/* 把刻度间距作为第二参传给 yFmt：值域很窄时（真机温度长期停在
		   40.0–41.x°C，5 个刻度全落在 2° 内）格式化函数据此增加小数位，
		   否则标签会取整成「39° 40° 40° 41° 41°」这种重复值。
		   旧的 yFmt 只用第一参，多传一个参数不影响它们。 */
		var yStep = ys.ticks.length > 1 ? (ys.ticks[1] - ys.ticks[0]) : (ys.max - ys.min);
		for (i = 0; i < ys.ticks.length; i++) {
			var gy = Y(ys.ticks[i]);
			if (gy < this.padT - 1 || gy > h - this.padB + 1) continue;
			el('line', { x1: this.padL, y1: gy, x2: w - this.padR, y2: gy, class: 'tm-chart-gridline' }, gGrid);
			var ty = el('text', { x: this.padL - 8, y: gy + 4, class: 'tm-chart-ylabel', 'text-anchor': 'end' }, gGrid);
			ty.textContent = cfg.yFmt ? cfg.yFmt(ys.ticks[i], yStep) : String(Math.round(ys.ticks[i] * 100) / 100);
		}

		var viewSpan = W.vt1 - W.vt0;
		var xt = timeTicks(W.vt0, W.vt1, this.xTickCount);
		for (i = 0; i < xt.ticks.length; i++) {
			var gx = X(xt.ticks[i]);
			if (gx < this.padL - 1 || gx > w - this.padR + 1) continue;
			el('line', { x1: gx, y1: this.padT, x2: gx, y2: h - this.padB, class: 'tm-chart-gridline-v' }, gGrid);
			var tx = el('text', { x: gx, y: h - this.padB + 18, class: 'tm-chart-xlabel', 'text-anchor': 'middle' }, gGrid);
			tx.textContent = fmtTime(xt.ticks[i], viewSpan);
		}

		el('line', { x1: this.padL, y1: this.padT, x2: this.padL, y2: h - this.padB, class: 'tm-chart-axis' }, gGrid);
		el('line', { x1: this.padL, y1: h - this.padB, x2: w - this.padR, y2: h - this.padB, class: 'tm-chart-axis' }, gGrid);

		/* --- 分桶降采样（数据量大时才生效，min/max 保尖峰） --- */
		var bucketCount = clamp(Math.round(iw / 2), 40, 600);
		var ranges = this._bucketRanges(W.i0, W.i1, bucketCount);

		/* --- 系列曲线 --- */
		var gSeries = el('g', { class: 'tm-chart-series', 'clip-path': 'url(#' + clipId + ')' }, svg);
		this._linePaths = [];
		this._seriesPx = [];

		for (si = 0; si < this.series.length; si++) {
			var sd = this.series[si];
			if (!sd.visible) { this._seriesPx.push(null); continue; }

			var px = this._seriesPixels(si, ranges, X, Y);
			this._seriesPx.push(px);

			// 按 null 断点切分成若干连续段
			var segs = [], cur = [];
			for (i = 0; i < px.length; i++) {
				if (px[i] == null) { if (cur.length) { segs.push(cur); cur = []; } continue; }
				cur.push(px[i]);
			}
			if (cur.length) segs.push(cur);

			for (var g = 0; g < segs.length; g++) {
				var P = segs[g];
				if (!P.length) continue;
				var d = 'M' + P[0][0].toFixed(1) + ' ' + P[0][1].toFixed(1);
				for (var k = 1; k < P.length; k++) {
					if (sd.smooth && P.length > 2) {
						var cxm = (P[k - 1][0] + P[k][0]) / 2;
						d += ' C' + cxm.toFixed(1) + ' ' + P[k - 1][1].toFixed(1) +
							' ' + cxm.toFixed(1) + ' ' + P[k - 1][1].toFixed(1) +
							' ' + P[k][0].toFixed(1) + ' ' + P[k][1].toFixed(1);
					} else {
						d += ' L' + P[k][0].toFixed(1) + ' ' + P[k][1].toFixed(1);
					}
				}

				if (sd.fill && P.length > 1) {
					var baseY = (h - this.padB).toFixed(1);
					var area = el('path', {
						d: d + ' L' + P[P.length - 1][0].toFixed(1) + ' ' + baseY +
						   ' L' + P[0][0].toFixed(1) + ' ' + baseY + ' Z',
						class: 'tm-chart-area'
					}, gSeries);
					area.style.fill = sd.color;
				}

				var attrs = {
					d: d,
					class: 'tm-chart-line',
					fill: 'none',
					'stroke-width': sd.thick ? 2.5 : 1.8,
					'stroke-linecap': 'round',
					'stroke-linejoin': 'round'
				};
				if (sd.dashed) attrs['stroke-dasharray'] = '6 4';
				var pe = el('path', attrs, gSeries);
				pe.style.stroke = sd.color;
				// 虚线系列不参与描绘动画，否则 dasharray 会被覆盖
				if (!sd.dashed) this._linePaths.push(pe);
			}
		}

		/* --- 十字线与悬停标记（元素常驻，hover 时只改属性，不重建） --- */
		var gMark = el('g', { class: 'tm-chart-markers', 'clip-path': 'url(#' + clipId + ')' }, svg);
		this._vline = el('line', {
			class: 'tm-chart-cross', visibility: 'hidden',
			y1: this.padT, y2: h - this.padB
		}, gMark);

		this._dots = [];
		for (si = 0; si < this.series.length; si++) {
			if (!this.series[si].visible) { this._dots.push(null); continue; }
			var dot = el('circle', { r: 3.5, class: 'tm-chart-dot', visibility: 'hidden', 'stroke-width': 2 }, gMark);
			dot.style.fill = this.series[si].color;
			dot.style.stroke = cssVar('--tm-bg-panel', '#131836');
			this._dots.push(dot);
		}

		/* --- 命中区（透明矩形，接管鼠标） --- */
		el('rect', {
			x: this.padL, y: this.padT, width: iw, height: ih,
			fill: 'transparent', class: 'tm-chart-hit'
		}, svg);

		this._geom = { X: X, Y: Y, W: W, iw: iw, ih: ih };
		this._buildToolbar();

		if (opts.animate) this._animateIn();
	};

	/** C2：动态留白 —— 波动剧烈时少留白，近乎恒定时多留白，且刻度不撑大定义域 */
	Chart.prototype._yScale = function (vmin, vmax) {
		var cfg = this.cfg;
		var lo = cfg.yMin != null ? Number(cfg.yMin) : vmin;
		var hi = cfg.yMax != null ? Number(cfg.yMax) : vmax;
		if (cfg.yZero) lo = Math.min(0, lo);

		// 仅在未强制指定上下限时做动态 padding
		if (cfg.yMin == null || cfg.yMax == null) {
			var range = hi - lo;
			var mid = (hi + lo) / 2;
			// 变异系数：越大说明波动越剧烈，越不需要留白
			var cv = Math.abs(mid) > 1e-9 ? range / Math.abs(mid) : (range > 0 ? 1 : 0);
			var p;
			if (cv > 1.2) p = 0.03;
			else if (cv > 0.5) p = 0.06;
			else if (cv > 0.15) p = 0.10;
			else p = 0.35;
			var padv = range * p;
			if (cfg.yMin == null) lo -= padv;
			if (cfg.yMax == null) hi += padv;
			if (cfg.yZero) lo = Math.min(0, lo);
		}
		if (!(hi > lo)) hi = lo + 1;

		return { min: lo, max: hi, ticks: axisTicks(lo, hi, this.yTickCount) };
	};

	/** 分桶区间：点数不多时逐点，点数多时按桶（每桶最多贡献 min/max 两点） */
	Chart.prototype._bucketRanges = function (i0, i1, count) {
		var n = i1 - i0 + 1;
		var out = [];
		if (n <= count * 2) {
			for (var i = i0; i <= i1; i++) out.push([i, i]);
			return out;
		}
		var size = n / count;
		for (var b = 0; b < count; b++) {
			var s = i0 + Math.floor(b * size);
			var e = i0 + Math.floor((b + 1) * size) - 1;
			if (e < s) e = s;
			if (e > i1) e = i1;
			out.push([s, e]);
		}
		return out;
	};

	/** 桶 → 像素点；null 表示该桶无有效值，用于断线 */
	Chart.prototype._seriesPixels = function (si, ranges, X, Y) {
		var vals = this._vals[si];
		var pts = this.cfg.points;
		var out = [];
		if (!vals) return out;
		for (var b = 0; b < ranges.length; b++) {
			var s = ranges[b][0], e = ranges[b][1];
			if (s === e) {
				var v0 = vals[s];
				out.push(v0 == null ? null : [X(Number(pts[s][0])), Y(v0)]);
				continue;
			}
			var imin = -1, imax = -1, vmin = Infinity, vmax = -Infinity;
			for (var i = s; i <= e; i++) {
				var v = vals[i];
				if (v == null) continue;
				if (v < vmin) { vmin = v; imin = i; }
				if (v > vmax) { vmax = v; imax = i; }
			}
			if (imin < 0) { out.push(null); continue; }
			if (imin === imax) {
				out.push([X(Number(pts[imin][0])), Y(vmin)]);
			} else if (imin < imax) {
				out.push([X(Number(pts[imin][0])), Y(vmin)]);
				out.push([X(Number(pts[imax][0])), Y(vmax)]);
			} else {
				out.push([X(Number(pts[imax][0])), Y(vmax)]);
				out.push([X(Number(pts[imin][0])), Y(vmin)]);
			}
		}
		return out;
	};

	/* ------------------------------------------------- C4 切换过渡动画 */

	Chart.prototype._animateIn = function () {
		var plot = this.plot;
		plot.classList.remove('is-enter');
		void plot.offsetWidth; // 强制回流以重启动画
		plot.classList.add('is-enter');

		// 尊重系统“减少动态效果”偏好（低端设备/无障碍）
		var reduce = global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches;
		if (reduce || !this._linePaths || !this._linePaths.length) return;

		for (var i = 0; i < this._linePaths.length; i++) {
			(function (path) {
				var len = 0;
				try { len = path.getTotalLength(); } catch (e) { len = 0; }
				if (!len || !isFinite(len)) return;
				path.style.transition = 'none';
				path.style.strokeDasharray = len + ' ' + len;
				path.style.strokeDashoffset = String(len);
				requestAnimationFrame(function () {
					path.style.transition = 'stroke-dashoffset 420ms cubic-bezier(0.16,1,0.3,1)';
					path.style.strokeDashoffset = '0';
				});
				// 动画结束后清掉 dasharray，避免影响后续重绘与 PNG 导出
				setTimeout(function () {
					path.style.transition = '';
					path.style.strokeDasharray = '';
					path.style.strokeDashoffset = '';
				}, 480);
			})(this._linePaths[i]);
		}
	};

	/* --------------------------------------------------- C5 十字线与提示 */

	Chart.prototype._hover = function (clientX, clientY) {
		if (!this._geom || !this._hasData()) return;
		var G = this._geom;
		var r = this.plot.getBoundingClientRect();
		var mx = clientX - r.left;
		if (mx < this.padL || mx > this.padL + G.iw) { this._hideTip(); return; }

		// 像素 → 时间 → 最近点下标（二分 + 左右邻域比较）
		var t = G.W.vt0 + (mx - this.padL) / G.iw * (G.W.vt1 - G.W.vt0);
		var pts = this.cfg.points;
		var idx = this._sorted ? clamp(this._lowerBound(t), G.W.i0, G.W.i1) : G.W.i0;
		if (this._sorted && idx > G.W.i0 && idx < pts.length) {
			var a = Math.abs(Number(pts[idx - 1][0]) - t);
			var b = Math.abs(Number(pts[idx][0]) - t);
			if (a < b) idx = idx - 1;
		}

		var px = G.X(Number(pts[idx][0]));
		this._vline.setAttribute('x1', px);
		this._vline.setAttribute('x2', px);
		this._vline.setAttribute('visibility', 'visible');

		var rows = [];
		var span = G.W.vt1 - G.W.vt0;
		for (var si = 0; si < this.series.length; si++) {
			var dot = this._dots[si];
			if (!dot) continue;
			var v = this._vals[si] ? this._vals[si][idx] : null;
			if (v == null) { dot.setAttribute('visibility', 'hidden'); continue; }
			dot.setAttribute('cx', px);
			dot.setAttribute('cy', G.Y(v));
			dot.setAttribute('visibility', 'visible');
			rows.push('<div class="tm-chart-tip-row">' +
				'<span class="tm-chart-tip-dot" style="background:' + this.series[si].color + '"></span>' +
				'<span class="tm-chart-tip-label">' + esc(this.series[si].label) + '</span>' +
				'<b>' + esc(this.cfg.yFmt ? this.cfg.yFmt(v) : String(Math.round(v * 100) / 100)) + '</b></div>');
		}

		this.tip.innerHTML = '<div class="tm-chart-tip-time">' + esc(fmtTime(Number(pts[idx][0]), span)) + '</div>' + rows.join('');
		this.tip.style.display = 'block';

		// 定位 + 边界翻转，避免溢出容器
		var tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
		var left = px + 14;
		if (left + tw > this.w - 4) left = px - tw - 14;
		left = clamp(left, 4, Math.max(4, this.w - tw - 4));
		var top = clamp(clientY - r.top - th / 2, 4, Math.max(4, this.h - th - 4));
		this.tip.style.left = left + 'px';
		this.tip.style.top = top + 'px';
	};

	Chart.prototype._hideTip = function () {
		if (this.tip) this.tip.style.display = 'none';
		if (this._vline) this._vline.setAttribute('visibility', 'hidden');
		if (this._dots) {
			for (var i = 0; i < this._dots.length; i++) {
				if (this._dots[i]) this._dots[i].setAttribute('visibility', 'hidden');
			}
		}
	};

	/* ------------------------------------------------------- 图例与工具条 */

	Chart.prototype._buildLegend = function (force) {
		var self = this;
		var sig = this._seriesSig();
		if (!force && this._legendSig === sig) return;
		this._legendSig = sig;
		this.legend.innerHTML = '';

		this.series.forEach(function (sd) {
			var chip = document.createElement('button');
			chip.type = 'button';
			chip.className = 'tm-chart-chip';
			chip.setAttribute('aria-pressed', sd.visible ? 'true' : 'false');
			chip.innerHTML = '<span class="tm-chart-chip-dot" style="background:' + sd.color + '"></span>' + esc(sd.label);
			if (!sd.visible) chip.classList.add('off');
			chip.addEventListener('click', function () {
				sd.visible = !sd.visible;
				chip.classList.toggle('off', !sd.visible);
				chip.setAttribute('aria-pressed', sd.visible ? 'true' : 'false');
				self.render({ animate: false });
			});
			self.legend.appendChild(chip);
		});
	};

	Chart.prototype._buildToolbar = function () {
		var self = this;
		var zoomed = this.isZoomed();
		var n = (this.cfg.points || []).length;

		this.bar.innerHTML = '';
		if (!n) return;

		var hint = document.createElement('span');
		hint.className = 'tm-chart-hint';
		hint.textContent = zoomed
			? '已缩放至 ' + Math.round((this.viewTo - this.viewFrom) * 100) + '% · 拖拽平移 · 双击复位'
			: '滚轮缩放 · 拖拽平移 · 双击复位';
		this.bar.appendChild(hint);

		var count = document.createElement('span');
		count.className = 'tm-chart-count';
		count.textContent = n + ' 点';
		this.bar.appendChild(count);

		var reset = document.createElement('button');
		reset.type = 'button';
		reset.className = 'tm-btn tm-btn-xs';
		reset.textContent = '复位';
		reset.disabled = !zoomed;
		reset.addEventListener('click', function () { self.resetView(); });
		this.bar.appendChild(reset);

		var png = document.createElement('button');
		png.type = 'button';
		png.className = 'tm-btn tm-btn-xs';
		png.innerHTML = '导出 PNG';
		png.addEventListener('click', function () { self.exportPNG(); });
		this.bar.appendChild(png);
	};

	/* ------------------------------------------------------ C6 导出 PNG */

	/**
	 * 导出 PNG。
	 * 关键：SVG 序列化进 <img> 后就脱离了文档，CSS 变量与类样式全部失效，
	 * 因此必须把 getComputedStyle 的结果逐元素内联到克隆节点上。
	 */
	Chart.prototype.exportPNG = function () {
		var self = this;
		var src = this.svg;
		if (!src || !this._hasData()) return;

		var clone = src.cloneNode(true);
		clone.setAttribute('xmlns', NS);
		clone.setAttribute('width', this.w);
		clone.setAttribute('height', this.h);

		inlineStyles(src, clone);

		// 十字线/标记点/命中区不导出，只留干净曲线
		var hidden = clone.querySelectorAll('.tm-chart-cross,.tm-chart-dot,.tm-chart-hit');
		for (var i = 0; i < hidden.length; i++) hidden[i].setAttribute('visibility', 'hidden');

		var bg = cssVar('--tm-bg-panel', '#131836');
		var rect = document.createElementNS(NS, 'rect');
		rect.setAttribute('x', 0); rect.setAttribute('y', 0);
		rect.setAttribute('width', this.w); rect.setAttribute('height', this.h);
		rect.setAttribute('fill', bg);
		clone.insertBefore(rect, clone.firstChild);

		var str;
		try {
			str = new XMLSerializer().serializeToString(clone);
		} catch (e) {
			console.error('[tempmon] 图表序列化失败:', e);
			return;
		}

		var url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(str);
		var img = new Image();
		img.onload = function () {
			try {
				var scale = 2; // 2x 导出，高分屏与截图都清晰
				var cv = document.createElement('canvas');
				cv.width = self.w * scale;
				cv.height = self.h * scale;
				var ctx = cv.getContext('2d');
				ctx.fillStyle = bg;
				ctx.fillRect(0, 0, cv.width, cv.height);
				ctx.drawImage(img, 0, 0, cv.width, cv.height);

				var name = (self.cfg.title || 'tempmon-chart') + '-' +
					new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-') + '.png';
				var a = document.createElement('a');
				a.href = cv.toDataURL('image/png');
				a.download = name;
				document.body.appendChild(a);
				a.click();
				document.body.removeChild(a);
			} catch (err) {
				console.error('[tempmon] 导出 PNG 失败:', err);
			}
		};
		img.onerror = function () { console.error('[tempmon] 导出 PNG：SVG 图像加载失败'); };
		img.src = url;
	};

	/** 把源节点的计算样式递归复制到克隆节点 */
	function inlineStyles(srcNode, dstNode) {
		if (!srcNode || !dstNode) return;
		if (srcNode.nodeType === 1 && dstNode.setAttribute) {
			var cs = global.getComputedStyle(srcNode);
			var props = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray',
				'stroke-linecap', 'stroke-linejoin', 'opacity', 'font-family', 'font-size',
				'font-weight', 'text-anchor', 'visibility'];
			for (var i = 0; i < props.length; i++) {
				var v = cs.getPropertyValue(props[i]);
				if (v) dstNode.style.setProperty(props[i], v);
			}
		}
		var sk = srcNode.childNodes, dk = dstNode.childNodes;
		for (var j = 0; j < sk.length && j < dk.length; j++) {
			if (sk[j].nodeType === 1) inlineStyles(sk[j], dk[j]);
		}
	}

	/* ----------------------------------------------------------- 生命周期 */

	Chart.prototype.destroy = function () {
		if (this._raf) cancelAnimationFrame(this._raf);
		if (this._ro) { try { this._ro.disconnect(); } catch (e) { /* ignore */ } this._ro = null; }
		var idx = instances.indexOf(this);
		if (idx >= 0) instances.splice(idx, 1);
		if (this.c) { this.c.__tmChart = null; this.c.innerHTML = ''; }
		this.svg = this.plot = this.legend = this.bar = this.tip = null;
	};

	/* 窗口尺寸兜底（无 ResizeObserver 的浏览器），顺带清理已脱离 DOM 的实例 */
	var resizeTimer = null;
	global.addEventListener('resize', function () {
		clearTimeout(resizeTimer);
		resizeTimer = setTimeout(function () {
			for (var i = instances.length - 1; i >= 0; i--) {
				var inst = instances[i];
				if (!inst.plot || !inst.plot.isConnected) { inst.destroy(); continue; }
				inst._measure();
				inst.render({ animate: false });
			}
		}, 180);
	});

	/* ---------------------------------------------------------- 对外接口 */

	global.tempmonChart = {
		/**
		 * 绘制/复用图表。同一容器重复调用会复用实例并播放过渡动画，
		 * 这正是“切换时间范围不生硬替换”的实现方式（C4）。
		 */
		draw: function (container, cfg) {
			if (!container) return null;
			if (container.__tmChart) {
				container.__tmChart.setConfig(cfg, { animate: true, resetView: true });
				return container.__tmChart;
			}
			return new Chart(container, cfg);
		},

		/** 增量刷新（B1）：保留视窗，不播动画 */
		update: function (container, points) {
			var inst = container && container.__tmChart;
			if (!inst) return null;
			inst.update(points);
			return inst;
		},

		/** 取实例 */
		get: function (container) { return container ? (container.__tmChart || null) : null; },

		/** 销毁容器对应的图表（视图切换时调用，防泄漏） */
		destroy: function (container) {
			var inst = container && container.__tmChart;
			if (inst) inst.destroy();
		},

		/** 销毁所有已脱离 DOM 的图表 */
		prune: function () {
			for (var i = instances.length - 1; i >= 0; i--) {
				if (!instances[i].plot || !instances[i].plot.isConnected) instances[i].destroy();
			}
		},

		destroyAll: function () {
			while (instances.length) instances[0].destroy();
		},

		/** 供外部（如 sparkline）复用的调色板与颜色解析 */
		palette: PALETTE,
		resolveColor: resolveColor
	};
})(window);
