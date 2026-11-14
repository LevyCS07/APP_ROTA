import { useState } from 'react';
import { readableTextColor, routeColor } from './mapMarkers.js';

// Legenda flutuante sobre o mapa: número + cor + nome + ocupação de cada rota.
// Ajuda quem não distingue bem as cores (o número é o mesmo do marcador) e
// serve de atalho: clicar numa rota a coloca em foco, como na lista do painel.
export default function MapLegend({ project, hiddenRoutes, selectedRouteId, onSelectRoute }) {
  // Em telas estreitas o mapa é pequeno: começa recolhida.
  const [open, setOpen] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
    return !window.matchMedia('(max-width: 900px)').matches;
  });

  const counts = new Map();
  project.collaborators.forEach((c) => {
    if (c.routeId) counts.set(c.routeId, (counts.get(c.routeId) || 0) + 1);
  });
  const semRota = project.collaborators.filter((c) => !c.routeId).length;

  return (
    <div className="map-legend" role="region" aria-label="Legenda das rotas">
      <button
        type="button"
        className="map-legend-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Legenda · {project.routes.length} rota{project.routes.length === 1 ? '' : 's'} {open ? '▾' : '▸'}
      </button>

      {open && (
        <ul className="map-legend-list">
          {project.routes.map((route) => {
            const color = routeColor(route.id);
            const hidden = hiddenRoutes.has(route.id);
            return (
              <li key={route.id}>
                <button
                  type="button"
                  className={`legend-item ${selectedRouteId === route.id ? 'active' : ''} ${hidden ? 'hidden-route' : ''}`}
                  aria-pressed={selectedRouteId === route.id}
                  title={hidden ? `${route.name} (oculta no mapa)` : `Focar em ${route.name}`}
                  onClick={() => onSelectRoute(route.id)}
                >
                  <span className="legend-swatch" style={{ background: color, color: readableTextColor(color) }}>
                    {route.id}
                  </span>
                  <span className="legend-name">{route.name}</span>
                  <span className="legend-count">{counts.get(route.id) || 0}/{route.capacity}</span>
                </button>
              </li>
            );
          })}
          <li className="legend-none">
            <span className="legend-swatch square" aria-hidden="true" />
            <span className="legend-name">Sem rota</span>
            <span className="legend-count">{semRota}</span>
          </li>
        </ul>
      )}
    </div>
  );
}
