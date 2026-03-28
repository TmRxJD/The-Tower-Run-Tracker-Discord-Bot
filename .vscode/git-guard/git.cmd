@echo off
setlocal enabledelayedexpansion
set "REAL_GIT=C:\Program Files\Git\cmd\git.exe"
for %%A in (%*) do (
  set "ARG=%%~A"
  if /I "!ARG!"=="restore" (
    echo git restore is blocked in this workspace. Use git diff and apply_patch instead.
    exit /b 1
  )
)
"%REAL_GIT%" %*
exit /b %ERRORLEVEL%
