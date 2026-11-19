import { useState } from 'react';
import { readableTextColor, routeColor } from './mapMarkers.js';

const num = (value, digits = 1) => (value === null || value === undefined ? '—' : value.toFixed(digits).replace('.', ','));
const pct = (value) => `${Math.round(value * 100)}%`;

const FLAGS = {
  over: { text: '⚠ acima da capacidade', tone: 'bad' },
  slow: { text: '⏱ acima do limite de tempo', tone: 'bad' },
  low: { text: 'pouco ocupada', tone: 'warn' },
  empty: { text: 'vazia', tone: 'muted' }
};

// Distância/tempo mostrados na tabela: o trajeto real (ORS), se já foi
// calculado e está atualizado; senão a estimativa em linha reta.
const distance = (row) => (row.realKm !== null && !row.realStale ? row.realKm : row.lineKm);
const minutes = (row) => (row.realMin !== null && !row.realStale ? row.realMin : -1);

const SORTS = {
  id: (a, b) => a.id - b.id,
  count: (a, b) => a.count - b.count,
  occupancy: (a, b) => a.occupancy - b.occupancy,
  distance: (a, b) => distance(a) - distance(b),
  time: (a, b) => minutes(a) - minutes(b),
  bairros: (a, b) => a.bairros - b.bairros,
  overlap: (a, b) => a.overlapCount - b.overlapCount
};

const COLUMNS = [
  ['id', 'Rota'],
  ['count', 'Pessoas'],
  ['occupancy', 'Ocup.'],
  ['distance', 'Dist.'],
  ['time', 'Tempo'],
  ['bairros', 'Bairros'],
  ['overlap', 'Sobrep.']
];

// Visão geral: todas as rotas lado a lado para medir como a divisão está no
// conjunto (equilíbrio, ocupação, distâncias, sobreposição de áreas e alertas).
export default function OverviewPanel({
  overview,
  options,
  onOptionsChange,
  selectedRouteId,
  onSelectRoute,
  hiddenRoutes,
  computing,
  onComputeReal,
  onCancelCompute
}) {
  const [sort, setSort] = useState({ key: 'id', dir: 1 });
  const { rows, totals } = overview;
  const ordered = [...rows].sort((a, b) => SORTS[sort.key](a, b) * sort.dir || a.id - b.id);
  const stale = rows.filter((r) => r.count > 0 && (r.realKm === null || r.realStale)).length;

  function toggleSort(key) {
    setSort((current) => (current.key === key ? { key, dir: -current.dir } : { key, dir: 1 }));
  }

  const setOption = (name) => (event) => onOptionsChange({ ...options, [name]: event.target.checked });

  return (
    <section className="panel-section overview-section">
      <div className="overview-cards">
        <div className="ov-card">
          <span>Rotas ativas</span>
          <strong>{totals.activeRoutes}/{totals.routes}</strong>
        </div>
        <div className={`ov-card ${totals.unassigned > 0 ? 'warn' : ''}`}>
          <span>Alocados</span>
          <strong>{totals.assigned}</strong>
          <small>{totals.unassigned} sem rota</small>
        </div>
        <div className="ov-card">
          <span>Ocupação média</span>
          <strong>{pct(totals.occupancyAvg)}</strong>
          <small>{totals.activeRoutes > 0 ? `${totals.minPeople} a ${totals.maxPeople} pessoas por rota` : '—'}</small>
        </div>
        <div className="ov-card">
          <span>Distância total</span>
          <strong>{totals.realKm !== null ? `${num(totals.realKm)} km` : `≈ ${num(totals.lineKm)} km`}</strong>
          <small>{totals.realKm !== null ? 'pelas ruas' : 'linha reta (estimativa)'}</small>
        </div>
        <div className="ov-card">
          <span>Maior tempo</span>
          <strong>{totals.maxMin !== null ? `${Math.round(totals.maxMin)} min` : '—'}</strong>
          <small>{totals.maxMin !== null ? 'entre as rotas' : 'calcule os trajetos'}</small>
        </div>
        <div className={`ov-card ${totals.overlapPeople > 0 ? 'warn' : ''}`} title="Pessoas dentro da área (fecho convexo) de outra rota">
          <span>Sobreposição</span>
          <strong>{totals.overlapPeople}</strong>
          <small>pessoas na área de outra rota</small>
        </div>
      </div>

      <fieldset className="overview-layers">
        <legend>No mapa</legend>
        <label><input type="checkbox" checked={options.areas} onChange={setOption('areas')} /> Áreas</label>
        <label><input type="checkbox" checked={options.lines} onChange={setOption('lines')} /> Linhas de ordem</label>
        <label><input type="checkbox" checked={options.real} onChange={setOption('real')} /> Trajetos reais</label>
      </fieldset>

      <div className="overview-compute">
        {computing ? (
          <>
            <span className="status">Calculando trajetos… {computing.done}/{computing.total}</span>
            <button type="button" className="mini" onClick={onCancelCompute}>Cancelar</button>
          </>
        ) : (
          <button type="button" className="mini accent" onClick={onComputeReal} disabled={totals.activeRoutes === 0}>
            {stale > 0 ? `Calcular trajetos reais (${stale} pendente${stale === 1 ? '' : 's'})` : 'Recalcular trajetos reais'}
          </button>
        )}
      </div>

      <div className="table-scroll">
        <table className="overview-table">
          <thead>
            <tr>
              {COLUMNS.map(([key, label]) => (
                <th key={key} aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
                  <button type="button" onClick={() => toggleSort(key)}>
                    {label}{sort.key === key ? (sort.dir === 1 ? ' ▲' : ' ▼') : ''}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {ordered.map((row) => {
              const color = routeColor(row.id);
              const exact = row.realKm !== null && !row.realStale;
              return (
                <tr
                  key={row.id}
                  className={`${selectedRouteId === row.id ? 'selected' : ''} ${hiddenRoutes.has(row.id) ? 'hidden-route' : ''}`}
                  onClick={() => onSelectRoute(row.id)}
                >
                  <td>
                    <span className="ov-swatch" style={{ background: color, color: readableTextColor(color) }}>{row.id}</span>
                    <span className="ov-name">{row.name}</span>
                    {row.flags.length > 0 && (
                      <span className="ov-flags">
                        {row.flags.map((flag) => (
                          <em key={flag} className={`flag ${FLAGS[flag].tone}`}>{FLAGS[flag].text}</em>
                        ))}
                      </span>
                    )}
                  </td>
                  <td>{row.count}/{row.capacity}</td>
                  <td>
                    <span className="occ-bar" aria-hidden="true"><i style={{ width: `${Math.min(100, row.occupancy * 100)}%`, background: row.flags.includes('over') ? '#ef4444' : color }} /></span>
                    {pct(row.occupancy)}
                  </td>
                  <td title={exact ? 'Trajeto real (ORS)' : 'Linha reta (estimativa)'}>{exact ? '' : '≈'}{num(distance(row))} km</td>
                  <td title={row.realStale ? 'Desatualizado: a rota mudou depois do cálculo' : undefined}>
                    {minutes(row) >= 0 ? `${Math.round(minutes(row))} min` : row.realStale ? 'desatual.' : '—'}
                  </td>
                  <td>{row.bairros}</td>
                  <td title={row.overlapWith.length ? `Dentro da área de: ${row.overlapWith.join(', ')}` : undefined} className={row.overlapCount > 0 ? 'bad' : ''}>
                    {row.overlapCount}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Clique numa rota para colocá-la em foco. Sobreposição = pessoas dentro da área de outra rota (marcadas com anel
        vermelho no mapa). O limite de tempo e a ocupação mínima vêm das configurações da geração.
      </p>
    </section>
  );
}
