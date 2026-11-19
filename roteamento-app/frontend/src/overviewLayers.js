import { byOrder } from './orderUtils.js';

// Desenha, no mapa, todas as rotas juntas para a visão geral:
//  - áreas (fecho convexo de cada rota), para ver sobreposição de território;
//  - linhas da ordem de embarque (parada a parada até o destino);
//  - trajetos reais (ORS) já calculados, quando pedidos.
// A rota em foco fica nítida e as demais esmaecem; rotas ocultas não aparecem.
export function drawOverview({ L, group, project, overview, options, hiddenRoutes, selectedRouteId, routeColor, previews = {} }) {
  group.clearLayers();
  const destino = [project.destino.lat, project.destino.lon];

  project.routes.forEach((route) => {
    if (hiddenRoutes.has(route.id)) return;
    const stops = project.collaborators.filter((c) => c.routeId === route.id).sort(byOrder);
    if (stops.length === 0) return;
    const color = routeColor(route.id);
    const dim = Boolean(selectedRouteId) && selectedRouteId !== route.id;
    const real = previews[route.id];

    if (options.areas) {
      const hull = overview.hulls.get(route.id) || [];
      if (hull.length >= 3) {
        L.polygon(hull.map((p) => [p.lat, p.lon]), {
          color,
          weight: 2,
          opacity: dim ? 0.25 : 0.9,
          fillColor: color,
          fillOpacity: dim ? 0.03 : 0.14,
          interactive: false
        }).addTo(group);
      }
    }

    if (options.lines) {
      L.polyline([...stops.map((c) => [c.lat, c.lon]), destino], {
        color,
        weight: dim ? 1.5 : 3,
        opacity: dim ? 0.25 : 0.75,
        dashArray: options.real && real ? '4 6' : null,
        interactive: false
      }).addTo(group);
    }

    if (options.real && real && real.coordinates && real.coordinates.length > 1) {
      L.polyline(real.coordinates.map(([lon, lat]) => [lat, lon]), {
        color,
        weight: dim ? 2 : 4,
        opacity: dim ? 0.3 : 0.9,
        interactive: false
      }).addTo(group);
    }
  });
}
