@echo off
setlocal
rem ---------------------------------------------------------------------------
rem Entry point of Autovisor from source on Windows: double-click it.
rem The first run creates config.ini from the template, prepares Python with
rem uv and opens the browser. The course address may stay empty: log in and
rem open a course in the browser and it starts. Arguments go to Autovisor.py
rem unchanged, e.g. run.cmd --check-browser in a terminal.
rem
rem This file must stay ASCII. With the console on UTF-8, cmd misreads batch
rem files that contain multi-byte characters: depending on where such a line
rem sits, it cuts the line and runs the second half as a command (seen on
rem Windows 11, in a double-clicked window and in the launcher's log alike).
rem The Chinese text people see lives in resources\run-messages.txt (UTF-8) and
rem is printed by :say.
rem
rem The console is switched to UTF-8 so that this text and the output of
rem Node / Python come out right, also through the launcher's pipes. It is not
rem switched back: on current Windows every chcp clears the screen, which wiped
rem whatever the run had printed, error messages included.
rem ---------------------------------------------------------------------------
set "MESSAGES=%~dp0resources\run-messages.txt"
rem Pause at the end only when double-clicked, so an error doesn't vanish with
rem the window. Never under the launcher (COURSE_UI=1): its stdin is a pipe
rem that stays open, so pause would wait forever and the run would never end.
set "PAUSE_AT_END="
if "%COURSE_UI%"=="1" goto :no_pause
echo %cmdcmdline% | findstr /i /c:"%~nx0" >nul && set "PAUSE_AT_END=1"
:no_pause
rem Switch only when needed: under the terminal UI the tools share its console,
rem which is already UTF-8, and a needless chcp could clear its screen.
for /f "tokens=2 delims=:." %%c in ('chcp') do set "CP=%%c"
set "CP=%CP: =%"
if not "%CP%"=="65001" chcp 65001 >nul

call :main %*
set "CODE=%errorlevel%"
if defined PAUSE_AT_END call :wait_close
exit /b %CODE%

:main
cd /d "%~dp0"

set "CONFIG=config.ini"

rem 1. Config file: create it from the template when missing, then go on
if not exist "%CONFIG%" copy /y config.ini.example "%CONFIG%" >nul

rem 2. uv prepares Python and the dependencies (no Python install needed).
rem    Also look where winget and uv's own installer put it: a uv installed
rem    after this process started is not on the PATH it inherited.
set "PATH=%LOCALAPPDATA%\Microsoft\WinGet\Links;%USERPROFILE%\.local\bin;%PATH%"
where uv >nul 2>nul
if errorlevel 1 call :install_uv
where uv >nul 2>nul
if errorlevel 1 goto :fail

rem 3. Dependencies: numpy and opencv too when the slider captcha is on.
rem    Quick when they are already installed.
rem    Python and the packages come from mirrors in China by default: most
rem    people using this are there, where GitHub (uv's Python builds) and PyPI
rem    are slow or unreachable from many networks. Mirrors set by the user win.
rem    The versions stay those of uv.lock; uv only rewrites the download URLs
rem    in it (checked). If the mirrors fail, try the official sources once.
set "EXTRA="
findstr /r /i /c:"^ *enableAutoCaptcha *= *true" "%CONFIG%" >nul && set "EXTRA=--extra captcha"
set "MIRRORED="
if defined UV_DEFAULT_INDEX goto :index_set
set "UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple"
set "MIRRORED=1"
:index_set
if defined UV_PYTHON_INSTALL_MIRROR goto :python_mirror_set
set "UV_PYTHON_INSTALL_MIRROR=https://registry.npmmirror.com/-/binary/python-build-standalone"
set "MIRRORED=1"
:python_mirror_set
call :say checking
uv sync %EXTRA%
if not errorlevel 1 goto :run
if not defined MIRRORED goto :sync_failed
call :say sync-official
set "UV_DEFAULT_INDEX="
set "UV_PYTHON_INSTALL_MIRROR="
uv sync %EXTRA%
if errorlevel 1 goto :sync_failed

rem 4. Run
:run
uv run python -u Autovisor.py %*
set "CODE=%errorlevel%"
goto :end

:install_uv
call :say no-uv
rem Under the launcher nobody can answer a question: stdin is its pipe, and
rem neither the window nor the terminal version can type into it, so a run sat
rem at this question for good (seen on a friend's first run). Starting
rem Zhihuishu there is the go-ahead; a double-clicked run.cmd still asks.
if "%COURSE_UI%"=="1" goto :get_uv
call :say ask-install-uv
choice /c YN
if errorlevel 2 goto :manual_uv
:get_uv
rem First from a PyPI mirror (see resources\install-uv.ps1): winget and uv's
rem own installer both download from GitHub.
call :say installing-uv
rem Started from PowerShell 7 (say in Windows Terminal) through the launcher,
rem PSModulePath lists PowerShell 7's modules first and Windows PowerShell 5.1
rem then loads the wrong ones. Emptied, 5.1 builds its own default.
set "PSModulePath="
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "%~dp0resources\install-uv.ps1"
where uv >nul 2>nul
if not errorlevel 1 exit /b 0
where winget >nul 2>nul
if errorlevel 1 goto :uv_failed
call :say installing-uv-winget
rem In the launcher's log winget's progress bars come out as garbage: keep its
rem output in a file there, and say where it is if the install fails.
set "WINGET_LOG=CON"
if "%COURSE_UI%"=="1" set "WINGET_LOG=%TEMP%\autovisor-winget.log"
winget install --id astral-sh.uv -e --accept-source-agreements --accept-package-agreements >"%WINGET_LOG%" 2>&1
where uv >nul 2>nul
if not errorlevel 1 exit /b 0
if not "%WINGET_LOG%"=="CON" call :say winget-log
:uv_failed
call :say uv-failed
:manual_uv
call :say manual-uv
exit /b 1

:sync_failed
call :say sync-failed
goto :fail

:fail
set "CODE=1"
:end
exit /b %CODE%

rem Print the line "<key>=<text>" of the messages file. "call echo" expands the
rem %VARIABLES% inside the text.
:say
if not exist "%MESSAGES%" (
    echo %~1
    exit /b 0
)
for /f "usebackq tokens=1,* delims==" %%a in (`findstr /b /c:"%~1=" "%MESSAGES%"`) do call echo %%b
exit /b 0

rem Double-clicked: stop here, or errors and the closing summary vanish with the
rem window. Our own line instead of pause's, which is English on code page 65001.
:wait_close
echo.
call :say press-any-key
pause >nul
exit /b 0
