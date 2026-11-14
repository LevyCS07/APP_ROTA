import { useState } from 'react';
import RouteOrderList from './RouteOrderList.jsx';

export default function RoutesPanel({
  project,
  routeColor,
  selectedCount,
  bulkRoute,
  setBulkRoute,
  onStartAreaSelect,
  selecting,
  onApplySelected,
  onClearSelection,
  onAddRoute,
  onSaveAssignments,
  onDownloadZip,
  onSaveToKnowledgeBase,
  savingKnowledge,
  kbStatus = { state: 'idle' },
  dirty,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  hiddenRoutes,
  onToggleHiddenRoute,
  hiddenBairros,
  onToggleHiddenBairro,
  onRemoveRoute,
  onUpdateRouteCapacity,
  selectedRouteId,
  editingRouteId,
  onSelectRoute,
  onToggleEditing,
  routeCollaborators,
  onReorderRoute,
  onAutoOrderRoute,
  preview
}) {
  // Seletor de rotas pesquisável — essencial quando há muitas rotas geradas
  // automaticamente e o usuário quer achar uma específica rápido.
  const [routeSearch, setRouteSearch] = useState('');
  // Painel de bairros e zonas: fechado por padrão para não ocupar espaço à toa.
  const [showRegions, setShowRegions] = useState(false);

  // Formulário de nova rota (substitui o prompt() do navegador).
  const [showNewRoute, setShowNewRoute] = useState(false);
  const [newCap, setNewCap] = useState('');
  const [newCapError, setNewCapError] = useState('');
  const [creatingRoute, setCreatingRoute] = useState(false);

  function openNewRoute() {
    // Sugere a capacidade da última rota criada (ou 22, o padrão do sistema).
    const last = project.routes[project.routes.length - 1];
    setNewCap(String(last?.capacity ?? 22));
    setNewCapError('');
    setShowNewRoute(true);
  }

  function closeNewRoute() {
    setShowNewRoute(false);
    setNewCapError('');
  }

  async function submitNewRoute(event) {
    event.preventDefault();
    const capacity = Number(newCap);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 200) {
      setNewCapError('Informe uma capacidade inteira entre 1 e 200.');
      return;
    }
    setCreatingRoute(true);
    const created = await onAddRoute(capacity);
    setCreatingRoute(false);
    if (created) closeNewRoute();
  }

  const allCounts = project.routes.map((route) => ({
    ...route,
    count: project.collaborators.filter((c) => c.routeId === route.id).length
  }));
  const query = routeSearch.trim().toLowerCase();
  const visibleCounts = query ? allCounts.filter((route) => route.name.toLowerCase().includes(query)) : allCounts;
  const semRota = project.collaborators.filter((c) => !c.routeId).length;

  // Só entram na lista bairros/zonas que realmente têm colaborador — nada
  // de listar todo bairro do GeoJSON à toa (pedido explícito).
  const bairroCounts = {};
  const zonaCounts = {};
  project.collaborators.forEach((c) => {
    if (c.bairro) bairroCounts[c.bairro] = (bairroCounts[c.bairro] || 0) + 1;
    if (c.zona) zonaCounts[c.zona] = (zonaCounts[c.zona] || 0) + 1;
  });
  const bairroEntries = Object.entries(bairroCounts).sort((a, b) => b[1] - a[1]);
  const zonaEntries = Object.entries(zonaCounts).sort((a, b) => b[1] - a[1]);

  // Cartão de status na base de conhecimento (só rotas salvas ajudam a aprender).
  const kbTitle = {
    idle: '● Ainda não está na base de conhecimento',
    saved: '✓ Salva na base de conhecimento',
    stale: '● Salva, mas alterada depois'
  }[kbStatus.state];
  const kbSub = {
    idle: 'Só rotas salvas ajudam o Cérebro e o ML a aprender.',
    saved: kbStatus.label || 'Nenhuma alteração desde que foi salva.',
    stale: 'Atualize para a base refletir a versão final.'
  }[kbStatus.state];
  const kbButton = savingKnowledge
    ? 'Salvando na base...'
    : kbStatus.state === 'stale'
      ? 'Atualizar na base'
      : 'Salvar na base de conhecimento';

  return (
    <aside className="panel">
      <div className="panel-header">
        <h2>Editor de rotas</h2>
        <p>Selecione pontos no mapa e envie para uma rota.</p>
        {project.modo === 'automatico' && (
          <p className="brain-badge" title="O Cérebro usa cenários validados parecidos; o ML ajusta as fronteiras entre rotas.">
            🧠 Cérebro: {project.cenariosSimilaresUsados || 0} cenário(s) semelhante(s) ·{' '}
            {project.experimentoAB ? (
              <strong className="on">teste A/B em andamento</strong>
            ) : (
              <strong className={project.mlUsado ? 'on' : 'off'}>ML {project.mlUsado ? 'ativo' : 'inativo'}</strong>
            )}
          </p>
        )}
      </div>

      <div className="panel-body">
        {/* Fluxo do dia a dia: os dois passos que você repete o tempo todo
            ficam juntos, numerados, e a ação de atribuir só liga quando
            existe seleção — reduz clique em botão errado. */}
        <section className="panel-section workflow-section">
          <h3 className="section-title"><span className="step-badge">1</span>Selecionar no mapa</h3>
          <div className="workflow-row">
            <button
              type="button"
              className={`select-area-btn ${selecting ? 'active' : ''}`}
              onClick={onStartAreaSelect}
            >
              {selecting ? '◻ Arraste no mapa…' : '◻ Selecionar área'}
            </button>
            <button type="button" className="link-btn" onClick={onClearSelection} disabled={selectedCount === 0}>
              Limpar
            </button>
          </div>
          <p className="muted">Clique em pontos individuais ou arraste um retângulo no mapa.</p>

          <h3 className="section-title"><span className="step-badge">2</span>Atribuir à rota</h3>
          <div className="workflow-row">
            <select value={bulkRoute} onChange={(e) => setBulkRoute(e.target.value)}>
              {project.routes.map((route) => (
                <option key={route.id} value={route.id}>{route.name}</option>
              ))}
            </select>
            <button type="button" className="primary cta" disabled={selectedCount === 0} onClick={onApplySelected}>
              Atribuir{selectedCount > 0 ? ` (${selectedCount})` : ''}
            </button>
          </div>
        </section>

        {/* Painel de bairros e zonas: quantidade de colaboradores por região,
            e a possibilidade de ocultar/mostrar por bairro no mapa. */}
        {(bairroEntries.length > 0 || zonaEntries.length > 0) && (
          <section className="panel-section regions-section">
            <button type="button" className="link-btn-dark" onClick={() => setShowRegions((v) => !v)}>
              {showRegions
                ? 'Bairros e zonas ▲'
                : `Bairros e zonas (${bairroEntries.length} bairros, ${zonaEntries.length} zonas) ▼`}
            </button>

            {showRegions && (
              <div className="regions-panel">
                {zonaEntries.length > 0 && (
                  <>
                    <p className="regions-subtitle">Zonas</p>
                    <ul className="region-list">
                      {zonaEntries.map(([zona, count]) => (
                        <li key={zona}>
                          <span>{zona}</span>
                          <strong>{count}</strong>
                        </li>
                      ))}
                    </ul>
                  </>
                )}

                {bairroEntries.length > 0 && (
                  <>
                    <p className="regions-subtitle">Bairros</p>
                    <ul className="region-list toggleable">
                      {bairroEntries.map(([bairro, count]) => (
                        <li key={bairro} className={hiddenBairros.has(bairro) ? 'hidden' : ''}>
                          <span title={bairro}>{bairro}</span>
                          <strong>{count}</strong>
                          <button type="button" className="mini" onClick={() => onToggleHiddenBairro(bairro)}>
                            {hiddenBairros.has(bairro) ? 'Mostrar' : 'Ocultar'}
                          </button>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}
          </section>
        )}

        <section className="panel-section routes-section">
          <div className="routes-header">
            <h3 className="section-title">Rotas</h3>
            <button type="button" className="add-route-pill" onClick={showNewRoute ? closeNewRoute : openNewRoute} aria-expanded={showNewRoute}>
              {showNewRoute ? 'Cancelar' : '+ Nova rota'}
            </button>
          </div>

          {showNewRoute && (
            <form className="new-route-form" onSubmit={submitNewRoute}>
              <label htmlFor="new-route-capacity">Capacidade da nova rota</label>
              <div className="new-route-row">
                <input
                  id="new-route-capacity"
                  type="number"
                  min="1"
                  max="200"
                  inputMode="numeric"
                  autoFocus
                  value={newCap}
                  aria-invalid={Boolean(newCapError)}
                  aria-describedby={newCapError ? 'new-route-error' : undefined}
                  onChange={(e) => { setNewCap(e.target.value); setNewCapError(''); }}
                  onKeyDown={(e) => e.key === 'Escape' && closeNewRoute()}
                />
                <button type="submit" className="mini create" disabled={creatingRoute}>
                  {creatingRoute ? 'Criando…' : 'Criar'}
                </button>
              </div>
              {newCapError && <p id="new-route-error" className="field-error" role="alert">{newCapError}</p>}
            </form>
          )}

          <input
            type="search"
            className="route-search"
            placeholder={`Buscar entre ${allCounts.length} rota${allCounts.length === 1 ? '' : 's'}...`}
            value={routeSearch}
            onChange={(e) => setRouteSearch(e.target.value)}
          />

          <div className="routes-list">
            {!query && (
              <div className={`route-row sem-rota ${semRota > 0 ? 'alert' : ''}`}>
                <span>Sem rota</span>
                <strong>{semRota}</strong>
              </div>
            )}

            {visibleCounts.map((route) => {
              const isSelected = selectedRouteId === route.id;
              const isEditing = editingRouteId === route.id;
              return (
                <div
                  className={`route-row compact ${hiddenRoutes.has(route.id) ? 'hidden-route' : ''} ${isSelected ? 'selected' : ''}`}
                  key={route.id}
                  style={{ borderLeftColor: routeColor(route.id) }}
                >
                  <button type="button" className="route-row-main" onClick={() => onSelectRoute(route.id)}>
                    <span>{route.name}</span>
                    <strong>{route.count}/{route.capacity}</strong>
                  </button>

                  {/* Detalhes só aparecem ao selecionar a rota (Estado 2 -
                      Foco): capacidade, ocultar/remover, distância,
                      dispersão e status do ORS ficam escondidos até então. */}
                  {isSelected && (
                    <div className="route-row-details">
                      {typeof route.distanciaKm === 'number' && (
                        <p className="route-meta">
                          ≈{route.distanciaKm} km{route.usedOrs ? '' : ' (linha reta)'}
                          {typeof route.dispersaoGraus === 'number' ? ` · dispersão ${route.dispersaoGraus}°` : ''}
                        </p>
                      )}

                      <div className="route-row-controls">
                        <label className="capacity-field">Cap.
                          <input
                            type="number"
                            min="1"
                            value={route.capacity}
                            onChange={(e) => onUpdateRouteCapacity(route.id, e.target.value)}
                          />
                        </label>
                        <div className="route-actions">
                          <button className="mini" onClick={() => onToggleHiddenRoute(route.id)}>
                            {hiddenRoutes.has(route.id) ? 'Mostrar' : 'Ocultar'}
                          </button>
                          <button className="mini danger" onClick={() => onRemoveRoute(route.id)} disabled={project.routes.length <= 1}>
                            Remover
                          </button>
                        </div>
                      </div>

                      <button
                        type="button"
                        className={`route-detail-toggle ${isEditing ? 'active' : ''}`}
                        onClick={() => onToggleEditing(route.id)}
                      >
                        {isEditing ? 'Fechar edição de ordem ▲' : 'Ver trajeto e editar ordem ▼'}
                      </button>

                      {/* Ordem de embarque e trajeto real só carregam no
                          Estado 3 (Edição) — modo ativo de modificação. */}
                      {isEditing && (
                        <div className="route-details">
                          {preview.loading && <span className="status">Calculando trajeto...</span>}
                          {preview.error && <span className="status error">{preview.error}</span>}
                          {!preview.loading && !preview.error && (
                            <span className="status">
                              {preview.usedRealRoute
                                ? 'Trajeto calculado pelas ruas (ORS).'
                                : 'Linha reta entre os pontos (defina ORS_API_KEY no backend para trajeto real).'}
                            </span>
                          )}
                          <button
                            type="button"
                            className="auto-order-btn"
                            disabled={preview.loading || routeCollaborators.length < 2}
                            onClick={() => onAutoOrderRoute(route.id)}
                          >
                            Ordenar automaticamente (mais distante → destino)
                          </button>
                          <p className="muted small">
                            Arraste um colaborador para reposicionar, ou use as setas para ajustes finos.
                          </p>
                          <RouteOrderList
                            collaborators={routeCollaborators}
                            onReorder={onReorderRoute}
                            disabled={preview.loading}
                          />
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            {visibleCounts.length === 0 && (
              <p className="muted route-search-empty">Nenhuma rota encontrada para "{routeSearch}".</p>
            )}
          </div>
        </section>
      </div>

      <div className="panel-footer">
        {dirty && <p className="unsaved-note">Alterações não salvas</p>}
        <div className="footer-buttons undo-redo-row">
          <button type="button" className="mini" onClick={onUndo} disabled={!canUndo} title="Desfazer (Ctrl+Z)">
            ↶ Desfazer
          </button>
          <button type="button" className="mini" onClick={onRedo} disabled={!canRedo} title="Refazer (Ctrl+Shift+Z)">
            ↷ Refazer
          </button>
        </div>
        <div className="footer-buttons">
          <button className="secondary" onClick={onSaveAssignments}>Salvar edições</button>
          <button className="primary" onClick={onDownloadZip}>Baixar KMLs e relatório</button>
        </div>
        {project.conhecimentoDisponivel && (
          <div className={`kb-card ${kbStatus.state}`}>
            <p className="kb-title">{kbTitle}</p>
            <p className="kb-sub">{kbSub}</p>
            {kbStatus.state !== 'saved' && (
              <button
                type="button"
                className="knowledge-btn"
                onClick={onSaveToKnowledgeBase}
                disabled={savingKnowledge}
              >
                {kbButton}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}
