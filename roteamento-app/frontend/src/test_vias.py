"""Testes dos pontos de passagem (vias) do trajeto. Dados SINTÉTICOS, sem ORS
(trajeto em linha reta, determinístico) e sem Supabase."""
import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "app"))
os.environ.pop("APP_ACCESS_TOKEN", None)
os.environ.pop("ORS_API_KEY", None)
os.environ["APP_DATA_DIR"] = "/tmp/rota_vias_test"

from fastapi.testclient import TestClient
from lxml import etree

import main as m
import route_optimizer as ro
import storage

storage.init()
ok_count = 0


def ok(cond, nome):
    global ok_count
    assert cond, f"FALHA: {nome}"
    ok_count += 1
    print(f"OK: {nome}")


# ------------------------------------------------------------------ 1) inserir_vias (função pura)
# sequência de visita [lon, lat]: A -> B -> C -> destino, ao longo de uma linha leste-oeste
A, B, C, D = [-60.10, -3.00], [-60.08, -3.00], [-60.06, -3.00], [-60.00, -3.00]
seq = [A, B, C, D]
via_bc = {"lat": -3.004, "lon": -60.070}   # entre B e C, fora da linha
via_cd = {"lat": -3.004, "lon": -60.030}   # entre C e destino

r = ro.inserir_vias(seq, [via_bc])
ok(r == [A, B, [-60.070, -3.004], C, D], "via entre B e C entra exatamente nesse segmento")
r = ro.inserir_vias(seq, [via_cd, via_bc])
ok(r == [A, B, [-60.070, -3.004], C, [-60.030, -3.004], D], "duas vias em segmentos diferentes ficam na ordem da rota")
v1, v2 = {"lat": -3.003, "lon": -60.075}, {"lat": -3.003, "lon": -60.065}
ok(ro.inserir_vias(seq, [v2, v1]) == [A, B, [-60.075, -3.003], [-60.065, -3.003], C, D], "vias no mesmo segmento seguem a ordem ao longo dele")
ok(ro.inserir_vias(seq, []) == seq and ro.inserir_vias(seq, None) == seq, "sem vias devolve a mesma sequência")
orig = [list(c) for c in seq]
ro.inserir_vias(seq, [via_bc])
ok(seq == orig, "não altera a lista recebida")
ok(ro.inserir_vias([A], [via_bc]) == [A], "com menos de 2 pontos não há segmento: nada a inserir")
# a mesma via continua válida se a ordem das paradas mudar (reatribuída ao segmento mais próximo)
seq2 = [A, C, B, D]
r2 = ro.inserir_vias(seq2, [via_bc])
ok(len(r2) == 5 and [-60.070, -3.004] in r2, "a via sobrevive à reordenação das paradas")
ok(len(ro.vias_aplicaveis([1] * 30, 10)) == 20 and len(ro.vias_aplicaveis([1] * 5, 47)) == 1 and ro.vias_aplicaveis([1], 48) == [], "limite de vias respeita MAX_VIAS e o limite de waypoints")

# ------------------------------------------------------------------ 2) projeto de teste
DEST = {"lat": -3.1000, "lon": -60.0000}


def salvar(pid, n_paradas=3, vias=None):
    colabs = []
    for i in range(1, n_paradas + 1):
        lat, lon = -3.00 - i * 0.001, -60.10 + i * 0.001
        colabs.append({"id": i, "nome": f"C{i}", "bairro": "B", "zona": None, "latE": lat, "lonE": lon, "latS": lat, "lonS": lon,
                       "lat": lat, "lon": lon, "distKm": 1.0, "bearing": 10.0, "routeId": 1, "order": i - 1})
    rota = {"id": 1, "name": "ROTA 01", "capacity": 60}
    if vias is not None:
        rota["vias"] = vias
    storage.save_project({"id": pid, "destino": DEST, "tipoRota": "Entrada", "modo": "manual", "routes": [rota], "collaborators": colabs})


client = TestClient(m.app)
VIA = {"lat": -3.0, "lon": -60.5}  # bem fora do eixo (desvio grande)

# ------------------------------------------------------------------ 3) endpoint PUT /vias
salvar("a")
r = client.put("/api/projects/a/routes/1/vias", json={"vias": [VIA]})
ok(r.status_code == 200 and r.json()["viasSuportadas"] is True, "PUT /vias responde 200 e o projeto avisa viasSuportadas")
ok(r.json()["routes"][0]["vias"] == [{"lat": -3.0, "lon": -60.5}], "a via fica guardada na rota")
ok(storage.load_project("a")["routes"][0]["vias"] == [{"lat": -3.0, "lon": -60.5}], "e persiste no armazenamento")
ok(client.put("/api/projects/a/routes/1/vias", json={"vias": []}).json()["routes"][0]["vias"] == [], "lista vazia remove todas as vias")
ok(client.put("/api/projects/a/routes/9/vias", json={"vias": []}).status_code == 404, "rota inexistente: 404")
ok(client.put("/api/projects/a/routes/1/vias", json={"vias": [{"lat": 95, "lon": -60}]}).status_code == 422, "latitude fora da faixa: 422")
ok(client.put("/api/projects/a/routes/1/vias", json={"vias": [{"lat": -3, "lon": -200}]}).status_code == 422, "longitude fora da faixa: 422")
ok(client.put("/api/projects/a/routes/1/vias", json={"vias": [{"lat": "x", "lon": 1}]}).status_code == 422, "valor não numérico: 422")
salvar("b", n_paradas=46)   # 46 paradas + destino = 47 pontos => cabe só 1 via
resp = client.put("/api/projects/b/routes/1/vias", json={"vias": [VIA, {"lat": -3.1, "lon": -60.4}]})
ok(resp.status_code == 422 and "no máximo 1 ponto" in resp.json()["detail"], "acima do limite de waypoints do ORS: 422 com mensagem clara")
ok(client.put("/api/projects/b/routes/1/vias", json={"vias": [VIA]}).status_code == 200, "dentro do limite: aceita")
salvar("c")
many = [{"lat": -3.0 - i * 0.001, "lon": -60.2} for i in range(21)]
ok(client.put("/api/projects/c/routes/1/vias", json={"vias": many}).status_code == 422, "mais de 20 vias: 422")

# ------------------------------------------------------------------ 4) preview usa as vias
salvar("d")
sem = client.get("/api/projects/d/routes/1/preview?tipo=Entrada").json()
ok(sem["vias"] == [] and sem["maxVias"] > 0 and len(sem["coordinates"]) == 4, "sem vias: trajeto direto (3 paradas + destino) e maxVias informado")
client.put("/api/projects/d/routes/1/vias", json={"vias": [VIA]})
com = client.get("/api/projects/d/routes/1/preview?tipo=Entrada").json()
ok(len(com["coordinates"]) == 5 and [-60.5, -3.0] in com["coordinates"], "com via: a linha passa pelo ponto de passagem")
ok(com["coordinates"].index([-60.5, -3.0]) in (1, 2, 3), "e ele fica entre as paradas, não no começo nem no fim")
ok(com["distanciaKm"] > sem["distanciaKm"] * 1.5 and com["duracaoMin"] > sem["duracaoMin"], "distância e tempo do preview refletem o desvio")
ok([w["id"] for w in com["waypoints"]] == [1, 2, 3], "as paradas (waypoints) não mudam: via não é passageiro")
salvar("e")   # rota SEM a chave "vias" (projeto antigo)
ok(client.get("/api/projects/e/routes/1/preview?tipo=Entrada").json()["vias"] == [], "projeto antigo, sem a chave 'vias', continua funcionando")
client.put("/api/projects/d/routes/1/order", json={"order": [3, 2, 1]})
ok(storage.load_project("d")["routes"][0]["vias"] == [{"lat": -3.0, "lon": -60.5}], "reordenar não apaga as vias")

# ------------------------------------------------------------------ 5) KML e relatório
NS = {"k": "http://www.opengis.net/kml/2.2"}


def ler(z, nome):
    root = etree.fromstring(z.read(nome))
    pts = [p.text for p in root.iterfind(".//k:Point/k:coordinates", NS)]
    linha = [tuple(float(x) for x in t.split(",")[:2]) for t in root.find(".//k:LineString/k:coordinates", NS).text.split()]
    return pts, linha


z = zipfile.ZipFile(io.BytesIO(client.get("/api/projects/d/download").content))
pe, le = ler(z, "ROTA_01_entrada.kml")
ps, ls = ler(z, "ROTA_01_saida.kml")
ok(len(pe) == 3 and len(ps) == 3, "o KML continua com 3 pontos (as paradas): a via NÃO vira Placemark")
ok((-60.5, -3.0) in le and (-60.5, -3.0) in ls, "a linha do trajeto (entrada e saída) passa pela via")
ok(le[-1] == (-60.0, -3.1) and ls[0] == (-60.0, -3.1), "entrada termina e saída parte do destino, como antes")
ok(le.index((-60.5, -3.0)) < len(le) - 1 and ls.index((-60.5, -3.0)) > 0, "a via fica no meio do percurso nas duas direções")
# sem vias o KML é idêntico ao anterior (regressão)
rows = m.ordered_route_rows(storage.load_project("e"), 1)
ok(m.gerar_kml("R", "Entrada", rows, DEST) == m.gerar_kml("R", "Entrada", rows, DEST, None) == m.gerar_kml("R", "Entrada", rows, DEST, []), "sem vias o KML é idêntico ao de antes")

print(f"\nTODOS OS TESTES PASSARAM ({ok_count})")
