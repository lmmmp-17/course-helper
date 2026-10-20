// Package shell 是窗口版外壳里和平台无关的那部分：解析后端的握手、Node 版本、
// 在跑的平台、按 DPI 换算尺寸。都是纯函数，在 Linux 上也能测。
package shell

import (
	"encoding/json"
	"errors"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

// MinNodeMajor 和 start.cmd 的要求一致。
const MinNodeMajor = 20

// Holder 是占着后端锁的那个入口（launcher/src/lock.mjs）。
type Holder struct {
	PID  int    `json:"pid"`
	Kind string `json:"kind"`
}

// Handshake 是 `node launcher/run.mjs --handshake` 打在 stdout 第一行的 JSON。
type Handshake struct {
	Ready   bool    `json:"ready"`
	URL     string  `json:"url"`
	Error   string  `json:"error"`
	Message string  `json:"message"`
	Holder  *Holder `json:"holder"`
}

// ParseHandshake 解析握手。拿到地址，或者明确说了为什么起不来，才算有效。
func ParseHandshake(line string) (Handshake, error) {
	var hs Handshake
	line = strings.TrimSpace(line)
	if line == "" {
		return hs, errors.New("后台没有任何输出")
	}
	if err := json.Unmarshal([]byte(line), &hs); err != nil {
		return hs, errors.New("后台的输出看不懂：" + truncate(line, 120))
	}
	if hs.Ready {
		u, err := url.Parse(hs.URL)
		if err != nil || u.Scheme != "http" || u.Hostname() != "127.0.0.1" || u.Query().Get("token") == "" {
			return hs, errors.New("后台给的地址不对：" + truncate(hs.URL, 120))
		}
		return hs, nil
	}
	if hs.Message == "" && hs.Error == "" {
		return hs, errors.New("后台没有给出地址，也没说原因")
	}
	return hs, nil
}

var versionPattern = regexp.MustCompile(`^v?(\d+)\.`)

// NodeMajor 从 `node -p process.versions.node`（或 node -v）的输出里取主版本号。
func NodeMajor(output string) (int, error) {
	m := versionPattern.FindStringSubmatch(strings.TrimSpace(output))
	if m == nil {
		return 0, errors.New("认不出 Node.js 的版本：" + truncate(strings.TrimSpace(output), 60))
	}
	return strconv.Atoi(m[1])
}

// APIURL 把控制台地址（http://127.0.0.1:端口/?token=…）换成某个接口的地址。
func APIURL(consoleURL, endpoint string) string {
	return strings.Replace(consoleURL, "/?", "/api/"+endpoint+"?", 1)
}

// WithShell 告诉页面它装在窗口版里：断开时的提示要说「重新打开网课助手」，而不是终端窗口。
func WithShell(consoleURL string) string {
	return consoleURL + "&shell=gui"
}

// Running 从 /api/tools 的返回里读出正在跑的平台名，按登记表的顺序。
func Running(toolsJSON []byte) ([]string, error) {
	var data struct {
		Tools []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"tools"`
		State struct {
			Runs map[string]struct {
				Running bool `json:"running"`
			} `json:"runs"`
		} `json:"state"`
	}
	if err := json.Unmarshal(toolsJSON, &data); err != nil {
		return nil, err
	}
	var names []string
	for _, tool := range data.Tools {
		if data.State.Runs[tool.ID].Running {
			names = append(names, tool.Name)
		}
	}
	return names, nil
}

// Scale 把 96 DPI 下的尺寸换算到当前 DPI。窗口用的是物理像素，不换算的话高分屏上窗口很小。
func Scale(px, dpi int) int {
	if dpi <= 0 {
		dpi = 96
	}
	return px * dpi / 96
}

func truncate(s string, n int) string {
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	return string(r[:n]) + "..."
}
