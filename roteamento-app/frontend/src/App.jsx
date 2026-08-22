import { useState } from 'react';
import { api, API_URL } from './api.js';
import DestinationPicker from './DestinationPicker.jsx';
import MapEditor from './MapEditor.jsx';

export default function App() {
  const [file, setFile] = useState(null);
  const [tipoRota, setTipoRota] = useState('Entrada');
  const [destino, setDestino] = useState({ lat: -3.119, lon: -60.021 });
  const [routeCount, setRouteCount] = useState(5);
  const [capacity, setCapacity] = useState(22);
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
      form.append('capacidades', JSON.stringify(Array.from({ length: routeCount }, () => Number(capacity))));
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
        <h1>Roteamento semi-automático</h1>
        <p className="setup-subtitle">Monte rotas por seleção visual no mapa e gere KMLs por ruas com ORS.</p>
        <label>Planilha Excel</label>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0])} />
        <div className="grid">
          <label>Tipo de coordenada para edição
            <select value={tipoRota} onChange={(e) => setTipoRota(e.target.value)}>
              <option>Entrada</option>
              <option>Saída</option>
            </select>
          </label>
          <label>Quantidade de rotas
            <input type="number" min="1" value={routeCount} onChange={(e) => setRouteCount(e.target.value)} />
          </label>
          <label>Capacidade
            <input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} />
          </label>
        </div>
        <div className="map-label">Selecione o destino</div>
        <DestinationPicker destino={destino} setDestino={setDestino} />
        <button className="primary" disabled={loading} onClick={createProject}>
          {loading ? 'Carregando...' : 'Abrir editor'}
        </button>
      </section>
    </main>
  );
}
