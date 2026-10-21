
# ***为了您更好地使用，请至少从开头看到 “二、注意事项”***

GitHub 打不开的话，用 Gitee 镜像：<https://gitee.com/lmmmp-17/course-helper>（Windows 安装包在它的「发行版」里）。

仅限非商业使用：本项目以 [CC BY-NC 4.0](LICENSE) 授权，不得用于商业盈利，详见文末「授权」。

# 碎碎念

本项目来自一个苦逼大学生和他的 Claude，在 GitHub 找了一圈，发现多多少少都有些小问题，比如过时和高风险，于是花了几天打磨了一下，本着技术平权和新手友好的原则搓了一个三合一工具，也同时针对主流的三个操作系统做了适配；**Windows 有 GUI，Linux 和 macOS 只有 TUI**

由于暴力伪造记录可能带来某些风险，所以三个子项目均使用 Playwright 让自动化操作更加像人，不过代价就是按最高倍速一点点播，但可以无人值守，适合在宿舍挂着

fork 上游作者的工作依然给了我很大启发，在此一并感谢🙏🙏🙏

**AIGC 警告**\
由于大部分内容由 AI 完成，欢迎提 Issue，不满意随便 fork

# 项目初衷

本工具旨在解放课余时间，让你做自己时间的主人\
使用时请遵守相关平台和机构规定，一旦使用该项目即代表你自行承担相关风险，带来的一切后果本人概不负责

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
- **智慧树不用自己装 Python**：第一次跑它时会自动准备好。Windows 上要先有 uv，没有的话，在网课助手里点开始就会直接用 winget 装（要等一两分钟）；单独双击 `autovisor\run.cmd` 时会先问你。
- **下载**：
  - Windows：到 [GitHub Releases](https://github.com/lmmmp-17/course-helper/releases) 或 [Gitee 发行版](https://gitee.com/lmmmp-17/course-helper/releases) 下载最新的 **`course-helper-windows.zip`**，解压。三个工具和窗口版程序都在里面。
    解压出来有好几个文件夹，**只需要双击 `网课助手.exe`**（一般在最下面），学习通、长江雨课堂、智慧树都在它里面选。别的文件夹是它要用的程序，不用点开，也别删。压缩包里的 `使用说明.txt` 写的也是这些。
  - Linux / macOS：在 GitHub 页面点 **Code → Download ZIP** 解压；或者 `git clone https://github.com/lmmmp-17/course-helper.git`。GitHub 打不开就用 Gitee：`git clone https://gitee.com/lmmmp-17/course-helper.git`。

### 2. 打开控制台

| 系统 | 怎么启动 |
| --- | --- |
| Windows | 双击解压出来的 **`网课助手.exe`**（窗口版，三个平台都在里面）；或者双击 **`start.cmd`**（终端版） |
| Linux / macOS | 在仓库目录下执行 **`./start.sh`**（终端版） |

窗口版和终端版用的是同一套后端和同一份设置，在哪边填过的值，换另一边打开都还在。两个不能同时开。

**窗口版**：一个独立窗口，用鼠标点。设置平时收成一行，点「改设置」展开。关窗口时如果还有平台在跑，会先问你，确认后把它们都停掉。

**终端版**：控制台就显示在这个命令行窗口里。窗口别关，关了在跑的平台会全部停掉。底部那一行会写着现在能按哪些键，常用的：

| 按键 | 作用 |
| --- | --- |
| 1 / 2 / 3 | 切到学习通 / 长江雨课堂 / 智慧树 |
| Enter | 开始 |
| S | 停止当前平台 |
| M | 静音开关 |
| C | 展开全部设置（展开后 Tab 或上下换一项，空格勾选、切换，Esc 收起） |
| PgUp / PgDn、End | 翻记录、回到最新 |
| Q | 退出（有平台在跑时会先问你） |

### 3. 开始

1. 选要用的平台（窗口版点平台名，终端版按 1 / 2 / 3）。设置不改就用默认的：静音、切到最高倍速、自动选浏览器。
2. 点「开始」（终端版按 **Enter**）。第一次会自动安装依赖，要等一两分钟，控制台会提示「第一次运行要先装依赖」。
3. 照控制台上的提示，在弹出来的浏览器窗口里操作：

   | 平台 | 你要做的 |
   | --- | --- |
   | 学习通 | 登录，进入课程，点开任意一节 |
   | 长江雨课堂 | 登录（验证码自己完成），进入课程，点开任意一个视频 |
   | 智慧树 | 登录（登录页的滑块自己拖），点开要学的课程，进到能看到视频的播放页 |

   三个平台都一样：登录，点开课程，脚本认出来就自动开始。只有第一次需要登录，以后会记住。
4. **想同时跑别的平台**：切过去再开始。正在跑的平台，名字旁边会显示已经跑了多久；中途出错停下、你还没切过去看的，名字旁边会标「停了」。
5. 要停哪个，就切到它点「停止」（终端版按 S）。关掉窗口版的窗口、或者在终端版里按 Q 退出，会把正在跑的全部停掉，等它们收完尾再走。

### 4. 它们会做什么

- 先静音，再切到播放器允许的最高倍速（学习通、雨课堂实测 2x，智慧树最高 1.5x），真实点击播放；暂停了会恢复，放完换下一个。
- 已经完成的跳过；**计分的测验不代做**，会跳过去接着找下一个视频。
- 智慧树课中弹出的不计分小题会自动作答并关掉；雨课堂播放中弹出任何窗口都会停下来等你处理。

## 二、注意事项

- **如果你同时要用电脑，推荐配合虚拟桌面食用**：把这些浏览器窗口挪到另一个桌面，自己在原来的桌面用电脑。Windows 上按 Win+Ctrl+D 新建桌面，Win+Ctrl+← / → 切换，Win+Tab 里可以把窗口拖到别的桌面。实测过的是 Linux 上的学习通、雨课堂和 Windows 上的学习通；智慧树和 macOS 还没实测。
- 每个平台各开一个浏览器窗口。这些窗口可以被别的窗口**盖住**，也可以挪到另一个桌面，但**别最小化**，也别在里面切到别的标签页，否则视频会停。
- 别在这些浏览器窗口里动鼠标。学习通的页面在鼠标离开时会自己暂停视频（平台防挂机的规则），所以在它的窗口里动了鼠标，视频可能会停一下，再被脚本点开（详见 [xuexitong/README.md](xuexitong/README.md) 的技术细节）。想用电脑就把它们放到后面。
- 取消勾选「静音」会直接外放声音，在教室、宿舍里注意。
- 同一个平台同时只能开一个；不同平台可以一起开。
- 控制台同时只能开一个。已经开着一个的话，再开会提示「…正在运行，先在那边退出」。
- 命令行窗口太小时控制台会提示你拉大一点（至少 60 列 × 18 行，100 列 × 30 行以上看着最舒服）。
- 用完把学习通、雨课堂的专用浏览器窗口关掉：它们开着调试端口，开着的时候本机任何程序都能控制它们。智慧树的浏览器会跟着它一起关。
- **以前单独用过雨课堂工具的**：它的调试端口从 9222 改成了 9223（这样才能和学习通同时跑）。第一次用新版之前，先把以前留下的雨课堂专用浏览器窗口关掉，不然新版起不来，学习通也可能连到那个旧窗口上去。

### 遇到问题

先在控制台里选中那个平台，看日志最后几行。常见的：

| 现象 | 处理 |
| --- | --- |
| 双击 `网课助手.exe` 或 `start.cmd` 后 Windows 提示"已保护你的电脑" | 点"更多信息"→"仍要运行"。从网上下载、没有数字签名的程序会这样 |
| 窗口版提示缺少 WebView2 运行时 | 点「是」去下载安装（Windows 11 自带，少数 Windows 10 没有）；或者点「否」先用终端版 |
| 窗口版提示「终端版的网课助手正在运行」 | 两个不能同时开，先在终端版里按 Q 退出 |
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

Windows 上双击 `.cmd` 运行时按 Ctrl+C，命令行窗口会问 `Terminate batch job (Y/N)?`（终止批处理操作吗）：按 Y 直接关窗口；按 N 窗口留着，可以看结束时的总结，再按任意键关掉。

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

### 发新版本（维护者）

1. 推一个 `v*` 标签到 GitHub（比如 `git tag v0.1.1 && git push origin v0.1.1`）。GitHub Actions 会编译 `网课助手.exe`，打成 `course-helper-windows.zip`，发到 GitHub Releases；标签里带 `-` 的（比如 `v0.2.0-rc.1`）发成预发布版。
2. Gitee 镜像不会自己跟上：到 <https://gitee.com/lmmmp-17/course-helper> 点仓库名旁边的同步按钮，拉取新的提交和标签。
3. 在 Gitee 的「发行版」里新建同名版本，把 GitHub Releases 上的 `course-helper-windows.zip` 下载下来传上去（`gh release download v0.1.1 -R lmmmp-17/course-helper`）。

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
| 被遮挡 | 三个工具的浏览器都带 `--disable-backgrounding-occluded-windows`，窗口互相盖住也不停（Windows 上实测，不带这一项盖住 1 秒内视频就停）。挪到另一个虚拟桌面也照常播放：Linux 上学习通、雨课堂实测过，Windows 上学习通真实播放实测过 |

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

2026-10-21 在 Windows 11（125% 缩放、深色模式）上测 v0.1.0-rc.2，发现、随后修掉的：

- 双击 `.cmd` 时，结束前打印的提示被清屏擦掉（「窗口版正在运行」、没装 Node、工具报错都看不到）。当前 Windows 上每次 `chcp` 换代码页都会清屏，脚本末尾切回原来的代码页时把这次打印的东西全擦了。现在切到 UTF-8 之后不再切回；双击的窗口本来马上就关。终端版正常退出时也不再停在「请按任意键继续」，出错才停。
- 深色模式下窗口版的标题栏是白的。现在跟着系统的深浅色走，切换时也跟着变。
- 和终端版互斥时弹的提示框躲在终端窗口后面。
- 在控制台里跑时，工具的状态行还写着「Ctrl+C 退出」，停止其实要点「停止」或者按 S。

同一天复测 v0.1.0-rc.3，又发现、随后修掉的：

- 双击三个工具自己的 `.cmd` 后按 Ctrl+C，`Terminate batch job (Y/N)?` 要问两遍：脚本为了切代码页又起了一个 cmd，两层各问一次。结尾的「按任意键」是英文，因为代码页是 65001 时 cmd 自带的那句是英文。
- 学习通、雨课堂在等课程页时，关掉它们的专用浏览器也不会退出，一直显示「已等 N 秒」。现在发现浏览器没了就正常退出。
- 在控制台里，学习通、雨课堂的「已等 N 秒」一分钟才更新一次。原因是工具把输出到管道当成输出到文件，状态行每分钟才记一行。现在改成发 `[[status]]` 行，界面实时刷新。
- 终端版：从展开的设置里开始，停下后设置仍是展开的，焦点还在输入框里；这时底栏写着「Q 退出」，按 Q 却是打字。另外太长的状态行和记录在右边被截断。
- 窗口版：单按一下 Alt 进入菜单模式后，再从别处关窗口，页面的确认框和系统对话框会同时弹出来。

接着复测 v0.1.0-rc.4，发现、随后修掉的：

- **`.cmd` 里的中文行被截成半截、当成命令执行，又出现了**（rc.2 修过一次），窗口版的记录里也看得到。pc 做了对照实验：先切到 65001 再从头重读的三种写法（`call`、直接运行、另起一个 `cmd`）全都会出错。同样的中文行，挪个位置就可能出事，所以问题出在 cmd 读含多字节字符的批处理本身。现在四个 `.cmd` 全部只用 ASCII，用户要看的中文提示放在旁边的 UTF-8 文本文件里（`launcher/start-messages.txt` 等），按键名取出来打印。切代码页再重读那一套也就不需要了，Ctrl+C 自然只问一遍。四个仓库都加了测试，`.cmd` 里一旦出现非 ASCII 字符，测试就会失败。
- 双击智慧树的 `run.cmd` 后按 Ctrl+C，会报「未处理异常」：真实控制台的 Ctrl+C 也发给了 Playwright 的驱动，驱动先退出了，再关浏览器就报连接断开。驱动一走浏览器也跟着结束，现在当成正常收尾。
- 已验证：Windows 上把浏览器留在另一个虚拟桌面 40 秒，学习通、雨课堂的页面一直是 `visible`。之后用户用 v0.1.0 真实播放学习通，挪到另一个虚拟桌面也照常播放。

复测 v0.1.0-rc.5：各个入口（双击、在已开的命令行里运行、窗口版启动）都不再出现半截中文，中文提示正常，Ctrl+C 只问一遍，智慧树按 Ctrl+C 正常收尾，回归项全部通过。顺手改掉两处观感问题：窗口版的记录里，uv 的进度（走 stderr）不再标成警告；Autovisor 的方块字符画在比例字体下会散掉，在控制台里改成一行字。

另外，自己跑测试时，一个偶发失败带出了一个更要紧的问题：雨课堂的一套播放器（xtplayer）会在一两秒内把外部设的静音改回去，而脚本设完静音只等 1～1.6 秒就检查，可能检查在它改回去之前，然后带着声音起播。脚本自己开的浏览器带 `--mute-audio`，声音被兜住了；连到你自己开的浏览器时会外放。现在要连续 2.5 秒保持静音才起播，详见 [yuketang/README.md](yuketang/README.md)。

### 控制台

- 每个平台一个运行槽：同一个平台不能开两个，不同平台互不等待。每条事件都带着是哪个平台的，界面按平台分别存表单、状态和日志，切换平台不影响别的在跑的。
- **停止 = 关掉工具的 stdin**。三个工具在控制台下把它当成 Ctrl+C，自己收尾；8 秒后还没退出才强制结束整棵进程树。Windows 上隔着 cmd.exe 发不了 Ctrl+C，以前只能强杀，智慧树每停一次就在 `%TEMP%` 留下一个 Playwright 的临时目录；现在实测 0.6 秒正常收尾、临时目录被删掉。
- 终端版只用 ASCII 画装饰（`[x]`、`(o)`、`>`），不用箭头、▶ 和框线字符：它们在中文 Windows 控制台里是两列宽，布局会错位。每一行按显示宽度截断，并关掉终端的自动换行。终端的窗口标题和窗口版的标题栏说法一样（`▶ 学习通 12:34`），标题由系统字体画，不受这个限制。
- 浏览器版只绑 `127.0.0.1`，接口要带启动时随机生成的口令。
- 更多（接口、配置文件怎么合并、Windows 上怎么停进程树）见 [launcher/README.md](launcher/README.md)。

### 目录结构

```
course-helper/
├── README.md              ← 你正在看的
├── LICENSE                CC BY-NC 4.0 全文
├── start.cmd              入口（Windows，终端版）
├── start.sh               入口（Linux / macOS，终端版）
├── desktop/windows/       Windows 窗口版外壳（网课助手.exe）：Go + WebView2，在 Releases 里发布
├── launcher/              控制台：本地 HTTP 服务 + 一个静态页面，没有 npm 依赖
├── xuexitong/             学习通（来自 lmmmp-17/xuexitongScript）
├── yuketang/              长江雨课堂（来自 lmmmp-17/yuketang）
├── autovisor/             智慧树（来自 lmmmp-17/Autovisor）
├── design/                界面设计稿
└── scripts/
    └── sync-from-forks.sh 从三个 fork 同步更新
```

只给维护者用的 `desktop/`、`scripts/`、`design/` 和 `.github/` 不进 Download ZIP，也不进发布包（`.gitattributes` 里的 `export-ignore`）。用户解压后看到的文件夹越少越好：有人对着一堆文件夹问过「该点哪个」。Windows 发布包里另外放了 `网课助手.exe` 和一份 `使用说明.txt`（源文件在 `desktop/windows/package/`）。

### 窗口版外壳（网课助手.exe）

- 纯 Go（`github.com/jchv/go-webview2`，不需要 cgo），在 Linux 上交叉编译：`desktop/windows/build.sh`。推送 `v*` 标签时由 GitHub Actions 编译，和仓库里用户要用的部分（`git archive`，见「目录结构」）以及 `使用说明.txt` 一起打成 `course-helper-windows.zip` 发到 Releases（`.github/workflows/release.yml`）。仓库里不放二进制文件。
- 它自己不干活：起一个后端（`node launcher\run.mjs --handshake`），读到地址后用 WebView2 打开窗口，里面就是浏览器版的那个页面。关窗口时关掉后端的 stdin，后端停掉所有平台、等它们收尾后退出；exe 被强杀时管道一断，后端照样收尾。
- 单实例：第二次双击把已经开着的窗口提到前面。和终端版互斥由后端的锁判断。
- 关窗口：外壳截下关闭消息（`WM_CLOSE`，以及任务栏「关闭窗口」发的 `SC_CLOSE`），请页面判断要不要问，用的是页面里的确认框。页面要先应一声，1.5 秒内没应声（脚本坏了之类）就改用系统对话框，保证窗口总能关掉。
- 建窗口之前先查 WebView2 运行时：缺了的话窗口会先画出来再失败，留下一个空白窗口。
- 标题栏跟着系统的深浅色走（`DwmSetWindowAttribute` 的 `DWMWA_USE_IMMERSIVE_DARK_MODE`），用户切换时收到 `WM_SETTINGCHANGE` 再设一次。页面本身靠 `prefers-color-scheme` 跟着走。
- WebView2 的数据和后端日志放在 `%LOCALAPPDATA%\course-helper\`，不在解压出来的文件夹里生成东西。

### 界面设计

窗口版和终端版的设计稿都在 `design/new/wangke-design/`（Claude Design 出的），交接说明在 `design/claude-design-brief.md`。

- `tokens.md`：颜色（浅色、深色各一套，文字色都按 WCAG 4.5:1 校过）、字号、间距、终端版对应的 16 色。
- `console.html`：原型，右下角的面板可以切出每一个状态。`launcher/public/index.html` 是照它接上真实后端的版本。
- `tui.txt`：终端版的布局草图。
- `icon.svg`：应用图标，`desktop/windows/winres/` 里是渲染好的各个尺寸。
- `copy-changes.md`：设计对原文案的改动。

### 测试

```bash
node --test launcher/tests/unit.test.mjs launcher/tests/backend.test.mjs launcher/tests/tui.test.mjs   # 控制台
(cd xuexitong/playwright && npm test)                          # 学习通：单元 + 端到端（需要本机 Chrome）
(cd yuketang/playwright && npm test)                           # 雨课堂：同上
(cd autovisor && uv run python -m unittest discover -s tests)  # 智慧树
(cd desktop/windows && go test ./...)                          # 窗口版外壳里和平台无关的部分
```

### 授权

本项目的目的是让同学们免费用，**不允许拿去商业盈利**。

- **本仓库自己写的部分**：控制台（`launcher/`）、窗口版外壳（`desktop/`）、界面设计（`design/`）、入口脚本、同步脚本和文档。**我对三个子项目做的修改**也一样。以上都以 [知识共享 署名-非商业性使用 4.0 国际（CC BY-NC 4.0）](https://creativecommons.org/licenses/by-nc/4.0/deed.zh-hans) 授权，全文见 [LICENSE](LICENSE)：可以自由使用、修改、转发，但要署名（注明来自 lmmmp-17/course-helper），而且**不得用于商业目的**，比如收费替别人挂网课、打包售卖、做成付费服务。
- **上游原有的代码**仍按上游的授权，这里改不了，也不该改：`autovisor/` 来自 CXRunfree/Autovisor，是 MIT（见 [autovisor/LICENSE](autovisor/LICENSE)，版权声明照原样保留）；学习通和雨课堂的上游都没有声明许可证。
- 所以，智慧树上游那部分原始代码别人照样可以按 MIT 去用；非商业的限制管的是这个仓库新增和改动的部分。

---

本项目仅用于学习和研究，请遵守学校与平台的相关规定。
