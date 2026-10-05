@echo off
REM Publishes this folder to https://github.com/robdatta/E-mail_Manager
REM Brings in any changes made on GitHub first, then uploads the local commits.
cd /d "%~dp0"
where git >nul 2>nul || (echo Git is not installed. Get it from https://git-scm.com/download/win and run this again. & pause & exit /b 1)
git remote get-url origin >nul 2>nul || git remote add origin https://github.com/robdatta/E-mail_Manager.git
git branch -M main
git config user.name "Rob Datta"
git config user.email "robdatta@gmail.com"

echo Checking GitHub for changes...
git fetch origin || (echo. & echo Could not reach GitHub. Check your internet connection and try again. & pause & exit /b 1)

git rev-parse --verify -q origin/main >nul && (
  echo.
  echo Changes on GitHub that are not on this computer:
  git log --oneline --format="  %%h  %%an  %%ad  %%s" --date=short main..origin/main
  echo.
  echo Changes on this computer that are not on GitHub:
  git log --oneline --format="  %%h  %%an  %%ad  %%s" --date=short origin/main..main
  echo.
  choice /M "Combine them and upload"
  if errorlevel 2 (echo Cancelled. Nothing was changed. & pause & exit /b 1)
  git pull --rebase origin main
  if errorlevel 1 (
    git rebase --abort >nul 2>nul
    echo.
    echo The changes on GitHub conflict with the local ones. Nothing was uploaded.
    echo Send a screenshot of this window so the conflict can be resolved.
    pause & exit /b 1
  )
)

git push -u origin main
if errorlevel 1 (echo. & echo Push failed. Send a screenshot of this window.) else (echo. & echo Done: https://github.com/robdatta/E-mail_Manager)
pause
