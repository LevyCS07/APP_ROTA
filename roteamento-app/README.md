# Roteamento App

Protótipo com frontend React e backend FastAPI.

## Requisito importante

Use Python 3.12. Python 3.14 ainda pode tentar compilar bibliotecas como `pandas`,
o que exige Visual Studio no Windows.

## Rodar o backend no Windows

No PowerShell:

```powershell
cd "C:\Users\Levy Souza\Documents\Codex\2026-05-26\analise-esse-c-digo-para-mim\roteamento-app\backend"
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
$env:ORS_API_KEY="SUA_CHAVE_ORS_AQUI"
uvicorn app.main:app --reload
```

No Prompt de Comando/CMD:

```cmd
cd "C:\Users\Levy Souza\Documents\Codex\2026-05-26\analise-esse-c-digo-para-mim\roteamento-app\backend"
py -3.12 -m venv .venv
.venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
set ORS_API_KEY=SUA_CHAVE_ORS_AQUI
uvicorn app.main:app --reload
```

## Rodar o frontend

Em outro terminal:

```powershell
cd "C:\Users\Levy Souza\Documents\Codex\2026-05-26\analise-esse-c-digo-para-mim\roteamento-app\frontend"
npm install
npm run dev
```

Abra o endereço mostrado pelo Vite, normalmente `http://localhost:5173`.

## Deploy online

Arquitetura recomendada para o protótipo:

- Frontend React: Vercel
- Backend FastAPI: Render

### 1. Antes de subir para o GitHub

Copie o arquivo de bairros para:

```text
roteamento-app/backend/app/data/BAIRROS_MANAUS.geojson
```

Sem esse arquivo, o backend online não consegue identificar os bairros.

Também gere uma nova chave ORS se a chave atual já foi compartilhada em algum lugar.

### 2. Backend no Render

No Render, crie um Web Service apontando para a pasta:

```text
roteamento-app/backend
```

Configurações:

```text
Build Command:
pip install -r requirements.txt

Start Command:
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

Variáveis de ambiente:

```text
PYTHON_VERSION=3.12.8
ORS_API_KEY=sua_chave_ors
BAIRROS_GEOJSON_PATH=app/data/BAIRROS_MANAUS.geojson
CORS_ORIGINS=https://seu-app.vercel.app
```

Depois que publicar, copie a URL do backend, por exemplo:

```text
https://roteamento-backend.onrender.com
```

### 3. Frontend na Vercel

Na Vercel, crie um projeto apontando para:

```text
roteamento-app/frontend
```

Configurações:

```text
Build Command:
npm run build

Output Directory:
dist
```

Variável de ambiente:

```text
VITE_API_URL=https://roteamento-backend.onrender.com
```

Troque a URL acima pela URL real do seu backend no Render.

Depois de publicar, volte ao Render e ajuste:

```text
CORS_ORIGINS=https://url-real-do-seu-frontend.vercel.app
```
