import { useEffect, useState } from 'react';
import { api } from './api.js';

const STATUS_LABELS = {
  MANUAL_VALIDADA: 'Criadas manualmente',
  AUTOMATICA_APROVADA: 'Automáticas aprovadas sem ajuste',
  AUTOMATICA_AJUSTADA: 'Automáticas ajustadas pelo usuário',
  AUTOMATICA_NAO_VALIDADA: 'Automáticas descartadas'
};

function pct(value) {
  return value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`;
}

function formatDia(iso) {
  if (!iso) return '';
  const [, month, day] = iso.split('-');
  return day && month ? `${day}/${month}` : iso;
}

function destinoStatus(d) {
  if (d.ativo) return { chip: 'ok', texto: 'ML ativo' };
  if (d.cenarios < d.minimo) return { chip: 'wait', texto: `Faltam ${d.minimo - d.cenarios} cenário(s)` };
  return { chip: 'off', texto: 'ML inativo' };
}

// Gráfico de barras em SVG puro (sem dependências): taxa de aprovação sem
// ajuste por janela de cenários automáticos, do mais antigo ao mais recente.
function ApprovalChart({ serie }) {
  const width = 600;
  const height = 170;
  const top = 18;
  const bottom = 34;
  const plotHeight = height - top - bottom;
  const slot = width / serie.length;
  const barWidth = Math.min(64, slot * 0.6);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Taxa de aprovação sem ajuste ao longo do tempo">
      {[0, 0.5, 1].map((tick) => (
        <g key={tick}>
          <line x1="0" x2={width} y1={top + plotHeight * (1 - tick)} y2={top + plotHeight * (1 - tick)} stroke="#e2e8f0" />
          <text x="2" y={top + plotHeight * (1 - tick) - 3} fontSize="10" fill="#94a3b8">{Math.round(tick * 100)}%</text>
        </g>
      ))}
      {serie.map((item, index) => {
        const h = Math.max(2, plotHeight * (item.taxa || 0));
        const x = index * slot + (slot - barWidth) / 2;
        return (
          <g key={index}>
            <rect x={x} y={top + plotHeight - h} width={barWidth} height={h} rx="4" fill="#7c3aed" />
            <text x={x + barWidth / 2} y={top + plotHeight - h - 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">
              {pct(item.taxa)}
            </text>
            <text x={x + barWidth / 2} y={height - 18} textAnchor="middle" fontSize="10" fill="#64748b">{formatDia(item.fim)}</text>
            <text x={x + barWidth / 2} y={height - 6} textAnchor="middle" fontSize="9" fill="#94a3b8">n={item.n}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Dashboard({ onBack }) {
  const [stats, setStats] = useState(null);
  const [learning, setLearning] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retraining, setRetraining] = useState(false);

  function load({ retrain = false } = {}) {
    setError('');
    if (retrain) setRetraining(true);
    else setLoading(true);
    return Promise.allSettled([api.getKnowledgeStats(), api.getLearningOverview({ retrain })])
      .then(([statsResult, learningResult]) => {
        if (statsResult.status === 'fulfilled') setStats(statsResult.value);
        // O resumo de aprendizado é um complemento: se falhar (backend antigo,
        // por exemplo), o histórico clássico continua aparecendo.
        if (learningResult.status === 'fulfilled') setLearning(learningResult.value);
        if (statsResult.status === 'rejected') {
          setError(statsResult.reason?.message || 'Não foi possível carregar o histórico.');
        }
      })
      .finally(() => {
        setLoading(false);
        setRetraining(false);
      });
  }

  useEffect(() => {
    load();
  }, []);

  const hasLearning = learning && learning.disponivel;
  const aprov = hasLearning ? learning.aprovacao : null;
  const tendencia = aprov?.tendenciaPontosPercentuais;
  const efeito = hasLearning ? learning.efeitoMl : null;
  const amostraPequena = efeito && (efeito.comMl.n < 5 || efeito.semMl.n < 5);

  return (
    <main className="setup">
      <section className="setup-card dashboard-card">
        <div className="dashboard-header">
          <div>
            <h1>Histórico de rotas</h1>
            <p className="setup-subtitle">
              O que o Cérebro (histórico no Supabase) e o modelo de ML já aprenderam com as gerações anteriores.
            </p>
          </div>
          <button className="secondary" onClick={onBack}>← Voltar</button>
        </div>

        {loading && <p className="muted-light">Carregando... (a primeira consulta pode levar alguns segundos enquanto o ML é treinado)</p>}
        {error && <p className="login-error">{error}</p>}

        {stats && !stats.disponivel && (
          <p className="muted-light">A base de conhecimento não está configurada neste backend.</p>
        )}

        {stats && stats.disponivel && (
          <>
            <h3 className="dashboard-section-title">Aprendizado</h3>
            <div className="dashboard-metrics learn-metrics">
              <div className="metric-card">
                <span className="metric-label">Cenários salvos</span>
                <strong className="metric-value">{stats.totalCenarios}</strong>
                {hasLearning && <span className="metric-sub">{learning.validados} validados (ensinam o Cérebro)</span>}
              </div>
              <div className="metric-card">
                <span className="metric-label">Padrões aprendidos</span>
                <strong className="metric-value">
                  {hasLearning ? learning.cerebro.conexoesFortes + learning.cerebro.penalizacoes : '—'}
                </strong>
                {hasLearning && (
                  <span className="metric-sub">
                    {learning.cerebro.conexoesFortes} conexões · {learning.cerebro.penalizacoes} penalizações
                  </span>
                )}
              </div>
              <div className="metric-card">
                <span className="metric-label">Aprovação sem ajuste</span>
                <strong className="metric-value">{hasLearning ? pct(aprov.taxaGeral) : '—'}</strong>
                {hasLearning && (
                  <span className="metric-sub">
                    {aprov.totalAutomaticos} automáticas
                    {tendencia !== null && tendencia !== undefined && (
                      <>
                        {' · '}
                        <span className={tendencia >= 0 ? 'trend-up' : 'trend-down'}>
                          {tendencia >= 0 ? '▲' : '▼'} {Math.abs(tendencia)} p.p.
                        </span>{' '}
                        vs. início
                      </>
                    )}
                  </span>
                )}
              </div>
              <div className="metric-card">
                <span className="metric-label">ML ativo</span>
                <strong className="metric-value">
                  {hasLearning ? `${learning.mlAtivoEm} de ${learning.destinos.length}` : '—'}
                </strong>
                {hasLearning && <span className="metric-sub">destinos com modelo aprovado</span>}
              </div>
            </div>

            {hasLearning && aprov.serie.length >= 2 && (
              <>
                <h3 className="dashboard-section-title">Evolução: automáticas aprovadas sem ajuste</h3>
                <p className="muted-light small">
                  Cada barra agrupa cenários automáticos consecutivos. Se o aprendizado ajuda, as barras tendem a subir.
                </p>
                <div className="chart-box"><ApprovalChart serie={aprov.serie} /></div>
                <div className="note-box">
                  Atenção: a taxa também depende do rigor de quem revisa e do tipo de planilha de cada dia. Use como
                  indício, não como prova.
                </div>
              </>
            )}
            {hasLearning && aprov.serie.length < 2 && (
              <p className="muted-light">
                A evolução aparece depois de pelo menos 4 cenários automáticos validados.
              </p>
            )}

            {hasLearning && efeito && (
              <>
                <h3 className="dashboard-section-title">Efeito do ML: com × sem</h3>
                <div className="compare-grid">
                  <div className="compare-card">
                    <span className="metric-label">Geradas COM ML</span>
                    <strong>{pct(efeito.comMl.taxa)}</strong>
                    <span className="metric-sub">aprovadas sem ajuste · {efeito.comMl.n} cenário(s)</span>
                  </div>
                  <div className="compare-card">
                    <span className="metric-label">Geradas SEM ML</span>
                    <strong>{pct(efeito.semMl.taxa)}</strong>
                    <span className="metric-sub">aprovadas sem ajuste · {efeito.semMl.n} cenário(s)</span>
                  </div>
                </div>
                {amostraPequena && (
                  <div className="note-box">
                    Amostra pequena (menos de 5 cenários em um dos lados): a diferença pode ser só acaso. Só
                    cenários gerados depois da ativação do ML contam como &quot;com ML&quot;.
                  </div>
                )}
              </>
            )}

            {hasLearning && learning.destinos.length > 0 && (
              <>
                <h3 className="dashboard-section-title">Modelo de ML por destino</h3>
                <p className="muted-light small">
                  O ML é treinado por destino. Ele só entra em ação com {learning.destinos[0].minimo}+ cenários
                  validados no destino e qualidade mínima na validação cruzada.
                </p>
                <div className="dashboard-status-list">
                  {learning.destinos.map((d, index) => {
                    const status = destinoStatus(d);
                    const progresso = Math.min(100, Math.round((d.cenarios / d.minimo) * 100));
                    return (
                      <div className="dest-row" key={index}>
                        <div className="dest-top">
                          <span>
                            Destino {d.lat.toFixed(4)}, {d.lon.toFixed(4)} · <strong>{d.cenarios}</strong> cenário(s)
                            {d.aucCv !== null && d.aucCv !== undefined && <> · AUC {d.aucCv}</>}
                          </span>
                          <span className={`chip ${status.chip}`}>{status.texto}</span>
                        </div>
                        <div className={`progress ${d.cenarios >= d.minimo ? 'done' : ''}`}>
                          <span style={{ width: `${progresso}%` }} />
                        </div>
                        {!d.ativo && d.cenarios >= d.minimo && d.motivo && (
                          <span className="muted-light small">Motivo: {d.motivo}</span>
                        )}
                      </div>
                    );
                  })}
                </div>
              </>
            )}

            {learning && !learning.disponivel && (
              <p className="muted-light">O resumo de aprendizado não está disponível agora.</p>
            )}

            <div className="dashboard-actions">
              <button className="secondary" onClick={() => load({ retrain: true })} disabled={retraining || loading}>
                {retraining ? 'Retreinando...' : 'Atualizar e retreinar ML'}
              </button>
              <span className="muted-light small">O modelo é guardado por 6 h; use este botão após salvar novos cenários.</span>
            </div>

            <h3 className="dashboard-section-title">Resumo do histórico</h3>
            <div className="dashboard-metrics">
              <div className="metric-card">
                <span className="metric-label">Ocupação média</span>
                <strong className="metric-value">{stats.ocupacaoMedia !== null ? `${Math.round(stats.ocupacaoMedia * 100)}%` : '—'}</strong>
              </div>
              <div className="metric-card">
                <span className="metric-label">Tempo total médio por cenário</span>
                <strong className="metric-value">{stats.tempoTotalMedioMin !== null ? `${Math.round(stats.tempoTotalMedioMin)} min` : '—'}</strong>
              </div>
            </div>

            <h3 className="dashboard-section-title">Por status</h3>
            <div className="dashboard-status-list">
              {Object.entries(STATUS_LABELS).map(([key, label]) => (
                <div className="status-row" key={key}>
                  <span>{label}</span>
                  <strong>{(stats.porStatus && stats.porStatus[key]) || 0}</strong>
                </div>
              ))}
            </div>
          </>
        )}
      </section>
    </main>
  );
}
