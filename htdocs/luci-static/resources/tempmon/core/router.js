/**
 * luci-app-tempmon — 路由模块 (history pushState)
 *
 * 重要约束：后端控制器 tempmon.lua 只注册了这些子路径：
 *   dashboard / cpu / memory / storage / network / procs / logs / settings / config
 * 其中 **没有 overview，也没有 sensors**。因此：
 *   - overview 复用服务端路由 dashboard
 *   - sensors 无服务端路由，只能用 ?view=sensors 查询参数承载，
 *     否则用户刷新页面会拿到 LuCI 404（这是不能接受的回归）
 *
 * 同时 base 前缀必须取自 TM_API.base（LuCI 可能挂在 /cgi-bin/luci 下），
 * 绝不能硬编码 '/admin/tempmon'。
 */

/* 视图定义：id 为内部标识，seg 为服务端路径段（null = 无服务端路由） */
export const VIEWS = [
	{ id: 'overview', seg: 'dashboard', label: '系统概览', icon: 'overview', group: 'monitor' },
	{ id: 'cpu',      seg: 'cpu',       label: 'CPU',      icon: 'cpu',      group: 'monitor' },
	{ id: 'memory',   seg: 'memory',    label: '内存',     icon: 'mem',      group: 'monitor' },
	{ id: 'storage',  seg: 'storage',   label: '存储',     icon: 'store',    group: 'monitor' },
	{ id: 'network',  seg: 'network',   label: '网络',     icon: 'net',      group: 'monitor' },
	{ id: 'procs',    seg: 'procs',     label: '进程',     icon: 'proc',     group: 'monitor' },
	{ id: 'sensors',  seg: null,        label: '传感器',   icon: 'gauge',    group: 'monitor' },
	{ id: 'logs',     seg: 'logs',      label: '日志',     icon: 'log',      group: 'manage' },
	{ id: 'settings', seg: 'settings',  label: '设置',     icon: 'set',      group: 'manage' }
];

/* LuCI 真实基址，例如 "/cgi-bin/luci/admin/tempmon" */
const BASE = (window.TM_API && window.TM_API.base) || '/admin/tempmon';

/**
 * 路由管理器
 */
class Router {
	constructor() {
		this.currentView = 'overview';
		this.listeners = [];
		this.initialized = false;
	}

	init() {
		if (this.initialized) return;
		this.currentView = this.parseFromLocation();

		/* 从 LuCI 菜单点进来时地址栏会停在 BASE：menu.d 里 admin/tempmon 用的是
		   alias 动作，而 dispatcher.uc 的 alias 分支是 dispatch() 内部重新派发、
		   并不发 302，所以 URL 不会自己变成 /dashboard。这里把它规范化，
		   让「地址栏显示 = 刷新后停留 = 可分享链接」三者一致。
		   parseFromLocation() 对空路径段已回退到 overview，视图本身不受影响；
		   受限环境下 replaceState 抛错就直接忽略。 */
		try {
			const p = window.location.pathname || '';
			if (p === BASE || p === BASE + '/') {
				window.history.replaceState({ view: this.currentView }, '', this.urlFor(this.currentView));
			}
		} catch (err) { /* 忽略：地址栏不规范不影响功能 */ }

		// 浏览器前进/后退：优先用 state，state 丢失时回退到 URL 解析
		window.addEventListener('popstate', (e) => {
			const view = (e.state && this.isValid(e.state.view))
				? e.state.view
				: this.parseFromLocation();
			this.currentView = view;
			this.notify(view, null, false);
		});

		this.initialized = true;
	}

	/** 校验视图 id */
	isValid(id) {
		return VIEWS.some(v => v.id === id);
	}

	/** 从当前 URL 解析视图（先查询参数，再路径段） */
	parseFromLocation() {
		const loc = window.location;

		// 1) ?view=xxx 优先（sensors 这类无服务端路由的视图靠它承载）
		const m = /[?&]view=([^&#]+)/.exec(loc.search || '');
		if (m) {
			const qv = decodeURIComponent(m[1]);
			if (this.isValid(qv)) return qv;
		}

		// 2) 路径段：剥掉 BASE 前缀后取第一段
		let rest = loc.pathname || '';
		if (BASE && rest.indexOf(BASE) === 0) rest = rest.slice(BASE.length);
		rest = rest.replace(/^\/+/, '').replace(/\/+$/, '');
		const seg = rest.split('/')[0];

		if (!seg) return 'overview';
		const view = VIEWS.find(v => v.seg === seg);
		return view ? view.id : 'overview';
	}

	/** 生成视图对应的 URL（保证刷新不会 404） */
	urlFor(viewId) {
		const view = VIEWS.find(v => v.id === viewId) || VIEWS[0];
		if (view.seg) return BASE + '/' + view.seg;
		// 无服务端路由的视图（sensors）挂在 dashboard 下用查询参数区分
		return BASE + '/dashboard?view=' + encodeURIComponent(view.id);
	}

	/**
	 * 导航到指定视图
	 * @param {string} viewId
	 * @param {boolean} pushState 是否写入历史（popstate 回调里传 false）
	 * @returns {boolean} 是否发生了视图变化
	 */
	navigate(viewId, pushState = true) {
		if (!this.isValid(viewId)) {
			console.warn('[tempmon] 无效视图:', viewId);
			return false;
		}
		const prev = this.currentView;
		if (prev === viewId) return false; // 同视图重复点击不重渲染

		this.currentView = viewId;

		if (pushState) {
			try {
				window.history.pushState({ view: viewId }, '', this.urlFor(viewId));
			} catch (err) {
				// 受限环境下 pushState 可能抛错，降级为纯内存路由（功能不受影响）
				console.warn('[tempmon] pushState 失败，降级为内存路由:', err);
			}
		}

		this.notify(viewId, prev, true);
		return true;
	}

	getCurrentView() {
		return VIEWS.find(v => v.id === this.currentView) || VIEWS[0];
	}

	getViews() {
		return VIEWS;
	}

	/** 按分组取视图，供侧边栏渲染 */
	getViewsByGroup(group) {
		return VIEWS.filter(v => v.group === group);
	}

	/** 注册路由变化监听；返回取消订阅函数 */
	onRouteChange(cb) {
		this.listeners.push(cb);
		return () => {
			const i = this.listeners.indexOf(cb);
			if (i > -1) this.listeners.splice(i, 1);
		};
	}

	notify(view, prev, userNav) {
		this.listeners.forEach(cb => {
			try { cb(view, prev, userNav); }
			catch (e) { console.error('[tempmon] 路由监听器异常:', e); }
		});
	}

	/* 面包屑渲染/绑定统一放在 components/BreadCrumb.js，
	   避免两处实现产生 class 名与 href 规则不一致（历史上这里曾拼出
	   /admin/tempmon/overview 这种服务端不存在的路径，刷新即 404）。 */
}

export const router = new Router();
export { BASE as TEMPON_BASE };
