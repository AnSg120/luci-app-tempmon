# luci-app-tempmon — OpenWrt 系统监控插件（深色科技风仪表盘）

面向 OpenWrt LuCI 的轻量系统监控插件。包名沿用历史上的 `tempmon`
（最初只做温度监控），当前定位是**零外部依赖的系统监控仪表盘**：守护进程
周期性采样温度 / CPU / 频率 / 负载 / 内存 / 存储 / 网卡 / 磁盘 I/O / 运行时间，
写入纯文本 CSV 环形日志；LuCI 提供 **8 视图深色科技风 Dashboard**（概览、
CPU、内存、存储、网络、进程、日志、设置），数据全部来自真实系统源。
**主题严格跟随 LuCI 全局主题**：全部视觉属性由 CSS 变量驱动，优先继承主
题变量，内置明暗兜底，切换主题无需改动插件。

## 功能

| 视图 | 内容 |
| --- | --- |
| 概览 | 温度（分级着色）/ CPU / 内存 / 存储 / 网络 / 运行时间 6 张指标卡（带迷你趋势图）、设备信息、WAN/LAN 网络概览 |
| CPU | 环形图（用户/系统/等待真实拆分）、使用率平滑面积图、各核心负载条、负载均值 |
| 内存 | 环形图、使用率面积图、缓存/缓冲区/空闲/交换分区详情（实时 /proc/meminfo） |
| 存储 | 环形图、磁盘读写 B/s 面积图、分区使用情况表（df 用量 + /proc/mounts 文件系统类型，过滤 tmpfs 等伪文件系统） |
| 网络 | 总上行/下行面积图（WAN 口径）、接口状态表（角色徽章/连接状态/IP/实时速率）、流量累计与 TCP/UDP/总连接数 |
| 进程 | 真实 `top` 快照：按表头列解析（兼容 busybox/procps-ng），PID/名称/CPU%/内存%/状态 |
| 日志 | 真实 `logread`：类型过滤（内核/系统/网络/服务/其他）+ 搜索 + 分页 + 清空 |
| 设置 | 服务启停、自定义隐藏项、导出 CSV、清空历史、阈值告警与 LuCI 参数页 |

## 主题系统（核心特性）

- **视觉令牌**：组件零硬编码颜色，全部引用 `--tm-*` 语义变量（定义于
  `htdocs/luci-static/resources/tempmon/theme.css`）
- **继承链**：`var(--primary, …)` 等优先取 LuCI 主题暴露的变量
  （luci-theme-argon 等）；主题未提供时启用内置**明暗两套兜底**
- **自动切换**：JS 读取 body 背景亮度自动判定深/浅，`MutationObserver`
  监听主题切换实时生效；顶栏 ◐ 按钮可手动 auto/深/浅
- **图表同源变色**：折线/面积/环形/进度条颜色均以
  `style="stroke:var(--tm-…)"` 绑定变量，主题切换零重绘、无色彩割裂
- 时间范围页签统一为 **1 小时 / 6 小时 / 24 小时 / 3 天 / 7 天**

## 目录结构

```
luci-app-tempmon/
├── Makefile                        # ★ 唯一版本源（PKG_VERSION/PKG_RELEASE）
├── CHANGELOG.md                    # 发布历史
├── release/                        # 编译产物（.ipk，git 忽略）
├── root/
│   ├── etc/config/tempmon          # UCI 默认配置
│   ├── etc/init.d/tempmon          # procd 服务
│   ├── usr/libexec/tempmon/collect.sh   # 采样守护进程
│   └── usr/share/luci/menu.d/ + rpcd/acl.d/   # LuCI 菜单（8 项）与 ACL
├── luasrc/
│   ├── controller/tempmon.lua      # 路由 + JSON API（schema 驱动解析、流式读取）
│   ├── model/cbi/tempmon.lua       # 设置表单
│   └── view/tempmon/dashboard.htm  # 唯一页面壳（8 视图 = 同一模板 + URL 路径）
├── htdocs/luci-static/resources/tempmon/
│   ├── theme.css                   # 主题变量层
│   ├── app.css                     # 组件样式（仅引用变量）
│   ├── app.js                      # 前端应用（数据层/路由/8 视图/主题探测）
│   └── chart.js                    # 无依赖 SVG 图表库
├── po/                             # 中文翻译
├── tests/                          # test-collect.sh（采样冒烟）+ api-test.sh（API 集成）
└── tools/                          # build_ipk.py / verify_ipk.py / gen_po.py
```

## 编译与安装

### 方式一：免 SDK 打包（仅需 Python 3，出口在 release/）

```sh
py tools/build_ipk.py                      # 版本号自动读自 Makefile
py tools/verify_ipk.py release/luci-app-tempmon_2.1.1-17_all.ipk
scp -O release/luci-app-tempmon_2.1.1-17_all.ipk root@192.168.1.1:/tmp/
ssh root@192.168.1.1 "opkg install /tmp/luci-app-tempmon_2.1.1-17_all.ipk"
```

> `-O` 为老 dropbear（无 sftp-server）的 scp 兼容参数。安装/升级后
> postinst 会自动清 LuCI 缓存、重启 uhttpd 与采集服务。

### 方式二：OpenWrt SDK / Buildroot（Linux / WSL）

```sh
cp -r luci-app-tempmon package/
make package/luci-app-tempmon/compile V=s
```

## 使用

LuCI 菜单 **系统监控** 下含 8 个入口（概览/CPU/内存/存储/网络/进程/日志/设置），
URL 即视图（可直接收藏）：`/cgi-bin/luci/admin/tempmon/<view>`。

## 配置（/etc/config/tempmon）

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `1` | 采集开关（关闭后进程空闲等待） |
| `interval` | `60` | 采样间隔秒（≥5，修改即时生效） |
| `data_dir` | `/tmp/tempmon` | 数据目录（默认内存、重启清空；可改 Flash 路径但注意寿命） |
| `max_lines` | `30000` | history.log 轮转阈值（保留最新一半） |
| `hide_items` | 空 | 概览指标卡自定义隐藏（空格分隔，见设置页；仅影响展示） |
| `temp_warn` | `75` | 温度最高值 ≥ 此值：顶栏"温度偏高" + syslog 告警 |
| `temp_crit` | `85` | 温度最高值 ≥ 此值：顶栏"温度告警" + syslog 告警 |

## 数据格式（`<data_dir>`）

| 文件 | 内容 |
| --- | --- |
| `zones.txt` | `<idx> <name> <sysfs路径>` 温度区清单 |
| `ifaces.txt` | `<idx> <name> <role\|-> <ip\|-> <label…>` 接口清单（无线含频段） |
| `meta.txt` | `zones=N cores=N ifaces=… v=3 interval=M` 布局签名（变化自动归档重建） |
| `history.log` | CSV 采样行：`ts,usage,core0..N,freq,load1/5/15,mt/mf/ma,temps,每接口4列,user/sys/wait%,overlay总/可用,uptime_s` |
| `disk.log` | `ts,read_Bps,write_Bps` 磁盘 I/O 独立环形日志 |
| `count.txt` | history.log 行数侧车（API 秒级读取） |

## 安全说明

- 所有写操作接口（启停服务/自定义隐藏/清空历史/清空日志）要求 **POST +
  自定义头 `X-TM-CSRF` + 同源 Origin/Referer 校验**（表单跨站请求无法携带
  自定义头，构成 CSRF 缓解）
- `data_dir` 由服务端集中校验（必须绝对路径、禁止 `..`）
- 接口仅在已认证的 LuCI 会话下可访问（24.10 经 menu.d 注册；菜单可见性
  与登录态绑定，不依赖自定义 ACL 组——部分固件的 root 会话不包含插件
  自定义 ACL 组时会导致菜单项被过滤）

### 已知限制

- 写接口的 CSRF 缓解采用全局双提交 nonce（`/tmp/tempmon.nonce`，页面模板
  生成/轮换），同一设备上任何已登录 LuCI 用户均可读取，属于同设备
  会话内的缓解而非常规跨站防御；24.10 桥接层不暴露会话令牌，此为
  当前可行的折中
- 网卡 IP 清单依赖 `ip -4 -o addr`（busybox 版 `ip` 不支持 `-o` 时该列
  显示 `—`，速率/累计不受影响）；无线频段标注依赖可选包 `iwinfo`
- 进程页的内存占用列仅在 procps-ng 版 `top`（含 `%MEM`）下显示数值，
  busybox 固件显示 `—`（其 `top` 不提供内存占用列）

## 测试

```sh
# 采集逻辑冒烟（任意 POSIX 环境，Windows 用 Git Bash）
sh tests/test-collect.sh

# 路由器上的 API 集成测试（自动伪造临时会话、逐端点断言、含 CSRF 拒绝用例）
scp tests/api-test.sh root@192.168.1.1:/tmp/ && ssh root@192.168.1.1 sh /tmp/api-test.sh
```

## License

GPL-2.0-only · maintainer: luci-app-tempmon contributors
发布历史见 [CHANGELOG.md](CHANGELOG.md)。