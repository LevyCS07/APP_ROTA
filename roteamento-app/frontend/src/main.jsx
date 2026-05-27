import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import './styles.css';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';
const COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
  '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324',
  '#800000', '#808000', '#000075', '#a9a9a9'
];

function DestinationPicker({ destino, setDestino }) {
  const mapRef = useRef(null);
  const markerRef = useRef(null);

  useEffect(() => {
    if (mapRef.current) return;
    const map = L.map('setup-map').setView([destino.lat, destino.lon], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(map);
    markerRef.current = L.marker([destino.lat, destino.lon]).addTo(map);
    map.on('click', (e) => {
      setDestino({ lat: Number(e.latlng.lat.toFixed(6)), lon: Number(e.latlng.lng.toFixed(6)) });
    });
    mapRef.current = map;
  }, []);

  useEffect(() => {
    if (!markerRef.current) return;
    markerRef.current.setLatLng([destino.lat, destino.lon]);
  }, [destino]);

  return <div id="setup-map" />;
}

function routeColor(routeId) {
  if (!routeId) return '#111';
  return COLORS[(routeId - 1) % COLORS.length];
}

function pointIcon(routeId, selected = false) {
  const color = routeColor(routeId);
  const radius = routeId ? '50%' : '3px';
  const size = selected ? 18 : routeId ? 14 : 16;
  const border = selected ? '#facc15' : '#fff';
  return L.divIcon({
    className: '',
    iconAnchor: [size / 2, size / 2],
    html: `<div style="width:${size}px;height:${size}px;border-radius:${radius};background:${color};border:3px solid ${border};box-shadow:0 1px 6px rgba(0,0,0,.55)"></div>`
  });
}

function MapEditor({ project, setProject }) {
  const mapRef = useRef(null);
  const layerRef = useRef(null);
  const markersRef = useRef({});
  const rectangleRef = useRef(null);
  const selectStartRef = useRef(null);
  const selectingRef = useRef(false);
  const [selected, setSelected] = useState(new Set());
  const [bulkRoute, setBulkRoute] = useState(project.routes[0]?.id || 1);

  const assignments = useMemo(() => {
    const out = {};
    project.collaborators.forEach((c) => {
      if (c.routeId) out[c.id] = c.routeId;
    });
    return out;
  }, [project]);

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
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    const layer = layerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();
    markersRef.current = {};

    project.collaborators.forEach((collab) => {
      const isSelected = selected.has(collab.id);
      const marker = L.marker([collab.lat, collab.lon], {
        icon: pointIcon(collab.routeId, isSelected)
      }).bindTooltip(`${collab.nome}${collab.routeId ? '' : ' (sem rota)'}`);
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

    L.marker([project.destino.lat, project.destino.lon], {
      icon: L.divIcon({
        className: '',
        iconAnchor: [42, 12],
        html: '<div class="destino-marker">Destino</div>'
      })
    }).addTo(map);

    const bounds = L.latLngBounds(project.collaborators.map((c) => [c.lat, c.lon]));
    bounds.extend([project.destino.lat, project.destino.lon]);
    map.fitBounds(bounds.pad(0.15));
  }, [project, selected]);

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
        .filter((c) => bounds.contains(L.latLng(c.lat, c.lon)))
        .map((c) => c.id);
      setSelected((prev) => new Set([...prev, ...ids]));
      if (rectangleRef.current) {
        map.removeLayer(rectangleRef.current);
        rectangleRef.current = null;
      }
      selectStartRef.current = null;
      selectingRef.current = false;
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
  }, [project]);

  async function saveAssignments(nextProject = project) {
    const payload = {};
    nextProject.collaborators.forEach((c) => {
      payload[c.id] = c.routeId || null;
    });
    const res = await fetch(`${API_URL}/api/projects/${project.id}/assignments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: payload })
    });
    setProject(await res.json());
  }

  function applySelected() {
    const next = {
      ...project,
      collaborators: project.collaborators.map((c) =>
        selected.has(c.id) ? { ...c, routeId: Number(bulkRoute) } : c
      )
    };
    setSelected(new Set());
    setProject(next);
  }

  async function addRoute() {
    const capacity = Number(prompt('Capacidade da nova rota', '22') || 22);
    const res = await fetch(`${API_URL}/api/projects/${project.id}/routes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ capacity })
    });
    setProject(await res.json());
  }

  async function removeRoute(routeId) {
    const res = await fetch(`${API_URL}/api/projects/${project.id}/routes/${routeId}`, { method: 'DELETE' });
    if (res.ok) setProject(await res.json());
  }

  async function downloadZip() {
    const payload = {};
    project.collaborators.forEach((c) => {
      payload[c.id] = c.routeId || null;
    });
    await fetch(`${API_URL}/api/projects/${project.id}/assignments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments: payload })
    });
    window.location.href = `${API_URL}/api/projects/${project.id}/download`;
  }

  const counts = project.routes.map((route) => ({
    ...route,
    count: project.collaborators.filter((c) => c.routeId === route.id).length
  }));
  const semRota = project.collaborators.filter((c) => !c.routeId).length;

  return (
    <div className="editor">
      <div id="map" />
      <aside className="panel">
        <div className="panel-section">
          <button onClick={() => { selectingRef.current = true; }}>Selecionar área</button>
          <select value={bulkRoute} onChange={(e) => setBulkRoute(e.target.value)}>
            {project.routes.map((route) => (
              <option key={route.id} value={route.id}>{route.name}</option>
            ))}
          </select>
          <button onClick={applySelected}>Adicionar selecionados</button>
          <button className="secondary" onClick={() => setSelected(new Set())}>Limpar seleção</button>
          <div className="muted">{selected.size} selecionado(s)</div>
        </div>
        <div className="panel-section">
          <button onClick={addRoute}>Adicionar rota</button>
          <button className="primary" onClick={() => saveAssignments()}>Salvar edições</button>
          <button className="primary" onClick={downloadZip}>Baixar KMLs e relatório</button>
        </div>
        <div className="routes-list">
          <div className="route-row sem-rota"><span>Sem rota</span><strong>{semRota}</strong></div>
          {counts.map((route) => (
            <div className="route-row" key={route.id} style={{ borderLeftColor: routeColor(route.id) }}>
              <span>{route.name}</span>
              <strong>{route.count}/{route.capacity}</strong>
              <button className="mini" onClick={() => removeRoute(route.id)} disabled={project.routes.length <= 1}>Remover</button>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function App() {
  const [file, setFile] = useState(null);
  const [tipoRota, setTipoRota] = useState('Entrada');
  const [modo, setModo] = useState('Manual');
  const [destino, setDestino] = useState({ lat: -3.119, lon: -60.021 });
  const [routeCount, setRouteCount] = useState(5);
  const [capacity, setCapacity] = useState(22);
  const [project, setProject] = useState(null);
  const [loading, setLoading] = useState(false);

  async function createProject() {
    if (!file) return alert('Selecione a planilha.');
    setLoading(true);
    try {
      const form = new FormData();
      form.append('file', file);
      form.append('destino_lat', destino.lat);
      form.append('destino_lon', destino.lon);
      form.append('tipo_rota', tipoRota);
      form.append('modo', modo);
      form.append('capacidades', JSON.stringify(Array.from({ length: routeCount }, () => Number(capacity))));
      const res = await fetch(`${API_URL}/api/projects`, { method: 'POST', body: form });
      if (!res.ok) throw new Error(await res.text());
      setProject(await res.json());
    } catch (err) {
      alert(`Erro ao criar projeto: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }

  if (project) return <MapEditor project={project} setProject={setProject} />;

  return (
    <main className="setup">
      <section className="setup-card">
        <h1>Roteamento de colaboradores</h1>
        <label>Planilha Excel</label>
        <input type="file" accept=".xlsx" onChange={(e) => setFile(e.target.files?.[0])} />
        <div className="grid">
          <label>Tipo de rota<select value={tipoRota} onChange={(e) => setTipoRota(e.target.value)}><option>Entrada</option><option>Saída</option></select></label>
          <label>Modo<select value={modo} onChange={(e) => setModo(e.target.value)}><option>Manual</option><option>Automática</option></select></label>
          <label>Quantidade de rotas<input type="number" min="1" value={routeCount} onChange={(e) => setRouteCount(e.target.value)} /></label>
          <label>Capacidade<input type="number" min="1" value={capacity} onChange={(e) => setCapacity(e.target.value)} /></label>
          <label>Destino lat<input type="number" step="0.000001" value={destino.lat} onChange={(e) => setDestino({ ...destino, lat: Number(e.target.value) })} /></label>
          <label>Destino lon<input type="number" step="0.000001" value={destino.lon} onChange={(e) => setDestino({ ...destino, lon: Number(e.target.value) })} /></label>
        </div>
        <DestinationPicker destino={destino} setDestino={setDestino} />
        <button className="primary" disabled={loading} onClick={createProject}>{loading ? 'Carregando...' : 'Abrir editor'}</button>
      </section>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<App />);
