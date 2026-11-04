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

// Gráfico de barras em SVG puro (sem dependências). `valueKey` escolhe o campo
// de cada ponto (taxa de aprovação ou fração média de colaboradores movidos).
function BarChart({ serie, valueKey, color, label }) {
  const width = 600;
  const height = 170;
  const top = 18;
  const bottom = 34;
  const plotHeight = height - top - bottom;
  const slot = width / serie.length;
  const barWidth = Math.min(64, slot * 0.6);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
      {[0, 0.5, 1].map((tick) => (
        <g key={tick}>
          <line x1="0" x2={width} y1={top + plotHeight * (1 - tick)} y2={top + plotHeight * (1 - tick)} stroke="#e2e8f0" />
          <text x="2" y={top + plotHeight * (1 - tick) - 3} fontSize="10" fill="#94a3b8">{Math.round(tick * 100)}%</text>
        </g>
      ))}
      {serie.map((item, index) => {
        const value = item[valueKey] || 0;
        const h = Math.max(2, plotHeight * value);
        const x = index * slot + (slot - barWidth) / 2;
        return (
          <g key={index}>
            <rect x={x} y={top + plotHeight - h} width={barWidth} height={h} rx="4" fill={color} />
            <text x={x + barWidth / 2} y={top + plotHeight - h - 4} textAnchor="middle" fontSize="11" fontWeight="700" fill="#334155">
              {pct(value)}
            </text>
            <text x={x + barWidth / 2} y={height - 18} textAnchor="middle" fontSize="10" fill="#64748b">{formatDia(item.fim)}</text>
            <text x={x + barWidth / 2} y={height - 6} textAnchor="middle" fontSize="9" fill="#94a3b8">n={item.n}</text>
          </g>
        );
      })}
    </svg>
  );
}

function vereditoInfo(ab) {
  const min = ab.minimoPorGrupo;
  switch (ab.veredito) {
    case 'sem_dados':
      return { classe: 'neutral', texto: 'Teste ligado, aguardando as primeiras gerações automáticas salvas na base.' };
    case 'amostra_insuficiente':
      return {
        classe: 'neutral',
        texto: `Ainda sem veredito: são necessários pelo menos ${min} cenários salvos com a métrica em cada grupo (agora: ML ${ab.ml?.nMovida ?? 0}, controle ${ab.controle?.nMovida ?? 0}).`
      };
    case 'ml_melhor':
      return { classe: 'ok', texto: `O ML parece reduzir as correções: ${Math.abs(ab.diferencaPontosPercentuais)} p.p. a menos de colaboradores movidos (p = ${ab.pValor}).` };
    case 'ml_pior':
      return { classe: 'bad', texto: `O ML parece AUMENTAR as correções: ${Math.abs(ab.diferencaPontosPercentuais)} p.p. a mais de colaboradores movidos (p = ${ab.pValor}). Considere desligá-lo (ML_ENABLED=0).` };
    default:
      return { classe: 'neutral', texto: `Sem diferença clara entre os grupos (p = ${ab.pValor}).` };
  }
}

export default function Dashboard({ onBack }) {
  const [stats, setStats] = useState(null);
  const [learning, setLearning] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [retraining, setRetraining] = useState(false);
  const [metrica, setMetrica] = useState('aprovacao');

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
  const ajuste = hasLearning ? learning.ajuste : null;
  const ab = hasLearning ? learning.experimentoAB : null;

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
                <span className="metric-label">Colaboradores movidos</span>
                <strong className="metric-value">{hasLearning && ajuste.n > 0 ? pct(ajuste.media) : '—'}</strong>
                {hasLearning && (
                  <span className="metric-sub">
                    {ajuste.n > 0 ? `média em ${ajuste.n} cenário(s) · menor é melhor` : 'aparece após salvar novos cenários'}
                    {ajuste.tendenciaPontosPercentuais !== null && ajuste.tendenciaPontosPercentuais !== undefined && (
                      <>
                        {' · '}
                        <span className={ajuste.tendenciaPontosPercentuais <= 0 ? 'trend-up' : 'trend-down'}>
                          {ajuste.tendenciaPontosPercentuais <= 0 ? '▼' : '▲'} {Math.abs(ajuste.tendenciaPontosPercentuais)} p.p.
                        </span>
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

            {hasLearning && (
              <>
                <h3 className="dashboard-section-title">Evolução</h3>
                <div className="seg" role="tablist">
                  <button className={metrica === 'aprovacao' ? 'active' : ''} onClick={() => setMetrica('aprovacao')}>
                    Aprovadas sem ajuste
                  </button>
                  <button className={metrica === 'movidos' ? 'active' : ''} onClick={() => setMetrica('movidos')}>
                    Colaboradores movidos
                  </button>
                </div>
                {metrica === 'aprovacao' ? (
                  <p className="muted-light small">Cada barra agrupa cenários automáticos consecutivos. Se o aprendizado ajuda, as barras tendem a subir.</p>
                ) : (
                  <p className="muted-light small">
                    % de colaboradores que o usuário trocou de rota em relação à sugestão automática. Aqui, quanto
                    MENOR, melhor. Só cenários salvos depois desta atualização têm essa medida.
                  </p>
                )}
                {metrica === 'aprovacao' && aprov.serie.length >= 2 && (
                  <div className="chart-box"><BarChart serie={aprov.serie} valueKey="taxa" color="#7c3aed" label="Taxa de aprovação sem ajuste" /></div>
                )}
                {metrica === 'movidos' && ajuste.serie.length >= 2 && (
                  <div className="chart-box"><BarChart serie={ajuste.serie} valueKey="media" color="#f59e0b" label="Fração média de colaboradores movidos" /></div>
                )}
                {((metrica === 'aprovacao' && aprov.serie.length < 2) || (metrica === 'movidos' && ajuste.serie.length < 2)) && (
                  <p className="muted-light">O gráfico aparece depois de pelo menos 4 cenários automáticos salvos com essa medida.</p>
                )}
                <div className="note-box">
                  Atenção: os resultados também dependem do rigor de quem revisa e do tipo de planilha de cada dia. Use
                  como indício; a comparação mais confiável é o teste A/B abaixo.
                </div>
              </>
            )}

            {hasLearning && (
              <>
                <h3 className="dashboard-section-title">Teste A/B do ML (sorteio aleatório)</h3>
                {!ab && (
                  <p className="muted-light small">
                    Desligado. Para ligar, defina <strong>ML_AB=1</strong> nas variáveis do Render. Em cada geração
                    automática de um destino com modelo aprovado, o sistema sorteia (50/50) se o ML é usado. O
                    revisor não vê o sorteio, e depois de {learning.experimentoAB?.minimoPorGrupo || 10} cenários
                    salvos por grupo este painel mostra se o ML realmente reduz as correções.
                  </p>
                )}
                {ab && (
                  <>
                    <div className="compare-grid">
                      <div className="compare-card">
                        <span className="metric-label">Grupo COM ML</span>
                        <strong>{ab.ml ? pct(ab.ml.mediaMovida) : '—'}</strong>
                        <span className="metric-sub">
                          colaboradores movidos (média) · {ab.ml ? ab.ml.nMovida : 0} cenário(s) · aprovação {ab.ml ? pct(ab.ml.taxa) : '—'}
                        </span>
                      </div>
                      <div className="compare-card">
                        <span className="metric-label">Grupo SEM ML (controle)</span>
                        <strong>{ab.controle ? pct(ab.controle.mediaMovida) : '—'}</strong>
                        <span className="metric-sub">
                          colaboradores movidos (média) · {ab.controle ? ab.controle.nMovida : 0} cenário(s) · aprovação {ab.controle ? pct(ab.controle.taxa) : '—'}
                        </span>
                      </div>
                    </div>
                    {(() => {
                      const info = vereditoInfo(ab);
                      return <div className={`verdict ${info.classe}`}>{info.texto}</div>;
                    })()}
                    <p className="muted-light small">
                      p-valor = chance de ver uma diferença assim apenas por acaso; abaixo de 0,05 costuma-se considerar
                      a diferença real. O teste está {ab.ativo ? 'ligado' : 'desligado'} agora.
                    </p>
                  </>
                )}
              </>
            )}

            {hasLearning && efeito && (
              <>
                <h3 className="dashboard-section-title">Com × sem ML (observacional, não sorteado)</h3>
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
