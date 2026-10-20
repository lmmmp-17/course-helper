@echo off
setlocal
for /f "tokens=2 delims=:." %%c in ('chcp') do set "OLDCP=%%c"
chcp 65001 >nul
rem 网课助手的入口（Windows）：双击运行即可。
rem 会开一个本地控制台，并用你的默认浏览器打开它；三个平台都在里面启动。
cd /d "%~dp0"

set "PAUSE_AT_END="
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && set "PAUSE_AT_END=1"

where node >nul 2>nul
if errorlevel 1 call :install_node
where node >nul 2>nul
if errorlevel 1 goto :fail

for /f %%v in ('node -p "parseInt(process.versions.node)"') do set "NODE_MAJOR=%%v"
if %NODE_MAJOR% LSS 20 goto :old_node

node launcher\run.mjs %*
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
echo [错误] Node.js 版本太旧（当前 %NODE_MAJOR%，需要 20 或更新）。
goto :fail

:fail
set "CODE=1"
:end
if defined PAUSE_AT_END pause
chcp %OLDCP% >nul
exit /b %CODE%
