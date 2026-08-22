export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

async function requestJson(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Erro ${res.status} em ${path}`);
  }
  return res.json();
}

export const api = {
  health() {
    return fetch(`${API_URL}/api/health`);
  },

  async createProject(form) {
    const res = await fetch(`${API_URL}/api/projects`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(await res.text());
    return res.json();
  },

  saveAssignments(projectId, assignments) {
    return requestJson(`/api/projects/${projectId}/assignments`, {
      method: 'PUT',
      body: JSON.stringify({ assignments })
    });
  },

  addRoute(projectId, capacity) {
    return requestJson(`/api/projects/${projectId}/routes`, {
      method: 'POST',
      body: JSON.stringify({ capacity })
    });
  },

  removeRoute(projectId, routeId) {
    return requestJson(`/api/projects/${projectId}/routes/${routeId}`, { method: 'DELETE' });
  },

  updateRouteCapacity(projectId, routeId, capacity) {
    return requestJson(`/api/projects/${projectId}/routes/${routeId}`, {
      method: 'PATCH',
      body: JSON.stringify({ capacity })
    });
  },

  // Define a ordem de embarque (lista de ids de colaboradores) dentro de uma rota.
  reorderRoute(projectId, routeId, order) {
    return requestJson(`/api/projects/${projectId}/routes/${routeId}/order`, {
      method: 'PUT',
      body: JSON.stringify({ order })
    });
  },

  // Busca o trajeto real (linha via ORS) e a sequência de embarque de uma rota.
  previewRoute(projectId, routeId, tipo) {
    return requestJson(`/api/projects/${projectId}/routes/${routeId}/preview?tipo=${encodeURIComponent(tipo)}`);
  },

  downloadUrl(projectId) {
    return `${API_URL}/api/projects/${projectId}/download`;
  }
};
