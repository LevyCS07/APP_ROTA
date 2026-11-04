"""Importação de rotas JÁ EXISTENTES (KML) para alimentar a base de conhecimento.

Cada arquivo KML é UMA rota: um ponto por colaborador (na ordem de embarque),
o ponto do destino (primeiro ou último, conforme Entrada/Saída) e, opcionalmente,
uma linha com o trajeto. Os arquivos de um mesmo dia/turno/destino formam UM
cenário — o ML aprende comparando "mesma rota" com "rota diferente", então um
cenário precisa ter todas as rotas do dia (nunca uma rota isolada).

Privacidade: só as COORDENADAS são lidas. Nomes (`<name>`, descrições, dados
estendidos) são ignorados e nunca saem deste módulo.

Segurança: o XML é lido com resolução de entidades e acesso à rede desligados
(contra XXE / billion laughs), com limite de tamanho e de quantidade de arquivos.
"""

import hashlib
import math
import re

from lxml import etree

MAX_FILES = 30
MAX_FILE_BYTES = 5 * 1024 * 1024
SNAP_M = 30.0            # tolerância para casar um ponto com a ponta do trajeto
DESTINO_TOL_KM = 0.3     # destinos de rotas do mesmo lote devem coincidir até aqui
AMBIGUITY_MIN_KM = 3.0   # distância mínima para sugerir Entrada/Saída pela geometria


# ---------------------------------------------------------------------------
# Geometria
# ---------------------------------------------------------------------------

def _hav_km(a, b):
    """a, b = (lat, lon)."""
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dphi = p2 - p1
    dl = math.radians(b[1] - a[1])
    h = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 12742.0 * math.asin(math.sqrt(h))


def _bearing(origem, alvo):
    p1, p2 = math.radians(origem[0]), math.radians(alvo[0])
    dl = math.radians(alvo[1] - origem[1])
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _line_km(linha):
    return sum(_hav_km(linha[i], linha[i + 1]) for i in range(len(linha) - 1))


# ---------------------------------------------------------------------------
# Leitura do KML
# ---------------------------------------------------------------------------

def _local(el):
    return etree.QName(el).localname if isinstance(el.tag, str) else ""


def _parse_coord_triplet(text):
    """'lon,lat[,alt]' -> (lat, lon) ou None se inválido/fora de faixa."""
    parts = text.strip().split(",")
    if len(parts) < 2:
        return None
    try:
        lon, lat = float(parts[0]), float(parts[1])
    except ValueError:
        return None
    if not (math.isfinite(lat) and math.isfinite(lon)) or not (-90 <= lat <= 90 and -180 <= lon <= 180):
        return None
    return (lat, lon)


def _coords_of(element):
    """Todas as coordenadas (lat, lon) de um elemento <coordinates>."""
    out = []
    for token in (element.text or "").split():
        c = _parse_coord_triplet(token)
        if c:
            out.append(c)
    return out


def parse_kml(content, filename):
    """Lê UM arquivo KML e devolve os dados brutos (sem decidir o destino):

      {"nome", "pontos": [(lat, lon)...], "linha": [(lat, lon)...],
       "distanciaKm", "direcaoSugerida", "avisos"}

    Lança ValueError (mensagem em pt-BR) se o arquivo for inválido ou vazio."""
    parser = etree.XMLParser(resolve_entities=False, no_network=True, load_dtd=False, huge_tree=False)
    try:
        root = etree.fromstring(content, parser)
    except etree.XMLSyntaxError as exc:
        raise ValueError(f"{filename}: não é um KML/XML válido ({str(exc)[:80]}).")
    if root is None or _local(root).lower() != "kml":
        raise ValueError(f"{filename}: o arquivo não é um KML (raiz <kml> não encontrada).")

    pontos, linhas, avisos = [], [], []
    for el in root.iter():
        if _local(el) != "Placemark":
            continue
        for child in el.iter():
            name = _local(child)
            if name == "Point":
                coord = next((c for c in child.iter() if _local(c) == "coordinates"), None)
                found = _coords_of(coord) if coord is not None else []
                if found:
                    pontos.append(found[0])
            elif name == "LineString":
                coord = next((c for c in child.iter() if _local(c) == "coordinates"), None)
                found = _coords_of(coord) if coord is not None else []
                if len(found) >= 2:
                    linhas.append(found)

    if not pontos:
        raise ValueError(f"{filename}: nenhum ponto (Placemark/Point) encontrado.")
    linha = []
    if linhas:
        linha = max(linhas, key=len)
        if len(linhas) > 1:
            avisos.append(f"{filename}: há {len(linhas)} trajetos; usei o mais detalhado.")

    nome = re.sub(r"\.kml$", "", filename.rsplit("/", 1)[-1], flags=re.IGNORECASE).strip()[:60] or "ROTA"
    return {
        "nome": nome,
        "pontos": pontos,
        "linha": linha,
        "distanciaKm": round(_line_km(linha), 2) if linha else None,
        "direcaoSugerida": _sugerir_direcao(pontos),
        "avisos": avisos,
    }


def _sugerir_direcao(pontos):
    """O destino é o ponto-ponta que fica MUITO longe do agrupamento dos demais
    (a geometria sozinha não distingue: nas duas direções as duas pontas casam
    com pontos). Retorna 'Entrada' (destino = último ponto), 'Saída' (destino
    = primeiro) ou None quando não há como afirmar."""
    if len(pontos) < 4:
        return None
    meio = pontos[1:-1]
    centro = (sum(p[0] for p in meio) / len(meio), sum(p[1] for p in meio) / len(meio))
    d_primeiro, d_ultimo = _hav_km(pontos[0], centro), _hav_km(pontos[-1], centro)
    if d_ultimo > AMBIGUITY_MIN_KM and d_ultimo > 3 * max(d_primeiro, 0.5):
        return "Entrada"
    if d_primeiro > AMBIGUITY_MIN_KM and d_primeiro > 3 * max(d_ultimo, 0.5):
        return "Saída"
    return None


# ---------------------------------------------------------------------------
# Resolução do destino conforme Entrada/Saída
# ---------------------------------------------------------------------------

def resolver_rota(parsed, tipo_rota):
    """Define destino e passageiros de uma rota conforme `tipo_rota`:
    Entrada = o destino é o ÚLTIMO ponto (embarques ... destino);
    Saída   = o destino é o PRIMEIRO ponto (destino ... desembarques).
    Retorna {"nome","passageiros":[(lat,lon)...],"destino":(lat,lon),
             "distanciaKm","avisos"}."""
    pontos, linha, avisos = parsed["pontos"], parsed["linha"], list(parsed["avisos"])
    nome = parsed["nome"]
    entrada = tipo_rota == "Entrada"

    sugerida = parsed["direcaoSugerida"]
    if sugerida and sugerida != tipo_rota:
        avisos.append(f"{nome}: pela geometria parece uma rota de {sugerida}, mas você escolheu {tipo_rota}. Confira.")

    extremo = pontos[-1] if entrada else pontos[0]
    if linha:
        ponta_linha = linha[-1] if entrada else linha[0]
        if _hav_km(extremo, ponta_linha) * 1000 > SNAP_M:
            # O destino não está marcado como ponto: usa a ponta do trajeto.
            avisos.append(f"{nome}: o destino não está marcado como ponto; usei a ponta do trajeto.")
            destino, passageiros = ponta_linha, list(pontos)
        else:
            destino = extremo
            passageiros = pontos[:-1] if entrada else pontos[1:]
    else:
        avisos.append(f"{nome}: sem trajeto no arquivo; assumi o {'último' if entrada else 'primeiro'} ponto como destino.")
        destino = extremo
        passageiros = pontos[:-1] if entrada else pontos[1:]

    if not passageiros:
        raise ValueError(f"{nome}: nenhum passageiro (só o ponto de destino).")
    return {"nome": nome, "passageiros": passageiros, "destino": destino, "distanciaKm": parsed["distanciaKm"], "avisos": avisos}


# ---------------------------------------------------------------------------
# Montagem do cenário
# ---------------------------------------------------------------------------

def scenario_id(tipo_rota, destino, rotas):
    """Identificador determinístico: reimportar o mesmo conjunto de rotas
    atualiza o cenário em vez de duplicá-lo. Independe da ordem dos arquivos
    e da ordem dos pontos dentro de cada rota (mas respeita a partição)."""
    partes = sorted("|".join(sorted(f"{lat:.5f},{lon:.5f}" for lat, lon in r["passageiros"])) for r in rotas)
    base = f"{tipo_rota}#{destino[0]:.4f},{destino[1]:.4f}#" + "#".join(partes)
    return "import-" + hashlib.sha1(base.encode("utf-8")).hexdigest()[:16]


def montar_projeto(rotas, tipo_rota, capacidades, bairro_fn=None):
    """Constrói um dict no formato de `project` que `knowledge_base.save_scenario`
    e `learn_from_scenario` já entendem — sem nomes (colaboradores anônimos).

    rotas: lista de `resolver_rota`; capacidades: lista de int alinhada às rotas;
    bairro_fn: callable (lat, lon) -> nome do bairro ou None."""
    destino = rotas[0]["destino"]
    colaboradores, rotas_proj, avisos = [], [], []
    cid = 0
    for index, (rota, cap) in enumerate(zip(rotas, capacidades), start=1):
        if _hav_km(rota["destino"], destino) > DESTINO_TOL_KM:
            avisos.append(f"{rota['nome']}: destino a {_hav_km(rota['destino'], destino):.1f} km do destino da primeira rota. Todas as rotas deveriam ir ao mesmo local.")
        rotas_proj.append({"id": index, "name": rota["nome"], "capacity": int(cap),
                           "distanciaKm": rota["distanciaKm"], "duracaoMin": None, "dispersaoGraus": None})
        for order, (lat, lon) in enumerate(rota["passageiros"]):
            cid += 1
            bairro = None
            if bairro_fn:
                try:
                    bairro = bairro_fn(lat, lon)
                except Exception:
                    bairro = None
            colaboradores.append({
                "id": cid, "nome": "",               # anônimo: nunca há nomes aqui
                "bairro": bairro, "zona": None,
                "latE": lat, "lonE": lon, "latS": lat, "lonS": lon,   # só há as coordenadas da rota
                "lat": lat, "lon": lon,
                "distKm": round(_hav_km((lat, lon), destino), 3),
                "bearing": round(_bearing(destino, (lat, lon)), 2),
                "routeId": index, "order": order,
            })
    projeto = {
        "id": scenario_id(tipo_rota, destino, rotas),
        "destino": {"lat": round(destino[0], 6), "lon": round(destino[1], 6)},
        "tipoRota": tipo_rota,
        "modo": "manual",
        "routes": rotas_proj,
        "collaborators": colaboradores,
    }
    return projeto, avisos
