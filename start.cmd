@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Everything above :main must stay ASCII. cmd reads a batch file line by line
rem in the console's code page, and switching to UTF-8 halfway shifts the lines
rem that follow (on a GBK console the Chinese comments below were run as
rem commands). So when the console is not UTF-8 yet, switch it and run this
rem file again in a fresh cmd, which then reads it from the top in UTF-8.
rem ---------------------------------------------------------------------------
if "%COURSE_CMD_SELF%"=="%~f0" goto :inner
for /f "tokens=2 delims=:." %%c in ('chcp') do set "OLDCP=%%c"
set "OLDCP=%OLDCP: =%"
rem Pause at the end only when double-clicked, so an error doesn't vanish with
rem the window. Never under the launcher (COURSE_UI=1): its stdin is a pipe
rem that stays open, so pause would wait forever and the run would never end.
set "PAUSE_AT_END="
if "%COURSE_UI%"=="1" goto :no_pause
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && set "PAUSE_AT_END=1"
:no_pause
if "%OLDCP%"=="65001" goto :here
chcp 65001 >nul
set "COURSE_CMD_SELF=%~f0"
cmd /d /c ""%~f0" %*"
set "CODE=%errorlevel%"
chcp %OLDCP% >nul
goto :done
:here
call :main %*
set "CODE=%errorlevel%"
:done
if defined PAUSE_AT_END pause
exit /b %CODE%

:inner
call :main %*
exit /b %errorlevel%

:main
rem 学习通 Playwright 版的入口（Windows）：双击运行即可。
rem 第一次运行会自动安装依赖；连不上浏览器时会自动启动一个专用的 Chrome（没装就用 Edge）。
rem 参数原样传给 run.mjs，比如在命令行里 start.cmd --max-sections 1
cd /d "%~dp0playwright"

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
exit /b %CODE%
