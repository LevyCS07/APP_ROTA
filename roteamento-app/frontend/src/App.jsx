import { useState } from 'react';
import { api, API_URL } from './api.js';
import DestinationPicker from './DestinationPicker.jsx';
import MapEditor from './MapEditor.jsx';

export default function App() {
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

  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(false);

  async function createProject() {
    if (!file) return alert('Selecione a planilha.');
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

  if (project) return <MapEditor project={project} setProject={setProject} />;

  return (
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
          <p className="auto-hint">
            O sistema vai agrupar os colaboradores por região/direção em relação ao destino,
            respeitar a capacidade informada, definir uma sequência de embarque e já deixar
            tudo pronto na tela de edição para você ajustar o que quiser antes de exportar.
          </p>
        )}

        <div className="map-label">Selecione o destino</div>
        <DestinationPicker destino={destino} setDestino={setDestino} />
        <button className="primary" disabled={loading} onClick={createProject}>
          {loading ? (modo === 'automatico' ? 'Gerando rotas...' : 'Carregando...') : 'Abrir editor'}
        </button>
      </section>
    </main>
  );
}
