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
  preview
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

      <div className="panel-section">
        <button onClick={onStartAreaSelect}>Selecionar área</button>
        <select value={bulkRoute} onChange={(e) => setBulkRoute(e.target.value)}>
          {project.routes.map((route) => (
            <option key={route.id} value={route.id}>{route.name}</option>
          ))}
        </select>
        <button onClick={onApplySelected}>Adicionar selecionados</button>
        <button className="secondary" onClick={onClearSelection}>Limpar seleção</button>
        <div className="muted">{selectedCount} selecionado(s)</div>
      </div>

      <div className="panel-section">
        <button onClick={onAddRoute}>Adicionar rota</button>
        <button className="primary" onClick={onSaveAssignments}>Salvar edições</button>
        <button className="primary" onClick={onDownloadZip}>Baixar KMLs e relatório</button>
      </div>

      <div className="routes-list">
        <div className="route-row sem-rota">
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
    </aside>
  );
}
