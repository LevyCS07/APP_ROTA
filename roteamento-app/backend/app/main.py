import io
import json
import math
import os
import uuid
import zipfile
from pathlib import Path

import numpy as np
import openrouteservice
import pandas as pd
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from lxml import etree
from pydantic import BaseModel
from shapely.geometry import Point, shape
from sklearn.cluster import KMeans
from sklearn.preprocessing import StandardScaler

TAXA_MINIMA = 0.60
MAX_WAYPOINTS = 48
CAMPO_NOME_BAIRRO = "Name"

app = FastAPI(title="Roteamento API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=os.getenv("CORS_ORIGINS", "*").split(","),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

PROJECTS = {}
BAIRROS_CACHE = None


def haversine(lat1, lon1, lat2, lon2):
    r = 6371
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def geojson_path():
    candidates = [
        os.getenv("BAIRROS_GEOJSON_PATH"),
        Path(__file__).parent / "data" / "BAIRROS_MANAUS.geojson",
        Path.cwd() / "BAIRROS_MANAUS.geojson",
        Path(r"C:\Users\Levy Souza\Desktop\APOIO\BAIRROS_MANAUS.geojson"),
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return Path(candidate)
    raise HTTPException(500, "BAIRROS_MANAUS.geojson não encontrado. Configure BAIRROS_GEOJSON_PATH.")


def carregar_bairros():
    global BAIRROS_CACHE
    if BAIRROS_CACHE is not None:
        return BAIRROS_CACHE
    with geojson_path().open("r", encoding="utf-8-sig") as f:
        geojson = json.load(f)
    bairros = []
    for feat in geojson.get("features", []):
        props = feat.get("properties", {})
        nome = str(props.get(CAMPO_NOME_BAIRRO) or props.get("NOME") or props.get("BAIRRO") or f"B{len(bairros)}")
        geom = shape(feat["geometry"])
        centroid = geom.centroid
        bairros.append(
            {
                "idx": len(bairros),
                "nome": nome,
                "geometry": geom,
                "centroid_lat": centroid.y,
                "centroid_lon": centroid.x,
            }
        )
    BAIRROS_CACHE = bairros
    return bairros


def atribuir_bairro(lat, lon, bairros):
    pt = Point(lon, lat)
    for bairro in bairros:
        if bairro["geometry"].contains(pt):
            return bairro["idx"], bairro["nome"]
    melhor = min(bairros, key=lambda b: haversine(lat, lon, b["centroid_lat"], b["centroid_lon"]))
    return melhor["idx"], melhor["nome"]


def colunas_tipo(tipo):
    return ("LAT E", "LONG E") if tipo == "Entrada" else ("LAT S", "LONG S")


def read_excel(file_bytes):
    df = pd.read_excel(io.BytesIO(file_bytes), sheet_name="BD")
    required = ["COLABORADOR", "LAT E", "LONG E", "LAT S", "LONG S"]
    missing = [col for col in required if col not in df.columns]
    if missing:
        raise HTTPException(400, f"Colunas ausentes: {', '.join(missing)}")
    for col in ["LAT E", "LONG E", "LAT S", "LONG S"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    return df.dropna(subset=["LAT E", "LONG E", "LAT S", "LONG S"]).reset_index(drop=True)


def build_collaborators(df, tipo_rota, destino):
    bairros = carregar_bairros()
    lat_col, lon_col = colunas_tipo(tipo_rota)
    collaborators = []
    for idx, row in df.iterrows():
        lat, lon = float(row[lat_col]), float(row[lon_col])
        bairro_idx, bairro_nome = atribuir_bairro(lat, lon, bairros)
        collaborators.append(
            {
                "id": int(idx),
                "nome": str(row["COLABORADOR"]),
                "bairro_idx": int(bairro_idx),
                "bairro": bairro_nome,
                "latE": float(row["LAT E"]),
                "lonE": float(row["LONG E"]),
                "latS": float(row["LAT S"]),
                "lonS": float(row["LONG S"]),
                "lat": lat,
                "lon": lon,
                "distKm": round(haversine(lat, lon, destino["lat"], destino["lon"]), 3),
                "routeId": None,
            }
        )
    return collaborators


def auto_assign(collaborators, capacidades):
    if not collaborators or not capacidades:
        return
    n_routes = min(len(capacidades), len(collaborators))
    coords = np.array([[c["lat"], c["lon"]] for c in collaborators])
    if n_routes > 1:
        labels = KMeans(n_clusters=n_routes, random_state=42, n_init=10).fit_predict(
            StandardScaler().fit_transform(coords)
        )
    else:
        labels = np.zeros(len(collaborators), dtype=int)
    used = {i + 1: 0 for i in range(len(capacidades))}
    for cluster in range(n_routes):
        items = [c for c, label in zip(collaborators, labels) if label == cluster]
        items.sort(key=lambda c: c["distKm"], reverse=True)
        route_id = cluster + 1
        cap = capacidades[cluster]
        for item in items:
            if used[route_id] < cap:
                item["routeId"] = route_id
                used[route_id] += 1


def project_response(project):
    return {
        "id": project["id"],
        "destino": project["destino"],
        "tipoRota": project["tipoRota"],
        "routes": project["routes"],
        "collaborators": project["collaborators"],
    }


@app.get("/api/health")
def health():
    return {"ok": True}


@app.post("/api/projects")
async def create_project(
    file: UploadFile = File(...),
    destino_lat: float = Form(...),
    destino_lon: float = Form(...),
    tipo_rota: str = Form("Entrada"),
    modo: str = Form("Manual"),
    capacidades: str = Form("[22]"),
):
    caps = [int(c) for c in json.loads(capacidades)]
    if not caps:
        raise HTTPException(400, "Informe ao menos uma rota.")
    df = read_excel(await file.read())
    destino = {"lat": float(destino_lat), "lon": float(destino_lon)}
    collaborators = build_collaborators(df, tipo_rota, destino)
    routes = [
        {"id": i + 1, "name": f"ROTA_{i + 1:02d}", "capacity": cap}
        for i, cap in enumerate(caps)
    ]
    if modo == "Automática":
        auto_assign(collaborators, caps)
    project_id = str(uuid.uuid4())
    PROJECTS[project_id] = {
        "id": project_id,
        "destino": destino,
        "tipoRota": tipo_rota,
        "routes": routes,
        "collaborators": collaborators,
    }
    return project_response(PROJECTS[project_id])


class AssignmentPayload(BaseModel):
    assignments: dict[int, int | None]


@app.put("/api/projects/{project_id}/assignments")
def update_assignments(project_id: str, payload: AssignmentPayload):
    project = PROJECTS.get(project_id)
    if not project:
        raise HTTPException(404, "Projeto não encontrado.")
    valid_routes = {route["id"] for route in project["routes"]}
    for collaborator in project["collaborators"]:
        if collaborator["id"] in payload.assignments:
            route_id = payload.assignments[collaborator["id"]]
            collaborator["routeId"] = route_id if route_id in valid_routes else None
    return project_response(project)


class RoutePayload(BaseModel):
    capacity: int = 22
    name: str | None = None


@app.post("/api/projects/{project_id}/routes")
def add_route(project_id: str, payload: RoutePayload):
    project = PROJECTS.get(project_id)
    if not project:
        raise HTTPException(404, "Projeto não encontrado.")
    next_id = max([route["id"] for route in project["routes"]] or [0]) + 1
    project["routes"].append(
        {"id": next_id, "name": payload.name or f"ROTA_{next_id:02d}", "capacity": int(payload.capacity)}
    )
    return project_response(project)


@app.delete("/api/projects/{project_id}/routes/{route_id}")
def remove_route(project_id: str, route_id: int):
    project = PROJECTS.get(project_id)
    if not project:
        raise HTTPException(404, "Projeto não encontrado.")
    if len(project["routes"]) <= 1:
        raise HTTPException(400, "Mantenha ao menos uma rota.")
    project["routes"] = [route for route in project["routes"] if route["id"] != route_id]
    for collaborator in project["collaborators"]:
        if collaborator["routeId"] == route_id:
            collaborator["routeId"] = None
    return project_response(project)


def ors_route(coords):
    key = os.getenv("ORS_API_KEY")
    if not key or len(coords) > MAX_WAYPOINTS:
        return coords
    try:
        client = openrouteservice.Client(key=key)
        res = client.directions(coordinates=coords, profile="driving-car", optimize_waypoints=True, format="geojson")
        return res["features"][0]["geometry"]["coordinates"]
    except Exception:
        return coords


def gerar_kml(nome_rota, tipo, rows, destino):
    col_lat, col_lon = ("latE", "lonE") if tipo == "Entrada" else ("latS", "lonS")
    coords = [[row[col_lon], row[col_lat]] for row in rows] + [[destino["lon"], destino["lat"]]]
    route_coords = ors_route(coords)

    kml_root = etree.Element("kml", xmlns="http://www.opengis.net/kml/2.2")
    doc = etree.SubElement(kml_root, "Document")
    etree.SubElement(doc, "name").text = f"{nome_rota} ({tipo})"
    for row in rows:
        pm = etree.SubElement(doc, "Placemark")
        etree.SubElement(pm, "name").text = row["nome"]
        pt = etree.SubElement(pm, "Point")
        etree.SubElement(pt, "coordinates").text = f"{row[col_lon]},{row[col_lat]},0"
    line = etree.SubElement(doc, "Placemark")
    etree.SubElement(line, "name").text = f"Trajeto {nome_rota} ({tipo})"
    ls = etree.SubElement(line, "LineString")
    etree.SubElement(ls, "tessellate").text = "1"
    etree.SubElement(ls, "coordinates").text = " ".join([f"{lon},{lat},0" for lon, lat in route_coords])
    buf = io.BytesIO()
    etree.ElementTree(kml_root).write(buf, pretty_print=True, xml_declaration=True, encoding="UTF-8")
    return buf.getvalue()


@app.get("/api/projects/{project_id}/download")
def download(project_id: str):
    project = PROJECTS.get(project_id)
    if not project:
        raise HTTPException(404, "Projeto não encontrado.")
    zip_buffer = io.BytesIO()
    report_rows = []
    with zipfile.ZipFile(zip_buffer, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for route in project["routes"]:
            rows = [c for c in project["collaborators"] if c["routeId"] == route["id"]]
            if not rows:
                continue
            for tipo in ["Entrada", "Saída"]:
                zf.writestr(f'{route["name"]}_{tipo.lower()}.kml', gerar_kml(route["name"], tipo, rows, project["destino"]))
            for row in rows:
                report_rows.append(
                    {
                        "ROTA": route["name"],
                        "COLABORADOR": row["nome"],
                        "BAIRRO": row["bairro"],
                        "LAT E": row["latE"],
                        "LONG E": row["lonE"],
                        "LAT S": row["latS"],
                        "LONG S": row["lonS"],
                    }
                )
        xlsx = io.BytesIO()
        pd.DataFrame(report_rows).to_excel(xlsx, index=False)
        zf.writestr("relatorio_rotas.xlsx", xlsx.getvalue())
    zip_buffer.seek(0)
    return StreamingResponse(
        zip_buffer,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="rotas_kml_relatorio.zip"'},
    )
