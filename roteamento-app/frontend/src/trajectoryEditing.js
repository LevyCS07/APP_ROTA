// Ajuste do trajeto no mapa: arrastar a LINHA da rota cria um ponto de
// passagem (via) no local em que o usuário soltar, como no Google Maps.
//
// Só um arrasto de verdade cria a via (um clique simples na linha é ignorado,
// para não criar pontos sem querer). Botão direito, Esc e perda de foco
// cancelam. Isolado do componente para poder ser testado.

const MIN_DRAG_PX = 6;

export function attachViaCreate({ map, L, line, onCreate, onCancel, canStart }) {
  const win = typeof window !== 'undefined' ? window : null;
  let start = null; // { latlng, point }
  let ghost = null;
  let moved = false;

  const cleanup = () => {
    if (ghost) {
      map.removeLayer(ghost);
      ghost = null;
    }
    if (start) map.dragging.enable();
    start = null;
    moved = false;
  };

  const onDown = (e) => {
    if (canStart && !canStart()) return; // outro modo (selecionar área, clicar no mapa) está ativo
    const original = e.originalEvent;
    if (original && typeof original.button === 'number' && original.button !== 0) return;
    map.dragging.disable(); // sem isso o mapa inteiro arrastaria junto
    start = { latlng: e.latlng, point: map.latLngToContainerPoint(e.latlng) };
    ghost = L.circleMarker(e.latlng, { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1, interactive: false }).addTo(map);
  };

  const onMove = (e) => {
    if (!start || !ghost) return;
    ghost.setLatLng(e.latlng);
    if (map.latLngToContainerPoint(e.latlng).distanceTo(start.point) >= MIN_DRAG_PX) moved = true;
  };

  const finish = (latlng) => {
    if (!start) return;
    const created = moved;
    cleanup();
    if (created) onCreate(latlng);
    else if (onCancel) onCancel();
  };

  const onUp = (e) => finish(e.latlng);
  const onWindowUp = (ev) => {
    // Soltou o botão fora do mapa: conclui com a última posição conhecida.
    if (!start || (typeof ev.button === 'number' && ev.button !== 0)) return;
    finish(ghost ? ghost.getLatLng() : start.latlng);
  };
  const cancel = () => {
    if (!start) return;
    cleanup();
    if (onCancel) onCancel();
  };
  const onKey = (ev) => ev.key === 'Escape' && cancel();
  const onContext = (ev) => {
    if (start) ev.preventDefault();
    cancel();
  };

  line.on('mousedown', onDown);
  map.on('mousemove', onMove);
  map.on('mouseup', onUp);
  const container = map.getContainer();
  container.addEventListener('contextmenu', onContext);
  if (win) {
    win.addEventListener('mouseup', onWindowUp);
    win.addEventListener('keydown', onKey);
    win.addEventListener('blur', cancel);
  }

  return () => {
    cleanup();
    line.off('mousedown', onDown);
    map.off('mousemove', onMove);
    map.off('mouseup', onUp);
    container.removeEventListener('contextmenu', onContext);
    if (win) {
      win.removeEventListener('mouseup', onWindowUp);
      win.removeEventListener('keydown', onKey);
      win.removeEventListener('blur', cancel);
    }
  };
}
