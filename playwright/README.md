# Playwright 版：技术说明

**怎么装、怎么用，见仓库根目录 [README 的初级使用教程](../README.md#一初级使用教程)。** 这里讲的是它为什么这么做、做到了哪一步、还有哪些查得出来。

用**真实输入事件**驱动学习通课程播放。和 [`userscript/`](../userscript/) 里的油猴脚本解决的是同一件事，区别只在一处，但那一处是根本性的：

| | 油猴版 | 这一版 |
| --- | --- | --- |
| 点击从哪来 | 页面里 `dispatchEvent(new MouseEvent(...))` | CDP `Input.dispatchMouseEvent`，浏览器自己构造 |
| `event.isTrusted` | `false`，**无法伪造**（WebIDL `[LegacyUnforgeable]`，实例属性且不可配置） | `true` |
| 页面写 `if (!e.isTrusted) return` | 一定过不去 | 正常放行 |
| 失焦 / `blur` | 只能事后把视频按回播放，事件照样发生过 | Playwright 默认就开了焦点模拟，blur 根本不触发 |
| 跨域 iframe 里的视频 | 读不到（同源策略），只能跳过 | 直接读 |
| 代价 | 粘贴即用 | 要装 Node 和一个 npm 包，Chrome 得用特定方式启动 |

## 焦点问题

这是相对油猴版的另一个实质差别。油猴版只能在页面里对抗焦点变化：监听 `blur` / `visibilitychange`，等视频被页面脚本暂停之后再按回去——事件照样发生过，页面照样看得见。

这一版从浏览器层面让这些事件根本不发生：

| CDP 命令 | 作用 | 谁发的 |
| --- | --- | --- |
| `Emulation.setFocusEmulationEnabled` | 渲染进程始终认为自己持有焦点，`document.hasFocus()` 恒为 `true`，窗口失焦不再触发 `blur` / `focusout` | **Playwright 自己**：它接管每个页面时都会发（连接模式也一样，只有显式传 `noDefaults` 才不发）。我们再显式发一次，不依赖这个默认行为 |
| `Page.setWebLifecycleState('active')` | 阻止标签页被冻结，否则后台标签的定时器会被大幅节流 | 我们 |
| `Emulation.setIdleOverride` | Idle Detection API 恒为"用户活跃、屏幕未锁" | 我们 |

所以端到端测试里"切到别的标签后 `hasFocus()` 仍为 `true`、零次 blur"这一条，验证的是结果，不是我们这几行代码的功劳——不加 `hardenFocus` 它也会通过。

`--check` 会列出这三项实际是否生效（旧版 Chrome 可能缺某个命令，缺了不影响其余部分）。

**还剩一件做不到的**：`document.visibilityState` 没有对应的 override。它由标签页自身状态决定。所以：

- 把课程页放在一个**单独的 Chrome 窗口**里。失焦但没被遮住的窗口，其活动标签页的 `visibilityState` 仍然是 `visible`，只有 `hasFocus()` 会变 `false`——而那一项已经被模拟掉了。
- 不要在同一个窗口里切到别的标签页，那会让课程页变成后台标签（`hidden`）。
- 窗口最小化也会变 `hidden`。放到别的窗口后面、或者挪到另一个工作区都没问题——但 **Windows 上窗口被完全盖住同样会变 `hidden`**，视频直接暂停（实测 Chrome 155 / Win11，1 秒内）。启动参数 `--disable-backgrounding-occluded-windows` 能兜住遮挡，兜不住最小化。脚本自己开的 Chrome 和 Playwright 的 launch 模式都带了这一项，手动开 Chrome 时要自己加。

## 跨平台

Node 和 `playwright-core` 本身三平台通用。需要分平台处理的只有两件事，代码里已经处理：

- **浏览器可执行文件位置**：自动启动时按平台去标准安装位置找（`src/platform.mjs`），`--browser auto` 先找 Chrome、没有再找 Edge；launch 模式用 `channel: 'chrome'` / `'msedge'` 让 Playwright 自己去找。错误提示里的手动启动命令优先用本机实际找到的路径
- **Chrome 和 Edge**：都是 Chromium 内核，启动参数、CDP、焦点模拟完全一样，差别只在路径和专用 profile 目录（`xuexitong-chrome` / `xuexitong-edge`，分开放，两者的 profile 格式不完全通用）。调试端口上已经开着另一种浏览器、而 `--browser` 明确选了这一种时会报错，不会悄悄接管
- **profile 目录**：`--profile-dir` 一律 `path.resolve()` 成绝对路径，否则换个工作目录就换了一个 profile

没有用到任何 shell 命令、路径分隔符假设或平台专有 API。`--launch` 模式下 `--start-maximized` 在 Linux 的部分窗口管理器下会被忽略，不影响功能。

## 行为随机化

真实输入解决的是"事件可不可信"，不解决"像不像人操作"。节拍上的特征和油猴版是同一批，处理方式也一致：

- **指针轨迹**：三次贝塞尔曲线 + 缓入缓出，步数随距离变化，沿途有微抖和偶发迟疑，28% 概率过冲后回修。落点用正态分布集中在元素中部，不是几何正中心。
- **按下与抬起**：移到位后停 45–190ms 再按下，按住 48–132ms。
- **滚动**：目标在视口外时用真实滚轮分多次滚过去，不用 `scrollIntoView()`。
- **节间停顿**：2.6–9 秒，12% 概率停 20–70 秒（"离开一会儿"）。
- **轮询**：进度查询每轮重新抽间隔，不踩整秒。
- **倍速**：默认 1，且一次都不写 `playbackRate`。
- **指针微动**：播放期间每 18–55 秒动一下。

起播前先静音（默认，`--no-mute` 关掉）。真实播放器上的静音按钮只有 40×2 像素，外面还套着悬停弹出的音量条，真实点击容易落到音量条上，所以这一步是直接把 `muted` 设上，并且一定在第一次点播放之前做，不会先外放一两秒。

切节时，目录上标了任务点的页面会直接跳到**下一个还有待完成任务点的小节**，已完成的和 0 个任务点的小节都不进去。视频不算任务点的小节不播。

起播优先**真实点击播放按钮**（`.vjs-big-play-button`），而不是调 `video.play()`：前者是人本来就会做的操作，也顺便拿到用户激活，不会被 autoplay 策略拦。只有真实点击都失败时才退回 `video.play()`，并在日志里说明这一步是脚本调用（`--no-allow-scripted-play` 可以完全禁止）。

## 节奏与「用户激活」

这两条来自本地检测靶场（`~/work/cx-detect-lab`，全程离线，另一个会话搭的）实测出来的真人基线。

**停顿的分布形状**。以前所有等待都是「区间内均匀取值」加 8% 的长尾，变异系数（标准差/均值）只有 0.17~0.28；靶场测到真人连续操作的间隔是 0.45~0.49。同样是随机，分布形状不是一回事——真人的停顿是「多数偏短、偶尔拖很久」。现在 `human.mjs` 改成对数正态取样：配置值当中位数，下限仍是配置的下限（不会比你设的还快），上限封顶 3 倍只为挡极端值。实测变异系数约 0.46。

**开场先真实地动一下**（`settleIn`）。被调试端口接管的浏览器里，`navigator.userActivation.hasBeenActive` 会在页面加载约 1.5 秒后自行变成 true，普通 Chrome 则要等真实交互——靶场里 Playwright 自己启动和接管已有 Chrome 两种方式表现一致。于是出现一个自相矛盾的状态：浏览器说用户激活过，页面却一个可信输入事件都没收到。而以前 1.2~5.5 秒的启动延迟反而让这个状态一直挂着：**越是加「像人的延迟」，这个窗口开得越久**。现在接管页面后先移动指针、小幅滚一下再滚回来（滚轮同样是可信输入，但不会点到任何东西），把这个状态合上，之后再走原来的启动延迟。

## 测试

```bash
npm test            # 单元 + 端到端（约 30 秒）
npm run test:unit   # 只跑不需要浏览器的部分
```

端到端测试用本机真实 Chrome 跑完整流程，桩页面（`tests/fixtures/course.html`）**只接受 `isTrusted` 的事件**，任何合成事件都会被记进 `rejected` 且不产生效果。所以这个测试通过就等于证明了：目录点击、页签点击、播放按钮点击、滚轮，全都是浏览器自己构造的可信事件。

它覆盖三节不同形态的小节（直接有视频 / 先学习目标 / 先章节测验），并断言：

- `rejected` 为空——一次合成事件都没有
- 三次起播全是真实点击，`video.play()` 零次
- 切节顺序正确，页签和测验下一步都点到了
- 产生过真实滚轮事件（最后一节在视口外）
- `navigator.webdriver` 为 `false`，探针点击 `isTrusted` 为 `true`
- 开另一个标签页抢到前台之后，课程页的 `document.hasFocus()` 仍为 `true` 且没有收到 `blur`

没装 Chrome 时端到端部分会 skip，不会让测试失败。

## 反向看：这套方案还能被什么查出来

下面这些都在本机 Chrome 上实测过，不是推断。

### 实测没问题的

| 检测手法 | 结果 |
| --- | --- |
| `navigator.webdriver` | `false`（两种模式都是） |
| CDP / DevTools 痕迹：`console.log(err)` 是否读取 `err.stack` 的 getter | **不触发**。Playwright 开了 `Runtime` 域，但 Chrome 只在有 DevTools 前端时才去格式化 |
| `cdc_` / `__webdriver` / `$cdc_` 等注入变量 | 没有（那是 ChromeDriver 的特征，Playwright 不注入） |
| 窗口几何（`outerHeight - innerHeight`、`screen` 与 `window` 是否相等） | 正常 |
| `event.movementX/Y` | 由 Blink 按真实语义填，不需要我们操心 |

### 仍然查得出来的

| 点 | 说明 | 能做什么 |
| --- | --- | --- |
| **服务端侧的播放行为** | 这是最强的一类，而且脚本完全管不到：每节都从头看到尾、从不拖进度条、从不暂停、从不回看、节间间隔分布集中、连续几小时不断、集中在深夜 | 真要像人就得偶尔暂停几秒、偶尔往回拖一点重看。当前**没做**——它会让流程复杂不少，而且向前 seek 反而更容易被判违规。真要加，就加"真实点击暂停按钮停几秒"和"小幅度向后 seek" |
| **全新 profile** | 推荐的独立 `--user-data-dir` 是个崭新环境：没有历史、没有扩展，实测 `Notification.permission` 是 `denied` 而不是默认的 `default` | 要么用你平时的 profile（得先把 Chrome 完全退干净），要么就在那个独立 profile 里正常上网用一段时间 |
| **无头浏览器** | UA 里直接带 `HeadlessChrome`（实测），WebGL renderer 从真实 GPU 变成 `SwiftShader`（实测） | `launchOptions()` 写死 `headless: false`，单元测试断言了这一条。**不要改它** |
| **`document.visibilityState`** | 没有 CDP override | 见上面[焦点问题](#焦点问题)：课程页单独开一个窗口 |
| **轨迹的生理特征** | 真实人手有 8–12Hz 的微颤，贝塞尔曲线加随机抖动不具备那个频谱 | 现实中几乎没人做到这个精度的检测，没处理 |
| **从不用键盘** | 真人看视频会按空格暂停、调音量 | 没处理。要加就得小心别误触发页面快捷键 |
| **运行期间人也在动鼠标** | CDP 的虚拟鼠标和你的真实鼠标共享 Blink 里那个"上一次坐标"，两者交错会让 `movementX/Y` 跳变 | 跑的时候别在那个窗口里动鼠标。想用电脑就把窗口放到后面——焦点已经模拟掉了 |

### 一个和检测无关但更要紧的点：CDP 端口的安全性

`--remote-debugging-port=9222` 开着的时候，**本机任何程序**都能连上这个端口，拿到对那个浏览器的完全控制权——读 cookie、读登录态、以你的身份发请求。端口只绑 `127.0.0.1`（不对外网暴露），但对本机是完全敞开的。

所以：

- 用完就把那个 Chrome 实例关掉，别一直挂着
- 这是推荐**独立 profile** 的第二个理由：那个目录里只有学习通的登录态，不含你的 Google 账号、邮箱、其它网站的会话。真要出事，暴露面小得多
- 别在不信任的机器上开这个端口

`--check` 会往页面右下角临时插一块半透明探针来实测点击，读完结果立刻移除（`finally` 里清理）。如果页面装了 `MutationObserver`，那一下是看得见的——所以 `--check` 建议在课程页上单独跑，不要和正式播放混在一起。

## 文件

| 文件 | 作用 |
| --- | --- |
| `run.mjs` | CLI 入口 |
| `src/course.mjs` | 课程流程：读目录、选下一节、进视频步骤、起播、监控、切节 |
| `src/browser.mjs` | 连接 / 启动浏览器，启动参数集中在 `launchOptions()` |
| `src/pointer.mjs` | 指针轨迹与真实点击 |
| `src/environment.mjs` | 焦点与生命周期模拟 |
| `src/selectors.mjs` | 页面选择器与域名白名单 |
| `src/config.mjs` | 默认配置与参数解析 |
| `src/inspect.mjs` | `--inspect` 的只读结构检查 |
| `src/diagnose.mjs` | `--check` 的特征自检 |
| `src/human.mjs` | 随机化原语 |
| `src/platform.mjs` | 平台差异 |
| `src/logger.mjs` | 分档日志 |
| `tests/unit.test.mjs` | 不需要浏览器的单元测试 |
| `tests/e2e.test.mjs` | 用本机 Chrome 跑完整流程，桩页面在 `tests/fixtures/` |

## 和油猴版怎么选

- 想**粘贴即用**、不装任何东西 → 用 [`userscript/v3_optimized.js`](../userscript/v3_optimized.js)
- 页面在校验 `isTrusted`、或者你需要把窗口放到后台 → 用这一版

两版都只在 `chaoxing.com` 下运行（`src/selectors.mjs` 的 `isAllowedUrl`），也都不加载任何远程代码。
