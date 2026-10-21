//go:build windows

// 网课助手的 Windows 窗口版外壳。
//
// 它自己不干活：起一个后端（node launcher\run.mjs --handshake），读到控制台地址后
// 用 WebView2 打开一个独立窗口，里面就是 launcher\public\index.html。窗口关掉时关闭
// 后端的 stdin，后端会停掉所有在跑的平台、等它们收完尾再退出。
//
// 和终端版（start.cmd）共用同一份设置；两个不能同时开，由后端的锁判断（lock.mjs）。
package main

import (
	"bufio"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"

	"github.com/lmmmp-17/course-helper/desktop/windows/internal/shell"
)

const (
	appName = "网课助手"

	// 默认 960×720，最小 720×560（96 DPI 下），和交给设计的尺寸一致
	defaultWidth  = 960
	defaultHeight = 720
	minWidth      = 720
	minHeight     = 560

	webView2Download = "https://go.microsoft.com/fwlink/p/?LinkId=2124703"
	nodeDownload     = "https://nodejs.org/zh-cn/download"

	createNoWindow   = 0x08000000
	createNewConsole = 0x00000010

	mbOK          = 0x00000000
	mbOKCancel    = 0x00000001
	mbYesNoCancel = 0x00000003
	mbYesNo       = 0x00000004
	mbIconError   = 0x00000010
	mbIconWarning = 0x00000030
	mbIconInfo    = 0x00000040
	mbDefButton2  = 0x00000100
	mbSetFg       = 0x00010000
	mbTopmost     = 0x00040000
	idOK          = 1
	idYes         = 6
	idNo          = 7

	wmClose         = 0x0010
	wmSettingChange = 0x001A
	wmSetIcon       = 0x0080
	wmSysCommand    = 0x0112
	scClose         = 0xF060
	swRestore       = 9

	iconSmall  = 0
	iconBig    = 1
	imageIcon  = 1
	smCxIcon   = 11
	smCyIcon   = 12
	smCxSmIcon = 49
	smCySmIcon = 50

	// DWMWA_USE_IMMERSIVE_DARK_MODE：Windows 10 20H1 起是 20，更早的版本是 19
	dwmaDarkMode       = 20
	dwmaDarkModeBefore = 19
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procMessageBoxW         = user32.NewProc("MessageBoxW")
	procSetWindowLongPtrW   = user32.NewProc("SetWindowLongPtrW")
	procCallWindowProcW     = user32.NewProc("CallWindowProcW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procIsWindow            = user32.NewProc("IsWindow")
	procIsIconic            = user32.NewProc("IsIconic")
	procGetDpiForSystem     = user32.NewProc("GetDpiForSystem")
	procPostMessageW        = user32.NewProc("PostMessageW")
	procSendMessageW        = user32.NewProc("SendMessageW")
	procLoadImageW          = user32.NewProc("LoadImageW")
	procGetSystemMetrics    = user32.NewProc("GetSystemMetrics")

	procDwmSetWindowAttribute = windows.NewLazySystemDLL("dwmapi.dll").NewProc("DwmSetWindowAttribute")

	// GWLP_WNDPROC = -4
	gwlpWndProc = ^uintptr(3)
)

// 没有主窗口时弹的框（缺 Node、和终端版互斥之类）要自己到最前面：
// 不然会躲在刚才那个终端窗口后面，看起来像双击了没反应
func messageBox(owner uintptr, text string, flags uintptr) int {
	if owner == 0 {
		flags |= mbSetFg | mbTopmost
	}
	t, _ := windows.UTF16PtrFromString(text)
	c, _ := windows.UTF16PtrFromString(appName)
	r, _, _ := procMessageBoxW.Call(owner, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
	return int(r)
}

// 外壳自己的东西（WebView2 的数据、后端日志、窗口句柄）放在 %LOCALAPPDATA%\course-helper，
// 不在解压出来的文件夹里生成东西。
func dataDir() string {
	base := os.Getenv("LOCALAPPDATA")
	if base == "" {
		base = os.TempDir()
	}
	dir := filepath.Join(base, "course-helper")
	_ = os.MkdirAll(dir, 0o755)
	return dir
}

// 不弹黑框的命令
func hidden(name string, args ...string) *exec.Cmd {
	cmd := exec.Command(name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

func openURL(u string) {
	_ = hidden("rundll32", "url.dll,FileProtocolHandler", u).Start()
}

func main() {
	// 单实例：第二次双击把已经开着的窗口提到前面
	name, _ := windows.UTF16PtrFromString(`Local\CourseHelperWindow`)
	mutex, err := windows.CreateMutex(nil, false, name)
	if err == windows.ERROR_ALREADY_EXISTS {
		focusExisting()
		return
	}
	if mutex != 0 {
		defer windows.CloseHandle(mutex)
	}

	exe, _ := os.Executable()
	root := filepath.Dir(exe)
	if _, err := os.Stat(filepath.Join(root, "launcher", "run.mjs")); err != nil {
		messageBox(0, "找不到 launcher\\run.mjs。\n\n"+appName+".exe 要放在解压出来的 course-helper 文件夹里，"+
			"和 start.cmd 在一起，不能单独拿出来用。", mbIconError)
		return
	}
	// 先查 WebView2：缺了的话窗口会先画出来再失败，留下一个空白窗口
	if _, err := webviewloader.GetInstalledVersion(); err != nil {
		noWebView2(root)
		return
	}
	node, ok := findNode()
	if !ok {
		return
	}

	backend, hs, err := startBackend(node, root)
	if err != nil {
		messageBox(0, err.Error(), mbIconError)
		return
	}
	if !hs.Ready {
		// 另一个入口（多半是终端版）正开着
		text := hs.Message
		if text == "" {
			text = "后台没能启动：" + hs.Error
		}
		messageBox(0, text, mbIconInfo)
		backend.shutdown()
		return
	}
	runWindow(hs.URL)
	backend.shutdown()
}

/* ---------------- Node.js ---------------- */

func nodeMajor(path string) (int, error) {
	out, err := hidden(path, "-p", "process.versions.node").Output()
	if err != nil {
		return 0, err
	}
	return shell.NodeMajor(string(out))
}

// 找 Node.js 20 以上；没有就和 start.cmd 一样问要不要用 winget 装
func findNode() (string, bool) {
	installed := filepath.Join(os.Getenv("ProgramFiles"), "nodejs", "node.exe")
	candidates := []string{installed}
	if p, err := exec.LookPath("node"); err == nil {
		candidates = append([]string{p}, candidates...)
	}
	found := 0
	for _, path := range candidates {
		if major, err := nodeMajor(path); err == nil {
			if major >= shell.MinNodeMajor {
				return path, true
			}
			found = major
		}
	}

	question := "网课助手需要 Node.js " + strconv.Itoa(shell.MinNodeMajor) + " 或更新，这台电脑上还没有装。"
	if found > 0 {
		question = fmt.Sprintf("这台电脑上的 Node.js 版本太旧（%d），网课助手需要 %d 或更新。", found, shell.MinNodeMajor)
	}
	if _, err := exec.LookPath("winget"); err != nil {
		messageBox(0, question+"\n\n请到 Node.js 官网下载 LTS 版安装，装好后重新打开网课助手。", mbIconInfo)
		openURL(nodeDownload)
		return "", false
	}
	if messageBox(0, question+"\n\n现在用 winget 自动安装吗？会弹出一个安装窗口，装完自动继续。", mbYesNo|mbIconInfo) != idYes {
		return "", false
	}
	cmd := exec.Command("winget", "install", "--id", "OpenJS.NodeJS.LTS", "-e",
		"--accept-source-agreements", "--accept-package-agreements")
	cmd.SysProcAttr = &syscall.SysProcAttr{CreationFlags: createNewConsole}
	_ = cmd.Run()
	if major, err := nodeMajor(installed); err == nil && major >= shell.MinNodeMajor {
		return installed, true
	}
	messageBox(0, "Node.js 好像没装上。可以到 Node.js 官网下载 LTS 版手动安装，装好后重新打开网课助手。", mbIconWarning)
	openURL(nodeDownload)
	return "", false
}

/* ---------------- 后端 ---------------- */

type backend struct {
	cmd   *exec.Cmd
	stdin io.WriteCloser
	done  chan struct{}
}

func startBackend(node, root string) (*backend, shell.Handshake, error) {
	var hs shell.Handshake
	cmd := hidden(node, filepath.Join(root, "launcher", "run.mjs"), "--handshake")
	cmd.Dir = root
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, hs, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, hs, err
	}
	logPath := filepath.Join(dataDir(), "backend.log")
	logFile, _ := os.Create(logPath)
	if logFile != nil {
		cmd.Stderr = logFile
	}
	if err := cmd.Start(); err != nil {
		return nil, hs, fmt.Errorf("后台没能启动：%v", err)
	}
	b := &backend{cmd: cmd, stdin: stdin, done: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		if logFile != nil {
			logFile.Close()
		}
		close(b.done)
	}()

	first := make(chan string, 1)
	go func() {
		reader := bufio.NewReader(stdout)
		line, _ := reader.ReadString('\n')
		first <- line
		/* 之后不该再有输出，有也读掉，免得后端写满管道卡住 */
		_, _ = io.Copy(io.Discard, reader)
	}()

	select {
	case line := <-first:
		hs, err = shell.ParseHandshake(line)
		if err != nil {
			b.kill()
			return nil, hs, fmt.Errorf("后台没能启动：%v\n\n详细信息在 %s", err, logPath)
		}
		return b, hs, nil
	case <-b.done:
		return nil, hs, fmt.Errorf("后台一启动就退出了。\n\n详细信息在 %s", logPath)
	case <-time.After(30 * time.Second):
		b.kill()
		return nil, hs, fmt.Errorf("后台 30 秒都没有响应。\n\n详细信息在 %s", logPath)
	}
}

// 关掉 stdin：后端停掉所有平台、等它们收尾后自己退出（最多十秒左右）
func (b *backend) shutdown() {
	_ = b.stdin.Close()
	select {
	case <-b.done:
	case <-time.After(15 * time.Second):
		b.kill()
	}
}

func (b *backend) kill() {
	if b.cmd.Process != nil {
		_ = hidden("taskkill", "/pid", strconv.Itoa(b.cmd.Process.Pid), "/T", "/F").Run()
	}
}

/* ---------------- 窗口 ---------------- */

// 页面标题变了就同步到窗口标题上（任务栏里看得见「▶ 学习通 12:34」）
const titleScript = `(() => {
  const send = () => { try { window.courseHelperTitle(document.title); } catch (e) {} };
  document.addEventListener('DOMContentLoaded', () => {
    send();
    const title = document.querySelector('title');
    if (title) new MutationObserver(send).observe(title, { childList: true, characterData: true, subtree: true });
  });
})();`

func systemDPI() int {
	if procGetDpiForSystem.Find() != nil {
		return 96
	}
	dpi, _, _ := procGetDpiForSystem.Call()
	return int(dpi)
}

func runWindow(consoleURL string) {
	dpi := systemDPI()
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		AutoFocus: true,
		DataPath:  filepath.Join(dataDir(), "webview2"),
		WindowOptions: webview2.WindowOptions{
			Title:  appName,
			Width:  uint(shell.Scale(defaultWidth, dpi)),
			Height: uint(shell.Scale(defaultHeight, dpi)),
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		/* WebView2 装了但初始化失败：退回浏览器，对话框关掉时一起停掉 */
		openURL(consoleURL)
		messageBox(0, "窗口没能打开，控制台已经改在你的浏览器里打开了。\n\n点「确定」会停掉所有在跑的平台并退出。", mbOK|mbIconWarning)
		return
	}
	defer w.Destroy()
	w.SetSize(shell.Scale(minWidth, dpi), shell.Scale(minHeight, dpi), webview2.HintMin)

	hwnd := uintptr(w.Window())
	hwndFile := filepath.Join(dataDir(), "window.hwnd")
	_ = os.WriteFile(hwndFile, []byte(strconv.FormatUint(uint64(hwnd), 10)), 0o644)
	defer os.Remove(hwndFile)
	setIcons(hwnd)
	applyTitleBarTheme(hwnd)
	installCloseGuard(w, hwnd, consoleURL)

	_ = w.Bind("courseHelperTitle", func(title string) {
		if strings.TrimSpace(title) != "" {
			w.SetTitle(title)
		}
	})
	w.Init(titleScript)
	w.Navigate(shell.WithShell(consoleURL))
	w.Run()
}

// 窗口类上只有一个 32 像素的图标（go-webview2 注册窗口类时给的），标题栏上的小图标是它缩出来的，
// 窗口本身也没有图标（WM_GETICON 拿到 0）。按系统要的两种尺寸各从资源里取一张设上。
func setIcons(hwnd uintptr) {
	var module windows.Handle
	_ = windows.GetModuleHandleEx(0, nil, &module)
	for _, icon := range []struct{ which, cx, cy uintptr }{{iconBig, smCxIcon, smCyIcon}, {iconSmall, smCxSmIcon, smCySmIcon}} {
		cx, _, _ := procGetSystemMetrics.Call(icon.cx)
		cy, _, _ := procGetSystemMetrics.Call(icon.cy)
		handle, _, _ := procLoadImageW.Call(uintptr(module), 1, imageIcon, cx, cy, 0)
		if handle != 0 {
			_, _, _ = procSendMessageW.Call(hwnd, wmSetIcon, icon.which, handle)
		}
	}
}

// 标题栏跟着系统的深浅色走。页面自己已经跟着走了，不改的话深色页面顶着一条白标题栏。
func applyTitleBarTheme(hwnd uintptr) {
	if procDwmSetWindowAttribute.Find() != nil {
		return
	}
	var dark int32
	if systemDark() {
		dark = 1
	}
	for _, attr := range []uintptr{dwmaDarkMode, dwmaDarkModeBefore} {
		if r, _, _ := procDwmSetWindowAttribute.Call(hwnd, attr, uintptr(unsafe.Pointer(&dark)), 4); r == 0 {
			return
		}
	}
}

// 「设置 → 个性化 → 颜色 → 选择默认应用模式」
func systemDark() bool {
	key, err := registry.OpenKey(registry.CURRENT_USER, `Software\Microsoft\Windows\CurrentVersion\Themes\Personalize`, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer key.Close()
	light, _, err := key.GetIntegerValue("AppsUseLightTheme")
	return err == nil && light == 0
}

// 关窗口时还有平台在跑：先问一句。
//
// 用页面里的确认框（设计稿里的样子）：截下 WM_CLOSE，请页面判断要不要问；页面先应一声
// （courseHelperAck），用户点「全部停止并关闭」或者本来就没在跑，页面调 courseHelperClose，
// 这里才真的关。页面 1.5 秒内没应声（脚本坏了、后端断了页面没加载出来之类），
// 改用系统对话框问，保证窗口总能关掉。
var (
	previousProc uintptr
	guardURL     string
	guardView    webview2.WebView
	guardHwnd    uintptr
	closeAllowed atomic.Bool
	askSeq       atomic.Int64
	ackedSeq     atomic.Int64
	guardProc    = windows.NewCallback(closeGuard)
)

// 除了 WM_CLOSE，也直接截下 SC_CLOSE（任务栏缩略图、右键菜单里的「关闭窗口」发的是它），
// 不指望它一定会被默认处理转成 WM_CLOSE。
func closeGuard(hwnd, msg, wp, lp uintptr) uintptr {
	closing := msg == wmClose || (msg == wmSysCommand && wp&0xFFF0 == scClose)
	if closing && !closeAllowed.Load() {
		askToClose()
		return 0
	}
	if msg == wmSettingChange && lp != 0 && windows.UTF16PtrToString((*uint16)(unsafe.Pointer(lp))) == "ImmersiveColorSet" {
		/* 用户切了深浅色 */
		applyTitleBarTheme(hwnd)
	}
	r, _, _ := procCallWindowProcW.Call(previousProc, hwnd, msg, wp, lp)
	return r
}

func askToClose() {
	seq := askSeq.Add(1)
	guardView.Eval("window.courseHelperAskClose && window.courseHelperAskClose()")
	go func() {
		time.Sleep(1500 * time.Millisecond)
		if ackedSeq.Load() < seq {
			guardView.Dispatch(nativeConfirmClose)
		}
	}()
}

func allowClose() {
	closeAllowed.Store(true)
	_, _, _ = procPostMessageW.Call(guardHwnd, wmClose, 0, 0)
}

func nativeConfirmClose() {
	if names := runningTools(guardURL); len(names) > 0 {
		text := fmt.Sprintf("还有 %d 个平台在跑（%s），关掉窗口会把它们都停掉。\n\n确定要关掉吗？",
			len(names), strings.Join(names, "、"))
		if messageBox(guardHwnd, text, mbOKCancel|mbIconWarning|mbDefButton2) != idOK {
			return
		}
	}
	allowClose()
}

func installCloseGuard(w webview2.WebView, hwnd uintptr, consoleURL string) {
	guardURL = consoleURL
	guardView = w
	guardHwnd = hwnd
	_ = w.Bind("courseHelperAck", func() { ackedSeq.Store(askSeq.Load()) })
	_ = w.Bind("courseHelperClose", func() { allowClose() })
	previousProc, _, _ = procSetWindowLongPtrW.Call(hwnd, gwlpWndProc, guardProc)
}

func runningTools(consoleURL string) []string {
	client := http.Client{Timeout: 2 * time.Second}
	res, err := client.Get(shell.APIURL(consoleURL, "tools"))
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil {
		return nil
	}
	names, _ := shell.Running(body)
	return names
}

func focusExisting() {
	raw, err := os.ReadFile(filepath.Join(dataDir(), "window.hwnd"))
	if err == nil {
		if hwnd, err := strconv.ParseUint(strings.TrimSpace(string(raw)), 10, 64); err == nil {
			h := uintptr(hwnd)
			if ok, _, _ := procIsWindow.Call(h); ok != 0 {
				if iconic, _, _ := procIsIconic.Call(h); iconic != 0 {
					_, _, _ = procShowWindow.Call(h, swRestore)
				}
				_, _, _ = procSetForegroundWindow.Call(h)
				return
			}
		}
	}
	messageBox(0, appName+"已经开着了。", mbIconInfo)
}

func noWebView2(root string) {
	answer := messageBox(0, "这台电脑缺少 Microsoft Edge WebView2 运行时，"+appName+"的窗口打不开。\n\n"+
		"点「是」打开下载页面，装好后重新打开"+appName+"；\n点「否」改用终端版（start.cmd）。", mbYesNoCancel|mbIconWarning)
	switch answer {
	case idYes:
		openURL(webView2Download)
	case idNo:
		cmd := exec.Command("cmd.exe")
		cmd.SysProcAttr = &syscall.SysProcAttr{CmdLine: `cmd.exe /c start "" "` + filepath.Join(root, "start.cmd") + `"`}
		_ = cmd.Start()
	}
}
