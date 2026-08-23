import RouteOrderList from './RouteOrderList.jsx';

function routeColorFor(routeId, routeColor) {
  return routeColor(routeId);
}

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
  hiddenRoutes,
  onToggleHiddenRoute,
  onRemoveRoute,
  onUpdateRouteCapacity,
  focusedRouteId,
  onToggleFocusRoute,
  routeCollaborators,
  onReorderRoute,
  onAutoOrderRoute,
  preview,
  dirty
}) {
  const counts = project.routes.map((route) => ({
    ...route,
    count: project.collaborators.filter((c) => c.routeId === route.id).length
  }));
  const semRota = project.collaborators.filter((c) => !c.routeId).length;

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

          <div className="routes-list">
            <div className={`route-row sem-rota ${semRota > 0 ? 'alert' : ''}`}>
              <span>Sem rota</span>
              <strong>{semRota}</strong>
            </div>

            {counts.map((route) => {
              const isFocused = focusedRouteId === route.id;
              return (
                <div
                  className={`route-row ${hiddenRoutes.has(route.id) ? 'hidden-route' : ''}`}
                  key={route.id}
                  style={{ borderLeftColor: routeColorFor(route.id, routeColor) }}
                >
                  <div className="route-main">
                    <span>{route.name}</span>
                    <strong>{route.count}/{route.capacity}</strong>
                  </div>
                  {typeof route.distanciaKm === 'number' && (
                    <p className="route-meta">
                      ≈{route.distanciaKm} km{route.usedOrs ? '' : ' (linha reta)'}
                      {typeof route.dispersaoGraus === 'number' ? ` · dispersão ${route.dispersaoGraus}°` : ''}
                    </p>
                  )}

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

                  <button
                    type="button"
                    className={`route-detail-toggle ${isFocused ? 'active' : ''}`}
                    onClick={() => onToggleFocusRoute(route.id)}
                  >
                    {isFocused ? 'Ocultar trajeto e ordem ▲' : 'Ver trajeto e ordem de embarque ▼'}
                  </button>

                  {isFocused && (
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
              );
            })}
          </div>
        </section>
      </div>

      <div className="panel-footer">
        {dirty && <p className="unsaved-note">Alterações não salvas</p>}
        <div className="footer-buttons">
          <button className="secondary" onClick={onSaveAssignments}>Salvar edições</button>
          <button className="primary" onClick={onDownloadZip}>Baixar KMLs e relatório</button>
        </div>
      </div>
    </aside>
  );
}
