import io
import json
import math
import os
import re
import sqlite3
import threading
import uuid
import zipfile
from pathlib import Path

import openrouteservice
import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from lxml import etree
from pydantic import BaseModel
from shapely.geometry import Point, shape

MAX_UPLOAD_BYTES = 15 * 1024 * 1024
MAX_WAYPOINTS = 48  # Inclui o destino final.
CAMPO_NOME_BAIRRO = "Name"
TIPOS_ROTA = {"Entrada", "Saída"}

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(os.getenv("APP_DATA_DIR", BASE_DIR / "data"))
DB_PATH = Path(os.getenv("PROJECTS_DB_PATH", DATA_DIR / "projects.sqlite3"))
BAIRROS_CACHE = None
DB_LOCK = threading.RLock()

allowed_origins = [origin.strip() for origin in os.getenv("CORS_ORIGINS", "https://app-rota.vercel.app").split(",") if origin.strip()]
app = FastAPI(title="Roteamento API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=allowed_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    allow_headers=["Content-Type", "Authorization"],
)


def init_db():
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute("CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL)")


def load_project(project_id: str):
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        row = conn.execute("SELECT data FROM projects WHERE id = ?", (project_id,)).fetchone()
    if not row:
        raise HTTPException(404, "Projeto não encontrado.")
    return json.loads(row[0])


def save_project(project):
    payload = json.dumps(project, ensure_ascii=False, separators=(",", ":"))
    with DB_LOCK, sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            "INSERT INTO projects(id, data) VALUES(?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data",
            (project["id"], payload),
        )


def haversine(lat1, lon1, lat2, lon2):
    radius_km = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius_km * math.asin(math.sqrt(a))


def bearing(lat1, lon1, lat2, lon2):
    """Direção (0-360°, sentido horário a partir do norte) do ponto 1 para o
    ponto 2. Usada para agrupar colaboradores que ficam 'do mesmo lado' do
    destino (bloco 4 - cone/direção do gerador automático)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    x = math.sin(dlambda) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def valid_coordinate(lat, lon):
    return math.isfinite(lat) and math.isfinite(lon) and -90 <= lat <= 90 and -180 <= lon <= 180


def geojson_path():
    candidates = [os.getenv("BAIRROS_GEOJSON_PATH"), DATA_DIR / "BAIRROS_MANAUS.geojson", Path.cwd() / "BAIRROS_MANAUS.geojson"]
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return Path(candidate)
    raise HTTPException(500, "BAIRROS_MANAUS.geojson não encontrado. Configure BAIRROS_GEOJSON_PATH.")


def carregar_bairros():
    global BAIRROS_CACHE
    if BAIRROS_CACHE is not None:
        return BAIRROS_CACHE
    try:
        with geojson_path().open("r", encoding="utf-8-sig") as file:
            geojson = json.load(file)
    except (OSError, json.JSONDecodeError) as exc:
        raise HTTPException(500, "Não foi possível carregar o GeoJSON de bairros.") from exc
    bairros = []
    for feature in geojson.get("features", []):
        if not feature.get("geometry"):
            continue
        geometry = shape(feature["geometry"])
        if geometry.is_empty:
            continue
        properties = feature.get("properties", {})
        nome = str(properties.get(CAMPO_NOME_BAIRRO) or properties.get("NOME") or properties.get("BAIRRO") or f"B{len(bairros)}")
        centroid = geometry.centroid
        bairros.append({"idx": len(bairros), "nome": nome, "geometry": geometry, "centroid_lat": centroid.y, "centroid_lon": centroid.x})
    if not bairros:
        raise HTTPException(500, "O GeoJSON não contém bairros utilizáveis.")
    BAIRROS_CACHE = bairros
    return bairros


def atribuir_bairro(lat, lon, bairros):
    point = Point(lon, lat)
    for bairro in bairros:
        # covers também inclui pontos que caem exatamente na fronteira do polígono.
        if bairro["geometry"].covers(point):
            return bairro["idx"], bairro["nome"]
    nearest = min(bairros, key=lambda bairro: haversine(lat, lon, bairro["centroid_lat"], bairro["centroid_lon"]))
    return nearest["idx"], nearest["nome"]


def colunas_tipo(tipo):
    return ("LAT E", "LONG E") if tipo == "Entrada" else ("LAT S", "LONG S")


def read_excel(file_bytes):
    try:
        df = pd.read_excel(io.BytesIO(file_bytes), sheet_name="BD")
    except Exception as exc:
        raise HTTPException(400, "Arquivo Excel inválido ou aba 'BD' não encontrada.") from exc
    required = ["COLABORADOR", "LAT E", "LONG E", "LAT S", "LONG S"]
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise HTTPException(400, f"Colunas ausentes: {', '.join(missing)}")
    for column in required[1:]:
        df[column] = pd.to_numeric(df[column], errors="coerce")
    df = df.dropna(subset=required[1:]).reset_index(drop=True)
    invalid = ~df.apply(lambda row: valid_coordinate(float(row["LAT E"]), float(row["LONG E"])) and valid_coordinate(float(row["LAT S"]), float(row["LONG S"])), axis=1)
    if invalid.any():
        raise HTTPException(400, "A planilha contém coordenadas fora dos limites válidos.")
    return df


def build_collaborators(df, tipo_rota, destino):
    bairros = carregar_bairros()
    lat_col, lon_col = colunas_tipo(tipo_rota)
    collaborators = []
    for idx, row in df.iterrows():
        lat, lon = float(row[lat_col]), float(row[lon_col])
        bairro_idx, bairro_nome = atribuir_bairro(lat, lon, bairros)
        collaborators.append({
            "id": int(idx),
            "nome": str(row["COLABORADOR"]),
            "bairro_idx": bairro_idx,
            "bairro": bairro_nome,
            "latE": float(row["LAT E"]),
            "lonE": float(row["LONG E"]),
            "latS": float(row["LAT S"]),
            "lonS": float(row["LONG S"]),
            "lat": lat,
            "lon": lon,
            "distKm": round(haversine(lat, lon, destino["lat"], destino["lon"]), 3),
            # Direção do destino até o colaborador (0-360°) — usada pelo
            # gerador automático de rotas para agrupar por região/sentido.
            "bearing": round(bearing(destino["lat"], destino["lon"], lat, lon), 2),
            "routeId": None,
            # Posição do colaborador na sequência de embarque dentro da rota (0-based).
            # None enquanto o colaborador não pertence a nenhuma rota.
            "order": None,
        })
    return collaborators


def ordered_route_rows(project, route_id):
    """Colaboradores de uma rota, na ordem de embarque definida pelo usuário."""
    rows = [c for c in project["collaborators"] if c["routeId"] == route_id]
    rows.sort(key=lambda c: (c["order"] if c["order"] is not None else 10 ** 9, c["id"]))
    return rows


def project_response(project):
    return {
        "id": project["id"],
        "destino": project["destino"],
        "tipoRota": project["tipoRota"],
        # .get() com padrão: projetos criados antes desses campos existirem
        # (dados já salvos no banco) continuam abrindo normalmente.
        "modo": project.get("modo", "manual"),
        "veiculo": project.get("veiculo", ""),
        "routes": project["routes"],
        "collaborators": project["collaborators"],
    }


def safe_filename(value):
    result = re.sub(r"[^A-Za-z0-9._-]+", "_", value.strip())
    return result.strip("._")[:80] or "rota"


# ---------------------------------------------------------------------------
# Gerador automático de rotas.
#
# Pipeline (cada função abaixo cobre um ou mais blocos do desenho original):
#   3 Nº de rotas        -> _decide_route_count
#   4 Cone/Direção        -> bearing() (já calculado em build_collaborators)
#   5 Pré-agrupamento     -> _split_by_direction
#   6 Corredor viário      -> aproximado pela própria coerência direcional dos
#                             grupos (ver nota abaixo; não há dados de malha
#                             viária disponíveis para um cálculo mais fiel)
#   7 Rotas candidatas    -> _split_by_direction (1 grupo = 1 rota candidata)
#   8 Capacidade          -> _rebalance_by_capacity
#   9 Ordenação           -> _nearest_neighbor_order
#  10 2-opt               -> _two_opt
#  11 Roteamento real     -> _evaluate_routes (chama o ORS, reaproveitando
#                             ors_route) — só 1 chamada por rota já finalizada,
#                             para não estourar a cota da API a cada iteração
#  12 Avaliação           -> métricas dentro de _evaluate_routes
#  13 Trocas/Refinamento  -> _relocate_improvement
#  14 Validação final     -> feita ao final de auto_generate_routes
# ---------------------------------------------------------------------------

def _decide_route_count(total, capacity, hint):
    """Bloco 3: quantas rotas serão necessárias. Usa a dica do usuário se
    fizer sentido; senão calcula a partir da capacidade do veículo, com uma
    unidade de folga para dar espaço ao rebalanceamento geográfico."""
    minimo = max(1, math.ceil(total / capacity))
    if hint and hint >= minimo:
        return hint
    return minimo


def _split_by_direction(collaborators, route_count):
    """Blocos 4+5+7: ordena os colaboradores pela direção (bearing) a partir
    do destino e fatia em `route_count` setores contíguos de tamanho
    aproximadamente igual. Colaboradores no mesmo setor angular tendem a sair
    pelas mesmas vias principais para alcançar o destino — na ausência de um
    grafo de ruas real, essa coerência direcional é o proxy usado aqui para o
    'corredor viário' do bloco 6."""
    ordered = sorted(collaborators, key=lambda c: c["bearing"])
    total = len(ordered)
    groups = [[] for _ in range(route_count)]
    base_size = total / route_count
    for index, collab in enumerate(ordered):
        group_index = min(int(index / base_size), route_count - 1)
        groups[group_index].append(collab)
    return groups


def _rebalance_by_capacity(groups, capacity):
    """Bloco 8: redistribui colaboradores nas fronteiras entre setores
    vizinhos (na 'roda' de direções) até que nenhum grupo exceda a
    capacidade, preservando ao máximo a coerência direcional (só troca com o
    vizinho mais próximo em ângulo)."""
    guard = 0
    changed = True
    while changed and guard < 500:
        changed = False
        guard += 1
        for i in range(len(groups)):
            if len(groups[i]) <= capacity:
                continue
            groups[i].sort(key=lambda c: c["bearing"])
            next_i = (i + 1) % len(groups)
            prev_i = (i - 1) % len(groups)
            if len(groups[next_i]) < capacity:
                groups[next_i].append(groups[i].pop())
                changed = True
            elif len(groups[prev_i]) < capacity:
                groups[prev_i].append(groups[i].pop(0))
                changed = True
    return groups


def _nearest_neighbor_order(rows, destino, lat_key, lon_key):
    """Bloco 9: sequência inicial de embarque. Começa no colaborador mais
    distante do destino e, a cada passo, avança para o não visitado mais
    próximo do atual — mesma heurística usada no botão manual de
    'ordenar automaticamente' do editor."""
    remaining = rows.copy()
    current = max(remaining, key=lambda r: haversine(r[lat_key], r[lon_key], destino["lat"], destino["lon"]))
    ordered = [current]
    remaining.remove(current)
    while remaining:
        nxt = min(remaining, key=lambda r: haversine(current[lat_key], current[lon_key], r[lat_key], r[lon_key]))
        ordered.append(nxt)
        remaining.remove(nxt)
        current = nxt
    return ordered


def _path_distance(sequence, lat_key, lon_key, destino):
    total = 0.0
    for a, b in zip(sequence, sequence[1:]):
        total += haversine(a[lat_key], a[lon_key], b[lat_key], b[lon_key])
    if sequence:
        total += haversine(sequence[-1][lat_key], sequence[-1][lon_key], destino["lat"], destino["lon"])
    return total


def _two_opt(sequence, lat_key, lon_key, destino, max_iterations=60):
    """Bloco 10: busca local 2-opt clássica sobre distância em linha reta
    (rota real ainda não existe nesse ponto do pipeline) para desfazer
    cruzamentos e zigue-zagues óbvios na sequência inicial."""
    best = sequence
    n = len(best)
    if n > 60:
        # Custo é quadrático por iteração; em rotas muito grandes, uma
        # passada só já ajuda bastante sem pesar no tempo de resposta.
        max_iterations = 1
    improved = True
    iterations = 0
    while improved and iterations < max_iterations and n > 3:
        improved = False
        iterations += 1
        for i in range(n - 1):
            for j in range(i + 2, n):
                if i == 0 and j == n - 1:
                    continue
                candidate = best[:i + 1] + best[i + 1:j + 1][::-1] + best[j + 1:]
                if _path_distance(candidate, lat_key, lon_key, destino) < _path_distance(best, lat_key, lon_key, destino) - 1e-9:
                    best = candidate
                    improved = True
    return best


def _relocate_improvement(routes, collaborators, destino, lat_key, lon_key, passes=3):
    """Bloco 13: tenta mover colaboradores de fronteira para uma rota vizinha
    quando isso os aproxima do centro geográfico dessa rota (e há vaga),
    depois recalcula a sequência de embarque das rotas afetadas."""
    route_ids = [route["id"] for route in routes]
    capacity_by_id = {route["id"]: route["capacity"] for route in routes}

    for _ in range(passes):
        centroids = {}
        for route_id in route_ids:
            members = [c for c in collaborators if c["routeId"] == route_id]
            if members:
                centroids[route_id] = (
                    sum(c[lat_key] for c in members) / len(members),
                    sum(c[lon_key] for c in members) / len(members)
                )
        moved_any = False
        for collab in collaborators:
            current_id = collab["routeId"]
            if current_id not in centroids:
                continue
            current_dist = haversine(collab[lat_key], collab[lon_key], *centroids[current_id])
            best_id, best_dist = current_id, current_dist
            for route_id, centroid in centroids.items():
                if route_id == current_id:
                    continue
                occupancy = sum(1 for c in collaborators if c["routeId"] == route_id)
                if occupancy >= capacity_by_id.get(route_id, 0):
                    continue
                dist = haversine(collab[lat_key], collab[lon_key], *centroid)
                if dist < best_dist - 0.05:  # só troca se ganhar pelo menos ~50 m, evita "flapping"
                    best_id, best_dist = route_id, dist
            if best_id != current_id:
                collab["routeId"] = best_id
                moved_any = True
        if not moved_any:
            break

    for route_id in route_ids:
        members = [c for c in collaborators if c["routeId"] == route_id]
        if not members:
            continue
        ordered = _nearest_neighbor_order(members, destino, lat_key, lon_key)
        ordered = _two_opt(ordered, lat_key, lon_key, destino)
        for order_index, collab in enumerate(ordered):
            collab["order"] = order_index


def _angular_spread(bearings):
    """Amplitude angular real de um conjunto de direções (0-360°), tratando
    corretamente o caso do grupo cruzar a fronteira 0°/360° — a diferença
    simples entre máximo e mínimo dá um valor errado nesse caso."""
    if not bearings:
        return 0.0
    values = sorted(bearings)
    gaps = [values[i + 1] - values[i] for i in range(len(values) - 1)]
    gaps.append(360 - values[-1] + values[0])
    return round(360 - max(gaps), 1)


def _evaluate_routes(routes, collaborators, destino, lat_key, lon_key):
    """Blocos 11+12: consulta o ORS (mesma função usada no preview/KML) para
    obter o trajeto real de cada rota já fechada e calcula métricas simples
    de avaliação (distância, ocupação, dispersão direcional)."""
    for route in routes:
        members = [c for c in collaborators if c["routeId"] == route["id"]]
        members.sort(key=lambda c: c["order"] if c["order"] is not None else 0)
        if not members:
            route.update(distanciaKm=0.0, usedOrs=False, ocupacao=0, dispersaoGraus=0.0)
            continue
        coords = [[m[lon_key], m[lat_key]] for m in members] + [[destino["lon"], destino["lat"]]]
        route_coords, used_ors = ors_route(coords)
        distancia_km = sum(
            haversine(lat1, lon1, lat2, lon2)
            for (lon1, lat1), (lon2, lat2) in zip(route_coords, route_coords[1:])
        )
        route.update(
            distanciaKm=round(distancia_km, 2),
            usedOrs=used_ors,
            ocupacao=len(members),
            dispersaoGraus=_angular_spread([m["bearing"] for m in members]),
        )
    return routes


def auto_generate_routes(collaborators, destino, capacity, route_count_hint, tipo_rota):
    """Executa o pipeline completo (blocos 3 a 14) e devolve a lista de
    rotas já povoadas; `collaborators` é alterado em memória (routeId/order
    de cada colaborador são preenchidos diretamente nos dicionários)."""
    total = len(collaborators)
    if total == 0:
        return [{"id": 1, "name": "ROTA_01", "capacity": capacity}]

    lat_key, lon_key = ("latE", "lonE") if tipo_rota == "Entrada" else ("latS", "lonS")

    route_count = _decide_route_count(total, capacity, route_count_hint)
    groups = _split_by_direction(collaborators, route_count)
    groups = _rebalance_by_capacity(groups, capacity)

    routes = []
    for index, group in enumerate(groups):
        if not group:
            continue
        route_id = index + 1
        routes.append({"id": route_id, "name": f"ROTA_{route_id:02d}", "capacity": capacity})
        ordered_group = _nearest_neighbor_order(group, destino, lat_key, lon_key)
        ordered_group = _two_opt(ordered_group, lat_key, lon_key, destino)
        for order_index, collab in enumerate(ordered_group):
            collab["routeId"] = route_id
            collab["order"] = order_index

    _relocate_improvement(routes, collaborators, destino, lat_key, lon_key, passes=3)

    # 14) Validação final: remove rotas que ficaram vazias após os ajustes e
    # renumera a ordem de embarque de 0..n-1 sem buracos.
    routes = [route for route in routes if any(c["routeId"] == route["id"] for c in collaborators)]
    for route in routes:
        members = [c for c in collaborators if c["routeId"] == route["id"]]
        members.sort(key=lambda c: c["order"] if c["order"] is not None else 0)
        for order_index, collab in enumerate(members):
            collab["order"] = order_index
    if not routes:
        routes = [{"id": 1, "name": "ROTA_01", "capacity": capacity}]

    return _evaluate_routes(routes, collaborators, destino, lat_key, lon_key)


@app.on_event("startup")
def startup():
    init_db()


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/projects")
async def create_project(
    file: UploadFile = File(...),
    destino_lat: float = Form(...),
    destino_lon: float = Form(...),
    tipo_rota: str = Form("Entrada"),
    modo: str = Form("manual"),
    capacidade: int = Form(22),
    quantidade_rotas: int = Form(0),
    veiculo: str = Form(""),
):
    if tipo_rota not in TIPOS_ROTA:
        raise HTTPException(422, "tipo_rota deve ser 'Entrada' ou 'Saída'.")
    if modo not in {"manual", "automatico"}:
        raise HTTPException(422, "modo deve ser 'manual' ou 'automatico'.")
    if not valid_coordinate(destino_lat, destino_lon):
        raise HTTPException(422, "Coordenadas de destino inválidas.")
    if capacidade < 1:
        raise HTTPException(422, "A capacidade deve ser maior que zero.")
    if quantidade_rotas < 0:
        raise HTTPException(422, "A quantidade de rotas não pode ser negativa.")
    if not (file.filename or "").lower().endswith((".xlsx", ".xls")):
        raise HTTPException(400, "Envie um arquivo .xlsx ou .xls.")
    contents = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(contents) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "O arquivo excede o limite de 15 MB.")

    df = read_excel(contents)
    destino = {"lat": float(destino_lat), "lon": float(destino_lon)}
    collaborators = build_collaborators(df, tipo_rota, destino)

    if modo == "automatico":
        routes = auto_generate_routes(collaborators, destino, capacidade, quantidade_rotas or None, tipo_rota)
    else:
        route_count = quantidade_rotas if quantidade_rotas > 0 else 5
        routes = [{"id": index + 1, "name": f"ROTA_{index + 1:02d}", "capacity": capacidade} for index in range(route_count)]

    project = {
        "id": str(uuid.uuid4()),
        "destino": destino,
        "tipoRota": tipo_rota,
        "modo": modo,
        "veiculo": veiculo.strip()[:60],
        "routes": routes,
        "collaborators": collaborators,
    }
    save_project(project)
    return project_response(project)


class AssignmentPayload(BaseModel):
    assignments: dict[int, int | None]


@app.put("/api/projects/{project_id}/assignments")
def update_assignments(project_id: str, payload: AssignmentPayload):
    project = load_project(project_id)
    routes = {route["id"]: route for route in project["routes"]}
    collaborators = {collaborator["id"]: collaborator for collaborator in project["collaborators"]}
    unknown_people = set(payload.assignments) - set(collaborators)
    unknown_routes = {route_id for route_id in payload.assignments.values() if route_id is not None and route_id not in routes}
    if unknown_people or unknown_routes:
        raise HTTPException(422, "A atribuição contém colaborador ou rota inexistente.")
    desired = {person_id: person["routeId"] for person_id, person in collaborators.items()}
    desired.update(payload.assignments)
    for route_id, route in routes.items():
        if sum(value == route_id for value in desired.values()) > route["capacity"]:
            raise HTTPException(422, f"A capacidade da rota '{route['name']}' seria excedida.")
    for person_id, route_id in payload.assignments.items():
        person = collaborators[person_id]
        if route_id == person["routeId"]:
            continue
        person["routeId"] = route_id
        if route_id is None:
            # Colaborador saiu de uma rota: não faz mais parte de nenhuma sequência de embarque.
            person["order"] = None
        else:
            # Colaborador novo (ou trocando de rota): entra no fim da sequência de embarque.
            existing_orders = [
                other["order"]
                for other in project["collaborators"]
                if other["routeId"] == route_id and other["order"] is not None and other["id"] != person_id
            ]
            person["order"] = (max(existing_orders) + 1) if existing_orders else 0
    save_project(project)
    return project_response(project)


class RoutePayload(BaseModel):
    capacity: int = 22
    name: str | None = None


class RouteUpdatePayload(BaseModel):
    capacity: int | None = None
    name: str | None = None


class RouteOrderPayload(BaseModel):
    # Lista com o id de todos os colaboradores da rota, na ordem de embarque desejada.
    order: list[int]


@app.post("/api/projects/{project_id}/routes")
def add_route(project_id: str, payload: RoutePayload):
    if payload.capacity < 1:
        raise HTTPException(422, "A capacidade deve ser maior que zero.")
    project = load_project(project_id)
    next_id = max([route["id"] for route in project["routes"]] or [0]) + 1
    name = (payload.name or f"ROTA_{next_id:02d}").strip()
    if not name:
        raise HTTPException(422, "O nome da rota não pode ficar vazio.")
    project["routes"].append({"id": next_id, "name": name[:100], "capacity": payload.capacity})
    save_project(project)
    return project_response(project)


@app.patch("/api/projects/{project_id}/routes/{route_id}")
def update_route(project_id: str, route_id: int, payload: RouteUpdatePayload):
    project = load_project(project_id)
    route = next((route for route in project["routes"] if route["id"] == route_id), None)
    if not route:
        raise HTTPException(404, "Rota não encontrada.")
    assigned = sum(person["routeId"] == route_id for person in project["collaborators"])
    if payload.capacity is not None:
        if payload.capacity < 1 or payload.capacity < assigned:
            raise HTTPException(422, f"A capacidade deve ser no mínimo {max(1, assigned)}.")
        route["capacity"] = payload.capacity
    if payload.name is not None:
        name = payload.name.strip()
        if not name:
            raise HTTPException(422, "O nome da rota não pode ficar vazio.")
        route["name"] = name[:100]
    save_project(project)
    return project_response(project)


@app.delete("/api/projects/{project_id}/routes/{route_id}")
def remove_route(project_id: str, route_id: int):
    project = load_project(project_id)
    route = next((route for route in project["routes"] if route["id"] == route_id), None)
    if not route:
        raise HTTPException(404, "Rota não encontrada.")
    if len(project["routes"]) <= 1:
        raise HTTPException(400, "Mantenha ao menos uma rota.")
    project["routes"] = [item for item in project["routes"] if item["id"] != route_id]
    for collaborator in project["collaborators"]:
        if collaborator["routeId"] == route_id:
            collaborator["routeId"] = None
            collaborator["order"] = None
    save_project(project)
    return project_response(project)


@app.put("/api/projects/{project_id}/routes/{route_id}/order")
def reorder_route(project_id: str, route_id: int, payload: RouteOrderPayload):
    """Define a ordem de embarque dos colaboradores de uma rota."""
    project = load_project(project_id)
    route = next((route for route in project["routes"] if route["id"] == route_id), None)
    if not route:
        raise HTTPException(404, "Rota não encontrada.")
    assigned = {c["id"]: c for c in project["collaborators"] if c["routeId"] == route_id}
    if set(payload.order) != set(assigned):
        raise HTTPException(422, "A lista de ordenação deve conter exatamente os colaboradores da rota, sem repetição.")
    for index, person_id in enumerate(payload.order):
        assigned[person_id]["order"] = index
    save_project(project)
    return project_response(project)


@app.post("/api/projects/{project_id}/routes/{route_id}/auto-order")
def auto_order_route(project_id: str, route_id: int, tipo: str = "Entrada"):
    """Ordena automaticamente a sequência de embarque de uma rota:
    começa pelo colaborador mais distante do destino e, a cada passo,
    avança para o colaborador não visitado mais próximo do atual
    (heurística do vizinho mais próximo), até esgotar a rota — a ideia é
    ir 'fechando' a distância até o destino, que é sempre a última parada."""
    if tipo not in TIPOS_ROTA:
        raise HTTPException(422, "tipo deve ser 'Entrada' ou 'Saída'.")
    project = load_project(project_id)
    route = next((route for route in project["routes"] if route["id"] == route_id), None)
    if not route:
        raise HTTPException(404, "Rota não encontrada.")
    rows = [c for c in project["collaborators"] if c["routeId"] == route_id]
    if not rows:
        return project_response(project)

    lat_key, lon_key = ("latE", "lonE") if tipo == "Entrada" else ("latS", "lonS")
    destino = project["destino"]
    ordered = _nearest_neighbor_order(rows, destino, lat_key, lon_key)

    for index, row in enumerate(ordered):
        row["order"] = index
    save_project(project)
    return project_response(project)


def ors_route(coords):
    """Retorna (coordenadas, usou_ors). Se a chave não estiver configurada, exceder o
    limite de waypoints, ou a chamada falhar, cai para uma linha reta entre os pontos."""
    key = os.getenv("ORS_API_KEY")
    if not key or len(coords) > MAX_WAYPOINTS:
        return coords, False
    try:
        client = openrouteservice.Client(key=key, timeout=15)
        response = client.directions(coordinates=coords, profile="driving-car", optimize_waypoints=True, format="geojson")
        return response["features"][0]["geometry"]["coordinates"], True
    except Exception:
        # A exportação continua possível, mas o trajeto será uma linha direta.
        return coords, False


@app.get("/api/projects/{project_id}/routes/{route_id}/preview")
def preview_route(project_id: str, route_id: int, tipo: str = "Entrada"):
    """Retorna o trajeto (linha real via ORS) e a sequência de embarque de uma rota,
    para exibição no mapa antes de baixar os KMLs."""
    if tipo not in TIPOS_ROTA:
        raise HTTPException(422, "tipo deve ser 'Entrada' ou 'Saída'.")
    project = load_project(project_id)
    route = next((route for route in project["routes"] if route["id"] == route_id), None)
    if not route:
        raise HTTPException(404, "Rota não encontrada.")
    rows = ordered_route_rows(project, route_id)
    if not rows:
        return {"waypoints": [], "coordinates": [], "usedOrs": False}
    lat_key, lon_key = ("latE", "lonE") if tipo == "Entrada" else ("latS", "lonS")
    coords = [[row[lon_key], row[lat_key]] for row in rows] + [[project["destino"]["lon"], project["destino"]["lat"]]]
    route_coords, used_ors = ors_route(coords)
    waypoints = [
        {"id": row["id"], "nome": row["nome"], "lat": row[lat_key], "lon": row[lon_key], "order": index + 1}
        for index, row in enumerate(rows)
    ]
    return {"waypoints": waypoints, "coordinates": route_coords, "usedOrs": used_ors}


def gerar_kml(nome_rota, tipo, rows, destino):
    lat_key, lon_key = ("latE", "lonE") if tipo == "Entrada" else ("latS", "lonS")
    coords = [[row[lon_key], row[lat_key]] for row in rows] + [[destino["lon"], destino["lat"]]]
    route_coords, _used_ors = ors_route(coords)
    kml = etree.Element("kml", xmlns="http://www.opengis.net/kml/2.2")
    document = etree.SubElement(kml, "Document")
    etree.SubElement(document, "name").text = f"{nome_rota} ({tipo})"
    for row in rows:
        placemark = etree.SubElement(document, "Placemark")
        etree.SubElement(placemark, "name").text = row["nome"]
        point = etree.SubElement(placemark, "Point")
        etree.SubElement(point, "coordinates").text = f"{row[lon_key]},{row[lat_key]},0"
    line = etree.SubElement(document, "Placemark")
    etree.SubElement(line, "name").text = f"Trajeto {nome_rota} ({tipo})"
    line_string = etree.SubElement(line, "LineString")
    etree.SubElement(line_string, "tessellate").text = "1"
    etree.SubElement(line_string, "coordinates").text = " ".join(f"{lon},{lat},0" for lon, lat in route_coords)
    output = io.BytesIO()
    etree.ElementTree(kml).write(output, pretty_print=True, xml_declaration=True, encoding="UTF-8")
    return output.getvalue()


@app.get("/api/projects/{project_id}/download")
def download(project_id: str):
    project = load_project(project_id)
    archive = io.BytesIO()
    report_rows = []
    with zipfile.ZipFile(archive, "w", compression=zipfile.ZIP_DEFLATED) as zipped:
        for route in project["routes"]:
            # Respeita a ordem de embarque definida pelo usuário no editor.
            rows = ordered_route_rows(project, route["id"])
            if not rows:
                continue
            route_filename = safe_filename(route["name"])
            for tipo in TIPOS_ROTA:
                zipped.writestr(f"{route_filename}_{safe_filename(tipo).lower()}.kml", gerar_kml(route["name"], tipo, rows, project["destino"]))
            report_rows.extend({"ROTA": route["name"], "ORDEM": index + 1, "COLABORADOR": row["nome"], "BAIRRO": row["bairro"], "LAT E": row["latE"], "LONG E": row["lonE"], "LAT S": row["latS"], "LONG S": row["lonS"]} for index, row in enumerate(rows))
        spreadsheet = io.BytesIO()
        pd.DataFrame(report_rows).to_excel(spreadsheet, index=False)
        zipped.writestr("relatorio_rotas.xlsx", spreadsheet.getvalue())
    archive.seek(0)
    return StreamingResponse(archive, media_type="application/zip", headers={"Content-Disposition": 'attachment; filename="rotas_kml_relatorio.zip"'})
