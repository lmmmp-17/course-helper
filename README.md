# 网课助手

一个仓库装下三个网课工具，外加一个控制台。学习通、长江雨课堂、智慧树可以**同时跑**，每个平台各开各的浏览器窗口，在同一个地方看进度。

| 平台 | 目录 | 工具 | 来自 |
| --- | --- | --- | --- |
| 学习通 | [`xuexitong/`](xuexitong/) | Playwright 版 | [lmmmp-17/xuexitongScript](https://github.com/lmmmp-17/xuexitongScript)（fork 自 chaolucky18/xuexitongScript） |
| 长江雨课堂 | [`yuketang/`](yuketang/) | Playwright 版 | [lmmmp-17/yuketang](https://github.com/lmmmp-17/yuketang)（fork 自 Gary-666/yuketang） |
| 智慧树 | [`autovisor/`](autovisor/) | Autovisor | [lmmmp-17/Autovisor](https://github.com/lmmmp-17/Autovisor)（fork 自 CXRunfree/Autovisor） |

## 一、初级使用教程

### 1. 准备（只做一次）

- **浏览器**：Google Chrome 或 Microsoft Edge，用你电脑上装的那个。Windows 自带 Edge，没装 Chrome 也能用。
- **Node.js 20 或更新**：
  - Windows：没装也没关系，第一次运行 `start.cmd` 时会问你要不要用 winget 自动装。
  - macOS：`brew install node`；Linux：用系统的包管理器装 `nodejs`。也可以到 [nodejs.org](https://nodejs.org/) 下载 LTS 版。
- **智慧树不用自己装 Python**：第一次跑它时会自动准备好（Windows 上会问你要不要用 winget 装 uv）。
- **下载**：
  - Windows：到 [Releases](https://github.com/lmmmp-17/course-helper/releases) 下载最新的 **`course-helper-windows.zip`**，解压。三个工具和窗口版程序都在里面。
  - Linux / macOS：在 GitHub 页面点 **Code → Download ZIP** 解压；或者 `git clone https://github.com/lmmmp-17/course-helper.git`。

### 2. 打开控制台

| 系统 | 怎么启动 |
| --- | --- |
| Windows | 双击解压出来的 **`网课助手.exe`**（窗口版）；或者双击 **`start.cmd`**（终端版） |
| Linux / macOS | 在仓库目录下执行 **`./start.sh`**（终端版） |

窗口版和终端版用的是同一套后端和同一份设置，在哪边填过的值，换另一边打开都还在。两个不能同时开。

**窗口版**：一个独立窗口，用鼠标点。关窗口时如果还有平台在跑，会先问你，确认后把它们都停掉。

**终端版**：控制台就显示在这个命令行窗口里。窗口别关，关了在跑的平台会全部停掉。按键：

| 按键 | 作用 |
| --- | --- |
| Tab | 切换平台 |
| 上 / 下 | 选中某一项 |
| 空格、左 / 右 | 勾选、改选项 |
| 回车 | 开始；在跑的时候是停止 |
| PgUp / PgDn | 往上翻日志 / 回到最新 |
| q | 退出（有平台在跑时会先问你） |

### 3. 开始

1. 选要用的平台（窗口版点平台名，终端版按 Tab），按需要改几个选项。不改就用默认的：静音、切到最高倍速、自动选浏览器。
2. 点「开始」（终端版按 **回车**）。第一次会自动安装依赖，要等一会儿。
3. 照控制台上的提示，在弹出来的浏览器窗口里操作：

   | 平台 | 你要做的 |
   | --- | --- |
   | 学习通 | 登录，进入课程，点开任意一节 |
   | 长江雨课堂 | 登录（验证码自己完成），进入课程，点开任意一个视频 |
   | 智慧树 | 登录（登录页的滑块自己拖），点开要学的课程，进到能看到视频的播放页 |

   三个平台都一样：登录，点开课程，脚本认出来就自动开始。只有第一次需要登录，以后会记住。
4. **想同时跑别的平台**：切过去再开始。正在跑的平台，名字旁边会显示已经跑了多久；中途出错停下、你还没切过去看的，名字旁边会标「停了」。
5. 要停哪个，就切到它点「停止」（终端版按回车）。关掉窗口版的窗口、或者在终端版里按 q 退出，会把正在跑的全部停掉，等它们收完尾再走。

### 4. 它们会做什么

- 先静音，再切到播放器允许的最高倍速（学习通、雨课堂实测 2x，智慧树最高 1.5x），真实点击播放；暂停了会恢复，放完换下一个。
- 已经完成的跳过；**计分的测验不代做**，会跳过去接着找下一个视频。
- 智慧树课中弹出的不计分小题会自动作答并关掉；雨课堂播放中弹出任何窗口都会停下来等你处理。

## 二、注意事项

- 每个平台各开一个浏览器窗口。这些窗口可以被别的窗口**盖住**，也可以挪到另一个桌面，但**别最小化**，也别在里面切到别的标签页，否则视频会停。
- 别在这些浏览器窗口里动鼠标。想用电脑就把它们放到后面。
- 取消勾选「静音」会直接外放声音，在教室、宿舍里注意。
- 同一个平台同时只能开一个；不同平台可以一起开。
- 控制台同时只能开一个。已经开着一个的话，再开会提示「…正在运行，先在那边退出」。
- 命令行窗口太小时控制台会提示你拉大一点（至少 60 列 × 18 行）。
- 刷完把学习通、雨课堂的专用浏览器窗口关掉：它们开着调试端口，开着的时候本机任何程序都能控制它们。智慧树的浏览器会跟着它一起关。
- **以前单独用过雨课堂工具的**：它的调试端口从 9222 改成了 9223（这样才能和学习通同时跑）。第一次用新版之前，先把以前留下的雨课堂专用浏览器窗口关掉，不然新版起不来，学习通也可能连到那个旧窗口上去。

### 遇到问题

先在控制台里选中那个平台，看日志最后几行。常见的：

| 现象 | 处理 |
| --- | --- |
| 双击 `网课助手.exe` 或 `start.cmd` 后 Windows 提示"已保护你的电脑" | 点"更多信息"→"仍要运行"。从网上下载、没有数字签名的程序会这样 |
| 窗口版提示缺少 WebView2 运行时 | 点「是」去下载安装（Windows 11 自带，少数 Windows 10 没有）；或者点「否」先用终端版 |
| 窗口版提示「终端版的网课助手正在运行」 | 两个不能同时开，先在终端版里按 q 退出 |
| `没找到 Node.js` | 按提示装 Node.js 20 或更新，装完重新运行 |
| `依赖安装失败` | 检查网络后重新开始。国内网络慢的话，先执行 `npm config set registry https://registry.npmmirror.com` |
| `调试端口一直没打开` | 这个平台的专用浏览器之前被打开过、还没关。关掉它的所有窗口再开始 |
| `…上开着的是 Chrome，不是你选的 Edge` | 之前用另一种浏览器跑过，那个专用窗口还开着。关掉它再开始 |
| 智慧树点开课程后一直没开始 | 要进到能直接看到视频的**播放页**，课程首页、课程列表不算 |
| 平台名字是灰的 | 那个工具的目录不在了。重新下载完整的仓库 |

各平台更细的说明在它们自己的 README 里：[学习通](xuexitong/README.md)、[雨课堂](yuketang/README.md)、[智慧树](autovisor/README.md)。

## 三、进阶教程

### 不用控制台，单独运行某个工具

三个工具的目录都是完整的项目，进去照它们自己的 README 用就行，参数也在那里：

| 平台 | 入口 | 说明 |
| --- | --- | --- |
| 学习通 | `xuexitong/start.cmd`、`xuexitong/start.sh` | [xuexitong/README.md](xuexitong/README.md) |
| 长江雨课堂 | `yuketang/start.cmd`、`yuketang/start.sh` | [yuketang/README.md](yuketang/README.md) |
| 智慧树 | `autovisor/run.cmd`、`autovisor/run.sh` | [autovisor/README.md](autovisor/README.md) |

单独运行和在控制台里运行可以混着来，只是同一个平台别同时开两个。

单独运行智慧树时可以在配置文件里填课程地址（`URL1`、`URL2`…），它会按顺序一门一门跑；控制台里启动的不用这些地址，和另外两个平台一样等你自己点开课程。

### 各平台的调试端口

| 平台 | 端口 | 什么时候用到 |
| --- | --- | --- |
| 学习通 | 9222 | 专用浏览器 |
| 长江雨课堂 | 9223 | 专用浏览器 |
| 智慧树 | 9224 | 只在「连接已有 Chrome」模式下用；普通模式由 Playwright 自己启动浏览器，不占端口 |

要换的话：学习通、雨课堂加 `--cdp-port <端口>`，智慧树改配置里的 `cdpUrl`。

### 控制台的选项

- `./start.sh --web`（Windows 是 `start.cmd --web`）：不用终端版，改在你的默认浏览器里打开控制台。`--port <端口>` 固定它的端口，`--no-open` 只打印地址不自动打开。
- 上次选的平台和填过的值记在系统的用户配置目录里（Windows 是 `%APPDATA%\course-helper\`，Linux 是 `~/.config/course-helper/`，macOS 是 `~/Library/Application Support/course-helper/`），不存密码。终端版和浏览器版共用这一份。
- 工具目录放在别处、加一个新工具：见 [launcher/README.md](launcher/README.md)。

### 从三个 fork 同步更新（维护者）

代码在三个 fork 里改，改完同步到这里：

```bash
scripts/sync-from-forks.sh              # 三个都同步
scripts/sync-from-forks.sh autovisor    # 只同步一个
```

装了 git-subtree 的话，也可以直接用它，效果一样：

```bash
git subtree pull --prefix=xuexitong https://github.com/lmmmp-17/xuexitongScript feat/low-fingerprint-playwright --squash
git subtree pull --prefix=yuketang  https://github.com/lmmmp-17/yuketang feat/real-browser --squash
git subtree pull --prefix=autovisor https://github.com/lmmmp-17/Autovisor feat/low-fingerprint-cross-platform --squash
```

Fedora 上 git 不带 subtree，要先 `sudo dnf install git-subtree`；Windows 的 Git for Windows 和 macOS 的 git 都自带。

## 四、有价值的技术细节

### 为什么用 subtree，不用 submodule

- GitHub 的 **Download ZIP 不包含 submodule 的内容**，下下来是三个空目录。这个仓库的读者大多是下 ZIP 的，所以三个工具的文件必须真的在仓库里。
- 用 subtree 的 squash 方式合进来：仓库里只有每次同步时的快照，`.git` 不到 2MB，三个 fork 各自的完整历史还在 fork 里。每次同步的提交尾注里记着同步到了 fork 的哪个提交（`git-subtree-split`）。
- 三个 fork 仍然是源头：上游有更新，先合进 fork，再同步到这里。

### 三个工具为什么能同时跑

| 可能冲突的地方 | 怎么分开的 |
| --- | --- |
| 浏览器和登录状态 | 学习通、雨课堂各用自己的专用目录（用户目录下的 `xuexitong-chrome`、`yuketang-chrome`，Edge 是 `-edge`）；智慧树普通模式由 Playwright 每次开一个临时目录 |
| 调试端口 | 9222 / 9223 / 9224 错开。以前学习通和雨课堂都用 9222，后开的那个会直接连到先开的那个浏览器上去 |
| 鼠标 | 点击和滚动是通过 CDP 发给各自页面的输入事件，不是挪系统光标，几个窗口之间不会抢 |
| 窗口焦点 | 三个工具都在各自页面上开了焦点模拟，后台窗口里的页面照样认为自己有焦点 |
| 被遮挡 | 三个工具的浏览器都带 `--disable-backgrounding-occluded-windows`，窗口互相盖住也不停（Windows 上实测，不带这一项盖住 1 秒内视频就停） |

2026-10-20 实测：

- Linux：三个真实工具同时运行，学习通、雨课堂各自起了专用 Chrome、连上各自的端口，智慧树起了自己的 Chrome 停在登录页，三个浏览器进程互不相干。从控制台停掉智慧树，它的 Python 进程和浏览器都正常结束。当时本机的 9222 被一个旧的雨课堂窗口占着，所以学习通、雨课堂是用临时端口和临时目录测的。
- Windows 11：三个工具通过控制台同时启动，学习通连 9222、雨课堂连 9223、智慧树起了 Edge，三个用户目录各不相同。按顺序停掉三个，每次都只结束了那一个工具的整棵进程树（智慧树那次是 13 个进程），另外两个不受影响；学习通、雨课堂的专用 Chrome 按设计留着。在控制台的命令行窗口按 Ctrl+C，在跑的工具会一起停掉。

这一轮在 Windows 上发现、随后修掉并复测通过的：

- 工具自己结束后入口脚本卡在 pause 上，控制台一直显示在跑；
- 中文 Windows 控制台下 `.cmd` 里的中文行被读错位；
- 智慧树的 Edge 被自动登录上系统的微软账号；
- 智慧树的中文日志是乱码（Python 往管道写用的是 cp936）；
- 停止时只能强杀，`%TEMP%` 里每次留下一个 Playwright 临时目录。改成关 stdin 之后，智慧树 0.6 秒正常收尾，临时目录被删掉；
- Windows 上阻塞读 stdin 会让 `import cv2` 卡死，改成每 0.2 秒查一次管道。

### 控制台

- 每个平台一个运行槽：同一个平台不能开两个，不同平台互不等待。每条事件都带着是哪个平台的，界面按平台分别存表单、状态和日志，切换平台不影响别的在跑的。
- **停止 = 关掉工具的 stdin**。三个工具在控制台下把它当成 Ctrl+C，自己收尾；8 秒后还没退出才强制结束整棵进程树。Windows 上隔着 cmd.exe 发不了 Ctrl+C，以前只能强杀，智慧树每停一次就在 `%TEMP%` 留下一个 Playwright 的临时目录；现在实测 0.6 秒正常收尾、临时目录被删掉。
- 终端版只用 ASCII 画装饰（`[x]`、`(o)`、`>`），不用箭头、▶ 和框线字符：它们在中文 Windows 控制台里是两列宽，布局会错位。每一行按显示宽度截断，并关掉终端的自动换行。
- 浏览器版只绑 `127.0.0.1`，接口要带启动时随机生成的口令。
- 更多（接口、配置文件怎么合并、Windows 上怎么停进程树）见 [launcher/README.md](launcher/README.md)。

### 目录结构

```
course-helper/
├── README.md              ← 你正在看的
├── start.cmd              入口（Windows，终端版）
├── start.sh               入口（Linux / macOS，终端版）
├── desktop/windows/       Windows 窗口版外壳（网课助手.exe）：Go + WebView2，在 Releases 里发布
├── launcher/              控制台：本地 HTTP 服务 + 一个静态页面，没有 npm 依赖
├── xuexitong/             学习通（来自 lmmmp-17/xuexitongScript）
├── yuketang/              长江雨课堂（来自 lmmmp-17/yuketang）
├── autovisor/             智慧树（来自 lmmmp-17/Autovisor）
└── scripts/
    └── sync-from-forks.sh 从三个 fork 同步更新
```

### 窗口版外壳（网课助手.exe）

- 纯 Go（`github.com/jchv/go-webview2`，不需要 cgo），在 Linux 上交叉编译：`desktop/windows/build.sh`。推送 `v*` 标签时由 GitHub Actions 编译，和整个仓库一起打成 `course-helper-windows.zip` 发到 Releases（`.github/workflows/release.yml`）。仓库里不放二进制文件。
- 它自己不干活：起一个后端（`node launcher\run.mjs --handshake`），读到地址后用 WebView2 打开窗口，里面就是浏览器版的那个页面。关窗口时关掉后端的 stdin，后端停掉所有平台、等它们收尾后退出；exe 被强杀时管道一断，后端照样收尾。
- 单实例：第二次双击把已经开着的窗口提到前面。和终端版互斥由后端的锁判断。
- 建窗口之前先查 WebView2 运行时：缺了的话窗口会先画出来再失败，留下一个空白窗口。
- WebView2 的数据和后端日志放在 `%LOCALAPPDATA%\course-helper\`，不在解压出来的文件夹里生成东西。

### 测试

```bash
node --test launcher/tests/unit.test.mjs launcher/tests/backend.test.mjs launcher/tests/tui.test.mjs   # 控制台
(cd xuexitong/playwright && npm test)                          # 学习通：单元 + 端到端（需要本机 Chrome）
(cd yuketang/playwright && npm test)                           # 雨课堂：同上
(cd autovisor && uv run python -m unittest discover -s tests)  # 智慧树
(cd desktop/windows && go test ./...)                          # 窗口版外壳里和平台无关的部分
```

### 授权

各目录沿用原项目的授权：`autovisor/` 是 MIT（见 [autovisor/LICENSE](autovisor/LICENSE)）；学习通和雨课堂的上游没有声明许可证。

---

本项目仅用于学习和研究，请遵守学校与平台的相关规定。
