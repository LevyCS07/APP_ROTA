// Geometria simples para a visão geral das rotas (cidade inteira cabe num
// plano local, então lon/lat podem ser tratados como x/y para fecho convexo).

export function haversineKm(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}

const cross = (o, a, b) => (a.lon - o.lon) * (b.lat - o.lat) - (a.lat - o.lat) * (b.lon - o.lon);

// Fecho convexo (monotone chain), sentido anti-horário. Menos de 3 pontos
// não colineares => [] (não há "área" para desenhar nem para testar).
export function convexHull(points) {
  const unique = [...new Map(points.map((p) => [`${p.lat.toFixed(7)},${p.lon.toFixed(7)}`, p])).values()];
  if (unique.length < 3) return [];
  const sorted = unique.sort((p, q) => p.lon - q.lon || p.lat - q.lat);
  const build = (list) => {
    const hull = [];
    for (const p of list) {
      while (hull.length >= 2 && cross(hull[hull.length - 2], hull[hull.length - 1], p) <= 0) hull.pop();
      hull.push(p);
    }
    hull.pop();
    return hull;
  };
  const hull = [...build(sorted), ...build([...sorted].reverse())];
  return hull.length >= 3 ? hull : [];
}

// Ponto ESTRITAMENTE dentro do fecho (na borda conta como fora: um ponto
// idêntico a um vértice de outra rota não é "invasão" de área).
export function pointInHull(hull, p) {
  if (hull.length < 3) return false;
  for (let i = 0; i < hull.length; i++) {
    if (cross(hull[i], hull[(i + 1) % hull.length], p) <= 1e-12) return false;
  }
  return true;
}

// Distância (km, linha reta) de cada parada até a próxima; a última vai ao destino.
export function legDistancesKm(stops, destino) {
  return stops.map((stop, index) => haversineKm(stop, index + 1 < stops.length ? stops[index + 1] : destino));
}
