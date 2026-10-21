def print_banner(plain: bool = False):
    if plain:
        # 从统一启动器跑时输出进的是它的记录, 那里是比例字体: 方块字符画会散成
        # 一堆方块还折行 (pc 在 Windows 上实测). 只留一行, 署名不丢
        print("Autovisor by Github CXRunfree")
        return
    banner_lines = [
        "  █████╗ ██╗   ██╗████████╗ ██████╗ ██╗   ██╗██╗███████╗ ██████╗ ██████╗",
        " ██╔══██╗██║   ██║╚══██╔══╝██╔═══██╗██║   ██║██║██╔════╝██╔═══██╗██╔══██╗",
        " ███████║██║   ██║   ██║   ██║   ██║██║   ██║██║███████╗██║   ██║██████╔╝",
        " ██╔══██║██║   ██║   ██║   ██║   ██║╚██╗ ██╔╝██║╚════██║██║   ██║██╔══██╗",
        " ██║  ██║╚██████╔╝   ██║   ╚██████╔╝ ╚████╔╝ ██║███████║╚██████╔╝██║  ██║",
        " ╚═╝  ╚═╝ ╚═════╝    ╚═╝    ╚═════╝   ╚═══╝  ╚═╝╚══════╝ ╚═════╝ ╚═╝  ╚═╝",
    ]
    signature_lines = [
        "by Github CXRunfree",
    ]
    width = max(len(line) for line in banner_lines)
    print()
    for line in banner_lines:
        print(line)
    for line in signature_lines:
        print(line.rjust(width))
    print()
