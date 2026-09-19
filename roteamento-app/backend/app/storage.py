"""Persistência dos projetos (colaboradores, rotas, atribuições).

Duas camadas, escolhidas automaticamente:
  - Supabase (tabela `projects`, coluna `data` jsonb) quando SUPABASE_URL e
    SUPABASE_KEY estão configurados — sobrevive a redeploys e ao Render
    "dormindo" por inatividade, ao contrário do disco local.
  - SQLite local como fallback quando o Supabase não está configurado —
    mesmo comportamento de antes (funciona, mas é apagado a cada restart
    sem disco persistente).

Diferente de `knowledge_base.py` (que é opcional e best-effort), este
módulo é uma dependência CRÍTICA do app — se uma escrita falhar, a
exceção deve subir e virar um erro 5xx visível, não ser engolida
silenciosamente. Perder uma atribuição de rota silenciosamente seria pior
do que travar a requisição com um erro claro.
"""

import json
import os
import sqlite3
import threading
from datetime import datetime, timezone
from pathlib import Path

_client = None
_client_checked = False
_DB_LOCK = threading.RLock()

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("APP_DATA_DIR", BASE_DIR / "data"))
DB_PATH = Path(os.getenv("PROJECTS_DB_PATH", DATA_DIR / "projects.sqlite3"))


def _get_client():
    global _client, _client_checked
    if _client_checked:
        return _client
    _client_checked = True
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")
    if not url or not key:
        return None
    # Remove barra(s) no final: o cliente monta o caminho como
    # "{url}/rest/v1/tabela" — se a URL já vier com barra sobrando, o
    # resultado ("..//rest/v1/...") é rejeitado pelo PostgREST com
    # "Invalid path specified in request URL" (PGRST125).
    url = url.rstrip("/")
    try:
        from supabase import create_client
        _client = create_client(url, key)
    except Exception:
        _client = None
    return _client


def is_using_supabase():
    return _get_client() is not None


def init():
    """Prepara o backend de armazenamento ativo. Chamado no startup do app."""
    if not is_using_supabase():
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL)")


def load_project(project_id):
    """Retorna o dict do projeto, ou None se não existir."""
    client = _get_client()
    if client:
        resp = client.table("projects").select("data").eq("id", project_id).execute()
        if not resp.data:
            return None
        return resp.data[0]["data"]

    with _DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT data FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        return None
    return json.loads(row[0])


def save_project(project):
    client = _get_client()
    if client:
        # jsonb aceita o dict diretamente — sem serializar para string.
        client.table("projects").upsert(
            {
                "id": project["id"],
                "data": json.loads(json.dumps(project, ensure_ascii=False)),
                "atualizado_em": datetime.now(timezone.utc).isoformat(),
            },
            on_conflict="id",
        ).execute()
        return

    payload = json.dumps(project, ensure_ascii=False, separators=(",", ":"))
    with _DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT INTO projects(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            (project["id"], payload),
        )
