//go:build !windows

// 窗口版外壳只给 Windows 用；Linux / macOS 用终端版（./start.sh）。
// 这个文件只是让 go build / go vet 在别的平台上也能过。
package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "窗口版只支持 Windows。Linux / macOS 请运行 ./start.sh（终端版）。")
	os.Exit(1)
}
