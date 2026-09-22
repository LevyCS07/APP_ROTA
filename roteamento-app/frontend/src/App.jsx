import { useEffect, useState } from 'react';
import { api, API_URL, getToken, setUnauthorizedHandler } from './api.js';
import DestinationPicker from './DestinationPicker.jsx';
import MapEditor from './MapEditor.jsx';
import Login from './Login.jsx';
import Dashboard from './Dashboard.jsx';

// Mensagens rotativas exibidas enquanto o modo automático processa — ele
// pode levar alguns segundos (chamadas reais ao ORS), então dar contexto
// do que está acontecendo evita a sensação de "travou".
const AUTO_LOADING_HINTS = [
  'Agrupando colaboradores por direção e zona...',
  'Calculando distâncias e tempos reais pelas ruas...',
  'Testando estratégias diferentes de rotas...',
  'Ajustando ocupação e sequência de embarque...',
  'Quase lá — finalizando os detalhes...'
];

export default function App() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [view, setView] = useState('setup'); // 'setup' | 'dashboard'

  const [file, setFile] = useState(null);
  const [tipoRota, setTipoRota] = useState('Entrada');
  const [destino, setDestino] = useState({ lat: -3.119, lon: -60.021 });
  const [modo, setModo] = useState('manual');

  // Modo manual: quantidade fixa de rotas, todas vazias, o usuário monta tudo.
  const [routeCount, setRouteCount] = useState(5);
  const [capacity, setCapacity] = useState(22);

  // Modo automático: o pipeline decide a quantidade de rotas (se deixado em
  // branco) e já entrega tudo pré-atribuído; o usuário só refina depois.
  const [autoRouteCount, setAutoRouteCount] = useState('');
  const [autoDecideCount, setAutoDecideCount] = useState(true);
  const [veiculo, setVeiculo] = useState('');

  // Configurações avançadas do algoritmo automático (item "configuração de
  // pesos"): controlam a função de custo central do gerador de rotas.
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [modoFrota, setModoFrota] = useState('minimizar');
  const [metaOcupacao, setMetaOcupacao] = useState(85);
  const [limiteMinutos, setLimiteMinutos] = useState(90);
  const [pesoTempo, setPesoTempo] = useState(40);
  const [pesoCoerencia, setPesoCoerencia] = useState(25);
  const [pesoDistancia, setPesoDistancia] = useState(20);
  const [pesoOcupacao, setPesoOcupacao] = useState(15);
  const pesoSoma = pesoTempo + pesoCoerencia + pesoDistancia + pesoOcupacao;

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hintIndex, setHintIndex] = useState(0);

  // Alterna a dica exibida na animação de carregamento enquanto o modo
  // automático está processando.
  useEffect(() => {
    if (!loading || modo !== 'automatico') return;
    setHintIndex(0);
    const interval = setInterval(() => {
      setHintIndex((i) => (i + 1) % AUTO_LOADING_HINTS.length);
    }, 2500);
    return () => clearInterval(interval);
  }, [loading, modo]);

  // Autenticação: valida o token guardado (se houver) uma vez, ao carregar
  // o app. Se o backend não exigir token (APP_ACCESS_TOKEN não configurado),
  // essa checagem sempre passa e a tela de login nunca aparece.
  useEffect(() => {
    setUnauthorizedHandler(() => setAuthenticated(false));
    api.checkAuth(getToken())
      .then(() => setAuthenticated(true))
      .catch(() => setAuthenticated(false))
      .finally(() => setAuthChecked(true));
  }, []);

  async function createProject() {
    if (!file) return alert('Selecione a planilha.');
    if (modo === 'automatico' && pesoSoma === 0) {
      return alert('A soma dos pesos do algoritmo não pode ser zero.');
    }
    setLoading(true);
    try {
      const health = await api.health();
      if (!health.ok) throw new Error(`Backend respondeu ${health.status} em ${API_URL}/api/health`);

      const form = new FormData();
      form.append('file', file);
      form.append('destino_lat', destino.lat);
      form.append('destino_lon', destino.lon);
      form.append('tipo_rota', tipoRota);
      form.append('modo', modo);

      if (modo === 'automatico') {
        form.append('capacidade', String(Number(capacity)));
        form.append('quantidade_rotas', autoDecideCount ? '0' : String(Number(autoRouteCount) || 0));
        form.append('veiculo', veiculo);
        form.append('modo_frota', autoDecideCount ? 'minimizar' : modoFrota);
        form.append('meta_ocupacao', String(metaOcupacao / 100));
        form.append('limite_minutos', String(Number(limiteMinutos) || 90));
        form.append('peso_tempo', String(pesoTempo / 100));
        form.append('peso_coerencia', String(pesoCoerencia / 100));
        form.append('peso_distancia', String(pesoDistancia / 100));
        form.append('peso_ocupacao', String(pesoOcupacao / 100));
      } else {
        form.append('capacidade', String(Number(capacity)));
        form.append('quantidade_rotas', String(Number(routeCount) || 1));
      }

      setProject(await api.createProject(form));
    } catch (err) {
      alert(
        `Erro ao criar projeto: ${err.message}\n\n` +
        `API configurada no frontend: ${API_URL}\n\n` +
        'Se a API estiver como localhost ou se o teste /api/health falhar no navegador, ajuste VITE_API_URL na Vercel e faça redeploy.'
      );
    } finally {
      setLoading(false);
    }
  }

  if (!authChecked) return null;
  if (!authenticated) return <Login onSuccess={() => setAuthenticated(true)} />;
  if (project) return <MapEditor project={project} setProject={setProject} />;
  if (view === 'dashboard') return <Dashboard onBack={() => setView('setup')} />;

  return (
    <>
      {loading && (
        <div className="loading-overlay" role="status" aria-live="polite">
          <div className="spinner" />
          <p className="loading-title">
            {modo === 'automatico' ? 'Gerando rotas automaticamente...' : 'Preparando o editor...'}
          </p>
          {modo === 'automatico' && <p className="loading-hint">{AUTO_LOADING_HINTS[hintIndex]}</p>}
        </div>
      )}
      <main className="setup">
      <section className="setup-card">
        <h1>Roteamento</h1>
        <p className="setup-subtitle">Monte rotas por seleção visual no mapa e gere KMLs por ruas com ORS.</p>

        <label>Planilha Excel</label>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0])} />

        <div className="mode-toggle">
          <button
            type="button"
            className={`mode-btn ${modo === 'manual' ? 'active' : ''}`}
            onClick={() => setModo('manual')}
          >
            <strong>Manual</strong>
            <span>Você monta as rotas do zero no editor.</span>
          </button>
          <button
            type="button"
            className={`mode-btn ${modo === 'automatico' ? 'active' : ''}`}
            onClick={() => setModo('automatico')}
          >
            <strong>Automático</strong>
            <span>O sistema gera uma proposta de rotas pronta para você refinar.</span>
          </button>
        </div>

        <div className="grid">
          <label>Tipo de operação
            <select value={tipoRota} onChange={(e) => setTipoRota(e.target.value)}>
              <option>Entrada</option>
              <option>Saída</option>
            </select>
          </label>
          <label>Capacidade por rota
            <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </label>

          {modo === 'manual' ? (
            <label>Quantidade de rotas
              <input type="number" min="1" value={routeCount} onChange={(e) => setRouteCount(e.target.value)} />
            </label>
          ) : (
            <>
              <label>Tipo de veículo <span className="optional">(opcional)</span>
                <input
                  type="text"
                  placeholder="Ex.: Van, ônibus 44 lugares..."
                  value={veiculo}
                  onChange={(e) => setVeiculo(e.target.value)}
                />
              </label>
              <label className={autoDecideCount ? 'disabled-label' : ''}>
                Quantidade de rotas
                <input
                  type="number"
                  min="1"
                  disabled={autoDecideCount}
                  value={autoRouteCount}
                  placeholder="auto"
                  onChange={(e) => setAutoRouteCount(e.target.value)}
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={autoDecideCount}
                  onChange={(e) => setAutoDecideCount(e.target.checked)}
                />
                Deixar o sistema decidir a quantidade de rotas
              </label>
            </>
          )}
        </div>

        {modo === 'automatico' && (
          <>
            <p className="auto-hint">
              O sistema vai agrupar os colaboradores por região/direção em relação ao destino,
              respeitar a capacidade informada, definir uma sequência de embarque e já deixar
              tudo pronto na tela de edição para você ajustar o que quiser antes de exportar.
            </p>

            <button type="button" className="link-btn-light" onClick={() => setShowAdvanced((v) => !v)}>
              {showAdvanced ? 'Ocultar configurações avançadas ▲' : 'Configurações avançadas do algoritmo ▼'}
            </button>

            {showAdvanced && (
              <div className="advanced-panel">
                <div className="grid">
                  <label>Meta de ocupação ({metaOcupacao}%)
                    <input
                      type="range" min="50" max="100" step="5"
                      value={metaOcupacao}
                      onChange={(e) => setMetaOcupacao(Number(e.target.value))}
                    />
                  </label>
                  <label>Limite de tempo por rota (min)
                    <input
                      type="number" min="10" max="240"
                      value={limiteMinutos}
                      onChange={(e) => setLimiteMinutos(e.target.value)}
                    />
                  </label>
                  <label className={autoDecideCount ? 'disabled-label' : ''}>
                    Modo de frota
                    <select value={modoFrota} onChange={(e) => setModoFrota(e.target.value)} disabled={autoDecideCount}>
                      <option value="minimizar">Minimizar quantidade de rotas</option>
                      <option value="fixa">Usar exatamente a quantidade informada</option>
                    </select>
                  </label>
                </div>

                <p className="weights-title">Pesos da função de custo (soma: {pesoSoma}%)</p>
                <div className="grid weights-grid">
                  <label>Tempo ({pesoTempo}%)
                    <input type="range" min="0" max="100" value={pesoTempo} onChange={(e) => setPesoTempo(Number(e.target.value))} />
                  </label>
                  <label>Coerência geográfica ({pesoCoerencia}%)
                    <input type="range" min="0" max="100" value={pesoCoerencia} onChange={(e) => setPesoCoerencia(Number(e.target.value))} />
                  </label>
                  <label>Distância ({pesoDistancia}%)
                    <input type="range" min="0" max="100" value={pesoDistancia} onChange={(e) => setPesoDistancia(Number(e.target.value))} />
                  </label>
                  <label>Ocupação ({pesoOcupacao}%)
                    <input type="range" min="0" max="100" value={pesoOcupacao} onChange={(e) => setPesoOcupacao(Number(e.target.value))} />
                  </label>
                </div>
                <p className="weights-hint">
                  Não precisa somar exatamente 100% — o que importa é a proporção entre eles. Tempo pesa mais por padrão
                  porque uma rota mais longa incomoda mais do que uma com ocupação um pouco abaixo do ideal.
                </p>
              </div>
            )}
          </>
        )}

        <div className="map-label">Selecione o destino</div>
        <DestinationPicker destino={destino} setDestino={setDestino} />
        <button className="primary" disabled={loading} onClick={createProject}>
          {loading ? (modo === 'automatico' ? 'Gerando rotas...' : 'Carregando...') : 'Abrir editor'}
        </button>

        <div className="setup-footer-links">
          <button type="button" className="link-btn-light" onClick={() => setView('dashboard')}>
            Ver histórico de rotas
          </button>
        </div>
      </section>
      </main>
    </>
  );
}
