import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { api } from './api.js';
import RoutesPanel from './RoutesPanel.jsx';

const COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
  '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324',
  '#800000', '#808000', '#000075', '#a9a9a9'
];

function routeColor(routeId) {
  if (!routeId) return '#111';
  return COLORS[(routeId - 1) % COLORS.length];
}

// order !== null desenha um marcador maior com o número da sequência de embarque.
function pointIcon(routeId, { selected = false, order = null } = {}) {
  const color = routeColor(routeId);
  const hasOrder = order !== null && order !== undefined;
  const size = selected ? 20 : hasOrder ? 22 : routeId ? 14 : 16;
  const radius = hasOrder || routeId ? '50%' : '3px';
  const border = selected ? '#facc15' : '#fff';
  const label = hasOrder
    ? `<span style="color:#fff;font-size:11px;font-weight:800;line-height:1">${order}</span>`
    : '';
  return L.divIcon({
    className: '',
    iconAnchor: [size / 2, size / 2],
    html: `<div style="width:${size}px;height:${size}px;border-radius:${radius};background:${color};border:3px solid ${border};box-shadow:0 1px 6px rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center">${label}</div>`
  });
}

const EMPTY_PREVIEW = { loading: false, error: null, coordinates: [], waypoints: [], usedRealRoute: false };

// Serializa apenas o routeId de cada colaborador, para comparar "o que está
// salvo no servidor" com "o que está na tela" (ver estado `dirty`).
function snapshotAssignments(project) {
  return project.collaborators.map((c) => `${c.id}:${c.routeId ?? ''}`).sort().join('|');
}

export default function MapEditor({ project, setProject }) {
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
  const [focusedRouteId, setFocusedRouteId] = useState(null);
  const [preview, setPreview] = useState(EMPTY_PREVIEW);
  // Espelha selectingRef em estado só para dar feedback visual no botão
  // "Selecionar área" (o ref sozinho é o que os handlers do mapa usam de fato).
  const [selecting, setSelecting] = useState(false);
  // Melhoria: indica se há atribuições feitas na tela que ainda não foram
  // confirmadas no backend (ex.: "Atribuir" sem depois clicar em "Salvar
  // edições"), para mostrar um aviso perto do botão de salvar.
  const [dirty, setDirty] = useState(false);
  const savedSnapshotRef = useRef(snapshotAssignments(project));

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

  // Mapa de colaboradorId -> posição na sequência de embarque, para a rota em foco.
  const orderByCollabId = new Map(
    focusedRouteId
      ? project.collaborators
          .filter((c) => c.routeId === focusedRouteId)
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
      const isSelected = selected.has(collab.id);
      const route = project.routes.find((item) => item.id === collab.routeId);
      const order = collab.routeId === focusedRouteId ? orderByCollabId.get(collab.id) : null;
      const tooltip = collab.routeId
        ? `${order ? `#${order} · ` : ''}${collab.nome} (${route?.name || `Rota ${collab.routeId}`})`
        : `${collab.nome} (sem rota)`;
      const marker = L.marker([collab.lat, collab.lon], {
        icon: pointIcon(collab.routeId, { selected: isSelected, order })
      }).bindTooltip(tooltip);
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
  }, [project, selected, hiddenRoutes, focusedRouteId]);

  // Seleção de área por arrasto (retângulo).
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const onMouseDown = (e) => {
      if (!selectingRef.current) return;
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
      rectangleRef.current.setBounds(L.latLngBounds(selectStartRef.current, e.latlng));
    };
    const onMouseUp = (e) => {
      if (!selectingRef.current || !selectStartRef.current) return;
      const bounds = L.latLngBounds(selectStartRef.current, e.latlng);
      const ids = project.collaborators
        .filter((c) => !c.routeId || !hiddenRoutes.has(c.routeId))
        .filter((c) => bounds.contains(L.latLng(c.lat, c.lon)))
        .map((c) => c.id);
      setSelected((prev) => new Set([...prev, ...ids]));
      if (rectangleRef.current) {
        map.removeLayer(rectangleRef.current);
        rectangleRef.current = null;
      }
      selectStartRef.current = null;
      selectingRef.current = false;
      setSelecting(false);
      map.dragging.enable();
    };

    map.on('mousedown', onMouseDown);
    map.on('mousemove', onMouseMove);
    map.on('mouseup', onMouseUp);
    return () => {
      map.off('mousedown', onMouseDown);
      map.off('mousemove', onMouseMove);
      map.off('mouseup', onMouseUp);
    };
  }, [project, hiddenRoutes]);

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
        color: routeColor(focusedRouteId),
        weight: 4,
        opacity: 0.85
      }).addTo(map);
      return latlngs;
    }
    return null;
  }

  // Busca e desenha o trajeto real da rota em foco. Sincroniza as
  // atribuições com o backend primeiro, para garantir que o preview reflita
  // qualquer edição local ainda não salva.
  useEffect(() => {
    if (!focusedRouteId) {
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
        const data = await api.previewRoute(synced.id, focusedRouteId, synced.tipoRota);
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
  }, [focusedRouteId]);

  function applySelected() {
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

  function toggleFocusRoute(routeId) {
    setFocusedRouteId((current) => (current === routeId ? null : routeId));
  }

  async function reorderFocusedRoute(orderedIds) {
    if (!focusedRouteId) return;
    setPreview((prev) => ({ ...prev, loading: true }));
    try {
      const synced = await syncAssignments();
      const updated = await api.reorderRoute(synced.id, focusedRouteId, orderedIds);
      setProject(updated);
      const data = await api.previewRoute(updated.id, focusedRouteId, updated.tipoRota);
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
      alert(`Não foi possível salvar a nova ordem: ${err.message}`);
    }
  }

  // Ordena automaticamente a rota em foco: começa no colaborador mais distante
  // do destino e encadeia pelo vizinho mais próximo até o fim (heurística do
  // vizinho mais próximo). O cálculo é feito no backend, que já tem as
  // coordenadas de todos os colaboradores.
  async function autoOrderFocusedRoute(routeId) {
    if (!routeId) return;
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
      alert(`Não foi possível ordenar automaticamente: ${err.message}`);
    }
  }

  async function addRoute() {
    const capacity = Number(prompt('Capacidade da nova rota', '22') || 22);
    setProject(await api.addRoute(project.id, capacity));
  }

  // Melhoria: confirma antes de remover uma rota que ainda tem colaboradores,
  // já que eles voltam para "sem rota" imediatamente e isso não pode ser desfeito.
  async function removeRoute(routeId) {
    const route = project.routes.find((item) => item.id === routeId);
    const count = project.collaborators.filter((c) => c.routeId === routeId).length;
    if (count > 0) {
      const ok = window.confirm(
        `A rota "${route?.name || routeId}" tem ${count} colaborador(es). Remover mesmo assim? Eles ficarão sem rota.`
      );
      if (!ok) return;
    }
    if (focusedRouteId === routeId) setFocusedRouteId(null);
    const updated = await api.removeRoute(project.id, routeId);
    setProject(updated);
  }

  async function updateRouteCapacity(routeId, capacity) {
    const nextCapacity = Math.max(1, Number(capacity || 1));
    setProject({
      ...project,
      routes: project.routes.map((route) =>
        route.id === routeId ? { ...route, capacity: nextCapacity } : route
      )
    });
    await api.updateRouteCapacity(project.id, routeId, nextCapacity);
  }

  async function downloadZip() {
    await syncAssignments();
    window.location.href = api.downloadUrl(project.id);
  }

  const routeCollaborators = project.collaborators.filter((c) => c.routeId === focusedRouteId);

  return (
    <div className="editor">
      <div id="map" />
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
        onSaveAssignments={() => saveAssignments()}
        onDownloadZip={downloadZip}
        dirty={dirty}
        hiddenRoutes={hiddenRoutes}
        onToggleHiddenRoute={toggleHiddenRoute}
        onRemoveRoute={removeRoute}
        onUpdateRouteCapacity={updateRouteCapacity}
        focusedRouteId={focusedRouteId}
        onToggleFocusRoute={toggleFocusRoute}
        routeCollaborators={routeCollaborators}
        onReorderRoute={reorderFocusedRoute}
        onAutoOrderRoute={autoOrderFocusedRoute}
        preview={preview}
      />
    </div>
  );
}
