import { useEffect, useRef } from 'react';
import L from 'leaflet';

export default function DestinationPicker({ destino, setDestino }) {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!markerRef.current) return;
    markerRef.current.setLatLng([destino.lat, destino.lon]);
  }, [destino]);

  return <div id="setup-map" />;
}
