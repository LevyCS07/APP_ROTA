import { createRoot } from 'react-dom/client';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
// Import do plugin em si (não só do CSS) — é ele que registra L.markerClusterGroup.
import 'leaflet.markercluster';
import 'leaflet.markercluster/dist/MarkerCluster.css';
import 'leaflet.markercluster/dist/MarkerCluster.Default.css';
import markerIcon2x from 'leaflet/dist/images/marker-icon-2x.png';
import markerIcon from 'leaflet/dist/images/marker-icon.png';
import markerShadow from 'leaflet/dist/images/marker-shadow.png';
import './styles.css';
import App from './App.jsx';

// O bundler (Vite) não resolve os caminhos padrão de ícone do Leaflet sozinho,
// o que causa 404 em marker-icon.png/marker-shadow.png. Registramos os
// caminhos corretos (já processados pelo Vite) uma única vez aqui.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: markerIcon2x,
  iconUrl: markerIcon,
  shadowUrl: markerShadow
});

createRoot(document.getElementById('root')).render(<App />);
