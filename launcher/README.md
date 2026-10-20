# 控制台（launcher）

网课助手的控制台：三个平台在这里启动、停止、看进度，可以同时跑。**怎么用见仓库根目录的 [README](../README.md#一初级使用教程)**，这里讲它怎么做的、怎么改。

没有任何 npm 依赖，需要 Node.js 20 或更新。入口是仓库根目录的 `start.cmd` / `start.sh`，也可以直接 `node launcher/run.mjs`。

几种界面共用同一个后端（`src/runner.mjs`）和同一份设置：

| 界面 | 怎么进 | 说明 |
| --- | --- | --- |
| 终端版（TUI） | 在终端里运行时默认就是它，也可以 `--tui` | `src/tui/`，直接在进程里调用 runner，不走 HTTP |
| 浏览器版 | `--web`（不在终端里运行时也走这个） | 本地 HTTP 服务 + `public/index.html` |
| 窗口版 | `--handshake`，由 `网课助手.exe` 启动 | 和浏览器版同一个页面，装在 WebView2 窗口里。外壳在 `desktop/windows/`，见根目录 README 的技术细节 |

## 命令行参数

| 参数 | 作用 |
| --- | --- |
| `--tui` / `--web` | 选界面，见上表 |
| `--port <端口>` | 浏览器版的本地端口，默认随机 |
| `--no-open` | 浏览器版不自动打开浏览器，只打印地址 |
| `--handshake` | 给窗口版外壳用：stdout 只打一行 JSON（`{ready, url}`，或者被占用时 `{ready:false, error:'locked', holder}`），stdin 关掉就停掉所有工具再退出 |
| `--help` | 显示说明 |

## 共享设置和锁

- **`src/settings.mjs`**：上次选的平台、每个平台填过的值（不存密码），放在系统的用户配置目录：Windows `%APPDATA%\course-helper\settings.json`，Linux `$XDG_CONFIG_HOME/course-helper/`（默认 `~/.config`），macOS `~/Library/Application Support/course-helper/`。工具启动成功时写入。预填的优先级：工具自己的配置文件 > 这里记的 > 登记表默认值。
- **`src/lock.mjs`**：同一时间只能有一个后端，不然同一个平台会被启动两次、抢同一个专用浏览器。锁文件 `launcher.lock` 放在同一目录，记着是谁占着（`gui` / `tui` / `web`）；占锁的进程已经不在了就当作失效、直接接手。

## 终端版

- `src/tui/width.mjs`：按 East Asian Width 算显示宽度，中文占两列；按宽度截断、折行。
- `src/tui/screen.mjs`：备用屏幕、raw 模式、按键解析、整帧绘制。每一行用绝对位置写、写完清到行尾，并关掉自动换行，宽度算错也只会截掉，不会串行。任何方式退出都先恢复终端。
- `src/tui/app.mjs`：状态、按键和「这一帧长什么样」，不碰终端，测试直接喂按键、读画面。
- 装饰只用 ASCII（`[x]`、`(o)`、`>`、`...`）：箭头、▶、框线字符和「…」在中文 Windows 控制台里是两列宽。
- 日志、结束原因、已运行时长的说法在 `src/present.mjs`；浏览器版的页面里有一份同样的逻辑，改说法时两边一起改。

## 工具目录放在别处

默认按合并仓库里的位置找：`launcher/` 旁边的 `xuexitong/`、`yuketang/`、`autovisor/`。放在别处的话，在 `launcher/` 里建一个 `tools.local.json`（已在 `.gitignore` 里），写上实际路径：

```json
{
  "xuexitong": "D:\\code\\xuexitongScript",
  "yuketang": "D:\\code\\yuketang",
  "autovisor": "D:\\code\\Autovisor"
}
```

界面上找不到的工具会显示成灰的，鼠标移上去能看到它找的是哪个路径。

## 加一个工具

改 `src/tools.mjs` 里的登记表，加一条就行，界面是照着这张表画出来的。两类：

- `kind: 'flags'`：选项通过命令行参数传（学习通、雨课堂这种）
- `kind: 'config'`：选项写进配置文件，再运行入口脚本（Autovisor 这种）

选项可以按平台限制（`platforms`），单选里的某一项也可以（比如 Chromium 只在 Linux 上出现），默认值也可以按平台给（`platformDefault`）。每次启动都要带的参数写在 `fixedArgs`（智慧树带 `--wait-course`：不用配置里的课程地址，等你在浏览器里点开课程，和另外两个平台一样）。

新工具要和别的一起跑，得保证它不和已有的抢东西：浏览器的用户目录、调试端口（已经用了 9222 / 9223 / 9224）。

## 为什么控制台不开在专用浏览器里

那些工具要靠课程页的 `document.visibilityState` 保持 `visible` 才能持续播放，而这一项没法模拟。控制台要是跟课程页同在一个窗口里，你一切过去，课程页就变成后台标签了。所以控制台总是开在系统默认浏览器里，和工具启动的专用 Chrome / Edge 分开。

## 并行怎么做的

- `src/runner.mjs` 给每个工具一个运行槽：同一个工具已经在跑（或者正在启动）时再开会被拒绝，不同工具互不等待。启动过程中有 `await`（写配置文件），先占住槽位，连点两下也只会起一个。
- 发给界面的每条事件（`started` / `status` / `line` / `exit`）都带着 `tool`。界面按工具分别存表单、状态和日志，只把选中的那个画出来；切换平台不会重画别的平台填到一半的表单。
- 退出启动器（Ctrl+C 或关掉窗口）时把所有在跑的都停掉。

## 配置文件怎么合并（智慧树）

- 只改界面上填了的项，注释和没动过的项原样保留。
- **留空 = 保持原样**。不然没填密码就会把配置里存着的密码清掉。
- 键名不分大小写。configparser 写回文件时会把键名全转成小写（上游 `GUI.py` 存过的配置就是 `enablehidewindow` 这样），按原样比的话会再追加一行同名键，configparser 读到重复键直接报错。
- 打开页面时会读已有配置来预填表单，密码不往页面上送。

## 接口

界面是纯静态的 `public/index.html`，后端只有这几个接口，想整体重做界面不用动后端：

| 接口 | 作用 |
| --- | --- |
| `GET /api/tools` | 工具登记表 + 每个工具的运行状态 `{ state: { runs: { <工具>: … } } }` |
| `GET /api/events` | SSE：先发一条 `state`（全部工具），之后是带 `tool` 的 `started` / `status` / `line` / `exit` |
| `POST /api/start` | `{ tool, values }`，失败返回 `{ error }` |
| `POST /api/stop` | `{ tool }` 停掉那一个；不带 `tool` 就全停 |

所有接口都要 `?token=`，token 在启动时随机生成、打印在那条地址里。原因是这个服务能在你机器上启动进程——本机任何一个网页要是能随便调它就太糟了。服务只绑 `127.0.0.1`。

工具输出里以 `[[status]] ` 开头的行会被当成「当前在干什么」单独显示，其余按日志走。工具没有这个前缀时界面就拿最新一行日志当状态，功能照常。

Windows 上入口是 `.cmd`，要经过 `cmd.exe` 启动：

- 启动时自己拼 `cmd.exe /d /s /c ""入口" "参数"…"`，不用 `shell: true` 加参数数组（新版 Node 标成弃用，DEP0190）。参数只来自登记表和界面选项，带 cmd 特殊字符的一律拒绝。
- 直接结束子进程只会结束外层的 `cmd.exe`，真正在播的 node / python 会留在后台，所以「停止」按进程树结束。先 `taskkill /T`（不带 `/F`）给树里的窗口发关闭消息：智慧树的 Edge 这样关掉，Playwright 会自己删掉临时 profile；直接 `/F` 的话 `%TEMP%` 里每停一次就留下一个 `playwright_chromiumdev_profile-*`（实测）。5 秒后还没退出的（命令行进程没有窗口可关）再 `taskkill /T /F`。
- 入口脚本看到 `COURSE_UI=1` 就不在结尾 `pause`：控制台给它的 stdin 是一直开着的管道，`pause` 会永远等下去，界面上就一直显示「在跑」（实测）。

Linux / macOS 上先发 SIGINT 让工具自己收尾，8 秒后还在就强制结束。

## 测试

```bash
node --test launcher/tests/unit.test.mjs launcher/tests/backend.test.mjs launcher/tests/tui.test.mjs
```

不需要浏览器，也不碰真实的工具目录（智慧树启动前会改写它自己的配置文件，测试一律用临时目录）：

- `unit.test.mjs`：参数拼装、配置文件合并、打开浏览器的命令、跑进程的状态机（几个工具同时跑、连点两下、事件归属、停止和强制结束）。
- `backend.test.mjs`：共享设置、锁、用真实子进程测的握手。
- `tui.test.mjs`：显示宽度、按键解析、终端版的状态机。

## 还没做的

- 三个工具还没有发 `[[status]]`，所以状态目前靠最新一行日志顶着。
- Windows 上并行和 `taskkill /T /F` 停止已经实测通过；改成先 `/T` 再 `/F` 之后还没在 Windows 上复测。
- ZHS（另一个智慧树项目）还没进登记表：它不开浏览器，是直接伪造观看记录的，和这三个路子不一样，要不要放进来再定。
