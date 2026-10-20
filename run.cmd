@echo off
setlocal
for /f "tokens=2 delims=:." %%c in ('chcp') do set "OLDCP=%%c"
chcp 65001 >nul
rem Autovisor 的 Windows 源码运行入口：双击运行即可。
rem 第一次运行会生成配置文件 config.ini；填好课程地址后再运行，会自动准备 Python 环境并开始。
rem 参数原样传给 Autovisor.py，比如在命令行里 run.cmd --check-browser
cd /d "%~dp0"

rem 双击打开的窗口在结束时停一下，不然报错一闪就没了
set "PAUSE_AT_END="
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && set "PAUSE_AT_END=1"
set "CONFIG=config.ini"

rem 1. 配置文件：没有就从模板生成，用记事本打开让用户填课程地址
if not exist "%CONFIG%" goto :new_config
rem 正式运行（不带参数）却没填课程地址：先说清楚
if "%~1"=="" (
    findstr /r /i /c:"^ *URL[0-9n]* *= *https://" "%CONFIG%" >nul || goto :need_url
)

rem 2. uv：用来准备 Python 和依赖（不用自己装 Python）
where uv >nul 2>nul
if errorlevel 1 call :install_uv
where uv >nul 2>nul
if errorlevel 1 goto :fail

rem 3. 依赖：开着自动过滑块时多装 numpy、opencv。已经装好的话这一步很快
set "EXTRA="
findstr /r /i /c:"^ *enableAutoCaptcha *= *true" "%CONFIG%" >nul && set "EXTRA=--extra captcha"
echo [setup] 检查依赖（uv sync %EXTRA%）...
uv sync %EXTRA%
if errorlevel 1 goto :sync_failed

rem 4. 运行
uv run python -u Autovisor.py %*
set "CODE=%errorlevel%"
goto :end

:new_config
copy /y config.ini.example "%CONFIG%" >nul
echo [setup] 已生成配置文件 %CONFIG%，正在用记事本打开。
echo         在 [course-url] 下面把 URL1 填成课程播放页的地址（能直接看到视频的那一页），
echo         保存后再运行一次 run.cmd。
start "" notepad "%CONFIG%"
set "CODE=0"
goto :end

:need_url
echo [提示] %CONFIG% 里还没有填课程地址，正在用记事本打开。
echo        在 [course-url] 下面把 URL1 填成课程播放页的地址，保存后再运行 run.cmd。
start "" notepad "%CONFIG%"
goto :fail

:install_uv
echo 没找到 uv（用来准备 Python 环境和依赖）。
where winget >nul 2>nul
if errorlevel 1 goto :manual_uv
choice /c YN /m "现在用 winget 自动安装 uv 吗"
if errorlevel 2 goto :manual_uv
winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%USERPROFILE%\.local\bin;%PATH%"
exit /b 0
:manual_uv
echo 请先安装 uv：https://docs.astral.sh/uv/getting-started/installation/ ，装完重新运行 run.cmd。
exit /b 1

:sync_failed
echo [错误] 依赖安装失败。检查网络后重新运行 run.cmd 即可。
goto :fail

:fail
set "CODE=1"
:end
if defined PAUSE_AT_END pause
chcp %OLDCP% >nul
exit /b %CODE%
