import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { api } from './api.js';
import RoutesPanel from './RoutesPanel.jsx';
import MapLegend from './MapLegend.jsx';
import { attachAreaSelection } from './areaSelection.js';
import { useFeedback } from './feedback.jsx';
import { NUMBER_MIN_ZOOM, pointIconSpec, routeColor } from './mapMarkers.js';
import { applyOrder, completeSequence, orderedIds, sameIds } from './orderUtils.js';
import { computeOverview, routeSignature } from './routeMetrics.js';
import { drawOverview } from './overviewLayers.js';
import { attachViaCreate } from './trajectoryEditing.js';

// order !== null desenha o número da sequência de embarque (só no Estado 3 -
// Edição); com rota atribuída, o marcador mostra o NÚMERO DA ROTA, para não
// depender só da cor (ver mapMarkers.js).
function pointIcon(routeId, options = {}) {
  const { size, html } = pointIconSpec(routeId, options);
  return L.divIcon({ className: '', iconAnchor: [size / 2, size / 2], html });
}

const EMPTY_PREVIEW = {
  loading: false,
  error: null,
  coordinates: [],
  waypoints: [],
  usedRealRoute: false,
  distanciaKm: null,
  duracaoMin: null,
  maxVias: null,
  delta: null // variação de km/min em relação ao trajeto anterior (após uma edição)
};

const round6 = (value) => Math.round(value * 1e6) / 1e6;
const COMMIT_DELAY_MS = 450; // espera o usuário parar de mexer antes de falar com o servidor

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

  // Painel: "rotas" (edição) ou "visao" (todas as rotas juntas, para medir o conjunto).
  const [panelView, setPanelView] = useState('rotas');
  const [overviewOptions, setOverviewOptions] = useState({ areas: true, lines: true, real: false });
  const [routePreviews, setRoutePreviews] = useState({}); // trajetos reais já calculados, por rota
  const [computingReal, setComputingReal] = useState(null); // { done, total } enquanto calcula
  const computeTokenRef = useRef(0);
  const overviewLayerRef = useRef(null);

  // Modo "definir a ordem clicando nos pontos do mapa".
  const [sequence, setSequence] = useState(null); // null | { picked: [ids] }
  const sequenceRef = useRef(null);
  sequenceRef.current = sequence;
  const sequenceActionsRef = useRef({});

  // Edição com a tela na frente: a lista e o mapa mudam NA HORA; o servidor é
  // atualizado em segundo plano (ver scheduleCommit). Os refs dão aos
  // callbacks do Leaflet sempre o valor mais recente.
  const projectRef = useRef(project);
  projectRef.current = project;
  const editingRouteIdRef = useRef(null);
  editingRouteIdRef.current = editingRouteId;
  const commitTimerRef = useRef(null);
  const syncChainRef = useRef(Promise.resolve());
  const previewTokenRef = useRef(0);
  const prevTotalsRef = useRef(null); // { routeId, km, min } do último trajeto mostrado
  const maxViasRef = useRef(null);
  const editVersionRef = useRef(0);
  const [unsynced, setUnsynced] = useState(false); // há ordem/desvios só na tela
  const hoverRef = useRef(null);

  // Desvios (pontos de passagem) do trajeto.
  const viasLayerRef = useRef(null);
  const viaDetachRef = useRef(null);
  const viaActionsRef = useRef({});

  // Resumo de TODAS as rotas (visão geral).
  const overview = useMemo(() => computeOverview(project, routePreviews), [project, routePreviews]);
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
    scheduleCommit(); // a ordem desfeita também precisa chegar ao servidor
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(true);
  }

  function redo() {
    if (!redoStackRef.current.length) return;
    const next = redoStackRef.current.pop();
    undoStackRef.current.push(project.collaborators);
    setProject((current) => ({ ...current, collaborators: next }));
    setDirty(true);
    scheduleCommit();
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
    if (value) updateSequence(null); // os dois modos usam o clique no mapa: um de cada vez
  }

  // Melhoria: tecla Esc cancela o modo "Selecionar área" a qualquer momento,
  // inclusive no meio de um arrasto em andamento.
  useEffect(() => {
    function onKeyDown(e) {
      if (e.key !== 'Escape') return;
      if (sequenceRef.current) {
        updateSequence(null);
        return;
      }
      if (!selectingRef.current) return;
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
    // Modo "clicar no mapa": quem já foi escolhido mostra o novo número.
    const seqIndex = new Map((sequence?.picked || []).map((id, index) => [id, index + 1]));

    project.collaborators.forEach((collab) => {
      if (collab.routeId && hiddenRoutes.has(collab.routeId)) return;
      if (collab.bairro && hiddenBairros.has(collab.bairro)) return;
      const isSelected = selected.has(collab.id);
      const route = project.routes.find((item) => item.id === collab.routeId);
      const inSequence = Boolean(sequence) && collab.routeId === editingRouteId;
      const order = inSequence
        ? seqIndex.get(collab.id) ?? null
        : collab.routeId === editingRouteId
          ? orderByCollabId.get(collab.id)
          : null;
      const overlap = panelView === 'visao' && overview.overlapIds.has(collab.id);
      const tooltip = collab.routeId
        ? `${order ? `#${order} · ` : ''}${collab.nome} (${route?.name || `Rota ${collab.routeId}`})`
        : `${collab.nome} (sem rota)`;
      const marker = L.marker([collab.lat, collab.lon], {
        icon: pointIcon(collab.routeId, { selected: isSelected, order, overlap, cid: collab.id })
      }).bindTooltip(tooltip);
      // Estado 2 (Foco) e Estado 3 (Edição): esmaece tudo que não pertence à
      // rota selecionada, para ela se destacar visualmente no mapa.
      if (selectedRouteId) {
        marker.setOpacity(collab.routeId === selectedRouteId ? 1 : 0.22);
      }
      // No modo "clicar no mapa" os ainda não escolhidos ficam meio apagados.
      if (inSequence) marker.setOpacity(seqIndex.has(collab.id) ? 1 : 0.55);
      marker.on('click', () => {
        if (sequenceRef.current) {
          sequenceActionsRef.current.click(collab);
          return;
        }
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
    highlightCollaborator(hoverRef.current); // mantém o destaque do item sob o mouse
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, selected, hiddenRoutes, hiddenBairros, selectedRouteId, editingRouteId, sequence, panelView, overview]);

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
  // Fila: duas sincronizações nunca rodam ao mesmo tempo (a última escrita vence).
  function enqueue(task) {
    const run = syncChainRef.current.then(task, task);
    syncChainRef.current = run.catch(() => {});
    return run;
  }

  // Envia ao servidor a ORDEM de embarque que só existe na tela (reordenar,
  // desfazer/refazer). Compara rota a rota e só manda o que mudou.
  async function flushOrders(local, server) {
    let current = server;
    const routeIds = [...new Set(local.collaborators.filter((c) => c.routeId).map((c) => c.routeId))];
    for (const routeId of routeIds) {
      const localIds = orderedIds(local.collaborators, routeId);
      if (sameIds(localIds, orderedIds(current.collaborators, routeId))) continue;
      current = await api.reorderRoute(current.id, routeId, localIds);
    }
    return current;
  }

  // Idem para os desvios (pontos de passagem) do trajeto. Servidores antigos
  // não os conhecem (`viasSuportadas` ausente): nesse caso não há o que enviar.
  async function flushVias(local, server) {
    if (!server.viasSuportadas) return server;
    let current = server;
    for (const route of local.routes) {
      const serverRoute = current.routes.find((item) => item.id === route.id);
      if (!serverRoute) continue;
      if (JSON.stringify(route.vias || []) === JSON.stringify(serverRoute.vias || [])) continue;
      try {
        current = await api.setRouteVias(current.id, route.id, route.vias || []);
      } catch (err) {
        // Recusado (ex.: limite de pontos): a tela volta ao que o servidor tem.
        const kept = serverRoute.vias || [];
        setProject((now) => ({ ...now, routes: now.routes.map((item) => (item.id === route.id ? { ...item, vias: kept } : item)) }));
        throw err;
      }
    }
    return current;
  }

  // Leva ao servidor TUDO o que está só na tela: atribuições, ordem e desvios.
  // Retorna o projeto como o servidor o tem depois disso.
  function syncAssignments(nextProject) {
    return enqueue(async () => {
      const local = nextProject || projectRef.current;
      const version = editVersionRef.current;
      const payload = {};
      local.collaborators.forEach((c) => {
        payload[c.id] = c.routeId || null;
      });
      let updated = await api.saveAssignments(local.id, payload);
      updated = await flushOrders(local, updated);
      updated = await flushVias(local, updated);
      savedSnapshotRef.current = snapshotAssignments(updated);
      setDirty(false);
      if (editVersionRef.current === version) setUnsynced(false); // nada novo na tela enquanto salvava
      return updated;
    });
  }

  async function saveAssignments(nextProject) {
    const local = nextProject || projectRef.current;
    const updated = await syncAssignments(local);
    // Se o usuário mexeu de novo enquanto salvava, mantém a tela dele.
    if (projectRef.current === local) setProject(updated);
  }

  function removeTrajeto() {
    if (viaDetachRef.current) {
      viaDetachRef.current();
      viaDetachRef.current = null;
    }
    if (trajetoLayerRef.current) {
      mapRef.current.removeLayer(trajetoLayerRef.current);
      trajetoLayerRef.current = null;
    }
  }

  function drawTrajeto(coordinates) {
    const map = mapRef.current;
    removeTrajeto();
    if (coordinates?.length > 1) {
      const latlngs = coordinates.map(([lon, lat]) => [lat, lon]);
      const visible = L.polyline(latlngs, {
        color: routeColor(editingRouteIdRef.current),
        weight: 4,
        opacity: 0.85,
        interactive: false
      });
      const layers = [visible];
      if (projectRef.current.viasSuportadas) {
        // Linha larga e invisível por cima: alvo fácil para agarrar com o mouse
        // e arrastar o trajeto (cria um ponto de passagem onde soltar).
        const hit = L.polyline(latlngs, { weight: 18, opacity: 0, bubblingMouseEvents: false });
        hit.bindTooltip('Arraste para desviar o trajeto', { sticky: true });
        layers.push(hit);
        viaDetachRef.current = attachViaCreate({
          map,
          L,
          line: hit,
          canStart: () => !selectingRef.current && !sequenceRef.current,
          onCreate: (latlng) => viaActionsRef.current.addVia(latlng)
        });
      }
      trajetoLayerRef.current = L.layerGroup(layers).addTo(map);
      return latlngs;
    }
    return null;
  }

  // Mostra um trajeto recém-calculado (totais, variação e linha no mapa) e o
  // guarda para a visão geral.
  function applyPreview(data, routeId, { compare = false, fit = false } = {}) {
    const previous = prevTotalsRef.current;
    const delta =
      compare && previous && previous.routeId === routeId
        ? { km: data.distanciaKm - previous.km, min: data.duracaoMin - previous.min }
        : null;
    prevTotalsRef.current = { routeId, km: data.distanciaKm, min: data.duracaoMin };
    maxViasRef.current = data.maxVias ?? null;
    setPreview({
      loading: false,
      error: null,
      coordinates: data.coordinates,
      waypoints: data.waypoints,
      usedRealRoute: Boolean(data.usedOrs),
      distanciaKm: data.distanciaKm,
      duracaoMin: data.duracaoMin,
      maxVias: data.maxVias ?? null,
      delta
    });
    setRoutePreviews((prev) => ({
      ...prev,
      [routeId]: {
        sig: routeSignature(projectRef.current, routeId),
        distanciaKm: data.distanciaKm,
        duracaoMin: data.duracaoMin,
        usedOrs: Boolean(data.usedOrs),
        coordinates: data.coordinates
      }
    }));
    const latlngs = drawTrajeto(data.coordinates);
    if (fit && latlngs) mapRef.current.fitBounds(L.latLngBounds(latlngs).pad(0.2));
  }

  // Agenda o envio das edições ao servidor (ordem, desfazer/refazer, desvios).
  // Esperar o usuário parar de mexer evita uma ida ao servidor por clique e
  // mantém a interface fluida; antes de baixar/salvar tudo é enviado de qualquer jeito.
  function scheduleCommit() {
    editVersionRef.current += 1;
    setUnsynced(true);
    clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(commitEdits, COMMIT_DELAY_MS);
  }

  async function commitEdits() {
    commitTimerRef.current = null; // já disparou: não há mais envio agendado
    const routeId = editingRouteIdRef.current;
    const token = ++previewTokenRef.current;
    setPreview((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const synced = await syncAssignments();
      if (!routeId) {
        setPreview((prev) => ({ ...prev, loading: false }));
        return;
      }
      const data = await api.previewRoute(synced.id, routeId, synced.tipoRota);
      if (token !== previewTokenRef.current) return; // veio uma edição mais nova; ela refaz o trajeto
      applyPreview(data, routeId, { compare: true });
    } catch (err) {
      if (token === previewTokenRef.current) setPreview((prev) => ({ ...prev, loading: false }));
      toast.fail('Não foi possível enviar a alteração ao servidor', err, { key: 'commit-error' });
    }
  }

  // Busca e desenha o trajeto real da rota em edição (Estado 3). Sincroniza
  // as atribuições com o backend primeiro, para garantir que o preview
  // reflita qualquer edição local ainda não salva.
  useEffect(() => {
    if (!editingRouteId) {
      removeTrajeto();
      prevTotalsRef.current = null;
      setPreview(EMPTY_PREVIEW);
      return;
    }

    let cancelled = false;
    setPreview({ ...EMPTY_PREVIEW, loading: true });

    (async () => {
      try {
        const local = projectRef.current;
        const synced = await syncAssignments(local);
        if (cancelled) return;
        if (projectRef.current === local) setProject(synced);
        const data = await api.previewRoute(synced.id, editingRouteId, synced.tipoRota);
        if (cancelled) return;
        applyPreview(data, editingRouteId, { fit: true });
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

  // Reordena a rota em edição. A lista e o mapa mudam NA HORA (nada fica
  // bloqueado esperando o servidor); o envio e o novo trajeto vêm em segundo plano.
  function reorderFocusedRoute(newOrder) {
    const routeId = editingRouteIdRef.current;
    if (!routeId) return;
    pushHistory(projectRef.current.collaborators);
    setProject((current) => ({ ...current, collaborators: applyOrder(current.collaborators, routeId, newOrder) }));
    scheduleCommit();
  }

  // Ordena automaticamente a rota em edição: começa no colaborador mais
  // distante do destino e encadeia pelo vizinho mais próximo até o fim
  // (heurística do vizinho mais próximo). O cálculo é feito no backend, que
  // já tem as coordenadas de todos os colaboradores.
  async function autoOrderFocusedRoute(routeId) {
    if (!routeId) return;
    pushHistory(projectRef.current.collaborators);
    const token = ++previewTokenRef.current;
    setPreview((prev) => ({ ...prev, loading: true }));
    try {
      const synced = await syncAssignments();
      const updated = await api.autoOrderRoute(synced.id, routeId, synced.tipoRota);
      setProject(updated);
      const data = await api.previewRoute(updated.id, routeId, updated.tipoRota);
      if (token !== previewTokenRef.current) return;
      applyPreview(data, routeId, { compare: true, fit: true });
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
    if (!dirty && !kbPending && !unsynced) return undefined;
    const onBeforeUnload = (event) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty, kbPending, unsynced]);

  // Ao sair do editor com um envio ainda agendado, manda agora: não perde a edição.
  useEffect(
    () => () => {
      if (commitTimerRef.current) {
        clearTimeout(commitTimerRef.current);
        commitTimerRef.current = null;
        syncAssignments().catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  // ---------- Modo "definir a ordem clicando nos pontos do mapa"
  function updateSequence(next) {
    sequenceRef.current = next; // imediato: dois cliques seguidos não se perdem
    setSequence(next);
  }

  function startSequence() {
    const routeId = editingRouteIdRef.current;
    if (!routeId || orderedIds(projectRef.current.collaborators, routeId).length < 2) return;
    setSelectMode(false);
    updateSequence({ picked: [] });
  }

  function undoSequence() {
    const current = sequenceRef.current;
    if (current && current.picked.length) updateSequence({ picked: current.picked.slice(0, -1) });
  }

  // Os pontos escolhidos vêm primeiro, na ordem dos cliques; os não clicados
  // seguem depois, na ordem em que já estavam. Vale como UMA alteração só
  // (um Ctrl+Z desfaz tudo).
  function finishSequence(picked = sequenceRef.current?.picked) {
    if (!picked || picked.length === 0) return;
    const current = orderedIds(projectRef.current.collaborators, editingRouteIdRef.current);
    updateSequence(null);
    reorderFocusedRoute(completeSequence(picked, current));
  }

  function handleSequenceClick(collab) {
    const current = sequenceRef.current;
    if (!current) return;
    if (collab.routeId !== editingRouteIdRef.current) {
      toast.info('Clique apenas nos pontos da rota em edição.', { key: 'seq-wrong', duration: 2500 });
      return;
    }
    if (current.picked.includes(collab.id)) {
      // Clicar de novo no último escolhido desfaz esse clique.
      if (current.picked[current.picked.length - 1] === collab.id) undoSequence();
      return;
    }
    const picked = [...current.picked, collab.id];
    const total = orderedIds(projectRef.current.collaborators, editingRouteIdRef.current).length;
    if (picked.length >= total) finishSequence(picked);
    else updateSequence({ picked });
  }
  sequenceActionsRef.current = { click: handleSequenceClick };

  // Sair da edição (ou trocar de rota) encerra o modo.
  useEffect(() => {
    updateSequence(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRouteId]);

  // ---------- Ligação lista <-> mapa
  function highlightCollaborator(id) {
    const previous = hoverRef.current;
    if (previous !== null && previous !== undefined && previous !== id) {
      markersRef.current[previous]?.getElement()?.classList.remove('pt-hover');
    }
    hoverRef.current = id;
    if (id !== null && id !== undefined) markersRef.current[id]?.getElement()?.classList.add('pt-hover');
  }

  // Clicar no nome na lista leva o mapa até o ponto (abre o grupo, se estiver agrupado).
  function focusCollaborator(id) {
    const marker = markersRef.current[id];
    const map = mapRef.current;
    if (!marker || !map) return;
    layerRef.current.zoomToShowLayer(marker, () => {
      map.panTo(marker.getLatLng());
      marker.openTooltip();
    });
  }

  // ---------- Visão geral de todas as rotas
  function changePanelView(view) {
    setPanelView(view);
    updateSequence(null);
    if (view === 'visao') {
      setEditingRouteId(null);
      const map = mapRef.current;
      if (map && project.collaborators.length) {
        const bounds = L.latLngBounds(project.collaborators.map((c) => [c.lat, c.lon]));
        bounds.extend([project.destino.lat, project.destino.lon]);
        map.fitBounds(bounds.pad(0.15));
      }
    }
  }

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!overviewLayerRef.current) overviewLayerRef.current = L.layerGroup().addTo(map);
    const group = overviewLayerRef.current;
    if (panelView !== 'visao') {
      group.clearLayers();
      return;
    }
    drawOverview({
      L,
      group,
      project,
      overview,
      options: overviewOptions,
      hiddenRoutes,
      selectedRouteId,
      routeColor,
      previews: routePreviews
    });
  }, [panelView, project, overview, overviewOptions, hiddenRoutes, selectedRouteId, routePreviews]);

  // Calcula o trajeto real (ORS) de cada rota com gente, uma de cada vez
  // (respeita o limite de requisições do ORS) e mostra o progresso.
  async function computeAllPreviews() {
    const token = ++computeTokenRef.current;
    const current = projectRef.current;
    const routes = current.routes.filter((route) => current.collaborators.some((c) => c.routeId === route.id));
    setComputingReal({ done: 0, total: routes.length });
    try {
      const synced = await syncAssignments();
      let done = 0;
      for (const route of routes) {
        if (token !== computeTokenRef.current) return; // cancelado
        const data = await api.previewRoute(synced.id, route.id, synced.tipoRota);
        setRoutePreviews((prev) => ({
          ...prev,
          [route.id]: {
            sig: routeSignature(projectRef.current, route.id),
            distanciaKm: data.distanciaKm,
            duracaoMin: data.duracaoMin,
            usedOrs: Boolean(data.usedOrs),
            coordinates: data.coordinates
          }
        }));
        done += 1;
        setComputingReal({ done, total: routes.length });
      }
      setOverviewOptions((options) => ({ ...options, real: true }));
    } catch (err) {
      toast.fail('Não foi possível calcular os trajetos', err);
    } finally {
      if (token === computeTokenRef.current) setComputingReal(null);
    }
  }

  function cancelComputeAll() {
    computeTokenRef.current += 1;
    setComputingReal(null);
  }

  // ---------- Ajuste do trajeto: pontos de passagem (desvios)
  const editingRoute = project.routes.find((route) => route.id === editingRouteId);
  const routeVias = (editingRoute && editingRoute.vias) || [];

  function currentVias() {
    const route = projectRef.current.routes.find((item) => item.id === editingRouteIdRef.current);
    return (route && route.vias) || [];
  }

  function setRouteViasLocal(routeId, vias) {
    setProject((current) => ({
      ...current,
      routes: current.routes.map((route) => (route.id === routeId ? { ...route, vias } : route))
    }));
    scheduleCommit();
  }

  function addVia(latlng) {
    const routeId = editingRouteIdRef.current;
    if (!routeId) return;
    const vias = currentVias();
    if (maxViasRef.current !== null && vias.length >= maxViasRef.current) {
      toast.info(`Esta rota já usa o máximo de ${maxViasRef.current} pontos de passagem.`, { key: 'vias-max' });
      return;
    }
    setRouteViasLocal(routeId, [...vias, { lat: round6(latlng.lat), lon: round6(latlng.lng) }]);
  }

  function moveVia(index, latlng) {
    const vias = currentVias().map((via, i) => (i === index ? { lat: round6(latlng.lat), lon: round6(latlng.lng) } : via));
    setRouteViasLocal(editingRouteIdRef.current, vias);
  }

  const removeVia = (index) => setRouteViasLocal(editingRouteIdRef.current, currentVias().filter((_, i) => i !== index));
  const clearVias = () => setRouteViasLocal(editingRouteIdRef.current, []);
  viaActionsRef.current = { addVia, moveVia, removeVia, clearVias };

  // Pinos dos desvios da rota em edição: arrastar ajusta; duplo clique ou
  // botão direito remove.
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (!viasLayerRef.current) viasLayerRef.current = L.layerGroup().addTo(map);
    const group = viasLayerRef.current;
    group.clearLayers();
    if (!editingRouteId || !project.viasSuportadas) return;
    routeVias.forEach((via, index) => {
      const marker = L.marker([via.lat, via.lon], {
        draggable: true,
        keyboard: false,
        zIndexOffset: 800,
        icon: L.divIcon({ className: '', iconSize: [20, 20], iconAnchor: [10, 10], html: `<div class="via-pin">${index + 1}</div>` })
      });
      marker.bindTooltip(`Ponto de passagem ${index + 1} — arraste para ajustar; duplo clique remove`);
      marker.on('dragend', () => viaActionsRef.current.moveVia(index, marker.getLatLng()));
      marker.on('dblclick', (e) => {
        L.DomEvent.stopPropagation(e);
        viaActionsRef.current.removeVia(index);
      });
      marker.on('contextmenu', (e) => {
        L.DomEvent.preventDefault(e.originalEvent);
        viaActionsRef.current.removeVia(index);
      });
      group.addLayer(marker);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editingRouteId, JSON.stringify(routeVias), project.viasSuportadas]);

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
        panelView={panelView}
        onPanelViewChange={changePanelView}
        overview={overview}
        overviewOptions={overviewOptions}
        onOverviewOptionsChange={setOverviewOptions}
        computingReal={computingReal}
        onComputeReal={computeAllPreviews}
        onCancelComputeReal={cancelComputeAll}
        sequence={sequence}
        onStartSequence={startSequence}
        onSequenceUndo={undoSequence}
        onSequenceFinish={() => finishSequence()}
        onSequenceCancel={() => updateSequence(null)}
        onFocusCollaborator={focusCollaborator}
        onHoverCollaborator={highlightCollaborator}
        routeVias={routeVias}
        maxVias={preview.maxVias}
        onRemoveVia={(index) => viaActionsRef.current.removeVia(index)}
        onClearVias={() => viaActionsRef.current.clearVias()}
      />
    </div>
  );
}
