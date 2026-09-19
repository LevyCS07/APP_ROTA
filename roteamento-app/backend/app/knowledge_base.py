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
import os
from collections import Counter

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


def register_feedback(project, sugestao_original, lat_key, lon_key):
    """Compara a sugestão automática original (`sugestao_original`, um
    snapshot {collab_id: routeId} tirado no momento da geração) com o
    estado atual do projeto (o que o usuário efetivamente exportou).
    Classifica o cenário (APROVADA se idêntico, AJUSTADA se houve qualquer
    mudança de rota) e atualiza conexões fortes / penalizações a partir das
    diferenças. Retorna o tipo_origem escolhido, ou None se a base de
    conhecimento estiver desativada ou a chamada falhar."""
    client = _get_client()
    if not client or sugestao_original is None:
        return None

    def _do():
        collaborators = project["collaborators"]
        by_id = {c["id"]: c for c in collaborators}
        # `sugestao_original` passa por um ciclo de serialização JSON (salvo
        # no SQLite e recarregado) entre a geração e o download — JSON só
        # permite chaves string, então as chaves numéricas viram string
        # nesse meio-tempo. Normalizamos para um novo dict com chaves int
        # (não reatribuímos o nome do parâmetro: isso o tornaria uma
        # variável local em toda a função e quebraria a leitura acima).
        original_por_id = {int(cid): route_id for cid, route_id in sugestao_original.items()}

        mudou = any(
            by_id[cid]["routeId"] != original_route
            for cid, original_route in original_por_id.items()
            if cid in by_id
        )
        tipo_origem = "AUTOMATICA_AJUSTADA" if mudou else "AUTOMATICA_APROVADA"

        if mudou:
            def route_groups(get_route_fn):
                groups = {}
                for c in collaborators:
                    r = get_route_fn(c)
                    if r is None:
                        continue
                    groups.setdefault(r, []).append(c)
                return groups

            original_groups = route_groups(lambda c: original_por_id.get(c["id"]))
            final_groups = route_groups(lambda c: c["routeId"])

            def pairs_in_groups(groups):
                result = set()
                for members in groups.values():
                    ids = [m["id"] for m in members]
                    for i in range(len(ids)):
                        for j in range(i + 1, len(ids)):
                            result.add(frozenset({ids[i], ids[j]}))
                return result

            pares_antes = pairs_in_groups(original_groups)
            pares_depois = pairs_in_groups(final_groups)

            separados = pares_antes - pares_depois   # estavam juntos, usuário separou
            juntados = pares_depois - pares_antes    # não estavam juntos, usuário juntou

            for pair in separados:
                id_a, id_b = tuple(pair)
                if id_a in by_id and id_b in by_id:
                    pa = (by_id[id_a][lat_key], by_id[id_a][lon_key])
                    pb = (by_id[id_b][lat_key], by_id[id_b][lon_key])
                    _upsert_correlacao(client, _round_point(*pa), _round_point(*pb), "PENALIZACAO")

            for pair in juntados:
                id_a, id_b = tuple(pair)
                if id_a in by_id and id_b in by_id:
                    pa = (by_id[id_a][lat_key], by_id[id_a][lon_key])
                    pb = (by_id[id_b][lat_key], by_id[id_b][lon_key])
                    _upsert_correlacao(client, _round_point(*pa), _round_point(*pb), "CONEXAO_FORTE")

        save_scenario(project, tipo_origem, peso=1.0)
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
