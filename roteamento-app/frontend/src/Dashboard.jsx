import { useEffect, useState } from 'react';
import { api } from './api.js';

const STATUS_LABELS = {
  MANUAL_VALIDADA: 'Criadas manualmente',
  AUTOMATICA_APROVADA: 'Automáticas aprovadas sem ajuste',
  AUTOMATICA_AJUSTADA: 'Automáticas ajustadas pelo usuário',
  AUTOMATICA_NAO_VALIDADA: 'Automáticas descartadas'
};

function formatPonto([lat, lon]) {
  return `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
}

export default function Dashboard({ onBack }) {
  const [stats, setStats] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    api.getKnowledgeStats()
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || 'Não foi possível carregar o histórico.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="setup">
      <section className="setup-card dashboard-card">
        <div className="dashboard-header">
          <div>
            <h1>Histórico de rotas</h1>
            <p className="setup-subtitle">O que a base de conhecimento (Supabase) já aprendeu com as gerações anteriores.</p>
          </div>
          <button className="secondary" onClick={onBack}>← Voltar</button>
        </div>

        {loading && <p className="muted-light">Carregando...</p>}
        {error && <p className="login-error">{error}</p>}

        {stats && !stats.disponivel && (
          <p className="muted-light">A base de conhecimento não está configurada neste backend.</p>
        )}

        {stats && stats.disponivel && (
          <>
            <div className="dashboard-metrics">
              <div className="metric-card">
                <span className="metric-label">Cenários salvos</span>
                <strong className="metric-value">{stats.totalCenarios}</strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Ocupação média</span>
                <strong className="metric-value">
                  {stats.ocupacaoMedia !== null ? `${Math.round(stats.ocupacaoMedia * 100)}%` : '—'}
                </strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Tempo total médio por cenário</span>
                <strong className="metric-value">
                  {stats.tempoTotalMedioMin !== null ? `${Math.round(stats.tempoTotalMedioMin)} min` : '—'}
                </strong>
              </div>
            </div>

            <h3 className="dashboard-section-title">Por status</h3>
            <div className="dashboard-status-list">
              {Object.entries(STATUS_LABELS).map(([key, label]) => (
                <div className="status-row" key={key}>
                  <span>{label}</span>
                  <strong>{stats.porStatus[key] || 0}</strong>
                </div>
              ))}
            </div>

            <div className="dashboard-columns">
              <div>
                <h3 className="dashboard-section-title">Conexões fortes mais frequentes</h3>
                <p className="muted-light small">Pares de pontos que o time tende a juntar na mesma rota.</p>
                {stats.topConexoesFortes.length === 0 && <p className="muted-light">Nenhuma ainda.</p>}
                <ul className="pair-list">
                  {stats.topConexoesFortes.map((pair, index) => (
                    <li key={index}>
                      <span>{formatPonto(pair.pontoA)} ↔ {formatPonto(pair.pontoB)}</span>
                      <strong>{pair.ocorrencias}×</strong>
                    </li>
                  ))}
                </ul>
              </div>
              <div>
                <h3 className="dashboard-section-title">Penalizações mais frequentes</h3>
                <p className="muted-light small">Pares de pontos que o time tende a separar em rotas diferentes.</p>
                {stats.topPenalizacoes.length === 0 && <p className="muted-light">Nenhuma ainda.</p>}
                <ul className="pair-list">
                  {stats.topPenalizacoes.map((pair, index) => (
                    <li key={index}>
                      <span>{formatPonto(pair.pontoA)} ↔ {formatPonto(pair.pontoB)}</span>
                      <strong>{pair.ocorrencias}×</strong>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
