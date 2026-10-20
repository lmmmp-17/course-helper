# 油猴 / 控制台版（V3）

> 这是仓库里两个版本之一。另一个是 **[Playwright 版](../playwright/)**：点击是浏览器生成的真实输入（`isTrusted` 为 `true`），窗口可以放到后台；代价是要装 Node 和一个 npm 包。安装步骤见[根目录 README 的初级使用教程](../README.md#一初级使用教程)。
>
> 这一版粘贴即用、零依赖，但点击是页面内合成的，`event.isTrusted` 为 `false` 且无法伪造。

当前版本以 `v3_optimized.js` 为唯一源码，油猴版由构建脚本生成。它聚焦于稳定播放与课程导航：

- 自动播放视频
- 视频结束后自动切换到下一小节
- 章节测验页面的受限跳转（最多尝试 3 次，防止循环）
- 从“学习目标”步骤自动切到“视频”步骤
- 手动点“2视频”页签后自动重新接管播放
- 行为随机化：抖动所有等待时长、派发完整的指针事件序列、不占用固定全局名（见[降低自动化特征](#降低自动化特征)）

这版的目标是保持原模板的行为方式，不再额外叠加复杂的后台保活、通知、测试按钮等附加层，尽量减少冲突。

## 文件说明

- [v3_optimized.js](v3_optimized.js)
  控制台直接执行版本
- [v3_optimized.user.js](v3_optimized.user.js)
  Tampermonkey 油猴版本
- [build.mjs](build.mjs)
  根据控制台版本生成油猴版

## 当前脚本行为

### 1. 学习目标页

如果当前小节先进入的是“学习目标”而不是视频页，脚本会尝试点击顶部的 `2视频` / `视频` 标签进入视频步骤。

说明：
- 这条路径已经按当前页面结构收紧，只走顶部视频标签，不再点击底部 `下一节` 按钮
- 原因是底部按钮在当前页面里可能触发额外调试/暂停逻辑，稳定性较差

### 2. 视频页

进入视频页后，脚本会：

- 识别 iframe 内的真实视频元素
- 自动调用 `play()`
- 如果播放被短暂中断，则尝试恢复播放
- 如果普通播放失败，则尝试静音播放

当前默认配置：

```javascript
configs: {
    playbackRate: 1,          // 默认不改倍速
    playbackRateJitter: 0,
    autoplay: true,
    mute: true,               // 起播前静音；要外放改成 false
    retryInterval: 2000,      // 下面这些时间值都是基准，实际执行时会抖动
    maxRetries: 10,
    videoCheckInterval: 1000,
    guardNoProgressMs: 7000,
    guardResumeCooldownMs: 1500,
    autoAdvanceNoVideo: false,

    humanize: true,
    timingSpread: 0.35,
    sectionPauseMs: [2600, 9000],
    longBreakChance: 0.12,
    longBreakMs: [20000, 70000],
    idleActivity: true,
    idleActivityMs: [18000, 55000],
    backgroundResumeDelayMs: [1200, 4200],
    blockWindowLeavePause: false,
    unmuteAfterStart: true,   // 只在 mute 为 false 时生效
    quietVolume: 0.04,
    resumeWhileHidden: true,
    logLevel: 'quiet',
}
```

### 3. 视频结束后

视频触发结束事件后，脚本会先停一段随机时间（默认 2.6～9 秒，并有约 12% 的概率停 20～70 秒），再调用 `nextUnit()`，在课程目录树中定位到下一小节并点击进入。

目录上标了任务点时（新版 mooc2 页面），“下一小节”指的是**下一个还有待完成任务点的小节**：已完成的、0 个任务点的小节都直接越过，不会一节一节点过去。视频不算任务点（卡片上没有任务点图标）的小节同样不播。整个目录都没有任务点标记的旧页面仍按顺序切换。

### 4. 章节测验

如果当前不是视频而是“章节测验”页面，脚本会尝试点击：

```javascript
#prevNextFocusNext
```

以跳过当前测验步骤并继续后续流程。

## 使用方法

### 方法一：控制台执行

1. 打开课程播放页
2. 按 `F12`
3. 进入 `Console`
4. 复制 [v3_optimized.js](v3_optimized.js) 全部内容
5. 粘贴并执行

执行后控制台会打印本次运行的句柄名（每次运行都不一样，例如 `window.__k3f9a2x7p.app`），脚本不再占用固定的 `window.app`。用这个句柄调用：

```javascript
const app = window.__k3f9a2x7p.app   // 换成控制台里实际打印的名字
app.run()
app.nextUnit()
app.destroy()
```

如果想沿用旧教程里直接写 `app.xxx()` 的写法，执行一次 `window.__k3f9a2x7p.app.expose()` 即可把实例挂到 `window.app`（注意这会重新留下一个固定的全局名，`destroy()` 时会被撤掉）。

### 方法二：Tampermonkey

1. 安装 Tampermonkey
2. 导入 [v3_optimized.user.js](v3_optimized.user.js)
3. 确认脚本已启用
4. 刷新播放页面

## 降低自动化特征

脚本跑在平台自己的页面里，页面脚本能看到的东西比想象中多。V3.5 针对下面这些可观测点做了处理，默认配置即生效。

| 可观测点 | 旧行为 | 现在 |
| --- | --- | --- |
| 点击事件 | 只派发一个 `clientX=clientY=0`、`detail=0` 的孤立 `click` | 补齐 `pointerover → pointermove → pointerdown → mousedown → focus → pointerup → mouseup → click`，坐标落在元素内的随机位置，按下到抬起间隔 48～132ms |
| 事件对象 | `sourceCapabilities` 为 `null`、无 `movementX/Y`、`relatedTarget` 恒为 `null` | 这几项补齐了。`isTrusted` 补不了，见下面[关于 isTrusted](#关于-istrusted) |
| 定时器节拍 | `setInterval(1000)` 巡检，切节、重试等固定整秒 | 全部改为自调度 `setTimeout`，每一轮时长都重新抽取（`timingSpread`） |
| 播放倍速 | 恒定 1.5 倍，随播放心跳一起上报 | 默认 1，并且**一次都不写** `playbackRate`；需要提速时配 `playbackRateJitter` 让它在区间内取值 |
| 全局变量 | 固定的 `window.app` + `window.__xuexitongPlayerV3` | 只挂在每次运行随机生成的、不可枚举的名字下，实例标记改用 `Symbol` |
| 切后台 | `blur` / `visibilitychange` 的同一毫秒内把视频按回播放 | 延迟 1.2～4.2 秒再恢复；`resumeWhileHidden: false` 可改成后台期间完全不动播放状态 |
| 鼠标事件拦截 | 捕获阶段对页面的 `mouseout` / `mouseleave` 调 `stopPropagation()` | 默认关闭（`blockWindowLeavePause`）。拦截页面自身的事件既会掐断学习通的菜单和悬浮提示，“指针移出窗口后视频一次都不暂停”本身也是异常 |
| 静音状态 | 静音起播后一直挂着 `muted` | 默认 `mute: true`，起播前就静音，全程不出声。改成 `false` 后才会在静音起播成功后退出静音并压到 `quietVolume`（默认 0.04）；若因此被打断则回退静音 |
| 输入事件 | 整节课零输入事件 | 播放期间每 18～55 秒产生几次指针微动（`idleActivity`），不改变页面状态、不碰滚动位置 |
| 启动时机 | 页面就绪的同一毫秒立刻动手 | 先等 1.2～5.5 秒的“反应时间”，轮询间隔同样抖动 |
| 控制台 | 成片的彩色大字横幅 | 默认 `logLevel: 'quiet'` 只打印关键状态；`'silent'` 连状态行也不打印。日志走启动时抓下来的原生 `console` 引用 |

排查问题时把 `app.configs.humanize` 设为 `false`，所有等待会回到确定值，`logLevel` 调成 `'verbose'` 可看到全部细节。

### 关于 isTrusted

**浏览器内的脚本改不了它。** 下面这两条路都是死的，实测确认过：

```javascript
// 1. 在事件实例上遮蔽 —— 抛 TypeError: Cannot redefine property: isTrusted
Object.defineProperty(event, 'isTrusted', { value: true });

// 2. 改原型 —— Event.prototype 上根本没有这个属性
Object.getOwnPropertyDescriptor(Event.prototype, 'isTrusted');  // undefined
```

原因是 `isTrusted` 在 WebIDL 里标了 `[LegacyUnforgeable]`：浏览器把它装成**事件实例自身**的 accessor，并且 `configurable: false`。所以它既不在原型上（无从重写），也不能在实例上被遮蔽。

实测结果（Chrome，`new MouseEvent('click')`）：

| 查询 | 结果 |
| --- | --- |
| `getOwnPropertyDescriptor(Event.prototype, 'isTrusted')` | `undefined` |
| `getOwnPropertyDescriptor(event, 'isTrusted').configurable` | `false` |
| `defineProperty(event, 'isTrusted', …)` | 抛 `TypeError` |

结论：页面只要写一行 `if (!e.isTrusted) return;`，油猴版的点击就一定过不去。要真正可信的输入只有一条路——浏览器层面的注入，也就是 [playwright/](../playwright/) 那个版本（CDP `Input.dispatchMouseEvent`，事件由浏览器自己构造，`isTrusted` 就是 `true`）。

同一批里**能**补的已经补了（这些属性在原型上且可配置，或者 init 直接支持）：

- `sourceCapabilities`：真实 `UIEvent` 带 `InputDeviceCapabilities`，合成事件默认是 `null`
- `movementX/Y`：同一次移动派发的 `pointermove` 与 `mousemove` 共享一个位移值，按下/抬起/点击不带位移（指针已经停住）
- `relatedTarget`：`mouseover` 带上一刻悬停的元素，而不是恒为 `null`（那相当于每次都从窗口外飘进来）
- `pointerId`：Chrome 给鼠标的固定是 `1`

### 还有一条路没走：绕开合成事件

直接调用页面自身的导航函数（目录项的 `onclick` 里通常就是一个带课程/章节 ID 的调用），根本不产生事件，也就没有 `isTrusted` 这回事。代价是依赖平台内部 API，页面一改版就坏，而且会绕过脚本自己那套 `.prev_white` 点击委托，需要在真实页面上先确认当前结构。

最后一点：这些改动降低的是“看起来像机器”的程度，不等于平台查不出来。倍速、总时长、答题行为等服务端侧的数据不在脚本的控制范围内。

## 已知说明

### 0. 无视频或课件页面

默认不会自动跳过无法识别的无视频页面，避免在课件未完成时反复触发“当前章节还有任务未完成”的平台提示。控制台会给出明确日志；确认当前节点无需处理后，可手动执行 `app.nextUnit()`。

如果课程结构已确认安全，才可在控制台将 `app.configs.autoAdvanceNoVideo = true`，让脚本自动切换无视频小节。

### 1. 为什么有时会看到 `AbortError`

常见报错：

```text
The play() request was interrupted by a call to pause()
```

这通常不是视频坏了，而是：

- 页面从步骤页切到视频页时，播放器初始化会短暂停一下
- 页面内部脚本会在加载过程中重置播放状态
- 浏览器对媒体播放请求进行了短暂中断

脚本会优先尝试恢复播放，而不是立即判定失败。

### 2. 为什么会出现重复日志

如果同一页面反复粘贴执行脚本，会导致同一套监听和定时逻辑叠加，从而出现多次日志。

建议：

- 刷新页面后只执行一次
- 如果使用油猴版，尽量不要再在控制台重复粘贴执行

### 3. 为什么“静音播放成功”但一开始还能听到声音

旧逻辑里曾经会在静音启动成功后恢复声音。当前建议使用持续静音方式，不再自动恢复。

## 当前调试结论

目前这版已经验证：

- 顶部 `2视频` 标签可以程序化点击
- 手动进入视频页后可以自动播放
- 静音恢复链路可用

目前重点保留的是稳定性，不再继续叠加额外功能。

## 安全说明

脚本运行在**已登录**的页面上，拥有该会话的全部权限，因此 V3.4 对这一点做了收紧。

### 1. 不再注入远程 jQuery

旧版在启动时会向页面插入 `https://code.jquery.com/jquery-3.6.0.min.js`。这意味着：

- 第三方 CDN 一旦被劫持或投毒，注入的代码将直接拥有你的学习通登录态
- 脚本没有做 SRI 校验，无法发现文件被替换
- 请求会把带课程、班级 ID 的页面地址通过 `Referer` 泄露给第三方
- 页面 CSP 收紧后会直接加载失败

现在改为内置一个极简 DOM 工具层，只实现脚本用到的那几个方法。**脚本不再加载任何外部资源，也不再依赖页面自带的 `window.jQuery`。**

### 2. 运行域名校验

控制台版本靠人工粘贴运行。若粘到了错误的标签页，或外观相似的钓鱼页面，脚本会在未知 DOM 上盲点元素。现在启动前会先确认当前域名属于 `chaoxing.com`，否则直接停止并给出提示。

### 3. 油猴元数据作用域收紧

| 项 | 旧 | 新 |
| --- | --- | --- |
| 协议 | `*://`（含明文 http） | `https://` |
| 子框架 | 每个匹配的 iframe 都注入 | `@noframes`，仅顶层文档 |
| 权限 | `@grant none` | `@grant none`（保持，不申请任何 GM API） |

### 4. 不覆盖页面自身的全局变量

- 启动定时器不再单独占用一个全局变量
- 实例挂在每次运行随机生成的、不可枚举的名字下，既不会撞上页面自己的 `window.app`，也不留固定指纹
- 从 3.3 / 3.4 粘贴升级时，会扫描 `window` 上 `__` 前缀的自有属性认领并停掉旧实例（包括旧版留下的 `window.app`）

### 5. `destroy()` 现在能真正停住脚本

旧版的 `destroy()` 不会取消已经排队的 `setTimeout`，重复粘贴会留下"僵尸实例"继续点击页面，表现为日志重复、小节被跳过。现在所有延时任务集中登记，`destroy()` 会一次清空并置位终止标记，后续回调不再执行。从 3.3 及更早版本直接粘贴升级时也会正确清理旧实例。

### 6. 跨域 iframe 处理

旧版只在最外层包了一个 `try/catch`，遇到第一个跨域 iframe 就中断整个搜索，并每秒往控制台抛一次异常。现在改为逐帧判定、静默跳过，只在最终没找到视频时汇总提示一次。

### 7. 不再拦截页面鼠标事件

旧版对页面上**每一个** `mouseout` / `mouseleave` 都调用了 `stopPropagation()` 和 `preventDefault()`，等于把学习通自身的菜单、悬浮提示等交互一起掐断，而且鼠标每跨过一个元素边界就触发一次。3.5 起默认完全不拦截（`blockWindowLeavePause: false`），视频保活只靠延迟恢复实现。

## 维护与验证

修改 `v3_optimized.js` 后，在仓库根目录执行：

```bash
node userscript/build.mjs
node userscript/tests/verify-v3.mjs
node userscript/tests/humanize-smoke.mjs
```

`verify-v3.mjs` 会：

1. 验证两个入口的语法，并确认油猴脚本与唯一源码完全一致
2. 执行安全回归检查——断言源码中没有远程地址、`eval`、`new Function`、`innerHTML` 赋值、动态 `script` 注入，且油猴元数据保持 https-only / `@noframes` / `@grant none` / 域名校验

`humanize-smoke.mjs` 会在一套极简 DOM 桩上真正跑一遍脚本（约 9 秒，含启动的随机等待），断言：没有固定全局名、点击是完整的指针序列且坐标非零、`sourceCapabilities` 被补上而 `isTrusted` 如实为 `false`、位移与 `relatedTarget` 符合真实事件的语义、等待时长确实分散、默认配置下一次都不写 `playbackRate`、`destroy()` 后不再派发事件。

桩里的 `isTrusted` 刻意做成了和真实浏览器一样的形态（实例自身的 accessor、`configurable: false`）。早先的桩把它放在原型上，于是“可以遮蔽 isTrusted”这个错误结论通过了测试——真实浏览器里会直接抛 `TypeError`。桩和真实行为不一致的地方，测试只会给出假的通过。

无需任何第三方依赖。


## 免责声明

本项目仅用于脚本调试、前端自动化研究和页面行为分析，请遵守目标平台的使用规定。
