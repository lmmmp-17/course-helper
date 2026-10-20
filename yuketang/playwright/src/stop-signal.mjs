/* ------------------------------------------------------------------
 * 统一启动器的停止信号
 *
 * 从启动器启动时（环境变量 COURSE_UI=1），stdin 是启动器给的管道。启动器
 * 把管道关掉，就是让我们停下来：和按 Ctrl+C 走同一条收尾路径。
 * Windows 上启动器没法给子进程发 Ctrl+C（入口还隔着 cmd.exe），以前只能
 * 强杀整棵进程树，收尾总结打不出来；有了这条路就能正常收尾。
 * ------------------------------------------------------------------ */
export function watchStdinForStop(stream, onStop) {
    let fired = false;
    const fire = () => {
        if (fired) return;
        fired = true;
        onStop();
    };
    stream.on('end', fire);
    stream.on('error', fire);
    /* 不读的话流不会走到 end */
    stream.resume();
    return () => {
        stream.off('end', fire);
        stream.off('error', fire);
        stream.pause();
    };
}
