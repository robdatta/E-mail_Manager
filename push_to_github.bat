@echo off
REM Publishes this folder to https://github.com/robdatta/E-mail_Manager
REM 1) Create an EMPTY repository named E-mail_Manager at https://github.com/new (no README, no license).
REM 2) Double-click this file. Git will open a browser window to sign in to GitHub the first time.
cd /d "%~dp0"
where git >nul 2>nul || (echo Git is not installed. Get it from https://git-scm.com/download/win and run this again. & pause & exit /b 1)
git remote get-url origin >nul 2>nul || git remote add origin https://github.com/robdatta/E-mail_Manager.git
git branch -M main
git push -u origin main
if errorlevel 1 (echo. & echo Push failed. Make sure the empty repository exists at https://github.com/robdatta/E-mail_Manager and try again.) else (echo. & echo Done: https://github.com/robdatta/E-mail_Manager)
pause
