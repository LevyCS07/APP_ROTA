"""Camada de conhecimento operacional do APP_ROTA (o "Cérebro").

Responsabilidades:
  - Persistir cenários/rotas/pontos no Supabase, SEM NENHUM dado pessoal —
    nunca nome, nunca id de colaborador, apenas coordenadas, bairro,
    contagens e métricas agregadas (ver `_anonymize_route`).
  - Buscar cenários históricos semelhantes a um novo contexto de geração
    (`find_similar_scenarios`).
  - Extrair "pistas" — conexões fortes / penalizações entre pontos
    geograficamente próximos aos do upload atual (`fetch_hints`) — para
    ORIENTAR o algoritmo de otimização sem ditar regras rígidas.
  - Registrar feedback: comparar a sugestão automática original com o que o
    usuário efetivamente exportou, classificar o cenário e atualizar as
    correlações de pontos (`register_feedback`).

Este módulo é OPCIONAL e best-effort por design: se as variáveis de
ambiente SUPABASE_URL/SUPABASE_KEY não estiverem definidas, ou qualquer
chamada falhar (rede, permissão, etc.), todas as funções aqui degradam
graciosamente — retornam None/[]/False — e NUNCA lançam uma exceção que
interrompa a geração ou exportação de rotas. A geração automática de rotas
funciona normalmente (só que sem o benefício do histórico) mesmo se o
Supabase estiver fora do ar ou nunca tiver sido configurado.
"""

import logging
import math
import os
from collections import Counter
from datetime import datetime, timezone

logger = logging.getLogger("knowledge_base")

_client = None
_client_checked = False

# Tolerância de arredondamento usada como "identidade" de um ponto entre
# diferentes uploads (mesmo endereço, GPS com pequena variação). 4 casas
# decimais ~ 11 metros.
POINT_PRECISION = 4

CARDINAIS = ["N", "NE", "L", "SE", "S", "SO", "O", "NO"]


def _round_point(lat, lon):
    return (round(lat, POINT_PRECISION), round(lon, POINT_PRECISION))


def _cardinal(bearing_deg):
    index = round((bearing_deg % 360) / 45) % 8
    return CARDINAIS[index]


def is_enabled():
    return _get_client() is not None


def _get_client():
    """Cria (uma vez) e reaproveita o client do Supabase. Retorna None se as
    variáveis de ambiente não estiverem configuradas ou a lib/credenciais
    forem inválidas — nesse caso, todo o módulo vira no-op."""
    global _client, _client_checked
    if _client_checked:
        return _client
    _client_checked = True

    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")  # use a service_role key aqui, não a anon key
    if not url or not key:
        logger.info("Supabase não configurado (SUPABASE_URL/SUPABASE_KEY ausentes) — base de conhecimento desativada.")
        return None
    # Remove barra(s) no final: evita "Invalid path specified in request URL"
    # (PGRST125) quando a env var vem com uma barra sobrando por engano.
    url = url.rstrip("/")
    try:
        from supabase import create_client
        _client = create_client(url, key)
    except Exception:
        logger.exception("Falha ao criar client do Supabase — base de conhecimento desativada.")
        _client = None
    return _client


def _safe(fn, default=None):
    """Executa `fn` engolindo qualquer exceção (rede, permissão, schema
    desatualizado etc.) — a base de conhecimento nunca pode derrubar uma
    geração ou exportação de rotas."""
    try:
        return fn()
    except Exception:
        logger.exception("Chamada à base de conhecimento falhou; seguindo sem ela.")
        return default


# ---------------------------------------------------------------------------
# Anonimização + persistência de cenários (regras 2, 3, 4)
# ---------------------------------------------------------------------------

def _anonymize_route(route, collaborators, lat_key, lon_key):
    """Converte uma rota + seus colaboradores no formato anonimizado que vai
    para o banco: SEM nome, SEM id — só coordenadas, bairro e sequência."""
    members = sorted(
        [c for c in collaborators if c["routeId"] == route["id"]],
        key=lambda c: c["order"] if c["order"] is not None else 0,
    )
    bearings = [m["bearing"] for m in members]
    bearing_medio = None
    if bearings:
        import math
        x = sum(math.cos(math.radians(b)) for b in bearings) / len(bearings)
        y = sum(math.sin(math.radians(b)) for b in bearings) / len(bearings)
        bearing_medio = (math.degrees(math.atan2(y, x)) + 360) % 360

    bairros = Counter(m.get("bairro") for m in members if m.get("bairro"))
    regiao_predominante = bairros.most_common(1)[0][0] if bairros else None
    direcao_fluxo = f"{_cardinal(bearing_medio)} -> Destino" if bearing_medio is not None else None

    pontos = [
        {
            "latitude": m[lat_key],
            "longitude": m[lon_key],
            "bairro": m.get("bairro"),
            "ordem_sequencial": index + 1,
        }
        for index, m in enumerate(members)
    ]

    rota_row = {
        "ordem_rota": route["id"],
        "regiao_predominante": regiao_predominante,
        "direcao_fluxo": direcao_fluxo,
        "bearing_medio": bearing_medio,
        "dispersao_graus": route.get("dispersaoGraus"),
        "quantidade_passageiros": len(members),
        "distancia_km": route.get("distanciaKm"),
        "tempo_min": route.get("duracaoMin"),
        "ocupacao": (len(members) / route["capacity"]) if route.get("capacity") else None,
    }
    return rota_row, pontos


def save_scenario(project, tipo_origem, peso=1.0):
    """Persiste (upsert) um cenário completo — cenário + rotas + pontos —
    de forma anonimizada. `tipo_origem` deve ser um dos 4 status definidos
    (MANUAL_VALIDADA, AUTOMATICA_APROVADA, AUTOMATICA_AJUSTADA,
    AUTOMATICA_NAO_VALIDADA). Best-effort: nunca lança exceção."""
    client = _get_client()
    if not client:
        return None

    def _do():
        lat_key, lon_key = ("latE", "lonE") if project["tipoRota"] == "Entrada" else ("latS", "lonS")
        collaborators = project["collaborators"]
        routes_with_members = [r for r in project["routes"] if any(c["routeId"] == r["id"] for c in collaborators)]

        distancia_total = sum(r.get("distanciaKm") or 0 for r in routes_with_members)
        tempo_total = sum(r.get("duracaoMin") or 0 for r in routes_with_members)
        capacidade = routes_with_members[0]["capacity"] if routes_with_members else None

        cenario_row = {
            "app_project_id": project["id"],
            "destino_lat": project["destino"]["lat"],
            "destino_lon": project["destino"]["lon"],
            "capacidade_veiculo": capacidade,
            "total_colaboradores": sum(1 for c in collaborators if c["routeId"] is not None),
            "total_rotas": len(routes_with_members),
            "distancia_total_km": round(distancia_total, 2),
            "tempo_total_min": round(tempo_total, 1),
            "tipo_rota": project["tipoRota"],
            "tipo_origem": tipo_origem,
            "peso": peso,
            # Atualiza a cada (re)salvamento — a busca de cenários
            # semelhantes ordena por recência, e o default do banco só vale
            # na criação da linha, não nos upserts seguintes.
            "atualizado_em": datetime.now(timezone.utc).isoformat(),
        }
        cenario_resp = client.table("cenarios").upsert(cenario_row, on_conflict="app_project_id").execute()
        cenario_id = cenario_resp.data[0]["id"]

        # Como pode ser um re-registro (usuário baixou de novo após mais
        # ajustes), limpa rotas/pontos antigos desse cenário antes de reinserir.
        client.table("rotas").delete().eq("cenario_id", cenario_id).execute()

        for route in routes_with_members:
            rota_row, pontos = _anonymize_route(route, collaborators, lat_key, lon_key)
            rota_row["cenario_id"] = cenario_id
            rota_resp = client.table("rotas").insert(rota_row).execute()
            rota_id = rota_resp.data[0]["id"]
            for ponto in pontos:
                ponto["rota_id"] = rota_id
            if pontos:
                client.table("pontos_rota").insert(pontos).execute()

        return cenario_id

    return _safe(_do)


# ---------------------------------------------------------------------------
# Busca de cenários semelhantes (bloco 6.2 do fluxo)
# ---------------------------------------------------------------------------

def find_similar_scenarios(destino, capacidade, total_colaboradores, tipo_rota, limit=5):
    """1º/5º filtro da hierarquia: cenários com destino próximo (bounding
    box ~5km, refinado depois se necessário), capacidade parecida e volume
    de colaboradores na mesma ordem de grandeza. Sem PostGIS, o filtro
    geográfico aqui é uma caixa delimitadora simples — suficiente para um
    pré-filtro; não precisa ser exato."""
    client = _get_client()
    if not client:
        return []

    def _do():
        margin = 0.05  # ~5km em graus, grosseiro o suficiente para pré-filtro
        query = (
            client.table("cenarios")
            .select("*")
            .gte("destino_lat", destino["lat"] - margin)
            .lte("destino_lat", destino["lat"] + margin)
            .gte("destino_lon", destino["lon"] - margin)
            .lte("destino_lon", destino["lon"] + margin)
            .eq("tipo_rota", tipo_rota)
            .gt("peso", 0)
            .order("peso", desc=True)
            .order("atualizado_em", desc=True)
            .limit(limit * 4)  # pega mais e refina em memória
        )
        rows = query.execute().data or []

        def score(row):
            cap_diff = abs((row.get("capacidade_veiculo") or 0) - capacidade)
            vol_diff = abs((row.get("total_colaboradores") or 0) - total_colaboradores)
            return cap_diff + vol_diff * 0.5

        rows.sort(key=score)
        return rows[:limit]

    return _safe(_do, default=[])


# ---------------------------------------------------------------------------
# Extração de pistas (conexões fortes / penalizações) — bloco 5, filtro 4
# ---------------------------------------------------------------------------

class HistoricalHints:
    """Ajustes de custo derivados do histórico, aplicados durante a
    CONSTRUÇÃO/sequenciamento das rotas (Savings, Nearest Neighbor, 2-opt,
    relocate) — nunca nas métricas finais reportadas ao usuário, que
    continuam vindas de dados reais (ORS ou estimativa por linha reta)."""

    def __init__(self, conexoes=None, penalizacoes=None):
        self.conexoes = conexoes or {}      # frozenset({pontoA, pontoB}) -> ocorrencias
        self.penalizacoes = penalizacoes or {}

    def is_empty(self):
        return not self.conexoes and not self.penalizacoes

    def factor(self, lat1, lon1, lat2, lon2):
        """Multiplicador de custo (duração/distância) entre dois pontos.
        <1 aproxima (conexão forte), >1 afasta (penalização). Sempre
        limitado a uma faixa razoável para nunca sobrepor capacidade/tempo
        reais — é uma sugestão, não uma regra rígida (diretriz central)."""
        key = frozenset({_round_point(lat1, lon1), _round_point(lat2, lon2)})
        if key in self.conexoes:
            return max(0.6, 1 - 0.05 * self.conexoes[key])
        if key in self.penalizacoes:
            return min(1.6, 1 + 0.05 * self.penalizacoes[key])
        return 1.0


def fetch_hints(collaborators, lat_key, lon_key):
    """Busca conexões fortes / penalizações envolvendo pontos próximos aos
    do upload atual (filtro 4 da hierarquia de busca).

    Como cada par fica salvo de forma normalizada (o ponto de menor
    lat/lon vira "ponto_a", o outro "ponto_b" — ver `_upsert_correlacao`),
    um ponto do upload atual pode aparecer em qualquer um dos dois lados;
    por isso fazemos a busca pelos dois."""
    client = _get_client()
    if not client or not collaborators:
        return HistoricalHints()

    def _do():
        lats = [c[lat_key] for c in collaborators]
        lons = [c[lon_key] for c in collaborators]
        margin = 0.01  # ~1km de folga além do bounding box dos pontos atuais
        bounds = (min(lats) - margin, max(lats) + margin, min(lons) - margin, max(lons) + margin)

        def query_side(prefix):
            lat_min, lat_max, lon_min, lon_max = bounds
            return (
                client.table("correlacoes_pontos")
                .select("*")
                .gte(f"{prefix}_lat", lat_min)
                .lte(f"{prefix}_lat", lat_max)
                .gte(f"{prefix}_lon", lon_min)
                .lte(f"{prefix}_lon", lon_max)
                .execute()
                .data
                or []
            )

        rows_by_id = {}
        for row in query_side("ponto_a") + query_side("ponto_b"):
            rows_by_id[row.get("id") or id(row)] = row

        conexoes, penalizacoes = {}, {}
        for row in rows_by_id.values():
            key = frozenset({
                (row["ponto_a_lat"], row["ponto_a_lon"]),
                (row["ponto_b_lat"], row["ponto_b_lon"]),
            })
            target = conexoes if row["tipo"] == "CONEXAO_FORTE" else penalizacoes
            target[key] = row["ocorrencias"]
        return HistoricalHints(conexoes, penalizacoes)

    return _safe(_do, default=HistoricalHints())


# ---------------------------------------------------------------------------
# Feedback loop (bloco 6.6 do fluxo, item 4 da especificação)
# ---------------------------------------------------------------------------

def _upsert_correlacao(client, ponto_a, ponto_b, tipo):
    # Normaliza a ordem do par para a chave única funcionar independente de
    # quem veio primeiro.
    a, b = sorted([ponto_a, ponto_b])
    existing = (
        client.table("correlacoes_pontos")
        .select("id, ocorrencias")
        .eq("ponto_a_lat", a[0]).eq("ponto_a_lon", a[1])
        .eq("ponto_b_lat", b[0]).eq("ponto_b_lon", b[1])
        .eq("tipo", tipo)
        .execute()
        .data
    )
    if existing:
        client.table("correlacoes_pontos").update(
            {"ocorrencias": existing[0]["ocorrencias"] + 1}
        ).eq("id", existing[0]["id"]).execute()
    else:
        client.table("correlacoes_pontos").insert({
            "ponto_a_lat": a[0], "ponto_a_lon": a[1],
            "ponto_b_lat": b[0], "ponto_b_lon": b[1],
            "tipo": tipo, "ocorrencias": 1,
        }).execute()


def _haversine_km(lat1, lon1, lat2, lon2):
    radius_km = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * radius_km * math.asin(math.sqrt(a))


def _consecutive_pairs_in_route(collaborators, lat_key, lon_key):
    """Pares de colaboradores que ficaram ADJACENTES na sequência de
    embarque de uma rota validada — um sinal de conexão bem mais preciso do
    que 'qualquer par que compartilha a rota', que marcaria como 'conexão
    forte' até pontos nas duas pontas opostas de uma rota grande, que na
    prática nunca ficam próximos um do outro."""
    grupos = {}
    for c in collaborators:
        if c["routeId"] is None:
            continue
        grupos.setdefault(c["routeId"], []).append(c)
    pares = set()
    for membros in grupos.values():
        ordenados = sorted(membros, key=lambda c: c["order"] if c["order"] is not None else 0)
        for a, b in zip(ordenados, ordenados[1:]):
            pa = _round_point(a[lat_key], a[lon_key])
            pb = _round_point(b[lat_key], b[lon_key])
            if pa != pb:
                pares.add(frozenset({pa, pb}))
    return pares


def _nearby_pairs_different_routes(collaborators, lat_key, lon_key, proximidade_km):
    """Pares GEOGRAFICAMENTE PRÓXIMOS que ficaram em rotas diferentes —
    sinal direto de penalização (o operador optou por separá-los apesar da
    proximidade). Usa uma grade espacial simples (bucket por célula de
    ~`proximidade_km`) em vez de comparar todos os pares — O(n) em vez de
    O(n²), essencial para planilhas grandes."""
    grid_size_deg = max(proximidade_km / 111.0, 0.0005)  # ~111km por grau, aproximação razoável perto do equador
    buckets = {}
    for c in collaborators:
        if c["routeId"] is None:
            continue
        key = (int(c[lat_key] // grid_size_deg), int(c[lon_key] // grid_size_deg))
        buckets.setdefault(key, []).append(c)

    pares = set()
    checados = set()
    for c in collaborators:
        if c["routeId"] is None:
            continue
        cx, cy = int(c[lat_key] // grid_size_deg), int(c[lon_key] // grid_size_deg)
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for outro in buckets.get((cx + dx, cy + dy), []):
                    if outro["id"] == c["id"]:
                        continue
                    par_id = frozenset({c["id"], outro["id"]})
                    if par_id in checados:
                        continue
                    checados.add(par_id)
                    if c["routeId"] == outro["routeId"]:
                        continue
                    dist_km = _haversine_km(c[lat_key], c[lon_key], outro[lat_key], outro[lon_key])
                    if dist_km <= proximidade_km:
                        pa = _round_point(c[lat_key], c[lon_key])
                        pb = _round_point(outro[lat_key], outro[lon_key])
                        if pa != pb:
                            pares.add(frozenset({pa, pb}))
    return pares


def learn_from_scenario(project, tipo_origem, lat_key, lon_key, proximidade_km=2.0):
    """Aprende diretamente do estado FINAL de um cenário validado — manual
    ou automático (aprovado ou ajustado) — em vez de depender de comparar
    com uma sugestão anterior. Isso é o que realmente implementa a
    diretriz central do projeto ("aprender com o histórico de
    comportamentos humanos operacionais que obtiveram sucesso"): toda rota
    validada ensina, não só as que foram ajustadas a partir de uma sugestão
    automática.

      - Toda dupla ADJACENTE na sequência de embarque -> CONEXAO_FORTE.
      - Toda dupla PRÓXIMA (`proximidade_km`) que ficou em rotas
        DIFERENTES -> PENALIZACAO (o operador escolheu separá-los).

    Cenários com peso 0 (AUTOMATICA_NAO_VALIDADA) não ensinam nada — são só
    para auditoria. Best-effort: nunca lança exceção."""
    if tipo_origem == "AUTOMATICA_NAO_VALIDADA":
        return None
    client = _get_client()
    if not client:
        return None

    def _do():
        collaborators = [c for c in project["collaborators"] if c["routeId"] is not None]
        if len(collaborators) < 2:
            return 0

        conexoes = _consecutive_pairs_in_route(collaborators, lat_key, lon_key)
        penalizacoes = _nearby_pairs_different_routes(collaborators, lat_key, lon_key, proximidade_km)

        for pair in conexoes:
            a, b = tuple(pair)
            _upsert_correlacao(client, a, b, "CONEXAO_FORTE")
        for pair in penalizacoes:
            a, b = tuple(pair)
            _upsert_correlacao(client, a, b, "PENALIZACAO")

        return len(conexoes) + len(penalizacoes)

    return _safe(_do, default=0)


def register_feedback(project, sugestao_original, lat_key, lon_key):
    """Compara a sugestão automática original (`sugestao_original`, um
    snapshot {collab_id: routeId} tirado no momento da geração) com o
    estado atual do projeto, só para CLASSIFICAR o cenário (APROVADA se
    idêntico, AJUSTADA se houve qualquer mudança de rota). A extração de
    conexões/penalizações em si vem de `learn_from_scenario`, que aprende
    do estado final — não da diferença — e por isso funciona igual para
    rotas manuais (ver `save_to_knowledge_base` em main.py). Retorna o
    tipo_origem escolhido, ou None se a base de conhecimento estiver
    desativada ou a chamada falhar."""
    client = _get_client()
    if not client or sugestao_original is None:
        return None

    def _do():
        collaborators = project["collaborators"]
        by_id = {c["id"]: c for c in collaborators}
        # `sugestao_original` passa por um ciclo de serialização JSON (salvo
        # no SQLite/Supabase e recarregado) entre a geração e o download —
        # JSON só permite chaves string, então as chaves numéricas viram
        # string nesse meio-tempo. Normalizamos para um novo dict com
        # chaves int (não reatribuímos o nome do parâmetro: isso o
        # tornaria uma variável local em toda a função e quebraria a
        # leitura acima).
        original_por_id = {int(cid): route_id for cid, route_id in sugestao_original.items()}

        mudou = any(
            by_id[cid]["routeId"] != original_route
            for cid, original_route in original_por_id.items()
            if cid in by_id
        )
        tipo_origem = "AUTOMATICA_AJUSTADA" if mudou else "AUTOMATICA_APROVADA"

        save_scenario(project, tipo_origem, peso=1.0)
        learn_from_scenario(project, tipo_origem, lat_key, lon_key)
        return tipo_origem

    return _safe(_do)


# ---------------------------------------------------------------------------
# Painel do histórico (item 6): visão agregada do que já foi aprendido
# ---------------------------------------------------------------------------

def get_stats(limit_top_correlacoes=15):
    """Retorna um resumo para exibição num painel: quantos cenários existem
    por status, ocupação/tempo médios, e os pares de pontos que mais se
    repetem como conexão forte ou penalização — só coordenadas, nunca
    identidade de colaborador."""
    client = _get_client()
    if not client:
        return {"disponivel": False}

    def _do():
        cenarios = (
            client.table("cenarios")
            .select("tipo_origem, capacidade_veiculo, total_colaboradores, total_rotas, distancia_total_km, tempo_total_min, criado_em")
            .order("criado_em", desc=True)
            .limit(500)
            .execute()
            .data
            or []
        )
        por_status = Counter(c["tipo_origem"] for c in cenarios)

        ocupacoes = []
        for c in cenarios:
            capacidade_total = (c.get("capacidade_veiculo") or 0) * (c.get("total_rotas") or 0)
            if capacidade_total:
                ocupacoes.append((c.get("total_colaboradores") or 0) / capacidade_total)
        ocupacao_media = round(sum(ocupacoes) / len(ocupacoes), 3) if ocupacoes else None

        tempos = [c["tempo_total_min"] for c in cenarios if c.get("tempo_total_min")]
        tempo_total_medio = round(sum(tempos) / len(tempos), 1) if tempos else None

        def top_pares(tipo):
            rows = (
                client.table("correlacoes_pontos")
                .select("ponto_a_lat, ponto_a_lon, ponto_b_lat, ponto_b_lon, ocorrencias")
                .eq("tipo", tipo)
                .order("ocorrencias", desc=True)
                .limit(limit_top_correlacoes)
                .execute()
                .data
                or []
            )
            return [
                {
                    "pontoA": [row["ponto_a_lat"], row["ponto_a_lon"]],
                    "pontoB": [row["ponto_b_lat"], row["ponto_b_lon"]],
                    "ocorrencias": row["ocorrencias"],
                }
                for row in rows
            ]

        return {
            "disponivel": True,
            "totalCenarios": len(cenarios),
            "porStatus": dict(por_status),
            "ocupacaoMedia": ocupacao_media,
            "tempoTotalMedioMin": tempo_total_medio,
            "topConexoesFortes": top_pares("CONEXAO_FORTE"),
            "topPenalizacoes": top_pares("PENALIZACAO"),
        }

    return _safe(_do, default={"disponivel": False})


# ---------------------------------------------------------------------------
# Visão consolidada do aprendizado (Cérebro + ML) para o painel de Histórico
# ---------------------------------------------------------------------------

def _taxa(aprovadas, total):
    return round(aprovadas / total, 3) if total else None


def _agrupar_destinos(cenarios, raio_km):
    """Agrupa cenários cujo destino está a <= raio_km do primeiro cenário do
    grupo (mesma lógica de proximidade que o ML usa para treinar por destino)."""
    grupos = []
    for c in cenarios:
        for g in grupos:
            if _haversine_km(g["lat"], g["lon"], c["destino_lat"], c["destino_lon"]) <= raio_km:
                g["itens"].append(c)
                break
        else:
            grupos.append({"lat": c["destino_lat"], "lon": c["destino_lon"], "itens": [c]})
    return grupos


def get_learning_overview(treinar=True, retrain=False, max_destinos=5):
    """Resumo do que o Cérebro e o ML já aprenderam, para o painel de
    Histórico. Só agregados: nenhuma identidade de colaborador. Best-effort:
    se o Supabase estiver fora, retorna {"disponivel": False}.

    `treinar`: permite treinar o ML (sob demanda, com cache de 6h) para os
    destinos com cenários suficientes. `retrain`: força novo treino."""
    client = _get_client()
    if not client:
        return {"disponivel": False}

    def _do():
        try:
            from . import ml_pairs
        except ImportError:
            import ml_pairs

        cenarios = (
            client.table("cenarios")
            .select("id, app_project_id, destino_lat, destino_lon, tipo_origem, peso, criado_em")
            .order("criado_em", desc=True)
            .limit(1000)
            .execute()
            .data
            or []
        )
        cenarios.reverse()  # cronológico (mais antigo -> mais novo)

        validados = [c for c in cenarios if c["tipo_origem"] != "AUTOMATICA_NAO_VALIDADA" and (c.get("peso") or 0) > 0]
        automaticos = [c for c in cenarios if c["tipo_origem"] in ("AUTOMATICA_APROVADA", "AUTOMATICA_AJUSTADA")]

        # --- Cérebro: correlações aprendidas -------------------------------
        correl = ml_pairs._fetch_all(lambda: client.table("correlacoes_pontos").select("tipo, ocorrencias"))
        conexoes = [r for r in correl if r["tipo"] == "CONEXAO_FORTE"]
        penal = [r for r in correl if r["tipo"] == "PENALIZACAO"]
        cerebro = {
            "conexoesFortes": len(conexoes),
            "penalizacoes": len(penal),
            "ocorrenciasTotais": sum(r.get("ocorrencias") or 0 for r in correl),
        }

        # --- Taxa de aprovação sem ajuste (e evolução) ----------------------
        aprovadas = sum(1 for c in automaticos if c["tipo_origem"] == "AUTOMATICA_APROVADA")
        serie = []
        if len(automaticos) >= 4:
            tamanho = max(3, math.ceil(len(automaticos) / 6))
            janelas = [automaticos[i:i + tamanho] for i in range(0, len(automaticos), tamanho)]
            if len(janelas) > 1 and len(janelas[-1]) < 2:
                janelas[-2].extend(janelas.pop())  # sobra de 1 cenário vai para a janela anterior
            for janela in janelas:
                ok = sum(1 for c in janela if c["tipo_origem"] == "AUTOMATICA_APROVADA")
                serie.append({"fim": (janela[-1].get("criado_em") or "")[:10], "taxa": _taxa(ok, len(janela)), "n": len(janela)})
        tendencia_pp = None
        if len(automaticos) >= 6:
            meio = len(automaticos) // 2
            antes, depois = automaticos[:meio], automaticos[meio:]
            t_antes = _taxa(sum(1 for c in antes if c["tipo_origem"] == "AUTOMATICA_APROVADA"), len(antes))
            t_depois = _taxa(sum(1 for c in depois if c["tipo_origem"] == "AUTOMATICA_APROVADA"), len(depois))
            if t_antes is not None and t_depois is not None:
                tendencia_pp = round((t_depois - t_antes) * 100, 1)
        aprovacao = {
            "taxaGeral": _taxa(aprovadas, len(automaticos)),
            "totalAutomaticos": len(automaticos),
            "serie": serie,
            "tendenciaPontosPercentuais": tendencia_pp,
        }

        # --- Efeito do ML: cenários gerados com ML x sem ML ------------------
        # Lê só o campo `mlUsado` do JSON do projeto (nunca os colaboradores).
        def _ml_flags():
            ids = [c["app_project_id"] for c in automaticos if c.get("app_project_id")]
            flags = {}
            for i in range(0, len(ids), 100):
                rows = (
                    client.table("projects")
                    .select("id, ml:data->>mlUsado")
                    .in_("id", ids[i:i + 100])
                    .execute()
                    .data
                    or []
                )
                for r in rows:
                    flags[r["id"]] = str(r.get("ml")).lower() == "true"
            return flags

        flags = _safe(_ml_flags, default=None)
        efeito_ml = None
        if flags is not None:
            com = [c for c in automaticos if flags.get(c.get("app_project_id"))]
            sem = [c for c in automaticos if not flags.get(c.get("app_project_id"))]
            ok = lambda lst: sum(1 for c in lst if c["tipo_origem"] == "AUTOMATICA_APROVADA")
            efeito_ml = {
                "comMl": {"n": len(com), "taxa": _taxa(ok(com), len(com))},
                "semMl": {"n": len(sem), "taxa": _taxa(ok(sem), len(sem))},
            }

        # --- ML por destino ----------------------------------------------------
        destinos = []
        grupos = _agrupar_destinos(validados, ml_pairs.DEST_RADIUS_KM)
        grupos.sort(key=lambda g: -len(g["itens"]))
        for g in grupos[:max_destinos]:
            lat = sum(i["destino_lat"] for i in g["itens"]) / len(g["itens"])
            lon = sum(i["destino_lon"] for i in g["itens"]) / len(g["itens"])
            n = len(g["itens"])
            item = {
                "lat": round(lat, 4), "lon": round(lon, 4), "cenarios": n,
                "minimo": ml_pairs.MIN_SCENARIOS, "ativo": False, "motivo": None,
                "aucCv": None, "pares": None,
            }
            if not ml_pairs.ML_ENABLED:
                item["motivo"] = "ML desativado (ML_ENABLED=0)"
            elif n < ml_pairs.MIN_SCENARIOS:
                item["motivo"] = "dados insuficientes"
            elif treinar:
                _model, info = ml_pairs.get_model({"lat": lat, "lon": lon}, force=retrain)
                item.update(ativo=bool(info.get("disponivel")), motivo=info.get("motivo"),
                            aucCv=info.get("auc_cv"), pares=info.get("pares"))
            else:
                item["motivo"] = "não consultado"
            destinos.append(item)

        return {
            "disponivel": True,
            "totalCenarios": len(cenarios),
            "validados": len(validados),
            "cerebro": cerebro,
            "aprovacao": aprovacao,
            "efeitoMl": efeito_ml,
            "destinos": destinos,
            "mlAtivoEm": sum(1 for d in destinos if d["ativo"]),
            "mlHabilitado": ml_pairs.ML_ENABLED,
        }

    return _safe(_do, default={"disponivel": False})
