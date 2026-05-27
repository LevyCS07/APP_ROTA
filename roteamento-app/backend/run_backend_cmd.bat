@echo off
setlocal

cd /d "%~dp0"

if not exist .venv\Scripts\python.exe (
  echo Ambiente virtual nao encontrado.
  echo Rode primeiro: setup_backend_cmd.bat
  pause
  exit /b 1
)

if "%ORS_API_KEY%"=="" (
  set /p ORS_API_KEY=Digite sua ORS_API_KEY: 
)

.venv\Scripts\python.exe -m uvicorn app.main:app --reload
