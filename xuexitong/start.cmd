@echo off
setlocal
for /f "tokens=2 delims=:." %%c in ('chcp') do set "OLDCP=%%c"
chcp 65001 >nul
rem 学习通 Playwright 版的入口（Windows）：双击运行即可。
rem 第一次运行会自动安装依赖；连不上浏览器时会自动启动一个专用的 Chrome（没装就用 Edge）。
rem 参数原样传给 run.mjs，比如在命令行里 start.cmd --max-sections 1
cd /d "%~dp0playwright"

rem 双击打开的窗口在结束时停一下，不然报错一闪就没了
set "PAUSE_AT_END="
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && set "PAUSE_AT_END=1"

where node >nul 2>nul
if errorlevel 1 call :install_node
where node >nul 2>nul
if errorlevel 1 goto :fail

for /f %%v in ('node -p "parseInt(process.versions.node)"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 goto :old_node

node run.mjs %*
set "CODE=%errorlevel%"
goto :end

:install_node
echo 没找到 Node.js（需要 20 或更新）。
where winget >nul 2>nul
if errorlevel 1 goto :manual_node
choice /c YN /m "现在用 winget 自动安装 Node.js LTS 吗"
if errorlevel 2 goto :manual_node
winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
set "PATH=%ProgramFiles%\nodejs;%PATH%"
exit /b 0
:manual_node
echo 请到 https://nodejs.org 下载 LTS 版安装，装完重新运行 start.cmd。
exit /b 1

:old_node
echo [错误] Node.js 版本太旧（当前 %NODE_MAJOR%，需要 20 或更新），请到 https://nodejs.org 下载 LTS 版重新安装。
goto :fail

:fail
set "CODE=1"
:end
if defined PAUSE_AT_END pause
chcp %OLDCP% >nul
exit /b %CODE%
