# CHANGELOG

本文件记录 luci-app-tempmon 的发布历史。版本号以 `Makefile` 的
`PKG_VERSION`/`PKG_RELEASE` 为唯一来源（`tools/build_ipk.py` 自动读取）。

## 1.0.0-1 — 首个正式发行版（v1.0.0）

**发行备注**：luci-app-tempmon v1.0.0 首发正式版，界面重构，PC与移动端自适应，
修复A/B/C/D/E原有体验痛点，稳定采集硬件温度，支持历史曲线查看。

版本方案调整：自本版起启用独立的 `1.x.y` 正式发行版号（此前为 2.x 开发线），
`PKG_VERSION:=1.0.0`、`PKG_RELEASE:=1`。**注意**：对已安装 2.2.0-5 开发版的设备，
opkg 会将 1.0.0-1 视为降级，升级时需 `opkg install --force-reinstall`（或先
`opkg remove` 再装），详见发布自检步骤。

同步动作（纯版本标记，无逻辑变更）：

- `Makefile`：`PKG_VERSION` 2.2.0 → 1.0.0，`PKG_RELEASE` 5 → 1；
  `LUCI_DESCRIPTION` 与 `tools/build_ipk.py` 的 control `DESCRIPTION`
  更新为上方发行备注。
- `luasrc/view/tempmon/dashboard.htm`：静态资源缓存串 `?v=3.2` → `?v=1.0.0`
  （4 处）；opkg status 读不到包版本时的兜底 `"3.0"` → `"1.0.0"`（2 处）。
- `htdocs/.../app.js`：头注释与加载顺序注释更新；`VERSION` 前端兜底
  `'3.2'` → `'1.0.0'`；页脚「前端 v3.2」硬编码改为统一读 `VERSION`，
  与 Makefile 单一版本源保持一致（消除页脚/侧边栏两处版本号脱钩的可能）。
- `chart.js` / `app.css` / `theme.css`：头注释版本标记同步为 v1.0.0。

功能基线：包含 2.2.0-1 至 2.2.0-5 的全部重构与修复——原生 ES Module 前端
（core/components/views 分层，无打包、零第三方依赖）、9 视图 SPA、
自研 SVG 图表（缩放/平移/十字线/图例开关/导出 PNG/增量刷新）、
三态主题（深/浅/自动）、骨架屏与错误重试、虚拟滚动、模态确认框、
告警横幅、Argon 主题样式泄漏抵消、LuCI 菜单单项收敛、侧边栏折叠修复。
后端 13 个 API、collect.sh、CSV 格式相对 2.2.0 线未改动。

## 2.2.0-5 — 修复侧边栏折叠按钮点了没反应

用户实测反馈「这个按钮的功能没有作用」（`panelLeft` 图标，`data-sidebar-collapse`）。
排查发现是**三个 bug 叠加**，任何一个单独存在都足以让折叠失效：

1. **回调被写成了触发器。** `bindSidebar(shell, onNavigate, onToggleCollapse)` 的第三个
   参数是「折叠态已经变了」的通知回调——`bindSidebar` 内部命中
   `[data-sidebar-collapse]` 时**已经**执行过 `toggleCollapse(shell, onToggleCollapse)`，
   并把它当作 `cb` 传进去。而 `app.js` 的 `bindGlobal()` 在这个回调里又调了一次
   `toggleCollapse(sidebar, …)`，于是一次点击变成「加上 `.collapsed` → 立刻移除」，
   净效果为零，`localStorage` 也被写回 `'0'`。
2. **resize 处理器里照抄了同一个错误，还额外泄漏监听。** 跨断点时
   `paintSidebar(); bindSidebar(…)` 里的 `bindSidebar` 带着同样的嵌套 `toggleCollapse`；
   更糟的是这次重绑**根本不必要**——`paintSidebar()` 只替换 `sidebar.innerHTML`，
   slot 元素本身没被换掉，而 `bindSidebar` 用的是事件委托（监听挂在 slot 上、
   点击时才 `closest()` 找目标），委托天然存活。每跨一次断点就往 slot 多挂一份
   `click`、往 `document` 多挂一份 `keydown`，无限累积，一次点击触发 N 次 toggle。
3. **CSS 兄弟选择器永远匹配不上。** `#tm-app .tm-sidebar.collapsed ~ .tm-main` 要求两者
   同级，但实际结构是 `#tm-app > #tm-sidebar-slot > aside.tm-sidebar` 与
   `#tm-app > .tm-main`——`.tm-sidebar` 的父节点是 slot，`.tm-main` 的父节点是 `#tm-app`。
   即使前两个 bug 修好，折叠后侧边栏缩到 64px、主区却仍留在 220px 处，
   中间空出 156px 死档。

修法：

- 删掉 `bindGlobal()` 与 resize 处理器里的两处嵌套 `toggleCollapse`；
  resize 里的 `bindSidebar(…)` 整个删除（委托无需重绑，`bindSidebar` 现在全app只调一次）。
- `toggleCollapse()` 与 `paintSidebar()` 都把 `collapsed` 类**同步打到 `#tm-sidebar-slot`**
  上（后者保证首屏就是折叠态时主区边距也正确）；CSS 改为
  `#tm-app #tm-sidebar-slot.collapsed ~ .tm-main`，特异度 (2,1,1) 稳压基础规则 (1,1,0)，
  而 ≤900px 抽屉模式的 `margin-left: 0 !important` 仍然优先。
- 顺带清掉 `buildShell()` 里多余的 `.tm-sidebar-mask`：`renderSidebar()` 已经在 slot 内部
  输出一个，`openMobile`/`closeMobile` 也只从 slot 里 `querySelector` 取它，
  外层那个永远带着 `hidden`、谁也不碰。同时删掉从未被使用的 `mask` 变量，
  以及 app.js 中已成死导入的 `toggleCollapse`。

图表**不需要**在折叠回调里手动重排：`chart.js` 内部用 `ResizeObserver` 监听容器，
主区宽度一变就自动重绘。

## 2.2.0-4 — 抵消 Argon 裸元素样式泄漏 + LuCI 菜单收敛为单项

### Argon 全局样式漏进本 app（用户实测反馈「有个 ::after 挡住了部分信息」）

实测 ArgonTheme v2.3.2 的 `cascade.css`（155263 B）里有 **70 条不带任何 class/id
限定的纯元素选择器**，会直接命中 `#tm-app` 内部的同名元素。逐条排查后修掉真正造成
破坏的几条（其余如 `a:link`、`button`、`table` padding 等都被本文件更高特异度的规则
压住了，无需处理）：

| Argon 规则 | 实际后果 |
| --- | --- |
| `header::after{content:"";position:absolute;height:2rem;width:100%;background:var(--primary)!important}` | 在顶栏内容**之上**盖一条 32px 高的不透明主题紫条，压住面包屑与按钮下半部——即用户看到的遮挡 |
| `footer{overflow:hidden;white-space:nowrap;text-align:right;color:#aaa}` | `.tm-footer` 未声明 `overflow`/`white-space`，页脚被强制单行并**裁掉**超出的版本文字与「参数配置」链接 |
| `tr>td,tr>th{border-top:thin solid #ddd}` | 与本文件的 `border-bottom` 叠成双线；`#ddd` 硬编码，暗色主题下刺眼 |
| `div>table>tbody>tr:nth-of-type(2n){background:#f9f9f9}` | 硬编码浅灰斑马纹，暗色主题下同样刺眼 |
| `h2–h6{line-height:1.1!important}` | 带 `!important`，只有同为 important 且特异度更高才压得回来 |
| `ul{line-height:normal}` | 覆盖本文件的行高继承 |

链接颜色**无需处理**：`#tm-app a` 特异度 (1,0,1) 本就压过 `a:link` (0,1,1)。
所有抵消规则都限定在 `#tm-app` 之内——Argon 自己的 `<header class="bg-primary">`
仍然需要那条紫条，不能误伤。

### LuCI 菜单从「1 + 9」收敛为单项

菜单里的 9 个子项（概览/CPU/内存/存储/网络/进程/日志/设置/参数）与本 app 侧边栏
完全重复，属于两套并行的导航。现改为只留「系统监控」一项，点击直达 dashboard。

调查过程中确认的机制（决定了改法）：

- Argon `header.htm` 的 `.main-left` 在服务端是**空容器**（`id="mainmenu"
  style="display:none"`，只有 brand 与 toggler），菜单由客户端 JS 经 ubus `luci`
  对象拉取 → **菜单来源是 `menu.d/*.json`，不是控制器的 `entry()`**。
- `/usr/share/ucode/luci/dispatcher.uc:588` 的 `if (child.title && type(child.action)
  == "object")` 说明**无 title 的节点不进菜单**；同文件 `case 'alias'` 分支只做
  `dispatch(http, [...split(action.path,'/')])`，**不检查 title**，因此可以安全地
  指向一个无 title 的节点。
- 反之 `case 'firstchild'` 依赖 `tree.children`：子项全部摘掉 title 后父项会因找不到
  候选而**整个从菜单消失**，所以父项动作必须由 `firstchild` 改为 `alias`。

据此：`admin/tempmon` 改为 `{"type":"alias","path":"admin/tempmon/dashboard"}`
（`alias` 写法参照设备上 `luci-mod-status.json` 的 `admin/status/logs`），9 个子节点
**保留节点与 action、只摘掉 `title`**。路由因此全部存活，`/cpu`、`/logs` 等深链与
刷新都不会 404。

- **`luasrc/controller/tempmon.lua` 一行未改**：13 个 API、`action_*` 函数、
  `entry()` 路由声明、CSRF 逻辑全部原样保留，「后端不动」的约束继续成立。
- `core/router.js` 的 `init()` 补一次 `replaceState`：`alias` 是内部派发不发 302，
  地址栏会停在 `/admin/tempmon`；规范化成 `/admin/tempmon/dashboard`，
  让「地址栏显示 = 刷新后停留 = 可分享链接」三者一致。
  `parseFromLocation()` 对空路径段本就回退 `overview`，故此前也不会出错。
- 已知代价：「参数」（CBI 页）不再出现在 LuCI 菜单里，仍可从 app 页脚与设置页的
  「参数配置」链接进入。

## 2.2.0-3 — 告警阈值展示改为以后端为准

2.2.0-2 部署到真机后，实测发现前端把**后端默认阈值当成了设备实际阈值**在展示。
这台设备的 UCI 是 `temp_warn='60'` / `temp_crit='70'`，而概览卡片上写着
「阈值 75/85°C」——当着用户的面报错参数。根因是阈值不由任何接口返回，
mock 测试用的又恰好是默认值，所以只有真机才能暴露。后端依然零改动
（`collect.sh`、`controller/tempmon.lua`、`cbi/tempmon.lua` 三者 sha256 与仓库逐一比对一致）。

- **概览温度卡副标题**不再写具体数字，改为转述后端判定结果
  （`后端判定：正常 / 警告 / 严重`）。卡片三态本来就已经取自
  `alertLevel(status.alert)`，这次把文字也对齐到同一权威来源。
  tooltip 补充说明：迷你图里的橙/红区段按后端**默认**阈值 75/85°C 标注、仅供参考。
- **传感器页逐路状态**只给「最热那一路」：控制器里 `alert` 正是拿所有分区的
  最高温 `tmax` 与 UCI 阈值比出来的（`tmax >= crit → 2`，`>= warn → 1`），
  所以最热一路的状态与 `alert` 严格等价；其余各路接口无从判定，只显示读数
  与 `—`，并附悬停解释。原先按 75/85 给每一路都判「正常/警告/严重告警」，
  在阈值被改过的设备上会给出错误结论。
- **更正 UCI 路径**：`tempmon.@tempmon[0]` → `tempmon.core.temp_warn / temp_crit`
  （实测 `uci show tempmon` 的节名是 `core`，匿名节写法在这台设备上不存在）。
  阈值明细行的措辞由「75 °C（前端展示值）」改为
  「后端默认 75 °C · 实际值接口不返回」，避免被读成设备当前配置。
- 清理 `Overview.js` 里未使用的 `tempLevel` 导入（全仓唯一引用点，属死导入）。
- 版本标记统一：文件头注释、`VERSION` 兜底值与 `dashboard.htm` 的 `?v=`
  全部对齐到 **3.2**（此前资源已是 `?v=3.2` 而文件头仍写 v3.1）。

## 2.2.0-2 — 与 LuCI 主题(Argon)共存修正 + 缓存策略修正

首次部署到真机（OpenWrt 24.10.6 / LuCI openwrt-24.10 / ArgonTheme v2.3.2）
后按实测结果修正。后端依然零改动。

- **布局：本页让自建 shell 独占视口**。`dashboard.htm` 带 `<%+header%>`，
  LuCI 主题会在 `#tm-app` 外再套一层自己的骨架。实测 Argon 的 `.main-left`
  是 240px 宽（≤1600px 时 208px）、`z-index:100` 的静态 flex 列，而自建
  `.tm-sidebar` 是 `position:fixed;left:0;z-index:200`，于是侧边栏整块压在
  LuCI 左菜单上（只在 x=220–240 露出 20px 边条），**全局导航与「退出」在本页
  完全点不到**；同时 `#maincontent` 的左偏移又与 `.tm-main` 的
  `margin-left:220px` 叠加，在侧边栏与内容之间留出约 260px 死区
  （实测侧边栏右缘 x=220、顶栏汉堡键 x=504、卡片左缘 x≈480）。
  `app.css` 新增第 0 节：隐藏 `.main-left` 与 `.darkMask`，清掉
  `#maincontent` / `.container` 的边距。这些规则必须写在 `#tm-app` 作用域之外
  （目标元素属于 LuCI，不在 `#tm-app` 里），但影响范围依然安全——`app.css`
  只由 `dashboard.htm` 引入；「参数」页走 `cbi()` 模板、不加载本文件，
  仍保留完整的 LuCI 菜单与退出入口。
- **补回逃生口**：侧边栏新增「LuCI」分组，含「返回 LuCI」(→ `/admin/status`)
  与「退出登录」(→ `/admin/logout`)。做成 `.tm-nav-item` 而不是放进
  `.tm-sidebar-foot`——后者在折叠态是 `opacity:0 + pointer-events:none`，
  逃生口必须在展开/折叠/抽屉三种状态下都点得到。路径由 `TM_API.base` 反推，
  不硬编码 LuCI 前缀；`core/util.js` 为此新增 `logout` 图标（第 44 个）。
- **缓存策略修正（重要）**：实测 uhttpd 对静态资源**不发 `Cache-Control` /
  `Expires`**，只有 `ETag` + `Last-Modified`，浏览器因此改用 RFC 7234 的
  启发式新鲜期（Chrome 与 Firefox 均取 `(Date - Last-Modified) × 10%`）。
  2.2.0-1 把 tar mtime 钉在 2023-12-08，与当前相差约 1062 天 → **新鲜期约
  106 天**；`dashboard.htm` 里的引用带 `?v=` 可以绕过，但约 60 处内部
  `import`（`./core/util.js` 这类）不带查询串，浏览器在这段时间内连条件请求
  都不发，升级后会「新 app.js 配旧 core 模块」直接白屏。`build_ipk.py` 改为
  用构建时刻作 mtime，使 `Date - Last-Modified ≈ 0`、新鲜期归零，未变更的文件
  仍走 304。同时 `?v=3.1` → `?v=3.2`（4 处），确保顶层文件不受旧缓存条目影响。
  **从 2.2.0-1 升级到本版本需要强制刷新一次（Ctrl+Shift+R）**：旧版留下的缓存
  条目仍带约 106 天新鲜期；此后升级不再需要。
- **图表 Y 轴刻度去重**：真机温度长期停在 40.0–41.x°C，5 个刻度全落在 2° 以内，
  而各视图的 `yFmt` 多写作 `Math.round(v) + 单位`，实测渲染成
  「39° 40° 40° 41° 41°」——重复标签。`chart.js` 现在把刻度间距作为第二参传给
  `yFmt`（旧签名只用第一参，向后兼容），`core/util.js` 新增
  `axisNum(v, step, suffix)` 按间距决定小数位（≥1 取整、≥0.1 保留一位、
  更小保留两位），6 个视图共 10 处 `yFmt` 改用它（含 K/M 单位换算的两处，
  间距同比例缩放后再判定）。
- **去掉重复提示**：「滚轮缩放 / 拖拽平移 / 双击复位」原先同时出现在面板副标题
  与图表工具栏两处。副标题只保留各自独有的信息（`N 路传感器`、
  `点击图例可开关序列`、`点击图例可单独查看某一路`），操作提示统一交给工具栏
  （触屏下由 `@media (hover: none)` 自动隐藏）。

真机验证：24 个前端文件与仓库逐字节一致；概览页真实数据全部正确
（40.0°C `cpu-thermal`、CPU 2.7%、内存 45.5% 即 221.2/485.8 MB、根分区 24.2%、
WAN ↓4.0 KB/s ↑93.7 KB/s、运行 3 天 18 小时、8 个接口角色分类正确、2 核明细、
`当前频率 —` 正确降级）；E1 前端实测采样间隔生效（`223 点 · 间隔 5s`）；
C3 动态 Y 域生效（温度轴自动收到 39–41°、CPU 轴 0–40%）；页脚版本号由
`package_version()` 从 opkg status 读出，确认安装的是新包。

## 2.2.0-1 — 前端整体重构为原生 ES Module

后端**零改动**：`collect.sh`、13 个 API 控制器、CSV 格式、meta 文件、
UCI 键全部保持原样，字段与结构 100% 兼容。仅改前端 CSS/JS，外加
`dashboard.htm` 的 2 个 `<link>` 与 2 个 `<script>` 标签（内联 Lua 逐字节未动）。
不引第三方框架、不用 npm/打包器，模块图由浏览器按 `import` 自行加载。
单文件 `app.js` 拆为 24 个文件：`core/`(4) + `components/`(7) + `views/`(9)
+ `app.js`/`chart.js`/`theme.css`/`app.css`。

- **颜值**：卡片三态(ok/warn/danger)、统一 24px 线性图标(43 个)、
  显式「明亮/深色/跟随系统」主题开关（替代原先的亮度探测）、
  自定义模态框替代 `window.confirm`、48 条字段含义 tooltip
- **交互**：采集后图表增量更新（复用实例、不重播动画、保留缩放态）；
  骨架屏 + 失败重试，加载/错误/空三态区分；导航统一到 history
  pushState + 面包屑；`api_procs`/`api_logs` 改虚拟滚动（300 条日志
  只渲染 40 行 DOM）
- **图表**：保留原 `chart.js` 内核，新增滚轮缩放 / 拖拽平移 / 双击复位 /
  触屏捏合，Y 轴按**可见**序列动态留白，十字准星吸附 + 多序列 tooltip +
  可点击图例，导出 PNG，档位切换淡入过渡而非生硬替换
- **布局**：断点 1920/1400/1100/900/600，侧边栏可折叠且偏好持久化，
  卡片强制等高；重点修复 600–1100px（此前体验最差区间）——收缩链
  `.tm-main`→`.tm-view`→`.tm-chart-box` 四级 `min-width:0` + 栅格
  `minmax(0,1fr)`，表格横向滚动改为无条件生效
- **功能**：新增采样耗时展示（**前端实测**采样间隔与接口往返耗时；
  后端未提供 `sample_time_ms`，界面如实标注，不伪造后端数据）；
  `api_status.alert` 告警可视化（顶栏状态 + 横幅 + 传感器页，
  **不新增任何前端告警规则**，阈值仍只在 UCI）；单位口径统一；
  右上角最后更新指示
- 修复：抽屉遮罩此前 `opacity` 永远为 0（全透明却仍拦点击），改用
  `visibility` 承载隐藏态以让淡入过渡真正执行；消除游离的 768px 断点，
  图表高度对齐 ≤899px、缩放提示改判 `@media (hover: none)`（触屏无滚轮）
- 打包：`build_ipk.py` 的 tar mtime 由常量改为**随版本单调推进**。
  常量会让安装后的 Last-Modified 永不变化，而模块内部 import 不带
  `?v=`，浏览器重验证将永远收到 304，下次升级会出现「新 app.js 配旧
  core 模块」；同版本仍可复现（同 mtime → 同 sha256）
- 已知：`.po` 目录只覆盖 Lua/CBI 文案，前端中文字符串不参与翻译
  （与 2.1.1-17 一致，经典脚本用不了 LuCI 的 `_()`）

## 2.1.1-17 — 双模布局(参考主流 LuCI 插件重排)

- 双模布局：默认 **compact(LuCI 原生)**——透明背景、白色/深色跟随全局
  主题(luci-app-statistics/nlbwmon 风格),紧凑间距与字号;工具栏按钮可切
  **dashboard(深色科技风)** 保留原风格,选择经 localStorage 记忆
- 对齐:所有指标卡 Grid 行 stretch 等高,卡片内 sub 文字自动沉底对齐
- 表格:单元格允许断词换行,窄屏(≤600px)面板横向滚动 + 表格最小宽度,
  不再挤压变形
- 密度:compact 模式整体收紧(卡片/面板/表格 padding、字体层级)、
  更接近 LuCI 系统页的信息密度
- 移动端:≤600px 断点微调(图表高度、甜甜圈居中、日志列宽、页脚折行);
  ≤900px 网格单列保持

## 2.1.1-16 — 单一导航(以 LuCI 菜单为本)

- 移除页面自建的 `header.tm-top` 顶栏与 `aside.tm-side` 侧栏(避免与
  LuCI 全局顶栏/左菜单双套叠加);徽章/时钟/刷新/主题切换收进内容区
  一条轻量工具行 `.tm-tool`,不再是模拟的系统顶栏
- 导航完全走 LuCI 原生菜单:`menu.d` 注册的 概览/CPU/内存/存储/网络/
  进程/日志/设置 八个视图 + 参数页;页面只渲染仪表盘内容

## 2.1.1-15 — CSRF 头校验语义修正

- 实测 24.10 的 LuCI 桥接层不会把自定义请求头（X-TM-CSRF）转发给 Lua，
  2.1.1-13 起"必须带该头"的强制校验导致所有写操作对任何客户端都 403
- 现改为：POST + URL `token=`(nonce) + 同源(Origin/Referer，无来源信息时
  放行给非浏览器客户端）为必须；X-TM-CSRF 作为**可选加固**——仅在
  确实能收到该头的环境里才参与比对，绝不作为硬性门槛
- 测试套件同步：新增"仅 token 无自定义头必须成功"用例；服务端逻辑
  保持对带头发起方的额外校验

## 2.1.1-14 — CSRF 同源兜底修正

- 修复 2.1.1-13 引入的校验缺口：请求带 Host 但无 Origin/Referer
  （uclient/curl、被代理剥离时的客户端）原先会误判为非同源而被拒；
  现在按设计回退为"信任 + token/头部双校验仍然生效"

## 2.1.1-13 — 上线前评审修复

- 紧急修复：`htdocs/luci-static/resources/tempmon/app.js` 存在被截断的重复
  `renderView` 函数，导致脚本解析失败、页面白屏；已删除残留定义
- 静态资源版本化：移除仓库中重复的 `.v2111.js/css` 文件，统一使用
  `?v=2.1.1` 查询参数进行缓存破坏；`verify_ipk.py` 同步更新
- 安全：写操作端点按文档实现 CSRF 双重校验——除 URL 参数 `token` 外，
  要求请求头 `X-TM-CSRF` 与 nonce 一致，并增加 Origin/Referer 同源校验；
  前端 `postJ()` 与 `tests/api-test.sh` 同步发送该请求头
- 安全：统一 Lua 与 Shell 对 `data_dir` 的校验，禁止非绝对路径与 `..`
- CBI 表单：为 `interval`、`max_lines`、`data_dir` 增加数值/路径校验；
  增加 `temp_warn < temp_crit` 交叉校验
- 采集器：`history.log` 轮转后同步更新 `count.txt`
- 国际化：清理过时的 PO/POT 条目，重新生成 `zh_Hans` 翻译
- 工程：将 `_review/` 下的调试/验证脚本整理到 `tools/review/`，
  删除 `_review/` 临时目录

## 2.1.1 — 布局与数据正确性修复（评审整改版）

- 布局：概览 6 张指标卡从固定 5 列网格改为自适应填充（消除第二行
  孤卡）；日志分类 chips 选中态高亮恢复（修复 `#tm-app .tm-chip` 选择器
  特异性覆盖 `.tm-chip.active` 的样式冲突）；内容区加最大宽度避免超宽屏
  拉伸；移除 `#tm-app` 的 overflow 裁切
- 导航：移除插件自绘深色侧栏（与 LuCI 主菜单重复的"双菜单"），视图导航
  统一交给 LuCI 菜单，内容区铺满整宽，URL 深链不变
- 兼容：menu.d 根节点移除 `depends.acl`——本固件的 root 会话不包含插件
  自定义 ACL 组，导致"系统监控"分组 `satisfied:false` 被菜单渲染过滤、
  菜单显示为空；页面路由仍受 LuCI 登录态保护，rpcd ACL 文件保留不变
- 进程视图：`top` 输出改为按表头列定位解析，兼容 busybox 与 procps-ng，
  修复 CPU% 与内存% 两列错位（此前把 %VSZ 当 CPU%、%CPU 当内存%）
- 存储视图：挂载表合并 /proc/mounts 的真实文件系统类型，过滤
  tmpfs/devtmpfs 等伪文件系统，"分区/挂载点/文件系统"三列各归其位
- 设置视图：移除从未生效的 panel_* 隐藏项（概览仅消费 6 张卡片键），
  服务端白名单兼容旧配置
- init.d：去掉 `procd_set_param file` 触发器——采集器每轮自读 UCI，
  无需因配置变化重启服务（数据目录变化仍由设置页提交后手动重启）
- 健壮性：fmt 系列数值格式化防御非数字输入；verify_ipk 默认路径按
  Makefile 版本动态生成；README 安装示例同步版本号
- 修复"参数"页 500：cbli 模型中两处提示文案的字符串内嵌了未转义中文
  引号（`"显示"温度偏高"并写"`），Lua 字符串被提前截断导致语法错误，
  改为「」全角书名号；po 同步更新
- 资源缓存：dashboard 模板引用的 4 个静态资源追加 `?v=2.1.1` 版本参数，
  避免浏览器缓存的旧版 app.js 与新页面壳错配导致视图渲染为空白
- 排障强化：移除 #tm-app 的负外边距（部分主题剪裁内容容器会把仪表盘整体
  裁没）；页面壳内置静态「加载中…」占位；新增前端错误浮层（JS 异常/Promise
  拒绝会以红底浮层直接显示在页面上）；页脚追加 boot-ok 执行证明

## 2.1.0 — 工程治理与加固（评审整改版）

- 工程卫生：`tools/` 仅保留打包三件套（build_ipk/verify_ipk/gen_po），
  历史 ipk 与一次性调试脚本清除，产物改入 `release/`（git 忽略），新增 `.gitignore`
- 版本单一来源：Makefile → 打包脚本 → opkg control → API（`api_status.version`，
  读 opkg status）→ 前端页脚，全链路一致；新增 CHANGELOG
- 安全：写操作端点（service/display/clear/logs-clear）增加 CSRF 防护——经实测
  24.10 桥接层不向 Lua 视图暴露会话令牌、且 dispatcher 原生 `post` 门会 500，
  故采用自控双提交 nonce（页面模板生成/轮换 `/tmp/tempmon.nonce`，端点比对
  `?token=`，跨站无法读取 nonce）；`data_dir` 集中校验
- 性能：`api_status` 改尾部读取 + `count.txt` 计数侧车；`api_data` 改流式
  渐进降采样（内存恒定 ≤ ~720 行），不再全表入内存
- 架构：CSV 解析改为 schema 驱动（`read_schema` 集中计算列偏移）；服务控制改为
  procd 优先 + 效果验证 + 仅降级时回退 pidfile/setsid
- 产品：LuCI 菜单展开 8 个子入口（概览/CPU/内存/存储/网络/进程/日志/设置），
  URL 路径即视图（可深链）；温度卡分级着色落地；新增温度告警
  （`temp_warn`/`temp_crit`，syslog 边沿触发 + 顶栏徽章）
- 文档：README 按真实实现重写；修正 maintainer

## 2.0.x — 深色科技风仪表盘

- 2.0.2：修复 CSV v3 尾列引入的解析偏移（运行时间/接口速率/存储错位）
- 2.0.1：busybox top 列序适配（进程表）
- 2.0.0：单页 Dashboard 重构（8 视图、自建导航壳、CSS 变量主题系统、
  进程/日志/磁盘 IO/连接数等真实数据端点）

## 1.x — 采集与 LuCI 集成奠基

- 1.2.x：网络接口用量（速率+累计+频段标注）、自定义隐藏项、pidfile 服务自管理
- 1.1.x：menu.d/ACL 接入 24.10 ucode 分发器、postinst 缓存清理、
  桥接环境兼容（getenv 替代 get_method、POST body 规避）
- 1.0.x：首版采集器（温度/CPU/频率/负载/内存）、状态页+历史页、免 SDK 打包工具链