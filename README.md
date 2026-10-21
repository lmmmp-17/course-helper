# 长江雨课堂刷课工具

自动学习长江雨课堂课程里的视频和图文。fork 自 [Gary-666/yuketang](https://github.com/Gary-666/yuketang)，这个分支加了一个 **Playwright 版**：用你自己的 Chrome 或 Edge 打开课程，真实点击播放，观看记录由平台自己的播放器上报。下面的教程讲的都是 Playwright 版。

## 一、初级使用教程

### 1. 准备（只做一次）

- **Google Chrome 或 Microsoft Edge**：用你电脑上装的那个。两个都有时默认用 Chrome；Windows 自带 Edge，没装 Chrome 也能直接用。
- **Node.js 20 或更新**：
  - Windows：没装也没关系，第一次运行 `start.cmd` 时会问你要不要用 winget 自动装。
  - macOS：`brew install node`；Linux：用系统的包管理器装 `nodejs`。也可以到 [nodejs.org](https://nodejs.org/) 下载 LTS 版。
- **下载这个仓库**：在 GitHub 页面点 **Code → Download ZIP** 解压；或者 `git clone https://github.com/lmmmp-17/yuketang.git`。

### 2. 运行

| 系统 | 怎么启动 |
| --- | --- |
| Windows | 双击仓库里的 **`start.cmd`** |
| Linux / macOS | 在仓库目录下执行 **`./start.sh`** |

接下来：

1. 第一次运行会自动安装依赖（只装一个约 5MB 的 npm 包，不下载浏览器），之后就不再装了。
2. 脚本会自动打开一个**专用的 Chrome**（没装 Chrome 就是 Edge）：单独的用户目录，和你平时用的浏览器分开，全程静音。
3. 在这个浏览器里**登录长江雨课堂**（登录时的验证码自己完成）。只有第一次需要登录，以后会记住。
4. 进入要学的课程，**点开任意一个视频**，进到「学习空间」页面（地址里带 `/ai-workspace/lms-graph/`）。脚本看到这个页面就会自动开始。

从哪一项开始，脚本就从哪一项往后学；后面都学完了，会回到前面补还没完成的。要停的时候按 `Ctrl+C`，或者直接关掉命令行窗口；浏览器不会被关掉。Windows 上按 `Ctrl+C` 后命令行会问 `Terminate batch job (Y/N)?`（终止批处理操作吗）：按 Y 直接关窗口，按 N 留着窗口看结束时的总结。

### 3. 它会做什么

- 读左侧「知识点」目录，找下一个**没打勾**的视频或图文。课堂（直播回放）不碰。折叠着的知识点，走到它时先展开，因为里面的视频不展开就不显示。
- **视频**：先静音，真实点击播放，起播后把倍速切到播放器菜单里最高的一档（实测 2x；平台不让改就保持原速）；暂停了会恢复，缓冲时就等着；放完停几秒再换下一项，偶尔会停得久一点。已经看完的不重放。
- **图文**：停留 25–70 秒，期间用滚轮往下翻。
- 播放中**弹出任何窗口**（提示、题目）都会停下来等你处理，不替你点。

## 二、注意事项

### 运行期间

- 浏览器窗口可以被别的窗口**盖住**，或者挪到另一个桌面，不影响播放。但**不要最小化**，也不要在同一个窗口里切到别的标签页，否则页面会变成后台状态，视频直接停。
- 脚本运行时，别在那个浏览器窗口里动鼠标。想用电脑就把它放到后面。
- 学完把这个专用浏览器关掉。它开着调试端口，开着的时候本机的任何程序都能控制它。

### 遇到问题

| 现象 | 处理 |
| --- | --- |
| 双击 `start.cmd` 后 Windows 提示"已保护你的电脑" | 点"更多信息"→"仍要运行"。从网上下载的 ZIP 解压出来的脚本可能会这样 |
| `没找到 Node.js` | 按提示装 Node.js 20 或更新，装完重新运行 |
| `依赖安装失败` | 检查网络后重新运行。国内网络慢的话，先执行 `npm config set registry https://registry.npmmirror.com` |
| `没找到本机的 Chrome，也没找到 Edge` | 装好其中一个再运行。装在非默认位置的，见进阶教程里的「换浏览器」 |
| `Chrome 启动了，但调试端口一直没打开`（或 Edge） | 这个专用浏览器之前被你手动打开过（没带调试端口）。关掉它的所有窗口再运行 |
| `播放被弹窗打断：…已停下` | 看一眼浏览器，把弹窗处理掉，再重新运行 |
| `视频缓冲了 N 秒还没动` | 网络或视频源有问题，刷新页面后重新运行 |
| `点了「…」但页面没有切过去` | 平台可能弹了提示框，看一眼浏览器，处理掉再重新运行 |
| 页面改版、脚本找不到东西 | 带着日志提 issue；进阶教程里的 `--inspect` 能把页面结构打出来 |

## 三、进阶教程

### 加参数

参数加在启动命令后面，比如 `./start.sh --max-items 1`。Windows 上要加参数的话，在命令行里进入仓库目录执行 `.\start.cmd --max-items 1`（前面的 `.\` 不能省，某些环境下 cmd 不会在当前目录找可执行文件）。

| 参数 | 作用 |
| --- | --- |
| `--max-items <n>` | 学完 n 项就停（第一次可以用 `--max-items 1` 试试） |
| `--no-articles` | 只看视频，跳过图文 |
| `--browser edge` | 用 Edge（`chrome` 用 Chrome；默认 `auto`：有 Chrome 用 Chrome，没有用 Edge） |
| `--playback-rate <倍速>` | 默认 `max`，切到播放器倍速菜单里最高的一档；给数字则取不超过它的最高档，给 `1` 完全不碰 |
| `--no-mute` | 不静音 |
| `--log-level verbose` | 显示全部细节，排查问题时用 |
| `--inspect` | 只读查看目录和当前项，不点击、不播放 |
| `--check` | 特征自检，不动学习进度 |
| `--setup` | 重新安装依赖 |
| `--help` | 列出全部参数 |

### 换浏览器

- `--browser chrome` / `--browser edge` 指定用哪个。明确选了哪个就只找哪个，找不到就报错，不会悄悄换成另一个。
- 浏览器装在非默认位置时，用 `--browser-path <可执行文件的完整路径>` 指定。旧参数名 `--chrome-path` 也认。
- Chrome 和 Edge 的专用目录是分开的（用户目录下的 `yuketang-chrome` / `yuketang-edge`），换了浏览器要重新登录一次。想换目录用 `--browser-profile <目录>`。
- 报 `…上开着的是 Chrome，不是你选的 Edge`：之前用另一种浏览器跑过，那个专用窗口还开着。关掉它，或者加 `--cdp-port 9333` 换个端口。
- 调试端口默认是 9223，特意和学习通工具的 9222 错开，两个工具可以同时跑。

### 自己启动浏览器

不想让脚本代劳的话，也可以自己用调试端口启动 Chrome 或 Edge，脚本连得上就不会再启动一个。命令和脚本用的是同一组参数：

```bash
# Linux
google-chrome --remote-debugging-port=9223 --user-data-dir="$HOME/yuketang-chrome" --disable-backgrounding-occluded-windows --mute-audio &

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9223 --user-data-dir="$HOME/yuketang-chrome" --disable-backgrounding-occluded-windows --mute-audio &
```

```bat
:: Windows（cmd）
"%ProgramFiles%\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9223 --user-data-dir="%USERPROFILE%\yuketang-chrome" --disable-backgrounding-occluded-windows --mute-audio

:: Windows 上用 Edge
"%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9223 --user-data-dir="%USERPROFILE%\yuketang-edge" --disable-backgrounding-occluded-windows --disable-features=msImplicitSignin,msForceBrowserSignIn --disable-sync --mute-audio
```

Linux / macOS 上用 Edge 的话，把命令换成 `microsoft-edge` 或 `"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"`，目录换成 `yuketang-edge`，同样加上 `--disable-features=msImplicitSignin,msForceBrowserSignIn --disable-sync`。

- 这几个参数都不能省，原因见下面的技术细节：少了 `--disable-backgrounding-occluded-windows`，Windows 上窗口被盖住视频就停；Edge 少了那两项，会被自动登录上你的微软账号。
- `--user-data-dir` 一定要是单独的目录。和平时用的浏览器共用的话，如果它已经开着，这条命令只会在原来的窗口里多开一个标签，**调试端口不会打开**。Edge 关掉窗口后默认还会在后台留着进程，更容易碰上这一条。
- 加 `--no-auto-launch` 可以让脚本连不上时只报错，不自己启动。

### 另一个版本：请求版（上游原来的）

在 [`legacy/`](legacy/)，说明见 [`legacy/README.md`](legacy/README.md)。它只支持旧版视频页，要装 Python 和几个包、手动抄 Cookie。和 Playwright 版的差别见下面的技术细节。

## 四、有价值的技术细节

### 两个版本的差别

| | Playwright 版（推荐） | 请求版（上游原来的） |
| --- | --- | --- |
| 在哪 | [`playwright/`](playwright/) | [`legacy/`](legacy/) |
| 怎么完成学习 | 真的打开页面、播放视频 | 不播放，直接往接口发拼出来的心跳 |
| 支持的页面 | 新版「学习空间」（`/ai-workspace/lms-graph/`） | 旧版视频页 |
| 需要装什么 | Node.js + 一个 npm 包 + Chrome 或 Edge | Python + 几个包，要手动抄 Cookie |

请求版发出的请求和真实播放器的对不上（心跳格式、节奏、页面标识都不一样，还默认三个视频同时"看"），详见 [`playwright/README.md`](playwright/README.md#为什么不在-mainpy-上改)。

### 为什么可以被盖住、但不能最小化

- 失焦靠焦点模拟兜住（页面里 `hasFocus()` 一直是 `true`），但 `document.visibilityState` 没有办法模拟：最小化、在同一窗口切到别的标签页，页面都会变成 `hidden`，视频随之暂停。
- Windows 上还多一种情况：浏览器会追踪窗口有没有被盖住。实测（Chrome 155 / Win11）窗口被别的窗口完全盖住后 1 秒内页面就变 `hidden`，视频被直接暂停，盖着的那段时间进度一点不走。启动参数 `--disable-backgrounding-occluded-windows` 能让它被盖住时保持 `visible`（Chrome 和 Edge 都实测过），但兜不住最小化。脚本自己开的浏览器都带这一项。
- 挪到另一个虚拟桌面：Linux 上学习通、雨课堂都实测过，照常播放（2026-10-21）。Windows 上不在当前桌面的 40 秒里，页面一直是 `visible`，靠的应该也是 `--disable-backgrounding-occluded-windows`；只看了页面状态，播放进度还没实测。

### 静音为什么要盯 2.5 秒

雨课堂有两套播放器。数字人播放器设上 `muted` 就静音了。另一套（xtplayer）有看门狗，外部设的 `muted` 会被它在一两秒内改回去，只有点它自己的音量键才保持得住。

以前设完 `muted` 等 1～1.6 秒看一眼，可能看在看门狗动手之前，于是判成「已静音」，带着声音起播。脚本自己开的浏览器带 `--mute-audio`，声音被兜住了；连到你自己开的浏览器时就会外放。现在设完要连续 2.5 秒都保持静音才算数，中途被改回去就去点播放器的音量键。测试里的桩把看门狗设成 2 秒，旧的做法每次都过不了。

### Edge 为什么要多带两个参数

实测（Edge 155 / Win11，Windows 登录着微软账号）：只带 `--no-first-run` 时，Edge 会把全新的专用目录也用系统账号自动登录上，并打开全量同步。窗口上弹出「正在你的所有设备上同步」的模态框把页面压暗；主账号的书签、密码、扩展同步进来，这边的浏览记录也同步回去。专用目录就不再独立了。

加上 `--disable-features=msImplicitSignin,msForceBrowserSignIn --disable-sync` 之后，同一个全新目录连续启动两次都没有登录、没有同步框。这几项只改浏览器自己的行为，页面上看不到。组策略 `ImplicitSignInEnabled` 也能关，但它会连你自己平时用的 Edge 一起改，所以不用。

Chrome 和 Edge 的专用目录分开放，各自登录一次，互不干扰。Chrome 那个沿用原来的目录名，以前登录过的不用重登。

### 目录结构

```
yuketang/
├── README.md               ← 你正在看的
├── start.cmd               入口（Windows）：双击运行
├── start.sh                入口（Linux / macOS）：./start.sh
├── playwright/             Playwright 版（推荐）
│   ├── README.md           技术说明：真实页面上的观察、和请求版的差别、测试
│   ├── run.mjs             start 脚本最终调用的就是它，也可以直接 node run.mjs
│   ├── package.json
│   ├── src/
│   │   ├── learning.mjs    学习流程：读目录、选下一项、展开知识点、播放视频、阅读图文
│   │   ├── browser.mjs     连接浏览器；连不上时启动专用 Chrome / Edge；等你打开学习空间页面
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
└── legacy/                 上游原来的请求版（main.py），说明见 legacy/README.md
```

### 测试

```bash
cd playwright
npm run test:unit       # 不需要浏览器
npm test                # 单元 + 端到端（需要本机装了 Chrome）
```

更多（在真实页面上观察到了什么、两套播放器、还有哪些没确认）见 [`playwright/README.md`](playwright/README.md)。

---

本项目仅供学习和研究使用，请遵守学校与平台的相关规定。
