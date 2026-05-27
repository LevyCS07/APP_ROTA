@echo off
setlocal

cd /d "%~dp0"

echo Verificando Python 3.12...
py -3.12 --version
if errorlevel 1 (
  echo.
  echo Python 3.12 nao foi encontrado.
  echo Instale o Python 3.12 e rode este arquivo novamente.
  echo Download: https://www.python.org/downloads/release/python-3128/
  pause
  exit /b 1
)

if exist .venv (
  echo Removendo ambiente virtual antigo...
  rmdir /s /q .venv
)

echo Criando ambiente virtual com Python 3.12...
py -3.12 -m venv .venv
if errorlevel 1 exit /b 1

echo Atualizando pip...
.venv\Scripts\python.exe -m pip install --upgrade pip
if errorlevel 1 exit /b 1

echo Instalando dependencias...
.venv\Scripts\python.exe -m pip install -r requirements.txt
if errorlevel 1 exit /b 1

echo.
echo Ambiente pronto.
echo Para iniciar o backend, rode:
echo run_backend_cmd.bat
pause
