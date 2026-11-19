import { byOrder } from './orderUtils.js';
import { convexHull, haversineKm, legDistancesKm, pointInHull } from './geometry.js';

// Assinatura do que define o trajeto de uma rota (paradas, ordem e desvios):
// serve para saber se um trajeto já calculado (ORS) ficou desatualizado.
export function routeSignature(project, routeId) {
  const route = project.routes.find((r) => r.id === routeId);
  const ids = project.collaborators.filter((c) => c.routeId === routeId).sort(byOrder).map((c) => c.id);
  return `${ids.join(',')}|${JSON.stringify((route && route.vias) || [])}`;
}

export const LOW_OCCUPANCY = 0.5; // abaixo disso a rota é marcada como "pouco ocupada"

// Resumo de TODAS as rotas para a visão geral. `previews` guarda, por rota, o
// último trajeto real calculado: { sig, distanciaKm, duracaoMin, usedOrs }.
export function computeOverview(project, previews = {}) {
  const destino = project.destino;
  const stopsByRoute = new Map();
  project.collaborators.forEach((c) => {
    if (!c.routeId) return;
    if (!stopsByRoute.has(c.routeId)) stopsByRoute.set(c.routeId, []);
    stopsByRoute.get(c.routeId).push(c);
  });
  stopsByRoute.forEach((list) => list.sort(byOrder));

  const hulls = new Map();
  stopsByRoute.forEach((list, routeId) => hulls.set(routeId, convexHull(list)));

  // Quem está dentro da área (fecho convexo) de OUTRA rota.
  const overlapIds = new Set();
  const overlapWith = new Map();
  stopsByRoute.forEach((list, routeId) => {
    list.forEach((stop) => {
      hulls.forEach((hull, otherId) => {
        if (otherId !== routeId && pointInHull(hull, stop)) {
          overlapIds.add(stop.id);
          if (!overlapWith.has(routeId)) overlapWith.set(routeId, new Set());
          overlapWith.get(routeId).add(otherId);
        }
      });
    });
  });

  const limite = Number(project.limiteMinutos) || null;
  const rows = project.routes.map((route) => {
    const stops = stopsByRoute.get(route.id) || [];
    const legs = legDistancesKm(stops, destino);
    const real = previews[route.id];
    const realStale = Boolean(real) && real.sig !== routeSignature(project, route.id);
    const count = stops.length;
    const flags = [];
    if (count === 0) flags.push('empty');
    if (count > route.capacity) flags.push('over');
    if (count > 0 && count / route.capacity < LOW_OCCUPANCY) flags.push('low');
    if (limite && real && !realStale && real.duracaoMin > limite) flags.push('slow');
    return {
      id: route.id,
      name: route.name,
      count,
      capacity: route.capacity,
      occupancy: route.capacity > 0 ? count / route.capacity : 0,
      lineKm: legs.reduce((sum, km) => sum + km, 0),
      maxLegKm: legs.length ? Math.max(...legs) : 0,
      bairros: new Set(stops.map((s) => s.bairro).filter(Boolean)).size,
      overlapCount: stops.filter((s) => overlapIds.has(s.id)).length,
      overlapWith: [...(overlapWith.get(route.id) || [])],
      realKm: real ? real.distanciaKm : null,
      realMin: real ? real.duracaoMin : null,
      realStale,
      flags
    };
  });

  const active = rows.filter((r) => r.count > 0);
  const assigned = project.collaborators.filter((c) => c.routeId).length;
  const allReal = active.length > 0 && active.every((r) => r.realKm !== null && !r.realStale);
  return {
    rows,
    hulls,
    overlapIds,
    totals: {
      routes: project.routes.length,
      activeRoutes: active.length,
      assigned,
      unassigned: project.collaborators.length - assigned,
      occupancyAvg: active.length ? active.reduce((s, r) => s + r.occupancy, 0) / active.length : 0,
      lineKm: rows.reduce((s, r) => s + r.lineKm, 0),
      realKm: allReal ? active.reduce((s, r) => s + r.realKm, 0) : null,
      maxMin: allReal ? Math.max(...active.map((r) => r.realMin)) : null,
      minPeople: active.length ? Math.min(...active.map((r) => r.count)) : 0,
      maxPeople: active.length ? Math.max(...active.map((r) => r.count)) : 0,
      overlapPeople: overlapIds.size
    }
  };
}

export { haversineKm };
