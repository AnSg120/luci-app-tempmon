/**
 * luci-app-tempmon - 主题控制模块
 * 管理明暗模式切换，替换旧的 bodyLuma 探测逻辑
 */

const THEME_KEY = 'tm-theme-preference';
const MODES = {
	DARK: 'dark',
	LIGHT: 'light',
	AUTO: 'auto'
};

/**
 * 主题控制器
 */
class ThemeController {
	constructor() {
		this.currentMode = this.loadPreference();
		this.appElement = null;
		this.listeners = [];
	}
	
	/**
	 * 初始化主题控制器
	 */
	init(appElement) {
		this.appElement = appElement;
		this.applyTheme(this.currentMode);
		
		// 监听系统主题变化（仅在 auto 模式下）
		if (this.currentMode === MODES.AUTO) {
			this.watchSystemTheme();
		}
	}
	
	/**
	 * 从 localStorage 加载用户偏好
	 */
	loadPreference() {
		try {
			const saved = localStorage.getItem(THEME_KEY);
			if (saved && Object.values(MODES).includes(saved)) {
				return saved;
			}
		} catch (e) {
			console.warn('[tempmon] Failed to load theme preference:', e);
		}
		return MODES.AUTO; // 默认自动模式
	}
	
	/**
	 * 保存用户偏好到 localStorage
	 */
	savePreference(mode) {
		try {
			localStorage.setItem(THEME_KEY, mode);
		} catch (e) {
			console.warn('[tempmon] Failed to save theme preference:', e);
		}
	}
	
	/**
	 * 应用主题
	 */
	applyTheme(mode) {
		if (!this.appElement) return;
		
		let actualMode = mode;
		
		// 如果是自动模式，检测系统偏好
		if (mode === MODES.AUTO) {
			actualMode = this.detectSystemTheme();
		}
		
		// 设置 data 属性
		if (actualMode === MODES.LIGHT) {
			this.appElement.setAttribute('data-tm-mode', 'light');
		} else {
			this.appElement.removeAttribute('data-tm-mode');
		}
		
		this.currentMode = mode;
		this.notifyListeners(mode, actualMode);
	}
	
	/**
	 * 检测系统主题偏好
	 */
	detectSystemTheme() {
		if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
			return MODES.LIGHT;
		}
		return MODES.DARK;
	}
	
	/**
	 * 监听系统主题变化
	 */
	watchSystemTheme() {
		if (!window.matchMedia) return;
		
		const mediaQuery = window.matchMedia('(prefers-color-scheme: light)');
		
		const handleChange = (e) => {
			if (this.currentMode === MODES.AUTO) {
				const newMode = e.matches ? MODES.LIGHT : MODES.DARK;
				this.applyTheme(MODES.AUTO);
			}
		};
		
		// 现代浏览器 API
		if (mediaQuery.addEventListener) {
			mediaQuery.addEventListener('change', handleChange);
		} else if (mediaQuery.addListener) {
			// 兼容旧版
			mediaQuery.addListener(handleChange);
		}
	}
	
	/**
	 * 切换主题模式
	 */
	toggleMode() {
		const modes = [MODES.DARK, MODES.LIGHT, MODES.AUTO];
		const currentIndex = modes.indexOf(this.currentMode);
		const nextIndex = (currentIndex + 1) % modes.length;
		const nextMode = modes[nextIndex];
		
		this.setMode(nextMode);
		return nextMode;
	}
	
	/**
	 * 设置指定模式
	 */
	setMode(mode) {
		if (!Object.values(MODES).includes(mode)) {
			console.warn('[tempmon] Invalid theme mode:', mode);
			return;
		}
		
		this.savePreference(mode);
		this.applyTheme(mode);
	}
	
	/**
	 * 获取当前模式
	 */
	getMode() {
		return this.currentMode;
	}
	
	/**
	 * 获取实际生效的模式
	 */
	getActualMode() {
		if (this.currentMode === MODES.AUTO) {
			return this.detectSystemTheme();
		}
		return this.currentMode;
	}
	
	/**
	 * 获取模式显示文本
	 */
	getModeLabel(mode = this.currentMode) {
		const labels = {
			[MODES.DARK]: '深色',
			[MODES.LIGHT]: '浅色',
			[MODES.AUTO]: '自动'
		};
		return labels[mode] || '未知';
	}
	
	/**
	 * 注册主题变化监听器
	 */
	onThemeChange(callback) {
		this.listeners.push(callback);
		return () => {
			// 返回取消订阅函数
			const index = this.listeners.indexOf(callback);
			if (index > -1) {
				this.listeners.splice(index, 1);
			}
		};
	}
	
	/**
	 * 通知所有监听器
	 */
	notifyListeners(preferredMode, actualMode) {
		this.listeners.forEach(callback => {
			try {
				callback(preferredMode, actualMode);
			} catch (e) {
				console.error('[tempmon] Theme listener error:', e);
			}
		});
	}
	
	/**
	 * 生成主题切换按钮的 SVG 图标
	 */
	getThemeIcon(mode = this.currentMode) {
		const icons = {
			[MODES.DARK]: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
			</svg>`,
			[MODES.LIGHT]: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="5"/>
				<line x1="12" y1="1" x2="12" y2="3"/>
				<line x1="12" y1="21" x2="12" y2="23"/>
				<line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
				<line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
				<line x1="1" y1="12" x2="3" y2="12"/>
				<line x1="21" y1="12" x2="23" y2="12"/>
				<line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
				<line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
			</svg>`,
			[MODES.AUTO]: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
				<circle cx="12" cy="12" r="11"/>
				<path d="M12 1v22"/>
				<path d="M1 12h22"/>
			</svg>`
		};
		return icons[mode] || icons[MODES.AUTO];
	}
}

// 导出单例实例
export const themeCtrl = new ThemeController();

// 导出常量
export const THEME_MODES = MODES;
