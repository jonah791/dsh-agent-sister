@echo off
rem Detached launcher for the sister (DSH desktop).
rem Usage: launch.cmd <exePath> <cdpPort>
rem
rem WHY DETACHED: if the harness shell starts her, she becomes a DESCENDANT of
rem the web process, and the web-restart cleanup tree-kills her. Observed twice
rem on 2026-09-30 -- last heartbeat 12:51:05 and 18:07:28, both inside a restart
rem window, and both times the launcher cmd never reached its "exit code" line,
rem which proves the cmd itself was killed rather than finishing.
rem The caller MUST use WMI Win32_Process.Create (or a scheduled task) so her
rem parent is WmiPrvSE, not the harness process tree.
rem
rem ASCII-ONLY ON PURPOSE: cmd.exe reads a UTF-8-no-BOM file under the OEM
rem codepage (936/GBK); a mis-decoded CJK rem line is parsed as commands and
rem swallows the FOLLOWING line -- which silently kills the set/log lines below.
setlocal
set "EXE=%~1"
set "PORT=%~2"
if "%EXE%"=="" set "EXE=E:\deepseek harness\DeepSeek Harness.exe"
if "%PORT%"=="" set "PORT=9333"
rem Environment is set EXPLICITLY: a detached launch inherits the WMI provider's
rem environment, not the caller's. She shares E:\alice\.dsh with her sister by
rem design (her delivery target session lives in E:\alice\.dsh\sessions\--E-alice--).
set "DSH_HOME=E:\alice\.dsh"
rem Clear the identity vars a harness shell would inject, or she registers on
rem the bus as the caller (observed: she impersonated this instance as web-3080).
set "DSH_PROFILE="
set "DSH_PROFILE_DIR="
set "DSH_WEB_URL="
set "DSH_SESSION_ID="
set "DSH_SHELL="
set "LOGDIR=E:\alice\.dsh\logs"
if not exist "%LOGDIR%" mkdir "%LOGDIR%"
set "LIFE=%LOGDIR%\sister-lifecycle.log"
set "OUT=%LOGDIR%\sister-boot.out.log"
set "ERR=%LOGDIR%\sister-boot.err.log"
>> "%LIFE%" echo [%DATE% %TIME%] start port=%PORT%
cd /d "%~dp1"
"%EXE%" --remote-debugging-port=%PORT% 1>"%OUT%" 2>"%ERR%"
>> "%LIFE%" echo [%DATE% %TIME%] exit code=%ERRORLEVEL%
endlocal
