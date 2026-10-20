# 刷课工具统一启动器

把三个工具收到一个界面里：选平台、填几个选项、点开始，进度在页面上看。

| 平台 | 工具 | 仓库 |
| --- | --- | --- |
| 学习通 | Playwright 版 | [xuexitongScript](https://github.com/lmmmp-17/xuexitongScript) |
| 长江雨课堂 | Playwright 版 | [yuketang](https://github.com/lmmmp-17/yuketang) |
| 智慧树 | Autovisor | [Autovisor](https://github.com/lmmmp-17/Autovisor) |

三个仓库自己的入口脚本（`start.cmd` / `run.cmd`）照旧能用，这个启动器只是在它们外面包了一层。

## 用法

| 系统 | 怎么启动 |
| --- | --- |
| Windows | 双击 **`start.cmd`** |
| Linux / macOS | **`./start.sh`** |

它会在本地开一个控制台，并用**你平时用的浏览器**打开。没自动弹出来的话，把终端里打印的那条地址复制过去。

> 控制台**不会**开在脚本启动的那个专用 Chrome 里。那些工具要靠课程页的
> `document.visibilityState` 保持 `visible` 才能持续播放，而这一项没法模拟——
> 控制台要是跟课程页同在一个窗口里，你一切过去课程页就变成后台标签了。

需要 Node.js 20 或更新。Windows 上没装的话，`start.cmd` 会问你要不要用 winget 装。启动器本身**没有任何 npm 依赖**。

## 仓库放在别处

默认按下面的相对位置找：

```
某个目录/
├── launcher/          ← 本项目
├── yuketang/
├── Autovisor/
└── ../xuexitongScript/
```

放在别处就建一个 `tools.local.json`（已在 `.gitignore` 里）：

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

- `kind: 'flags'` — 选项通过命令行参数传（学习通、雨课堂这种）
- `kind: 'config'` — 选项写进配置文件，再运行入口脚本（Autovisor 这种）

## 控制台接口

界面是纯静态的 `public/index.html`，后端只有这几个接口，想整体重做界面不用动后端：

| 接口 | 作用 |
| --- | --- |
| `GET /api/tools` | 工具登记表 + 当前运行状态 |
| `GET /api/events` | SSE：`state` / `started` / `status` / `line` / `exit` |
| `POST /api/start` | `{ tool, values }`，失败返回 `{ error }` |
| `POST /api/stop` | 停掉正在跑的那个 |

所有接口都要 `?token=`，token 在启动时随机生成、打印在那条地址里。原因是这个服务能在你机器上启动进程——本机任何一个网页要是能随便调它就太糟了。服务只绑 `127.0.0.1`。

工具输出里以 `[[status]] ` 开头的行会被当成「当前在干什么」单独显示，其余按日志走。工具没有这个前缀时界面就只显示原始输出，功能照常。

## 测试

```bash
node --test tests/unit.test.mjs
```

不需要浏览器：参数拼装、配置文件合并、打开浏览器的命令、跑进程的状态机。

## 还没做

- 界面只求能用，样式留到设计那一轮整体重做。
- 三个工具还没有发 `[[status]]`，所以进度目前靠原始输出看。
- ZHS（另一个智慧树项目）还没进登记表：它不开浏览器，是直接伪造观看记录的，和这三个路子不一样，要不要放进来再定。
