// Seleção de área por arrasto (retângulo) no mapa Leaflet.
//
// Isolada do componente para poder ser testada. Corrige o "quadrado travado":
//  - só o botão ESQUERDO inicia a seleção (antes, o botão direito apertado no
//    meio do arrasto criava um 2º retângulo e o 1º ficava órfão na tela);
//  - nunca sobra um retângulo anterior ao iniciar uma nova seleção;
//  - clique direito durante o arrasto CANCELA o arrasto (sem abrir o menu do
//    navegador sobre o mapa) e o modo "Selecionar área" continua ativo;
//  - soltar o botão FORA do mapa conclui a seleção com o último retângulo;
//  - se o mouseup se perder (botão já solto ao mover), o arrasto é cancelado;
//  - perder o foco da janela (Alt+Tab) durante o arrasto também cancela.

export function attachAreaSelection({
  map,
  L,
  selectingRef,
  rectangleRef,
  selectStartRef,
  onSelectBounds,
  onDone
}) {
  const container = map.getContainer();
  const win = typeof window !== 'undefined' ? window : null;

  const isLeftButton = (originalEvent) =>
    !originalEvent || typeof originalEvent.button !== 'number' || originalEvent.button === 0;

  // Remove o retângulo, zera o início do arrasto e devolve o pan ao mapa.
  const clearDrag = () => {
    if (rectangleRef.current) {
      map.removeLayer(rectangleRef.current);
      rectangleRef.current = null;
    }
    selectStartRef.current = null;
    map.dragging.enable();
  };

  const finish = (bounds) => {
    onSelectBounds(bounds);
    clearDrag();
    selectingRef.current = false;
    onDone();
  };

  const onMouseDown = (e) => {
    if (!selectingRef.current) return;
    if (!isLeftButton(e.originalEvent)) return;
    clearDrag(); // garante que nunca sobre um retângulo de uma seleção anterior
    selectStartRef.current = e.latlng;
    map.dragging.disable();
    rectangleRef.current = L.rectangle([e.latlng, e.latlng], {
      color: '#facc15',
      weight: 1,
      fillColor: '#facc15',
      fillOpacity: 0.12
    }).addTo(map);
  };

  const onMouseMove = (e) => {
    if (!selectingRef.current || !selectStartRef.current || !rectangleRef.current) return;
    const buttons = e.originalEvent && e.originalEvent.buttons;
    if (typeof buttons === 'number' && (buttons & 1) === 0) {
      // O botão esquerdo já foi solto e o mouseup se perdeu: cancela o arrasto.
      clearDrag();
      return;
    }
    rectangleRef.current.setBounds(L.latLngBounds(selectStartRef.current, e.latlng));
  };

  const onMouseUp = (e) => {
    if (!selectingRef.current || !selectStartRef.current) return;
    if (!isLeftButton(e.originalEvent)) return; // soltar o botão direito não conclui
    finish(L.latLngBounds(selectStartRef.current, e.latlng));
  };

  // Soltou o botão esquerdo fora do mapa: o Leaflet não avisa; conclui aqui.
  const onWindowMouseUp = (ev) => {
    if (!selectingRef.current || !selectStartRef.current) return;
    if (ev.button !== 0) return;
    const rect = rectangleRef.current;
    if (!rect) {
      clearDrag();
      return;
    }
    finish(rect.getBounds());
  };

  // Clique direito: cancela o arrasto em andamento e não abre o menu do
  // navegador sobre o mapa enquanto o modo de seleção estiver ativo.
  const onContextMenu = (ev) => {
    if (!selectingRef.current) return;
    ev.preventDefault();
    if (selectStartRef.current) clearDrag();
  };

  const onWindowBlur = () => {
    if (selectStartRef.current) clearDrag();
  };

  map.on('mousedown', onMouseDown);
  map.on('mousemove', onMouseMove);
  map.on('mouseup', onMouseUp);
  container.addEventListener('contextmenu', onContextMenu);
  if (win) {
    win.addEventListener('mouseup', onWindowMouseUp);
    win.addEventListener('blur', onWindowBlur);
  }

  return () => {
    map.off('mousedown', onMouseDown);
    map.off('mousemove', onMouseMove);
    map.off('mouseup', onMouseUp);
    container.removeEventListener('contextmenu', onContextMenu);
    if (win) {
      win.removeEventListener('mouseup', onWindowMouseUp);
      win.removeEventListener('blur', onWindowBlur);
    }
  };
}
