# 学习通刷课脚本

自动播放学习通课程视频、放完自动切到下一节。fork 自 [chaolucky18/xuexitongScript](https://github.com/chaolucky18/xuexitongScript)，这个分支在原来的油猴脚本之外加了一个 **Playwright 版**：用你自己的 Chrome 或 Edge，点击是浏览器生成的真实输入，窗口可以放到后台。下面的教程讲的都是 Playwright 版。

## 一、初级使用教程

### 1. 准备（只做一次）

- **Google Chrome 或 Microsoft Edge**：用你电脑上装的那个。两个都有时默认用 Chrome；Windows 自带 Edge，没装 Chrome 也能直接用。
- **Node.js 20 或更新**：
  - Windows：没装也没关系，第一次运行 `start.cmd` 时会问你要不要用 winget 自动装。
  - macOS：`brew install node`；Linux：用系统的包管理器装 `nodejs`。也可以到 [nodejs.org](https://nodejs.org/) 下载 LTS 版。
- **下载这个仓库**：在 GitHub 页面点 **Code → Download ZIP** 解压；或者 `git clone https://github.com/lmmmp-17/xuexitongScript.git`。

### 2. 运行

| 系统 | 怎么启动 |
| --- | --- |
| Windows | 双击仓库里的 **`start.cmd`** |
| Linux / macOS | 在仓库目录下执行 **`./start.sh`** |

接下来：

1. 第一次运行会自动安装依赖（只装一个约 5MB 的 npm 包，不下载浏览器），之后就不再装了。
2. 脚本会自动打开一个**专用的 Chrome**（没装 Chrome 就是 Edge）：单独的用户目录，和你平时用的浏览器分开，全程静音。
3. 在这个浏览器里**登录学习通**。只有第一次需要登录，以后会记住。
4. 进入要刷的课程，**点开任意一节**进到播放页。脚本看到播放页就会自动开始。

从哪一节开始，脚本就从哪一节往后走。要停的时候按 `Ctrl+C`，或者直接关掉命令行窗口；浏览器不会被关掉。

### 3. 它会做什么

- 读左侧目录，跳到下一个**还有待完成任务点**的小节。已完成的、没有任务点的小节直接越过，不算任务点的视频不播。
- 先静音，再把倍速切到播放器菜单里最高的一档（实测 2x；平台不让改就保持原速），然后真实点击播放按钮；暂停了会恢复；放完停几秒再切下一节，偶尔会停得久一点。
- 遇到章节测验之类的非视频任务点会**跳过**，继续找下一个有视频的小节——计分的测验本工具不代做，也不该卡在那里。

## 二、注意事项

### 运行期间

- 浏览器窗口可以被别的窗口**盖住**，或者挪到另一个桌面，不影响播放。但**不要最小化**，也不要在同一个窗口里切到别的标签页，否则页面会变成后台状态，视频直接停。
- 脚本运行时，别在那个浏览器窗口里动鼠标。想用电脑就把它放到后面。
- 刷完把这个专用浏览器关掉。它开着调试端口，开着的时候本机的任何程序都能控制它。

### 遇到问题

| 现象 | 处理 |
| --- | --- |
| 双击 `start.cmd` 后 Windows 提示"已保护你的电脑" | 点"更多信息"→"仍要运行"。从网上下载的 ZIP 解压出来的脚本可能会这样 |
| `没找到 Node.js` | 按提示装 Node.js 20 或更新，装完重新运行 |
| `依赖安装失败` | 检查网络后重新运行。国内网络慢的话，先执行 `npm config set registry https://registry.npmmirror.com` |
| `没找到本机的 Chrome，也没找到 Edge` | 装好其中一个再运行。装在非默认位置的，见进阶教程里的「换浏览器」 |
| `Chrome 启动了，但调试端口一直没打开`（或 Edge） | 这个专用浏览器之前被你手动打开过（没带调试端口）。关掉它的所有窗口再运行 |
| 日志说"还剩 N 个非视频任务点" | 章节测验等需要你自己完成，脚本已经跳过去继续播视频了 |
| `点了目录…但页面没有切过去` | 平台可能弹了提示框，看一眼浏览器，处理掉再重新运行 |
| 页面改版、脚本找不到东西 | 带着日志提 issue；进阶教程里的 `--inspect` 能把页面结构打出来 |

## 三、进阶教程

### 加参数

参数加在启动命令后面，比如 `./start.sh --max-sections 1`。Windows 上要加参数的话，在命令行里进入仓库目录执行 `.\start.cmd --max-sections 1`（前面的 `.\` 不能省，某些环境下 cmd 不会在当前目录找可执行文件）。

| 参数 | 作用 |
| --- | --- |
| `--max-sections <n>` | 播完 n 节就停（第一次可以用 `--max-sections 1` 试试） |
| `--browser edge` | 用 Edge（`chrome` 用 Chrome；默认 `auto`：有 Chrome 用 Chrome，没有用 Edge） |
| `--no-auto-advance-no-video` | 只剩测验等非视频任务点的小节停下来等你处理（默认是直接跳过） |
| `--playback-rate <倍速>` | 默认 `max`，切到播放器倍速菜单里最高的一档；给数字则取不超过它的最高档，给 `1` 完全不碰 |
| `--no-mute` | 不静音 |
| `--log-level verbose` | 显示全部细节，排查问题时用 |
| `--inspect` | 只读查看当前页面的结构，不点击、不播放 |
| `--check` | 特征自检，不动课程进度 |
| `--setup` | 重新安装依赖 |
| `--help` | 列出全部参数 |

### 换浏览器

- `--browser chrome` / `--browser edge` 指定用哪个。明确选了哪个就只找哪个，找不到就报错，不会悄悄换成另一个。
- 浏览器装在非默认位置时，用 `--browser-path <可执行文件的完整路径>` 指定。旧参数名 `--chrome-path` 也认。
- Chrome 和 Edge 的专用目录是分开的（用户目录下的 `xuexitong-chrome` / `xuexitong-edge`），换了浏览器要重新登录一次。想换目录用 `--browser-profile <目录>`。
- 报 `…上开着的是 Chrome，不是你选的 Edge`：之前用另一种浏览器跑过，那个专用窗口还开着。关掉它，或者加 `--cdp-port 9333` 换个端口。

### 自己启动浏览器

不想让脚本代劳的话，也可以自己用调试端口启动 Chrome 或 Edge，脚本连得上就不会再启动一个。命令和脚本用的是同一组参数：

```bash
# Linux
google-chrome --remote-debugging-port=9222 --user-data-dir="$HOME/xuexitong-chrome" --disable-backgrounding-occluded-windows --mute-audio &

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir="$HOME/xuexitong-chrome" --disable-backgrounding-occluded-windows --mute-audio &
```

```bat
:: Windows（cmd）
"%ProgramFiles%\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\xuexitong-chrome" --disable-backgrounding-occluded-windows --mute-audio

:: Windows 上用 Edge
"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\xuexitong-edge" --disable-backgrounding-occluded-windows --disable-features=msImplicitSignin,msForceBrowserSignIn --disable-sync --mute-audio
```

Linux / macOS 上用 Edge 的话，把命令换成 `microsoft-edge` 或 `"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"`，目录换成 `xuexitong-edge`，同样加上 `--disable-features=msImplicitSignin,msForceBrowserSignIn --disable-sync`。

- 这几个参数都不能省，原因见下面的技术细节：少了 `--disable-backgrounding-occluded-windows`，Windows 上窗口被盖住视频就停；Edge 少了那两项，会被自动登录上你的微软账号。
- `--user-data-dir` 一定要是单独的目录。和平时用的浏览器共用的话，如果它已经开着，这条命令只会在原来的窗口里多开一个标签，**调试端口不会打开**。Edge 关掉窗口后默认还会在后台留着进程，更容易碰上这一条。
- 加 `--no-auto-launch` 可以让脚本连不上时只报错，不自己启动。

### 另一个版本：油猴 / 控制台版

不想装任何东西时用它：把 [`userscript/v3_optimized.js`](userscript/v3_optimized.js) 粘贴到课程播放页的控制台执行，或者在 Tampermonkey 里导入 [`userscript/v3_optimized.user.js`](userscript/v3_optimized.user.js)。完整说明见 [`userscript/README.md`](userscript/README.md)。它和 Playwright 版的差别见下面的技术细节。

## 四、有价值的技术细节

### 两个版本的差别

| | Playwright 版（推荐） | 油猴 / 控制台版 |
| --- | --- | --- |
| 在哪 | [`playwright/`](playwright/) | [`userscript/`](userscript/) |
| 需要装什么 | Node.js + 一个 npm 包 | 什么都不用装 |
| 点击是否可信（`isTrusted`） | 是 | 否，页面一查就知道 |
| 窗口放到后台 | 不受影响 | 会被页面发现失焦，只能事后把视频按回去 |

油猴版的点击是页面脚本合成的，`event.isTrusted` 恒为 `false` 且无法伪造；窗口失焦后页面也能察觉。页面只要检查这两点，油猴版就藏不住。

### 为什么可以被盖住、但不能最小化

- 失焦靠焦点模拟兜住（页面里 `hasFocus()` 一直是 `true`），但 `document.visibilityState` 没有办法模拟：最小化、在同一窗口切到别的标签页，页面都会变成 `hidden`，视频随之暂停。
- Windows 上还多一种情况：浏览器会追踪窗口有没有被盖住。实测（Chrome 155 / Win11）窗口被别的窗口完全盖住后 1 秒内页面就变 `hidden`，视频被直接暂停，盖着的那段时间进度一点不走。启动参数 `--disable-backgrounding-occluded-windows` 能让它被盖住时保持 `visible`（Chrome 和 Edge 都实测过），但兜不住最小化。脚本自己开的浏览器都带这一项。

### Edge 为什么要多带两个参数

实测（Edge 155 / Win11，Windows 登录着微软账号）：只带 `--no-first-run` 时，Edge 会把全新的专用目录也用系统账号自动登录上，并打开全量同步。窗口上弹出「正在你的所有设备上同步」的模态框把页面压暗；主账号的书签、密码、扩展同步进来，这边的浏览记录也同步回去。专用目录就不再独立了。

加上 `--disable-features=msImplicitSignin,msForceBrowserSignIn --disable-sync` 之后，同一个全新目录连续启动两次都没有登录、没有同步框。这几项只改浏览器自己的行为，页面上看不到。组策略 `ImplicitSignInEnabled` 也能关，但它会连你自己平时用的 Edge 一起改，所以不用。

Chrome 和 Edge 的专用目录分开放，各自登录一次，互不干扰。Chrome 那个沿用原来的目录名，以前登录过的不用重登。

### 目录结构

```
xuexitongScript/
├── README.md               ← 你正在看的
├── start.cmd               入口（Windows）：双击运行
├── start.sh                入口（Linux / macOS）：./start.sh
├── playwright/             Playwright 版（推荐）
│   ├── README.md           技术说明：原理、焦点模拟、检测面、测试
│   ├── run.mjs             start 脚本最终调用的就是它，也可以直接 node run.mjs
│   ├── package.json
│   ├── src/
│   │   ├── course.mjs      课程流程：读目录、选下一节、起播、监控、切节
│   │   ├── browser.mjs     连接浏览器；连不上时启动专用 Chrome / Edge；等你打开课程页
│   │   ├── setup.mjs       第一次运行时自动安装依赖
│   │   ├── pointer.mjs     真实指针：贝塞尔轨迹、点击、滚轮
│   │   ├── environment.mjs 焦点与生命周期模拟（窗口放后台不触发 blur）
│   │   ├── selectors.mjs   页面选择器，平台改版时只改这里
│   │   ├── config.mjs      默认配置与命令行参数
│   │   ├── inspect.mjs     --inspect 只读检查
│   │   ├── diagnose.mjs    --check 特征自检
│   │   ├── human.mjs       随机化（等待时长、落点）
│   │   ├── platform.mjs    三平台差异（Chrome / Edge 路径、profile 目录）
│   │   └── logger.mjs
│   └── tests/              单元测试 + 用真实 Chrome 跑的端到端测试
├── userscript/             油猴 / 控制台版
│   ├── README.md           用法与实现说明
│   ├── v3_optimized.js     唯一源码（控制台粘贴版）
│   ├── v3_optimized.user.js  油猴版，由 build.mjs 生成，不要手改
│   ├── build.mjs
│   └── tests/
├── legacy/                 上游的旧脚本（v2.js、xuexitong.js），不再维护
└── docs/
    └── ISSUES_REVIEW.md    上游 issue 的整理
```

### 测试

```bash
# Playwright 版
cd playwright
npm run test:unit       # 不需要浏览器
npm test                # 单元 + 端到端（需要本机装了 Chrome）

# 油猴版（改了 v3_optimized.js 之后）
node userscript/build.mjs
node userscript/tests/verify-v3.mjs
node userscript/tests/humanize-smoke.mjs
```

更多（焦点模拟怎么做的、还能被什么查出来、哪些是实测过的）见 [`playwright/README.md`](playwright/README.md)。

---

本项目仅用于脚本调试、前端自动化研究和页面行为分析，请遵守目标平台的使用规定。
