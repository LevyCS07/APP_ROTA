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
  dirty,
  hiddenRoutes,
  onToggleHiddenRoute,
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

  const allCounts = project.routes.map((route) => ({
    ...route,
    count: project.collaborators.filter((c) => c.routeId === route.id).length
  }));
  const query = routeSearch.trim().toLowerCase();
  const visibleCounts = query ? allCounts.filter((route) => route.name.toLowerCase().includes(query)) : allCounts;
  const semRota = project.collaborators.filter((c) => !c.routeId).length;

  const knowledgeLabel = savingKnowledge
    ? 'Salvando no histórico...'
    : project.conhecimentoRegistrado
      ? '✓ Salvo — salvar de novo'
      : 'Salvar esta geração no histórico';

  return (
    <aside className="panel">
      <div className="panel-header">
        <h2>Editor de rotas</h2>
        <p>Selecione pontos no mapa e envie para uma rota.</p>
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

        <section className="panel-section routes-section">
          <div className="routes-header">
            <h3 className="section-title">Rotas</h3>
            <button type="button" className="add-route-pill" onClick={onAddRoute}>+ Nova rota</button>
          </div>

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
        <div className="footer-buttons">
          <button className="secondary" onClick={onSaveAssignments}>Salvar edições</button>
          <button className="primary" onClick={onDownloadZip}>Baixar KMLs e relatório</button>
        </div>
        {project.conhecimentoDisponivel && (
          <button
            type="button"
            className={`knowledge-btn ${project.conhecimentoRegistrado ? 'saved' : ''}`}
            onClick={onSaveToKnowledgeBase}
            disabled={savingKnowledge}
          >
            {knowledgeLabel}
          </button>
        )}
      </div>
    </aside>
  );
}
