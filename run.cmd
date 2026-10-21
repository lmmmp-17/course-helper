@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Everything above :main must stay ASCII. cmd reads a batch file line by line
rem in the console's code page, and switching to UTF-8 halfway shifts the lines
rem that follow (on a GBK console the Chinese comments below were run as
rem commands). So when the console is not UTF-8 yet, switch it and read this
rem file again from the top with "call", which then reads it all in UTF-8.
rem "call" keeps it in the same cmd: running it in a second cmd made Ctrl+C
rem ask "Terminate batch job (Y/N)?" twice, once for each cmd.
rem
rem The code page is left at UTF-8 afterwards. On current Windows every chcp
rem clears the screen, so switching back wiped whatever the run had printed,
rem error messages included. A double-clicked window closes right after anyway.
rem ---------------------------------------------------------------------------
if "%COURSE_CMD_SELF%"=="%~f0" goto :inner
rem Pause at the end only when double-clicked, so an error doesn't vanish with
rem the window. Never under the launcher (COURSE_UI=1): its stdin is a pipe
rem that stays open, so pause would wait forever and the run would never end.
set "PAUSE_AT_END="
if "%COURSE_UI%"=="1" goto :no_pause
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && set "PAUSE_AT_END=1"
:no_pause
for /f "tokens=2 delims=:." %%c in ('chcp') do set "CP=%%c"
set "CP=%CP: =%"
if "%CP%"=="65001" goto :inner
chcp 65001 >nul
set "COURSE_CMD_SELF=%~f0"
call "%~f0" %*
exit /b %errorlevel%

:inner
call :main %*
set "CODE=%errorlevel%"
if defined PAUSE_AT_END call :wait_close
exit /b %CODE%

:main
rem Autovisor 的 Windows 源码运行入口：双击运行即可。
rem 第一次运行会从模板生成配置文件 config.ini，自动准备 Python 环境，然后打开浏览器。
rem 课程地址可以不填：登录后在浏览器里点开一门课就会开始。
rem 参数原样传给 Autovisor.py，比如在命令行里 run.cmd --check-browser
cd /d "%~dp0"

set "CONFIG=config.ini"

rem 1. 配置文件：没有就从模板生成一份，接着往下跑
if not exist "%CONFIG%" copy /y config.ini.example "%CONFIG%" >nul

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
exit /b %CODE%

rem 双击运行时停在这里，不然报错和结束总结会跟着窗口一起消失。
rem 不用 pause 自带的那句：代码页是 65001 时它是英文。
:wait_close
echo.
echo 按任意键关闭这个窗口...
pause >nul
exit /b 0
