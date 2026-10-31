"""Camada de Machine Learning do APP_ROTA — classificador de PARES.

Pergunta que o modelo responde: "dado um par de colaboradores próximos entre
si, qual a probabilidade de um operador humano ter colocado os dois na MESMA
rota?". O resultado vira um multiplicador de custo (mesma interface do
`knowledge_base.HistoricalHints`: `is_empty()` e `factor(lat1, lon1, lat2, lon2)`),
então o `route_optimizer.py` NÃO precisa ser alterado.

Por que isso complementa o Cérebro atual
-----------------------------------------
`HistoricalHints` só age quando o MESMO ponto (~11 m) já apareceu em outro
cenário. O modelo aprende padrões GERAIS (distância, direção em relação ao
destino, diferença de distância ao destino, mesmo bairro) e por isso também
vale para colaboradores/endereços que nunca foram vistos.

Princípios (iguais aos do resto do projeto)
-------------------------------------------
  - Best-effort: qualquer falha => sem ML, geração segue normal.
  - É uma SUGESTÃO: o fator é limitado e nunca altera capacidade, limite de
    tempo nem as métricas finais reportadas.
  - Só usa dados anonimizados já existentes no Supabase (lat/lon, bairro,
    sequência, rota). Nenhum nome/ID de colaborador.
  - Portão de qualidade: o modelo só é aplicado se tiver dados suficientes e
    AUC validada (por cenário) acima de um mínimo. Senão, é como se não
    existisse.
  - Sem dependências novas: regressão logística em numpy (já vem com pandas).
"""

import logging
import math
import os
import random
import time

import numpy as np

logger = logging.getLogger("ml_pairs")

# --- configuração (tudo sobrescrevível por variável de ambiente) -----------
ML_ENABLED = os.getenv("ML_ENABLED", "1") not in ("0", "false", "False")
PAIR_RADIUS_KM = float(os.getenv("ML_PAIR_RADIUS_KM", "6.0"))   # só pares até aqui (domínio de treino)
STRENGTH = float(os.getenv("ML_STRENGTH", "0.25"))             # força do ajuste de custo
FACTOR_MIN, FACTOR_MAX = 0.75, 1.35                            # faixa do fator só do ML
FINAL_MIN, FINAL_MAX = 0.6, 1.6                                # mesma faixa do HistoricalHints
MIN_SCENARIOS = int(os.getenv("ML_MIN_SCENARIOS", "8"))
MIN_PAIRS = int(os.getenv("ML_MIN_PAIRS", "800"))
MIN_AUC = float(os.getenv("ML_MIN_AUC", "0.62"))
MAX_PAIRS_PER_SCENARIO = 6000
MODEL_TTL_S = int(os.getenv("ML_MODEL_TTL_S", str(6 * 3600)))

# Cenários aprovados sem nenhuma alteração são, em parte, o próprio algoritmo
# concordando consigo mesmo (viés de confirmação) — pesam menos.
ORIGIN_WEIGHT = {
    "MANUAL_VALIDADA": 1.0,
    "AUTOMATICA_AJUSTADA": 1.0,
    "AUTOMATICA_APROVADA": 0.3,
}

N_CUTS = 24  # cortes angulares de 15° em torno do destino
FEATURE_NAMES = (
    ["log_dist_km", "dbearing", "ddest_rel", "same_bairro", "log_dest_medio", "dist_x_dbearing"]
    + [f"corta_{int(k * 360 / N_CUTS)}deg" for k in range(N_CUTS)]
)


# ---------------------------------------------------------------------------
# Geometria / features
# ---------------------------------------------------------------------------

def _haversine(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dphi = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 12742.0 * math.asin(math.sqrt(a))


def _bearing(lat1, lon1, lat2, lon2):
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    x = math.sin(dl) * math.cos(p2)
    y = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(x, y)) + 360) % 360


def pair_features(a, b, destino):
    """a, b: dicts com lat, lon, bairro(opcional). Vetor de features do par.
    Todas as features são invariantes a translação (valem em qualquer cidade)."""
    dist = _haversine(a["lat"], a["lon"], b["lat"], b["lon"])
    da = _haversine(a["lat"], a["lon"], destino["lat"], destino["lon"])
    db = _haversine(b["lat"], b["lon"], destino["lat"], destino["lon"])
    ba = _bearing(destino["lat"], destino["lon"], a["lat"], a["lon"])
    bb = _bearing(destino["lat"], destino["lon"], b["lat"], b["lon"])
    dbearing = abs((ba - bb + 180) % 360 - 180) / 180.0
    ddest_rel = abs(da - db) / max(da, db, 0.1)
    ba_name, bb_name = a.get("bairro"), b.get("bairro")
    same_bairro = 1.0 if (ba_name and bb_name and ba_name == bb_name) else 0.0
    log_dist = math.log1p(dist)
    # "Este par atravessa o corte k?" — deixa o modelo aprender ONDE (em
    # ângulo, para este destino) os operadores costumam separar rotas:
    # rio, avenida, ponte etc. Só faz sentido com modelo POR DESTINO.
    diff = (bb - ba + 180) % 360 - 180
    cuts = []
    for k in range(N_CUTS):
        rel = (k * 360.0 / N_CUTS - ba) % 360
        crosses = (0 < rel <= diff) if diff >= 0 else (rel >= 360 + diff and rel > 0)
        cuts.append(1.0 if crosses else 0.0)
    return [log_dist, dbearing, ddest_rel, same_bairro, math.log1p((da + db) / 2), log_dist * dbearing] + cuts


# ---------------------------------------------------------------------------
# Regressão logística (IRLS com ridge) + métricas
# ---------------------------------------------------------------------------

def _sigmoid(z):
    return 1.0 / (1.0 + np.exp(-np.clip(z, -30, 30)))


def _fit_logistic(X, y, w, l2=3.0, iters=40):
    n, d = X.shape
    Xb = np.hstack([np.ones((n, 1)), X])
    beta = np.zeros(d + 1)
    reg = np.eye(d + 1) * l2
    reg[0, 0] = 0.0
    for _ in range(iters):
        p = _sigmoid(Xb @ beta)
        W = w * p * (1 - p) + 1e-9
        grad = Xb.T @ (w * (y - p)) - reg @ beta
        hess = (Xb.T * W) @ Xb + reg
        step = np.linalg.solve(hess, grad)
        beta += step
        if np.max(np.abs(step)) < 1e-7:
            break
    return beta


def _auc(y, score):
    """AUC pela estatística de postos (Mann-Whitney). None se faltar uma classe."""
    y = np.asarray(y)
    pos, neg = int(y.sum()), int(len(y) - y.sum())
    if pos == 0 or neg == 0:
        return None
    order = np.argsort(score, kind="mergesort")
    ranks = np.empty(len(score))
    sorted_scores = np.asarray(score)[order]
    i = 0
    while i < len(sorted_scores):  # postos médios para empates
        j = i
        while j + 1 < len(sorted_scores) and sorted_scores[j + 1] == sorted_scores[i]:
            j += 1
        ranks[order[i:j + 1]] = (i + j) / 2.0 + 1
        i = j + 1
    return float((ranks[y == 1].sum() - pos * (pos + 1) / 2) / (pos * neg))


class PairModel:
    def __init__(self, beta, mean, std, base_rate, metrics):
        self.beta, self.mean, self.std = beta, mean, std
        self.base_rate = base_rate
        self.metrics = metrics

    def proba(self, x):
        z = (np.asarray(x, dtype=float) - self.mean) / self.std
        return float(_sigmoid(self.beta[0] + z @ self.beta[1:]))

    def coefficients(self):
        return {name: round(float(c), 3) for name, c in zip(FEATURE_NAMES, self.beta[1:])}


def build_pairs(scenario, rng):
    """scenario: {destino:{lat,lon}, tipo_origem, peso, pontos:[{lat,lon,bairro,rota_id}]}.
    Retorna (X, y, w) com pares a <= PAIR_RADIUS_KM. y=1 se mesma rota."""
    pts = scenario["pontos"]
    destino = scenario["destino"]
    w_scn = ORIGIN_WEIGHT.get(scenario["tipo_origem"], 0.0) * float(scenario.get("peso") or 1.0)
    if w_scn <= 0 or len(pts) < 3:
        return [], [], []
    cell = PAIR_RADIUS_KM / 111.0
    buckets = {}
    for idx, p in enumerate(pts):
        buckets.setdefault((int(p["lat"] // cell), int(p["lon"] // cell)), []).append(idx)
    cand = []
    for (cx, cy), members in buckets.items():
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                for j in buckets.get((cx + dx, cy + dy), []):
                    for i in members:
                        if i < j:
                            cand.append((i, j))
    if len(cand) > MAX_PAIRS_PER_SCENARIO:
        cand = rng.sample(cand, MAX_PAIRS_PER_SCENARIO)
    X, y, w = [], [], []
    for i, j in cand:
        a, b = pts[i], pts[j]
        if _haversine(a["lat"], a["lon"], b["lat"], b["lon"]) > PAIR_RADIUS_KM:
            continue
        X.append(pair_features(a, b, destino))
        y.append(1.0 if a["rota_id"] == b["rota_id"] else 0.0)
        w.append(w_scn)
    return X, y, w


def train(scenarios, seed=7):
    """Treina e valida (k-fold POR CENÁRIO, para não vazar pares do mesmo
    cenário entre treino e teste). Retorna PairModel ou None."""
    rng = random.Random(seed)
    per_scn = []
    for s in scenarios:
        X, y, w = build_pairs(s, rng)
        if len(y) >= 20:
            per_scn.append((np.array(X), np.array(y), np.array(w)))
    n_scn = len(per_scn)
    n_pairs = sum(len(p[1]) for p in per_scn)
    info = {"cenarios": n_scn, "pares": n_pairs, "treinado_em": int(time.time())}
    if n_scn < MIN_SCENARIOS or n_pairs < MIN_PAIRS:
        info["motivo"] = "dados insuficientes"
        logger.info("ML: dados insuficientes (%s cenários, %s pares).", n_scn, n_pairs)
        return None, info

    folds = min(5, n_scn)
    aucs, ll_model, ll_base = [], [], []
    for k in range(folds):
        tr = [p for i, p in enumerate(per_scn) if i % folds != k]
        te = [p for i, p in enumerate(per_scn) if i % folds == k]
        if not tr or not te:
            continue
        Xtr, ytr, wtr = (np.vstack([p[0] for p in tr]), np.concatenate([p[1] for p in tr]), np.concatenate([p[2] for p in tr]))
        Xte, yte = np.vstack([p[0] for p in te]), np.concatenate([p[1] for p in te])
        mean, std = Xtr.mean(0), Xtr.std(0) + 1e-9
        beta = _fit_logistic((Xtr - mean) / std, ytr, wtr)
        pte = np.clip(_sigmoid(beta[0] + ((Xte - mean) / std) @ beta[1:]), 1e-6, 1 - 1e-6)
        auc = _auc(yte, pte)
        if auc is not None:
            aucs.append(auc)
        base = float(np.average(ytr, weights=wtr))
        ll_model.append(float(-np.mean(yte * np.log(pte) + (1 - yte) * np.log(1 - pte))))
        ll_base.append(float(-np.mean(yte * np.log(base) + (1 - yte) * np.log(1 - base))))

    info["auc_cv"] = round(float(np.mean(aucs)), 3) if aucs else None
    info["logloss_modelo"] = round(float(np.mean(ll_model)), 4) if ll_model else None
    info["logloss_base"] = round(float(np.mean(ll_base)), 4) if ll_base else None
    if not aucs or info["auc_cv"] < MIN_AUC:
        info["motivo"] = f"AUC de validação ({info['auc_cv']}) abaixo do mínimo ({MIN_AUC})"
        logger.info("ML: %s", info["motivo"])
        return None, info

    Xall = np.vstack([p[0] for p in per_scn])
    yall = np.concatenate([p[1] for p in per_scn])
    wall = np.concatenate([p[2] for p in per_scn])
    mean, std = Xall.mean(0), Xall.std(0) + 1e-9
    beta = _fit_logistic((Xall - mean) / std, yall, wall)
    base_rate = float(np.clip(np.average(yall, weights=wall), 0.02, 0.98))
    info["taxa_base"] = round(base_rate, 3)
    model = PairModel(beta, mean, std, base_rate, info)
    info["coeficientes"] = model.coefficients()
    return model, info


# ---------------------------------------------------------------------------
# Interface compatível com HistoricalHints (usada pelo CostContext)
# ---------------------------------------------------------------------------

class MLHints:
    """Multiplicador de custo vindo do modelo, combinado (produto) com as
    pistas exatas do Cérebro (`base`, opcional). <1 aproxima, >1 afasta."""

    def __init__(self, model, destino, collaborators, lat_key, lon_key, base=None, strength=STRENGTH):
        self.model, self.destino, self.base, self.strength = model, destino, base, strength
        self._bairro = {}
        for c in collaborators:
            self._bairro[(round(c[lat_key], 5), round(c[lon_key], 5))] = c.get("bairro")
        self._logit_base = math.log(model.base_rate / (1 - model.base_rate))
        self._cache = {}

    def is_empty(self):
        return False

    def _bairro_of(self, lat, lon):
        return self._bairro.get((round(lat, 5), round(lon, 5)))

    def ml_factor(self, lat1, lon1, lat2, lon2):
        if _haversine(lat1, lon1, lat2, lon2) > PAIR_RADIUS_KM:
            return 1.0  # fora do domínio de treino: não opina
        key = frozenset({(round(lat1, 5), round(lon1, 5)), (round(lat2, 5), round(lon2, 5))})
        cached = self._cache.get(key)
        if cached is not None:
            return cached
        a = {"lat": lat1, "lon": lon1, "bairro": self._bairro_of(lat1, lon1)}
        b = {"lat": lat2, "lon": lon2, "bairro": self._bairro_of(lat2, lon2)}
        p = min(max(self.model.proba(pair_features(a, b, self.destino)), 1e-4), 1 - 1e-4)
        shift = math.log(p / (1 - p)) - self._logit_base
        value = min(max(math.exp(-self.strength * shift), FACTOR_MIN), FACTOR_MAX)
        self._cache[key] = value
        return value

    def factor(self, lat1, lon1, lat2, lon2):
        f = self.ml_factor(lat1, lon1, lat2, lon2)
        if self.base is not None and not self.base.is_empty():
            f *= self.base.factor(lat1, lon1, lat2, lon2)
        return min(max(f, FINAL_MIN), FINAL_MAX)

    # ------------------------------------------------------------------
    # Refinamento das FRONTEIRAS entre grupos (setores angulares)
    # ------------------------------------------------------------------
    def _affinity(self, c, group, lat_key, lon_key, k=6):
        """Média do 'quanto o modelo acha que c combina' com os k membros
        mais próximos do grupo (em log-odds relativo à taxa-base)."""
        near = sorted(
            (m for m in group if m["id"] != c["id"]),
            key=lambda m: _haversine(c[lat_key], c[lon_key], m[lat_key], m[lon_key]),
        )[:k]
        if not near:
            return 0.0
        total = 0.0
        for m in near:
            f = self.ml_factor(c[lat_key], c[lon_key], m[lat_key], m[lon_key])
            total += -math.log(f) / max(self.strength, 1e-6)  # inverte o fator => log-odds
        return total / len(near)

    def refine_groups(self, groups, capacity, lat_key, lon_key, margin=0.8, passes=3):
        """Move colaboradores de FRONTEIRA para o grupo vizinho quando o
        modelo indica que combinam bem mais com ele (ganho > `margin` em
        log-odds). Respeita capacidade (absoluta) e nunca esvazia um grupo.
        Vizinho = grupo adjacente na ordem da direção média."""
        groups = [list(g) for g in groups]
        if len(groups) < 2:
            return groups
        for _ in range(passes):
            order = sorted(
                range(len(groups)),
                key=lambda i: _circ_mean([m["bearing"] for m in groups[i]]) if groups[i] else 0.0,
            )
            moved = False
            for pos, i in enumerate(order):
                for j in (order[(pos + 1) % len(order)], order[(pos - 1) % len(order)]):
                    if i == j:
                        continue
                    for c in list(groups[i]):
                        if len(groups[i]) <= 1 or len(groups[j]) >= capacity:
                            break
                        ganho = self._affinity(c, groups[j], lat_key, lon_key) - self._affinity(c, groups[i], lat_key, lon_key)
                        if ganho > margin:
                            groups[i].remove(c)
                            groups[j].append(c)
                            moved = True
            if not moved:
                break
        return groups


def _circ_mean(bearings):
    if not bearings:
        return 0.0
    x = sum(math.cos(math.radians(b)) for b in bearings) / len(bearings)
    y = sum(math.sin(math.radians(b)) for b in bearings) / len(bearings)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


# ---------------------------------------------------------------------------
# Carga de dados do Supabase + cache do modelo
# ---------------------------------------------------------------------------

def _fetch_all(build_query, page=1000):
    rows, start = [], 0
    while True:
        chunk = build_query().range(start, start + page - 1).execute().data or []
        rows.extend(chunk)
        if len(chunk) < page:
            return rows
        start += page


def load_training_scenarios(client, destino, limit=300):
    margin = DEST_RADIUS_KM / 111.0
    cenarios = (
        client.table("cenarios")
        .select("id, destino_lat, destino_lon, tipo_origem, peso")
        .gte("destino_lat", destino["lat"] - margin).lte("destino_lat", destino["lat"] + margin)
        .gte("destino_lon", destino["lon"] - margin).lte("destino_lon", destino["lon"] + margin)
        .gt("peso", 0)
        .neq("tipo_origem", "AUTOMATICA_NAO_VALIDADA")
        .order("atualizado_em", desc=True)
        .limit(limit)
        .execute()
        .data
        or []
    )
    out = []
    for c in cenarios:
        rotas = _fetch_all(lambda: client.table("rotas").select("id").eq("cenario_id", c["id"]))
        rota_ids = [r["id"] for r in rotas]
        if not rota_ids:
            continue
        pontos = _fetch_all(
            lambda: client.table("pontos_rota").select("rota_id, latitude, longitude, bairro").in_("rota_id", rota_ids)
        )
        out.append({
            "destino": {"lat": c["destino_lat"], "lon": c["destino_lon"]},
            "tipo_origem": c["tipo_origem"],
            "peso": c.get("peso"),
            "pontos": [
                {"lat": p["latitude"], "lon": p["longitude"], "bairro": p.get("bairro"), "rota_id": p["rota_id"]}
                for p in pontos
            ],
        })
    return out


_MODEL_CACHE = {}  # chave: destino arredondado (2 casas ~ 1 km) -> {model, info, at}
DEST_RADIUS_KM = float(os.getenv("ML_DEST_RADIUS_KM", "3.0"))


def get_model(destino, force=False):
    """Retorna (PairModel|None, info) para um DESTINO. Treina só com cenários
    cujo destino está a <= DEST_RADIUS_KM (os cortes angulares só têm sentido
    em relação ao mesmo destino). Cache em memória por MODEL_TTL_S."""
    if not ML_ENABLED:
        return None, {"disponivel": False, "motivo": "ML desativado (ML_ENABLED=0)"}
    key = (round(destino["lat"], 2), round(destino["lon"], 2))
    entry = _MODEL_CACHE.get(key)
    if entry and not force and time.time() - entry["at"] < MODEL_TTL_S:
        return entry["model"], entry["info"]
    try:
        from . import knowledge_base as kb
    except ImportError:
        import knowledge_base as kb
    client = kb._get_client()
    if client is None:
        return None, {"disponivel": False, "motivo": "Supabase não configurado"}
    try:
        scenarios = [
            s for s in load_training_scenarios(client, destino)
            if _haversine(s["destino"]["lat"], s["destino"]["lon"], destino["lat"], destino["lon"]) <= DEST_RADIUS_KM
        ]
        model, info = train(scenarios)
    except Exception:
        logger.exception("ML: falha ao treinar — seguindo sem ML.")
        return None, {"disponivel": False, "motivo": "erro no treino (ver logs)"}
    info["disponivel"] = model is not None
    _MODEL_CACHE[key] = {"model": model, "info": info, "at": time.time()}
    return model, info


def build_ml_hints(collaborators, destino, lat_key, lon_key, base_hints=None):
    """Ponto de integração com main.py. Nunca lança; sem modelo utilizável
    devolve `base_hints` intacto (comportamento idêntico ao atual)."""
    try:
        model, _info = get_model(destino)
        if model is None:
            return base_hints
        return MLHints(model, destino, collaborators, lat_key, lon_key, base=base_hints)
    except Exception:
        logger.exception("ML: falha ao montar hints — seguindo sem ML.")
        return base_hints
