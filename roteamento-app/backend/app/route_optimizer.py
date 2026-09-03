"""Motor de geração automática de rotas.

Este módulo concentra toda a lógica de otimização (agrupamento por
direção/cones, construção de rotas, refinamento e avaliação), separada da
camada HTTP em `main.py`. Ideia geral do pipeline:

  1. Cones/direção   -> agrupa colaboradores por direção em relação ao
                         destino (mantido como primeira etapa, ver `_split_by_direction`).
  2. Construção       -> para cada grupo, constrói uma ou mais rotas com uma
                         entre duas heurísticas: Nearest Neighbor ou Savings
                         (Clarke & Wright).
  3. Refinamento      -> 2-opt (troca de arestas) e relocate (move colaboradores
                         de fronteira quando isso melhora o CUSTO TOTAL da
                         solução, não apenas a distância a um centróide).
  4. Avaliação        -> `avaliar_rota()` / `avaliar_solucao()`: uma função de
                         custo central, com pesos configuráveis, que combina
                         tempo, distância, coerência geográfica e ocupação.
  5. Seleção          -> três estratégias concorrentes são geradas e comparadas
                         pela mesma função de custo; a de menor custo vence.

Limitações conhecidas (documentadas em vez de escondidas):
  - Não há um grafo de ruas real disponível localmente; "coerência viária"
    é aproximada por direção (bearing) + tempo/distância reais do ORS
    quando a chave está configurada, e por uma estimativa de linha reta
    com fator de sinuosidade quando não está.
  - A Matrix API do ORS tem um limite prático de pontos por chamada
    (`MATRIX_MAX_POINTS`); grupos maiores que isso caem no fallback estimado.
"""

import math
import os

import openrouteservice

MAX_WAYPOINTS = 48       # Limite de waypoints por chamada de directions (inclui o destino).
MATRIX_MAX_POINTS = 55   # Limite prático da Matrix API no plano gratuito do ORS.
INVALID_PENALTY = 100_000.0  # Penalidade (finita) para rotas que violam uma restrição "dura".

# Em 2026 o HeiGIT descontinuou api.openrouteservice.org em favor de uma URL
# unificada para todos os serviços deles. A lib openrouteservice-py usa o
# domínio antigo por padrão (parâmetro base_url do Client), então precisamos
# apontar explicitamente para o novo. Configurável via env var para não
# precisar mexer no código numa eventual próxima migração.
ORS_BASE_URL = os.getenv("ORS_BASE_URL", "https://api.heigit.org/openrouteservice")

# Cache de consultas ao ORS neste processo (regra 9 do prompt: evitar
# chamadas repetidas para o mesmo conjunto de pontos). É intencionalmente
# em memória e não persistido — o processo já é efêmero no Render.
_ROUTE_CACHE = {}
_MATRIX_CACHE = {}


# ---------------------------------------------------------------------------
# Geometria básica
# ---------------------------------------------------------------------------

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
    destino (etapa de cones)."""
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dlambda = math.radians(lon2 - lon1)
    x = math.sin(dlambda) * math.cos(phi2)
    y = math.cos(phi1) * math.sin(phi2) - math.sin(phi1) * math.cos(phi2) * math.cos(dlambda)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def _circular_mean_bearing(bearings):
    if not bearings:
        return 0.0
    x = sum(math.cos(math.radians(b)) for b in bearings) / len(bearings)
    y = sum(math.sin(math.radians(b)) for b in bearings) / len(bearings)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def _angular_spread(bearings):
    """Amplitude angular real de um conjunto de direções (0-360°), tratando
    corretamente o caso do grupo cruzar a fronteira 0°/360°."""
    if not bearings:
        return 0.0
    values = sorted(bearings)
    gaps = [values[i + 1] - values[i] for i in range(len(values) - 1)]
    gaps.append(360 - values[-1] + values[0])
    return round(360 - max(gaps), 1)


def _zigzag_score(ordered_members, lat_key, lon_key):
    """Proporção de 'reversões' bruscas de direção (>90°) entre paradas
    consecutivas — quanto mais perto de 0, mais suave é a rota."""
    if len(ordered_members) < 3:
        return 0.0
    reversals = 0
    prev_bearing = None
    for a, b in zip(ordered_members, ordered_members[1:]):
        brg = bearing(a[lat_key], a[lon_key], b[lat_key], b[lon_key])
        if prev_bearing is not None:
            diff = abs((brg - prev_bearing + 180) % 360 - 180)
            if diff > 90:
                reversals += 1
        prev_bearing = brg
    return reversals / max(1, len(ordered_members) - 2)


def _circular_cut_offset(bearings):
    """Escolhe o ponto de corte (0°) para fatiar os setores angulares no
    maior 'vão vazio' da distribuição de direções, em vez de sempre cortar
    exatamente em 0°/360° — evita partir ao meio um grupo natural de
    colaboradores só porque ele cruza essa marca (regra 1: agrupamento
    angular precisa tratar corretamente a passagem de 359° para 0°)."""
    if not bearings:
        return 0.0
    values = sorted(set(round(b, 3) for b in bearings))
    if len(values) < 2:
        return 0.0
    gaps = [(values[i + 1] - values[i], values[i]) for i in range(len(values) - 1)]
    gaps.append((360 - values[-1] + values[0], values[-1]))
    gap_size, start_of_gap = max(gaps)
    return (start_of_gap + gap_size / 2) % 360


def _fallback_pair_cost(lat1, lon1, lat2, lon2):
    """Estimativa de distância/tempo quando o ORS não está disponível: usa a
    distância em linha reta com um fator de sinuosidade típico de malha
    urbana e uma velocidade média conservadora."""
    sinuosity = 1.3
    avg_speed_kmh = 28.0
    distance_km = haversine(lat1, lon1, lat2, lon2) * sinuosity
    duration_min = (distance_km / avg_speed_kmh) * 60
    return distance_km, duration_min


# ---------------------------------------------------------------------------
# Integração com o ORS (com cache — regra 9)
# ---------------------------------------------------------------------------

def _round_coords_key(coords):
    return tuple((round(lon, 5), round(lat, 5)) for lon, lat in coords)


def _fallback_route(coords):
    distance_km = 0.0
    duration_min = 0.0
    for (lon1, lat1), (lon2, lat2) in zip(coords, coords[1:]):
        d_km, d_min = _fallback_pair_cost(lat1, lon1, lat2, lon2)
        distance_km += d_km
        duration_min += d_min
    return coords, distance_km, duration_min, False


def ors_route(coords):
    """Retorna (coordenadas, distancia_km, duracao_min, usou_ors) para a
    sequência completa de pontos, já na ordem de visita definida pelo
    algoritmo (o ORS NÃO é autorizado a reordenar os waypoints — regra 9).
    Cai para uma estimativa por linha reta se a chave não estiver
    configurada, o número de pontos exceder o limite, ou a chamada falhar.
    Resultado é cacheado por processo para a mesma sequência de coordenadas."""
    key = _round_coords_key(coords)
    if key in _ROUTE_CACHE:
        return _ROUTE_CACHE[key]

    api_key = os.getenv("ORS_API_KEY")
    if not api_key or len(coords) > MAX_WAYPOINTS:
        result = _fallback_route(coords)
    else:
        try:
            client = openrouteservice.Client(key=api_key, base_url=ORS_BASE_URL, timeout=15)
            # optimize_waypoints deliberadamente OMITIDO: a ordem já foi
            # decidida pelo algoritmo (cones + Savings/NN + 2-opt) e deve
            # ser respeitada, não reotimizada pelo ORS.
            response = client.directions(coordinates=coords, profile="driving-car", format="geojson")
            feature = response["features"][0]
            summary = feature["properties"]["summary"]
            result = (feature["geometry"]["coordinates"], summary["distance"] / 1000, summary["duration"] / 60, True)
        except Exception:
            result = _fallback_route(coords)

    _ROUTE_CACHE[key] = result
    return result


def _fallback_matrix(locations):
    n = len(locations)
    durations = [[0.0] * n for _ in range(n)]
    distances = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i == j:
                continue
            lon1, lat1 = locations[i]
            lon2, lat2 = locations[j]
            dist_km, dur_min = _fallback_pair_cost(lat1, lon1, lat2, lon2)
            distances[i][j] = dist_km
            durations[i][j] = dur_min
    return durations, distances, False


def ors_matrix(locations):
    """locations: lista de [lon, lat]. Retorna (durations_min, distances_km,
    usou_ors) como matrizes NxN. Cai para estimativa por linha reta se a
    chave não estiver configurada, exceder o limite de pontos, ou falhar.
    Resultado cacheado por processo para o mesmo conjunto de pontos."""
    key = _round_coords_key(locations)
    if key in _MATRIX_CACHE:
        return _MATRIX_CACHE[key]

    api_key = os.getenv("ORS_API_KEY")
    n = len(locations)
    if not api_key or n < 2 or n > MATRIX_MAX_POINTS:
        result = _fallback_matrix(locations)
    else:
        try:
            client = openrouteservice.Client(key=api_key, base_url=ORS_BASE_URL, timeout=20)
            response = client.distance_matrix(locations=locations, profile="driving-car", metrics=["duration", "distance"])
            durations_min = [[(v or 0) / 60 for v in row] for row in response["durations"]]
            distances_km = [[(v or 0) / 1000 for v in row] for row in response["distances"]]
            result = (durations_min, distances_km, True)
        except Exception:
            result = _fallback_matrix(locations)

    _MATRIX_CACHE[key] = result
    return result


class CostContext:
    """Fornece custos de deslocamento (duração em min / distância em km)
    entre colaboradores e até o destino, usando a Matrix API do ORS quando
    o grupo cabe no limite prático, com cache e fallback por linha reta.

    `hints` (opcional): pistas do histórico (`knowledge_base.HistoricalHints`)
    que ajustam o custo ENTRE COLABORADORES (nunca até o destino, que é pura
    geografia) para favorecer combinações que o usuário historicamente
    manteve juntas, e desfavorecer as que ele historicamente separou. É um
    ajuste de busca, não uma verdade absoluta — por isso as métricas finais
    reportadas (distanciaKm/duracaoMin) nunca usam esse ajuste."""

    def __init__(self, members, destino, lat_key, lon_key, hints=None):
        self.destino = destino
        self.lat_key = lat_key
        self.lon_key = lon_key
        self.hints = hints
        self.duration_matrix = None
        self.distance_matrix = None
        self.id_to_index = None
        self.used_ors = False
        if 1 <= len(members) < MATRIX_MAX_POINTS:
            locations = [[m[lon_key], m[lat_key]] for m in members] + [[destino["lon"], destino["lat"]]]
            self.duration_matrix, self.distance_matrix, self.used_ors = ors_matrix(locations)
            self.id_to_index = {m["id"]: idx for idx, m in enumerate(members)}

    def _hint_factor(self, a, b):
        if not self.hints or self.hints.is_empty():
            return 1.0
        return self.hints.factor(a[self.lat_key], a[self.lon_key], b[self.lat_key], b[self.lon_key])

    def duration(self, a, b):
        if self.duration_matrix is not None and a["id"] in self.id_to_index and b["id"] in self.id_to_index:
            base = self.duration_matrix[self.id_to_index[a["id"]]][self.id_to_index[b["id"]]]
        else:
            _, base = _fallback_pair_cost(a[self.lat_key], a[self.lon_key], b[self.lat_key], b[self.lon_key])
        return base * self._hint_factor(a, b)

    def distance(self, a, b):
        if self.distance_matrix is not None and a["id"] in self.id_to_index and b["id"] in self.id_to_index:
            base = self.distance_matrix[self.id_to_index[a["id"]]][self.id_to_index[b["id"]]]
        else:
            base, _ = _fallback_pair_cost(a[self.lat_key], a[self.lon_key], b[self.lat_key], b[self.lon_key])
        return base * self._hint_factor(a, b)

    def to_destino(self, a):
        if self.duration_matrix is not None and a["id"] in self.id_to_index:
            return self.duration_matrix[self.id_to_index[a["id"]]][-1]
        _, dur = _fallback_pair_cost(a[self.lat_key], a[self.lon_key], self.destino["lat"], self.destino["lon"])
        return dur

    def distance_to_destino(self, a):
        if self.distance_matrix is not None and a["id"] in self.id_to_index:
            return self.distance_matrix[self.id_to_index[a["id"]]][-1]
        dist, _ = _fallback_pair_cost(a[self.lat_key], a[self.lon_key], self.destino["lat"], self.destino["lon"])
        return dist

    def sequence_metrics(self, sequence):
        duracao = 0.0
        distancia = 0.0
        for a, b in zip(sequence, sequence[1:]):
            duracao += self.duration(a, b)
            distancia += self.distance(a, b)
        if sequence:
            duracao += self.to_destino(sequence[-1])
            distancia += self.distance_to_destino(sequence[-1])
        return duracao, distancia


# ---------------------------------------------------------------------------
# Configuração e função de custo central (regras 2 e 4)
# ---------------------------------------------------------------------------

class OptimizerConfig:
    """Pesos e limiares usados pela função de custo — todos facilmente
    calibráveis (regra 4: "os pesos devem ser facilmente configuráveis")."""

    def __init__(
        self,
        peso_tempo=0.40,
        peso_coerencia=0.25,
        peso_distancia=0.20,
        peso_ocupacao=0.15,
        meta_ocupacao=0.85,       # objetivo desejável, não obrigatório (regra 1)
        tempo_ideal_min=60.0,     # até aqui: ideal
        tempo_aceitavel_min=75.0,  # 60-75: aceitável, penalização progressiva
        tempo_limite_min=90.0,    # 75-90: atenção; acima: inválida
        modo_frota="minimizar",   # "minimizar" | "fixa"
        relocate_passes=2,
    ):
        self.peso_tempo = peso_tempo
        self.peso_coerencia = peso_coerencia
        self.peso_distancia = peso_distancia
        self.peso_ocupacao = peso_ocupacao
        self.meta_ocupacao = meta_ocupacao
        self.tempo_ideal_min = tempo_ideal_min
        self.tempo_aceitavel_min = tempo_aceitavel_min
        self.tempo_limite_min = tempo_limite_min
        self.modo_frota = modo_frota
        self.relocate_passes = relocate_passes

    def pesos(self):
        return {
            "tempo": self.peso_tempo,
            "coerencia": self.peso_coerencia,
            "distancia": self.peso_distancia,
            "ocupacao": self.peso_ocupacao,
        }


def _tempo_penalidade(duracao_min, config):
    if duracao_min <= config.tempo_ideal_min:
        return duracao_min
    if duracao_min <= config.tempo_aceitavel_min:
        excedente = duracao_min - config.tempo_ideal_min
        return config.tempo_ideal_min + excedente * 1.8
    if duracao_min <= config.tempo_limite_min:
        excedente = duracao_min - config.tempo_aceitavel_min
        base = config.tempo_ideal_min + (config.tempo_aceitavel_min - config.tempo_ideal_min) * 1.8
        return base + excedente * 3.5
    # Acima de 90 min a rota é inválida (regra 2). Usamos uma penalidade
    # finita e crescente em vez de infinito puro para que soluções
    # continuem comparáveis mesmo em casos degenerados (ex.: um colaborador
    # cuja distância mínima até o destino já excede sozinha o limite, e que
    # portanto nenhuma divisão de rota consegue corrigir).
    excedente = duracao_min - config.tempo_limite_min
    return INVALID_PENALTY + excedente * 10


def _ocupacao_penalidade(ocupacao_ratio, meta):
    if ocupacao_ratio > 1.0 + 1e-6:
        # Não deveria acontecer (capacidade é restrição absoluta em todo o
        # pipeline), mas penalizamos pesado por segurança.
        return INVALID_PENALTY + (ocupacao_ratio - 1.0) * 1000
    return abs(ocupacao_ratio - meta) * 100


def _coerencia_penalidade(dispersao_graus, zigzag_score):
    return dispersao_graus * 0.5 + zigzag_score * 100


def avaliar_rota(metrics, config):
    """Função central de avaliação de uma rota (regra 4). Recebe um dict de
    métricas (duracao_min, distancia_km, ocupacao [0-1+], dispersao_graus,
    zigzag_score) e devolve um custo — quanto menor, melhor."""
    tempo_cost = _tempo_penalidade(metrics["duracao_min"], config)
    ocupacao_cost = _ocupacao_penalidade(metrics["ocupacao"], config.meta_ocupacao)
    distancia_cost = metrics["distancia_km"]
    coerencia_cost = _coerencia_penalidade(metrics.get("dispersao_graus", 0.0), metrics.get("zigzag_score", 0.0))
    pesos = config.pesos()
    return (
        pesos["tempo"] * tempo_cost
        + pesos["coerencia"] * coerencia_cost
        + pesos["distancia"] * distancia_cost
        + pesos["ocupacao"] * ocupacao_cost
    )


def avaliar_solucao(routes, config, penalidade_por_rota=8.0):
    """Custo de uma solução inteira: soma o custo de cada rota e penaliza
    levemente o número total de rotas (para não fragmentar demais só para
    'facilitar' cada rota individualmente)."""
    if not routes:
        return INVALID_PENALTY * 10
    total = sum(avaliar_rota(route["metrics"], config) for route in routes)
    total += len(routes) * penalidade_por_rota
    return round(total, 3)


def _route_metrics_from_ctx(members, ctx, capacity):
    if not members:
        return {"duracao_min": 0.0, "distancia_km": 0.0, "ocupacao": 0.0, "dispersao_graus": 0.0, "zigzag_score": 0.0}
    duracao, distancia = ctx.sequence_metrics(members)
    return {
        "duracao_min": duracao,
        "distancia_km": distancia,
        "ocupacao": len(members) / capacity,
        "dispersao_graus": _angular_spread([m["bearing"] for m in members]),
        "zigzag_score": _zigzag_score(members, ctx.lat_key, ctx.lon_key),
    }


# ---------------------------------------------------------------------------
# Etapa 1: cones/direção (mantida como primeira etapa — regra 6)
# ---------------------------------------------------------------------------

def decide_route_count(total, capacity, hint, modo_frota="minimizar"):
    """Quantas rotas serão necessárias. Em modo 'fixa', respeita o número
    exato informado (mesmo que isso deixe a capacidade apertada); em modo
    'minimizar' (padrão), calcula a partir da capacidade do veículo."""
    minimo = max(1, math.ceil(total / capacity))
    if modo_frota == "fixa" and hint:
        return max(1, hint)
    if hint and hint >= minimo:
        return hint
    return minimo


def _split_by_direction(collaborators, route_count):
    """Ordena os colaboradores pela direção (bearing) a partir do destino,
    corrigindo o corte para não partir um grupo natural ao meio na fronteira
    0°/360° (regra 1), e fatia em `route_count` setores contíguos de tamanho
    aproximadamente igual."""
    offset = _circular_cut_offset([c["bearing"] for c in collaborators])

    def rotated(b):
        return (b - offset) % 360

    ordered = sorted(collaborators, key=lambda c: rotated(c["bearing"]))
    total = len(ordered)
    groups = [[] for _ in range(route_count)]
    base_size = total / route_count
    for index, collab in enumerate(ordered):
        group_index = min(int(index / base_size), route_count - 1)
        groups[group_index].append(collab)
    return groups


def _rebalance_by_capacity(groups, capacity):
    """Redistribui colaboradores nas fronteiras entre setores vizinhos (na
    'roda' de direções) até que nenhum grupo exceda a capacidade (restrição
    absoluta — regra 1), preservando ao máximo a coerência direcional."""
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


def _rebalance_toward_target(groups, capacity, target_ratio):
    """Aproxima os grupos de uma ocupação-alvo (ex.: 85%) SEM violar a
    capacidade, movendo colaboradores de fronteira de grupos acima da meta
    para vizinhos abaixo dela. É apenas um ajuste grosseiro na fase de
    agrupamento; o ajuste fino de verdade acontece no relocate por custo
    marginal (regra 5/10), que pode inclusive desfazer isso se não compensar."""
    target = max(1, round(capacity * target_ratio))
    guard = 0
    changed = True
    while changed and guard < 300:
        changed = False
        guard += 1
        for i in range(len(groups)):
            if len(groups[i]) <= target or len(groups[i]) <= 1:
                continue
            for neighbor in ((i + 1) % len(groups), (i - 1) % len(groups)):
                if len(groups[neighbor]) < target and len(groups[neighbor]) < capacity:
                    groups[i].sort(key=lambda c: c["bearing"])
                    moved = groups[i].pop() if neighbor == (i + 1) % len(groups) else groups[i].pop(0)
                    groups[neighbor].append(moved)
                    changed = True
                    break
    return groups


# ---------------------------------------------------------------------------
# Etapa 2: construção de rotas — Nearest Neighbor e Savings (regra 7)
# ---------------------------------------------------------------------------

def nearest_neighbor_order(members, destino, lat_key, lon_key):
    """Sequência inicial simples: começa no colaborador mais distante do
    destino e, a cada passo, avança para o não visitado mais próximo do
    atual (distância em linha reta — usada como palpite inicial rápido;
    o refinamento por custo real acontece no 2-opt)."""
    remaining = members.copy()
    current = max(remaining, key=lambda m: haversine(m[lat_key], m[lon_key], destino["lat"], destino["lon"]))
    ordered = [current]
    remaining.remove(current)
    while remaining:
        nxt = min(remaining, key=lambda m: haversine(current[lat_key], current[lon_key], m[lat_key], m[lon_key]))
        ordered.append(nxt)
        remaining.remove(nxt)
        current = nxt
    return ordered


def _two_opt(sequence, ctx, max_iterations=60):
    """Busca local 2-opt usando o custo real (via CostContext, que já
    encapsula matriz do ORS + fallback) para desfazer cruzamentos e
    zigue-zagues na sequência (regra 10).

    Diferença importante em relação ao 2-opt clássico de ciclo fechado: aqui
    a rota tem uma ponta FIXA (o destino, sempre por último) e uma ponta
    livre. Isso significa que reverter um PREFIXO da sequência (mantendo o
    restante intacto até o destino) é um movimento válido e às vezes
    necessário — o Savings, em particular, pode deixar pontos 'do lado
    errado' da sequência sem que um 2-opt de ciclo fechado tradicional (que
    ignora esse caso) jamais chegue a corrigir. Por isso o índice `i` aqui
    começa em -1 (prefixo vazio = reversão completa) em vez de 0."""
    best = sequence
    n = len(best)
    if n > 60:
        max_iterations = 1  # custo quadrático por iteração; uma passada já ajuda bastante

    def seq_cost(seq):
        total = 0.0
        for a, b in zip(seq, seq[1:]):
            total += ctx.duration(a, b)
        if seq:
            total += ctx.to_destino(seq[-1])
        return total

    improved = True
    iterations = 0
    while improved and iterations < max_iterations and n > 3:
        improved = False
        iterations += 1
        current_cost = seq_cost(best)
        for i in range(-1, n - 1):
            for j in range(i + 2, n):
                candidate = best[:i + 1] + best[i + 1:j + 1][::-1] + best[j + 1:]
                candidate_cost = seq_cost(candidate)
                if candidate_cost < current_cost - 1e-6:
                    best = candidate
                    current_cost = candidate_cost
                    improved = True
    return best


def clarke_wright_savings(members, destino, capacity, ctx, max_route_time=None):
    """Heurística de Savings (Clarke & Wright), regra 7: trata o destino
    como o 'depósito' comum e cada colaborador como um cliente. Começa com
    uma rota unitária por colaborador e vai mesclando os pares com maior
    'economia' (savings = d(destino,i) + d(destino,j) - d(i,j)), respeitando
    capacidade e (opcionalmente) o limite de tempo por rota."""
    if not members:
        return []
    if len(members) == 1:
        return [list(members)]

    routes = {m["id"]: [m] for m in members}
    route_of = {m["id"]: m["id"] for m in members}
    starts = {m["id"]: m["id"] for m in members}
    ends = {m["id"]: m["id"] for m in members}
    d0 = {m["id"]: ctx.to_destino(m) for m in members}

    pairs = []
    for i in range(len(members)):
        for j in range(i + 1, len(members)):
            a, b = members[i], members[j]
            savings = d0[a["id"]] + d0[b["id"]] - ctx.duration(a, b)
            pairs.append((savings, a["id"], b["id"]))
    pairs.sort(key=lambda item: -item[0])

    for savings, a_id, b_id in pairs:
        if savings <= 0:
            break  # sem mais ganho: unir esses pontos pioraria o total
        route_a, route_b = route_of.get(a_id), route_of.get(b_id)
        if route_a is None or route_b is None or route_a == route_b:
            continue

        merged = new_start = new_end = None
        if ends[route_a] == a_id and starts[route_b] == b_id:
            merged, new_start, new_end = routes[route_a] + routes[route_b], starts[route_a], ends[route_b]
        elif ends[route_b] == b_id and starts[route_a] == a_id:
            merged, new_start, new_end = routes[route_b] + routes[route_a], starts[route_b], ends[route_a]
        else:
            continue  # só dá pra unir por uma ponta livre de cada rota

        if len(merged) > capacity:
            continue
        if max_route_time is not None:
            duracao, _ = ctx.sequence_metrics(merged)
            if duracao > max_route_time:
                continue

        for m in merged:
            route_of[m["id"]] = route_a
        routes[route_a] = merged
        starts[route_a] = new_start
        ends[route_a] = new_end
        if route_b != route_a and route_b in routes:
            del routes[route_b]

    return list(routes.values())


# ---------------------------------------------------------------------------
# Etapa 3: refinamento — relocate por custo marginal (regras 5, 6, 10)
# ---------------------------------------------------------------------------

def _apply_relocate(groups, destino, capacity, lat_key, lon_key, config, hints=None):
    """Tenta mover colaboradores de fronteira entre grupos vizinhos (por
    direção média) quando isso melhora o CUSTO TOTAL da solução — avaliado
    pela mesma `avaliar_rota()` usada em todo o resto do sistema — e não
    apenas a distância até um centróide. Também pode decidir não preencher
    uma vaga disponível, se o ganho não compensar (regra 5)."""
    groups = [list(g) for g in groups if g]
    if len(groups) < 2:
        return groups

    for _ in range(config.relocate_passes):
        bearings_by_group = [
            _circular_mean_bearing([m["bearing"] for m in g]) if g else 0.0
            for g in groups
        ]
        order = sorted(range(len(groups)), key=lambda i: bearings_by_group[i])
        n = len(order)
        neighbor_pairs = {tuple(sorted((order[pos], order[(pos + 1) % n]))) for pos in range(n)}

        moved_any = False
        for i, j in neighbor_pairs:
            if i == j:
                continue
            group_a, group_b = groups[i], groups[j]
            if not group_a and not group_b:
                continue
            ctx = CostContext(group_a + group_b, destino, lat_key, lon_key, hints)

            for from_group, to_group, to_has_room in (
                (group_a, group_b, len(group_b) < capacity),
                (group_b, group_a, len(group_a) < capacity),
            ):
                if not to_has_room or len(from_group) <= 1:
                    continue
                for collab in list(from_group):
                    custo_antes = (
                        avaliar_rota(_route_metrics_from_ctx(from_group, ctx, capacity), config)
                        + avaliar_rota(_route_metrics_from_ctx(to_group, ctx, capacity), config)
                    )
                    novo_from = [m for m in from_group if m["id"] != collab["id"]]
                    novo_to = to_group + [collab]
                    custo_depois = (
                        avaliar_rota(_route_metrics_from_ctx(novo_from, ctx, capacity), config)
                        + avaliar_rota(_route_metrics_from_ctx(novo_to, ctx, capacity), config)
                    )
                    if custo_depois < custo_antes - 0.01:
                        from_group.remove(collab)
                        to_group.append(collab)
                        moved_any = True
                        break
        if not moved_any:
            break

    refined = []
    for group in groups:
        if not group:
            continue
        ctx = CostContext(group, destino, lat_key, lon_key, hints)
        ordered = nearest_neighbor_order(group, destino, lat_key, lon_key)
        ordered = _two_opt(ordered, ctx)
        refined.append(ordered)
    return refined


# ---------------------------------------------------------------------------
# Construção das 3 estratégias concorrentes (regra 8) e finalização
# ---------------------------------------------------------------------------

def _build_strategy_nn(groups, destino, lat_key, lon_key, hints=None):
    routes = []
    for group in groups:
        if not group:
            continue
        ctx = CostContext(group, destino, lat_key, lon_key, hints)
        ordered = nearest_neighbor_order(group, destino, lat_key, lon_key)
        ordered = _two_opt(ordered, ctx)
        routes.append(ordered)
    return routes


def _build_strategy_savings(groups, destino, capacity, lat_key, lon_key, config, hints=None):
    routes = []
    for group in groups:
        if not group:
            continue
        ctx = CostContext(group, destino, lat_key, lon_key, hints)
        sub_routes = clarke_wright_savings(group, destino, capacity, ctx, max_route_time=config.tempo_limite_min)
        for sub in sub_routes:
            routes.append(_two_opt(sub, ctx))
    return routes


def _finalize_strategy(route_member_lists, destino, capacity, lat_key, lon_key, config):
    """Atribui ids definitivos às rotas, garante o limite de 90 minutos
    (dividindo recursivamente quem ultrapassar — regra 2/3) e calcula as
    métricas finais (via ORS, com cache) de cada rota."""
    pending = []
    next_id = 1
    for members in route_member_lists:
        if not members:
            continue
        pending.append((next_id, list(members), 0))
        next_id += 1

    finished = []
    while pending:
        route_id, members, depth = pending.pop(0)
        if not members:
            continue
        ctx = CostContext(members, destino, lat_key, lon_key)
        duracao_estim, _distancia_estim = ctx.sequence_metrics(members)

        if duracao_estim > config.tempo_limite_min and len(members) > 1 and depth < 5:
            mid = max(1, len(members) // 2)
            new_id = next_id
            next_id += 1
            pending.append((route_id, members[:mid], depth + 1))
            pending.append((new_id, members[mid:], depth + 1))
            continue

        coords = [[m[lon_key], m[lat_key]] for m in members] + [[destino["lon"], destino["lat"]]]
        _coords, distancia_km, duracao_min, used_ors = ors_route(coords)
        metrics = {
            "duracao_min": duracao_min if used_ors else duracao_estim,
            "distancia_km": distancia_km if used_ors else _distancia_estim,
            "ocupacao": len(members) / capacity,
            "dispersao_graus": _angular_spread([m["bearing"] for m in members]),
            "zigzag_score": _zigzag_score(members, lat_key, lon_key),
        }
        for order_index, m in enumerate(members):
            m["routeId"] = route_id
            m["order"] = order_index
        finished.append({
            "id": route_id,
            "name": f"ROTA_{route_id:02d}",
            "capacity": capacity,
            "distanciaKm": round(metrics["distancia_km"], 2),
            "duracaoMin": round(metrics["duracao_min"], 1),
            "usedOrs": used_ors,
            "ocupacao": len(members),
            "dispersaoGraus": metrics["dispersao_graus"],
            "zigzagScore": round(metrics["zigzag_score"], 3),
            "excedeuLimite": metrics["duracao_min"] > config.tempo_limite_min,
            "metrics": metrics,
            "_members": members,
        })

    # Renumera para ids sequenciais e bonitos (1..N) após eventuais divisões.
    finished.sort(key=lambda route: route["id"])
    for new_index, route in enumerate(finished):
        route["id"] = new_index + 1
        route["name"] = f"ROTA_{route['id']:02d}"
        for m in route["_members"]:
            m["routeId"] = route["id"]

    all_members = [m for route in finished for m in route["_members"]]
    for route in finished:
        del route["_members"]
    return finished, all_members


def _copy_groups(groups):
    return [[dict(m) for m in g] for g in groups]


def generate_routes(collaborators, destino, capacity, route_count_hint, tipo_rota, config=None, hints=None):
    """Ponto de entrada principal: executa o pipeline completo e devolve a
    lista de rotas da MELHOR entre 3 estratégias concorrentes (regra 8),
    todas avaliadas pela mesma função de custo. `collaborators` é alterado
    em memória (routeId/order de cada colaborador são preenchidos
    diretamente nos dicionários originais).

    `hints` (opcional): um `knowledge_base.HistoricalHints` com conexões
    fortes/penalizações aprendidas de gerações anteriores — usado apenas
    para ORIENTAR a construção/sequenciamento (nunca para violar capacidade
    ou o limite de tempo, e nunca para maquiar as métricas finais)."""
    config = config or OptimizerConfig()
    total = len(collaborators)
    if total == 0:
        return [{"id": 1, "name": "ROTA_01", "capacity": capacity}]

    lat_key, lon_key = ("latE", "lonE") if tipo_rota == "Entrada" else ("latS", "lonS")
    route_count = decide_route_count(total, capacity, route_count_hint, config.modo_frota)

    base_groups = _split_by_direction([dict(c) for c in collaborators], route_count)
    base_groups = _rebalance_by_capacity(base_groups, capacity)
    base_groups = _rebalance_toward_target(base_groups, capacity, config.meta_ocupacao)

    candidatos = {}

    # Estratégia 1: Cones + Nearest Neighbor + 2-opt.
    groups_nn = _copy_groups(base_groups)
    candidatos["cones_nn_2opt"] = _build_strategy_nn(groups_nn, destino, lat_key, lon_key, hints)

    # Estratégia 2: Cones + Savings + 2-opt.
    groups_savings = _copy_groups(base_groups)
    candidatos["cones_savings_2opt"] = _build_strategy_savings(groups_savings, destino, capacity, lat_key, lon_key, config, hints)

    # Estratégia 3: Cones + Savings + 2-opt + refinamento (relocate).
    groups_savings_refino = _copy_groups(base_groups)
    groups_savings_refino = _apply_relocate(groups_savings_refino, destino, capacity, lat_key, lon_key, config, hints)
    candidatos["cones_savings_2opt_refino"] = _build_strategy_savings(groups_savings_refino, destino, capacity, lat_key, lon_key, config, hints)

    melhor_nome, melhor_routes, melhor_membros, melhor_custo = None, None, None, math.inf
    for nome, route_lists in candidatos.items():
        routes, membros = _finalize_strategy(route_lists, destino, capacity, lat_key, lon_key, config)
        custo = avaliar_solucao(routes, config)
        if custo < melhor_custo:
            melhor_nome, melhor_routes, melhor_membros, melhor_custo = nome, routes, membros, custo

    # Copia o resultado da estratégia vencedora de volta para os objetos
    # originais (o chamador espera que `collaborators` seja mutado in-place).
    by_id = {m["id"]: m for m in melhor_membros}
    for collab in collaborators:
        atualizado = by_id.get(collab["id"])
        if atualizado:
            collab["routeId"] = atualizado["routeId"]
            collab["order"] = atualizado["order"]

    for route in melhor_routes:
        route["estrategia"] = melhor_nome
        route["custoGlobal"] = melhor_custo

    return melhor_routes
