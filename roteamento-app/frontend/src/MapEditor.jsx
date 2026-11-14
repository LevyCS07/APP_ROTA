import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { api } from './api.js';
import RoutesPanel from './RoutesPanel.jsx';
import MapLegend from './MapLegend.jsx';
import { attachAreaSelection } from './areaSelection.js';
import { useFeedback } from './feedback.jsx';
import { NUMBER_MIN_ZOOM, pointIconSpec, routeColor } from './mapMarkers.js';

// order !== null desenha o número da sequência de embarque (só no Estado 3 -
// Edição); com rota atribuída, o marcador mostra o NÚMERO DA ROTA, para não
// depender só da cor (ver mapMarkers.js).
function pointIcon(routeId, options = {}) {
  const { size, html } = pointIconSpec(routeId, options);
  return L.divIcon({ className: '', iconAnchor: [size / 2, size / 2], html });
}

const EMPTY_PREVIEW = { loading: false, error: null, coordinates: [], waypoints: [], usedRealRoute: false };

// Serializa apenas o routeId de cada colaborador, para comparar "o que está
// salvo no servidor" com "o que está na tela" (ver estado `dirty`).
function snapshotAssignments(project) {
  return project.collaborators.map((c) => `${c.id}:${c.routeId ?? ''}`).sort().join('|');
}

// Como o anterior, mas inclui a ordem de embarque: a base de conhecimento
// também aprende com a sequência, então reordenar depois de salvar conta.
function snapshotFull(project) {
  return project.collaborators.map((c) => `${c.id}:${c.routeId ?? ''}:${c.order ?? ''}`).sort().join('|');
}

const KB_LABELS = {
  AUTOMATICA_APROVADA: 'Gerada automaticamente e aprovada sem alterações',
  AUTOMATICA_AJUSTADA: 'Gerada automaticamente e ajustada por você',
  MANUAL_VALIDADA: 'Criada manualmente'
};

export default function MapEditor({ project, setProject }) {
  const { toast, confirm } = useFeedback();
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const destinoMarkerRef = useRef(null);
  const markersRef = useRef({});
  const rectangleRef = useRef(null);
  const selectStartRef = useRef(null);
  const selectingRef = useRef(false);
  const fittedProjectRef = useRef(null);
  const trajetoLayerRef = useRef(null);

  const [selected, setSelected] = useState(new Set());
  const [bulkRoute, setBulkRoute] = useState(project.routes[0]?.id || 1);
  const [hiddenRoutes, setHiddenRoutes] = useState(new Set());
  // Ocultar/mostrar colaboradores por bairro (painel de bairros e zonas).
  const [hiddenBairros, setHiddenBairros] = useState(new Set());

  // Os 3 estados de visualização do mapa:
  //   Estado 1 (Geral)  -> selectedRouteId === null: todas as rotas normais.
  //   Estado 2 (Foco)   -> selectedRouteId definido, editingRouteId === null:
  //                        a rota selecionada em destaque, as demais esmaecidas.
  //   Estado 3 (Edição) -> editingRouteId === selectedRouteId: além do foco,
  //                        busca o trajeto real e habilita reordenar embarque.
  const [selectedRouteId, setSelectedRouteId] = useState(null);
  const [editingRouteId, setEditingRouteId] = useState(null);

  const [preview, setPreview] = useState(EMPTY_PREVIEW);
  // Espelha selectingRef em estado só para dar feedback visual no botão
  // "Selecionar área" (o ref sozinho é o que os handlers do mapa usam de fato).
  const [selecting, setSelecting] = useState(false);
  // Melhoria: indica se há atribuições feitas na tela que ainda não foram
  // confirmadas no backend (ex.: "Atribuir" sem depois clicar em "Salvar
  // edições"), para mostrar um aviso perto do botão de salvar.
  const [dirty, setDirty] = useState(false);
  const savedSnapshotRef = useRef(snapshotAssignments(project));
  // Persistência opcional na base de conhecimento (Supabase) — só acontece
  // quando o usuário clica no botão, nunca automaticamente.
  const [savingKnowledge, setSavingKnowledge] = useState(false);
  // Selo de status na base: "idle" (nunca salva), "saved" ou "stale" (salva,
  // mas a rota mudou depois). Só rotas salvas alimentam o Cérebro e o ML.
  const kbSavedSnapshotRef = useRef(project.conhecimentoRegistrado ? snapshotFull(project) : null);
  const [kbTipoOrigem, setKbTipoOrigem] = useState(null);
  const nudgedKbRef = useRef(false);
  let kbState = 'idle';
  if (project.conhecimentoRegistrado) {
    kbState = kbSavedSnapshotRef.current && snapshotFull(project) !== kbSavedSnapshotRef.current ? 'stale' : 'saved';
  }
  const kbStatus = { state: kbState, tipoOrigem: kbTipoOrigem, label: KB_LABELS[kbTipoOrigem] || null };

  // Desfazer/Refazer: guarda snapshots da lista de colaboradores (routeId +
  // order de cada um) antes de ações que valem a pena poder desfazer —
  // atribuir em massa e reordenar. Ações administrativas (nova rota, remover
  // rota, mudar capacidade) já têm seus próprios diálogos de confirmação e
  // ficam fora do histórico, para não confundir o que "desfazer" reverte.
  const undoStackRef = useRef([]);
  const redoStackRef = useRef([]);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  function pushHistory(collaboratorsSnapshot) {
    undoStackRef.current.push(collaboratorsSnapshot);
    if (undoStackRef.current.length > 25) undoStackRef.current.shift();
    redoStackRef.current = [];
    setCanUndo(true);
    setCanRedo(false);
  }

  function undo() {
    if (!undoStackRef.current.length) return;
    const previous = undoStackRef.current.pop();
    redoStackRef.current.push(project.collaborators);
    setProject((current) => ({ ...current, collaborators: previous }));
    setDirty(true);
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }

  function redo() {
    if (!redoStackRef.current.length) return;
    const next = redoStackRef.current.pop();
    undoStackRef.current.push(project.collaborators);
    setProject((current) => ({ ...current, collaborators: next }));
    setDirty(true);
    setCanUndo(true);
    setCanRedo(redoStackRef.current.length > 0);
  }

  // Atalhos de teclado: Ctrl/Cmd+Z desfaz, Ctrl/Cmd+Shift+Z (ou Ctrl+Y) refaz.
  useEffect(() => {
    function onKeyDown(e) {
      const ctrlOrCmd = e.ctrlKey || e.metaKey;
      if (!ctrlOrCmd) return;
      if (e.key.toLowerCase() === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((e.key.toLowerCase() === 'z' && e.shiftKey) || e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  function setSelectMode(value) {
    selectingRef.current = value;
    setSelecting(value);
  }

  // Melhoria: tecla Esc cancela o modo "Selecionar área" a qualquer momento,
  // inclusive no meio de um arrasto em andamento.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Escape' || !selectingRef.current) return;
      const map = mapRef.current;
      if (rectangleRef.current && map) {
        map.removeLayer(rectangleRef.current);
        rectangleRef.current = null;
        map.dragging.enable();
      }
      selectStartRef.current = null;
      setSelectMode(false);
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  // Mapa de colaboradorId -> posição na sequência de embarque, só relevante
  // no Estado 3 (Edição) — no Estado 2 (Foco) os pontos só ficam em destaque,
  // sem numeração de ordem.
  const orderByCollabId = new Map(
    editingRouteId
      ? project.collaborators
          .filter((c) => c.routeId === editingRouteId)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((c, index) => [c.id, index + 1])
      : []
  );

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map('map').setView([-3.119, -60.021], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);
    mapRef.current = map;
    const syncZoomClass = () =>
      map.getContainer().classList.toggle('map-low-zoom', map.getZoom() < NUMBER_MIN_ZOOM);
    map.on('zoomend', syncZoomClass);
    syncZoomClass();
    layerRef.current = L.markerClusterGroup({
      spiderfyOnMaxZoom: true,
      showCoverageOnHover: false,
      maxClusterRadius: 28,
      disableClusteringAtZoom: 18
    }).addTo(map);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Desenha/atualiza os marcadores dos colaboradores e do destino.
  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    markersRef.current = {};

    project.collaborators.forEach((collab) => {
      if (collab.routeId && hiddenRoutes.has(collab.routeId)) return;
      if (collab.bairro && hiddenBairros.has(collab.bairro)) return;
      const isSelected = selected.has(collab.id);
      const route = project.routes.find((item) => item.id === collab.routeId);
      const order = collab.routeId === editingRouteId ? orderByCollabId.get(collab.id) : null;
      const tooltip = collab.routeId
        ? `${order ? `#${order} · ` : ''}${collab.nome} (${route?.name || `Rota ${collab.routeId}`})`
        : `${collab.nome} (sem rota)`;
      const marker = L.marker([collab.lat, collab.lon], {
        icon: pointIcon(collab.routeId, { selected: isSelected, order })
      }).bindTooltip(tooltip);
      // Estado 2 (Foco) e Estado 3 (Edição): esmaece tudo que não pertence à
      // rota selecionada, para ela se destacar visualmente no mapa.
      if (selectedRouteId) {
        marker.setOpacity(collab.routeId === selectedRouteId ? 1 : 0.22);
      }
      marker.on('click', () => {
        setSelected((prev) => {
          const next = new Set(prev);
          if (next.has(collab.id)) next.delete(collab.id);
          else next.add(collab.id);
          return next;
        });
      });
      markersRef.current[collab.id] = marker;
      layer.addLayer(marker);
    });

    if (!destinoMarkerRef.current) {
      destinoMarkerRef.current = L.marker([project.destino.lat, project.destino.lon], {
        icon: L.divIcon({
          className: '',
          iconAnchor: [42, 12],
          html: '<div class="destino-marker">Destino</div>'
        })
      }).addTo(map);
    } else {
      destinoMarkerRef.current.setLatLng([project.destino.lat, project.destino.lon]);
    }

    if (fittedProjectRef.current !== project.id && project.collaborators.length) {
      const bounds = L.latLngBounds(project.collaborators.map((c) => [c.lat, c.lon]));
      bounds.extend([project.destino.lat, project.destino.lon]);
      map.fitBounds(bounds.pad(0.15));
      fittedProjectRef.current = project.id;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selected, hiddenRoutes, hiddenBairros, selectedRouteId, editingRouteId]);

  // Seleção de área por arrasto (retângulo). A lógica (botão direito, soltar
  // fora do mapa, perda de foco) fica em areaSelection.js.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    return attachAreaSelection({
      map,
      L,
      selectingRef,
      rectangleRef,
      selectStartRef,
      onSelectBounds: (bounds) => {
        const ids = project.collaborators
          .filter((c) => !c.routeId || !hiddenRoutes.has(c.routeId))
          .filter((c) => !c.bairro || !hiddenBairros.has(c.bairro))
          .filter((c) => bounds.contains(L.latLng(c.lat, c.lon)))
          .map((c) => c.id);
        setSelected((prev) => new Set([...prev, ...ids]));
      },
      onDone: () => setSelecting(false)
    });
  }, [project, hiddenRoutes, hiddenBairros]);

  // Envia ao backend o estado atual de atribuição de rotas (routeId de cada
  // colaborador). Ações como "Atribuir" só mudam o estado local no
  // navegador — sem isso, o servidor fica com uma versão desatualizada do
  // projeto, e endpoints que dependem dela (preview de trajeto, reordenar
  // embarque) passam a rejeitar os dados por não baterem com o que já foi
  // salvo. Por isso ela é chamada automaticamente antes dessas ações, além de
  // poder ser disparada manualmente pelo botão "Salvar edições".
  async function syncAssignments(nextProject = project) {
    const payload = {};
    nextProject.collaborators.forEach((c) => {
      payload[c.id] = c.routeId || null;
    });
    const updated = await api.saveAssignments(project.id, payload);
    savedSnapshotRef.current = snapshotAssignments(updated);
    setDirty(false);
    return updated;
  }

  async function saveAssignments(nextProject = project) {
    setProject(await syncAssignments(nextProject));
  }

  function drawTrajeto(coordinates) {
    const map = mapRef.current;
    if (trajetoLayerRef.current) {
      map.removeLayer(trajetoLayerRef.current);
      trajetoLayerRef.current = null;
    }
    if (coordinates?.length > 1) {
      const latlngs = coordinates.map(([lon, lat]) => [lat, lon]);
      trajetoLayerRef.current = L.polyline(latlngs, {
        color: routeColor(editingRouteId),
        weight: 4,
        opacity: 0.85
      }).addTo(map);
      return latlngs;
    }
    return null;
  }

  // Busca e desenha o trajeto real da rota em edição (Estado 3). Sincroniza
  // as atribuições com o backend primeiro, para garantir que o preview
  // reflita qualquer edição local ainda não salva.
  useEffect(() => {
    if (!editingRouteId) {
      if (trajetoLayerRef.current) {
        mapRef.current.removeLayer(trajetoLayerRef.current);
        trajetoLayerRef.current = null;
      }
      setPreview(EMPTY_PREVIEW);
      return;
    }

    let cancelled = false;
    setPreview({ ...EMPTY_PREVIEW, loading: true });

    (async () => {
      try {
        const synced = await syncAssignments();
        if (cancelled) return;
        setProject(synced);
        const data = await api.previewRoute(synced.id, editingRouteId, synced.tipoRota);
        if (cancelled) return;
        setPreview({
          loading: false,
          error: null,
          coordinates: data.coordinates,
          waypoints: data.waypoints,
          usedRealRoute: Boolean(data.usedOrs)
        });
        const latlngs = drawTrajeto(data.coordinates);
        if (latlngs) mapRef.current.fitBounds(L.latLngBounds(latlngs).pad(0.2));
      } catch (err) {
        if (cancelled) return;
        setPreview({ ...EMPTY_PREVIEW, error: err.message || 'Não foi possível calcular o trajeto.' });
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRouteId]);

  function applySelected() {
    pushHistory(project.collaborators);
    const next = {
      ...project,
      collaborators: project.collaborators.map((c) =>
        selected.has(c.id) ? { ...c, routeId: Number(bulkRoute) } : c
      )
    };
    setSelected(new Set());
    setProject(next);
    setDirty(snapshotAssignments(next) !== savedSnapshotRef.current);
  }

  function toggleHiddenRoute(routeId) {
    setHiddenRoutes((prev) => {
      const next = new Set(prev);
      if (next.has(routeId)) next.delete(routeId);
      else next.add(routeId);
      setSelected((current) => {
        const cleaned = new Set(current);
        project.collaborators.forEach((collab) => {
          if (collab.routeId === routeId) cleaned.delete(collab.id);
        });
        return cleaned;
      });
      return next;
    });
  }

  // Painel de bairros e zonas: ocultar/mostrar colaboradores por bairro.
  function toggleHiddenBairro(bairro) {
    setHiddenBairros((prev) => {
      const next = new Set(prev);
      if (next.has(bairro)) next.delete(bairro);
      else next.add(bairro);
      setSelected((current) => {
        const cleaned = new Set(current);
        project.collaborators.forEach((collab) => {
          if (collab.bairro === bairro) cleaned.delete(collab.id);
        });
        return cleaned;
      });
      return next;
    });
  }

  // Estado 2 (Foco): clicar numa rota compacta seleciona/desseleciona.
  // Trocar de rota selecionada sempre fecha a edição da rota anterior.
  function selectRoute(routeId) {
    setSelectedRouteId((current) => {
      setEditingRouteId(null);
      return current === routeId ? null : routeId;
    });
  }

  // Estado 3 (Edição): liga/desliga o modo ativo de edição (trajeto real +
  // reordenar embarque) da rota já selecionada.
  function toggleEditing(routeId) {
    setSelectedRouteId(routeId);
    setEditingRouteId((current) => (current === routeId ? null : routeId));
  }

  async function reorderFocusedRoute(orderedIds) {
    if (!editingRouteId) return;
    pushHistory(project.collaborators);
    setPreview((prev) => ({ ...prev, loading: true }));
    try {
      const synced = await syncAssignments();
      const updated = await api.reorderRoute(synced.id, editingRouteId, orderedIds);
      setProject(updated);
      const data = await api.previewRoute(updated.id, editingRouteId, updated.tipoRota);
      setPreview({
        loading: false,
        error: null,
        coordinates: data.coordinates,
        waypoints: data.waypoints,
        usedRealRoute: Boolean(data.usedOrs)
      });
      drawTrajeto(data.coordinates);
    } catch (err) {
      setPreview((prev) => ({ ...prev, loading: false }));
      toast.fail('Não foi possível salvar a nova ordem', err);
    }
  }

  // Ordena automaticamente a rota em edição: começa no colaborador mais
  // distante do destino e encadeia pelo vizinho mais próximo até o fim
  // (heurística do vizinho mais próximo). O cálculo é feito no backend, que
  // já tem as coordenadas de todos os colaboradores.
  async function autoOrderFocusedRoute(routeId) {
    if (!routeId) return;
    pushHistory(project.collaborators);
    setPreview((prev) => ({ ...prev, loading: true }));
    try {
      const synced = await syncAssignments();
      const updated = await api.autoOrderRoute(synced.id, routeId, synced.tipoRota);
      setProject(updated);
      const data = await api.previewRoute(updated.id, routeId, updated.tipoRota);
      setPreview({
        loading: false,
        error: null,
        coordinates: data.coordinates,
        waypoints: data.waypoints,
        usedRealRoute: Boolean(data.usedOrs)
      });
      const latlngs = drawTrajeto(data.coordinates);
      if (latlngs) mapRef.current.fitBounds(L.latLngBounds(latlngs).pad(0.2));
    } catch (err) {
      setPreview((prev) => ({ ...prev, loading: false }));
      toast.fail('Não foi possível ordenar automaticamente', err);
    }
  }

  // Cria a rota com a capacidade informada no formulário do painel (antes era
  // um prompt() do navegador). Devolve true/false para o formulário saber se fecha.
  async function addRoute(capacity) {
    try {
      // O servidor devolve o projeto inteiro: sincroniza antes para não
      // descartar atribuições feitas na tela e ainda não salvas.
      await syncAssignments();
      setProject(await api.addRoute(project.id, capacity));
      toast.success(`Nova rota criada (capacidade ${capacity}).`);
      return true;
    } catch (err) {
      toast.fail('Não foi possível criar a rota', err);
      return false;
    }
  }

  // Confirma antes de remover uma rota que ainda tem colaboradores, já que
  // eles voltam para "sem rota" imediatamente e isso não pode ser desfeito.
  async function removeRoute(routeId) {
    const route = project.routes.find((item) => item.id === routeId);
    const count = project.collaborators.filter((c) => c.routeId === routeId).length;
    if (count > 0) {
      const ok = await confirm({
        title: `Remover "${route?.name || routeId}"?`,
        message: `${count} colaborador${count === 1 ? '' : 'es'} dessa rota ficará${count === 1 ? '' : 'rão'} sem rota. Esta ação não pode ser desfeita.`,
        confirmLabel: 'Remover rota',
        danger: true
      });
      if (!ok) return;
    }
    try {
      await syncAssignments();
      if (selectedRouteId === routeId) setSelectedRouteId(null);
      if (editingRouteId === routeId) setEditingRouteId(null);
      setProject(await api.removeRoute(project.id, routeId));
      toast.success(`Rota "${route?.name || routeId}" removida.`);
    } catch (err) {
      toast.fail('Não foi possível remover a rota', err);
    }
  }

  async function updateRouteCapacity(routeId, capacity) {
    const nextCapacity = Math.max(1, Number(capacity || 1));
    setProject({
      ...project,
      routes: project.routes.map((route) =>
        route.id === routeId ? { ...route, capacity: nextCapacity } : route
      )
    });
    try {
      await api.updateRouteCapacity(project.id, routeId, nextCapacity);
    } catch (err) {
      // `key`: digitar vários números seguidos não empilha vários avisos.
      toast.fail('Não foi possível salvar a capacidade', err, { key: 'capacity-error' });
    }
  }

  async function handleSaveEdits() {
    try {
      await saveAssignments();
      toast.success('Edições salvas.', { duration: 2500, key: 'edits-saved' });
    } catch (err) {
      toast.fail('Não foi possível salvar as edições', err);
    }
  }

  async function downloadZip() {
    try {
      await syncAssignments();
      await api.downloadZip(project.id);
      toast.success('Arquivos baixados.', { duration: 3000, key: 'zip-downloaded' });
      // Baixar é o fim natural do trabalho: lembra (uma vez) de salvar na base,
      // porque só rotas salvas ajudam o sistema a aprender.
      if (project.conhecimentoDisponivel && kbState !== 'saved' && !nudgedKbRef.current) {
        nudgedKbRef.current = true;
        toast.info('Quer que o sistema aprenda com esta rota?', {
          description: 'Salvar na base ajuda o Cérebro e o ML a melhorar as próximas gerações.',
          action: { label: 'Salvar na base', onClick: saveToKnowledgeBase },
          duration: 15000
        });
      }
    } catch (err) {
      toast.fail('Não foi possível baixar os arquivos', err);
    }
  }

  // Persistência opcional: só acontece quando o usuário clica (ou aceita o lembrete).
  async function saveToKnowledgeBase() {
    setSavingKnowledge(true);
    try {
      // Antes enviava só o que o servidor já tinha: "Atribuir" muda apenas a
      // tela, então rotas editadas e não salvas iam desatualizadas para a base
      // (e a métrica de colaboradores movidos saía errada). Sincroniza primeiro.
      const synced = await syncAssignments();
      const result = await api.saveToKnowledgeBase(synced.id);
      const registered = { ...synced, conhecimentoRegistrado: true };
      kbSavedSnapshotRef.current = snapshotFull(registered);
      setKbTipoOrigem(result.tipoOrigem);
      setProject(registered);
      toast.success('Rota salva na base de conhecimento.', {
        description: KB_LABELS[result.tipoOrigem] || undefined
      });
    } catch (err) {
      toast.fail('Não foi possível salvar na base de conhecimento', err);
    } finally {
      setSavingKnowledge(false);
    }
  }

  // Fechar ou recarregar a aba descarta o editor (o projeto só existe em
  // memória na tela): avisa se há edições não salvas ou uma rota com trabalho
  // feito que ainda não foi para a base. O texto do aviso é do navegador.
  const hasAssigned = project.collaborators.some((c) => c.routeId);
  const kbPending = Boolean(project.conhecimentoDisponivel) && kbState !== 'saved' && hasAssigned;
  useEffect(() => {
    if (!dirty && !kbPending) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, kbPending]);

  const routeCollaborators = project.collaborators.filter((c) => c.routeId === editingRouteId);

  return (
    <div className="editor">
      <div className="map-wrap">
        <div id="map" />
        <MapLegend
          project={project}
          hiddenRoutes={hiddenRoutes}
          selectedRouteId={selectedRouteId}
          onSelectRoute={selectRoute}
        />
      </div>
      <RoutesPanel
        project={project}
        routeColor={routeColor}
        selectedCount={selected.size}
        bulkRoute={bulkRoute}
        setBulkRoute={setBulkRoute}
        onStartAreaSelect={() => setSelectMode(!selecting)}
        selecting={selecting}
        onApplySelected={applySelected}
        onClearSelection={() => setSelected(new Set())}
        onAddRoute={addRoute}
        onSaveAssignments={handleSaveEdits}
        onDownloadZip={downloadZip}
        onSaveToKnowledgeBase={saveToKnowledgeBase}
        savingKnowledge={savingKnowledge}
        kbStatus={kbStatus}
        dirty={dirty}
        canUndo={canUndo}
        canRedo={canRedo}
        onUndo={undo}
        onRedo={redo}
        hiddenRoutes={hiddenRoutes}
        hiddenBairros={hiddenBairros}
        onToggleHiddenBairro={toggleHiddenBairro}
        onToggleHiddenRoute={toggleHiddenRoute}
        onRemoveRoute={removeRoute}
        onUpdateRouteCapacity={updateRouteCapacity}
        selectedRouteId={selectedRouteId}
        editingRouteId={editingRouteId}
        onSelectRoute={selectRoute}
        onToggleEditing={toggleEditing}
        routeCollaborators={routeCollaborators}
        onReorderRoute={reorderFocusedRoute}
        onAutoOrderRoute={autoOrderFocusedRoute}
        preview={preview}
      />
    </div>
  );
}
