export const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000';

const TOKEN_KEY = 'appToken';

export function getToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export function setToken(token) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

// Chamado sempre que uma requisição volta com 401 — permite o App.jsx
// mostrar a tela de login de novo sem cada componente ter que checar isso.
let onUnauthorized = () => {};
export function setUnauthorizedHandler(fn) {
  onUnauthorized = fn;
}

function authHeaders() {
  const token = getToken();
  return token ? { 'X-App-Token': token } : {};
}

function handleUnauthorized() {
  setToken('');
  onUnauthorized();
}

async function requestJson(path, options = {}) {
  const res = await fetch(`${API_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...authHeaders(), ...(options.headers || {}) },
    ...options
  });
  if (res.status === 401) {
    handleUnauthorized();
    throw new Error('Sessão expirada. Faça login novamente.');
  }
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

  // Valida um token candidato antes de guardá-lo — chamado pela tela de
  // login. Não usa requestJson porque não queremos disparar o handler de
  // "sessão expirada" para uma tentativa de login que ainda nem começou.
  async checkAuth(token) {
    const res = await fetch(`${API_URL}/api/auth/check`, {
      headers: token ? { 'X-App-Token': token } : {}
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error('Token inválido.');
    return data;
  },

  async createProject(form) {
    const res = await fetch(`${API_URL}/api/projects`, { method: 'POST', body: form, headers: authHeaders() });
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error('Sessão expirada. Faça login novamente.');
    }
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

  // Ordena automaticamente: começa no colaborador mais distante do destino e
  // encadeia pelo vizinho mais próximo até o fim da rota.
  autoOrderRoute(projectId, routeId, tipo) {
    return requestJson(`/api/projects/${projectId}/routes/${routeId}/auto-order?tipo=${encodeURIComponent(tipo)}`, {
      method: 'POST'
    });
  },

  // Busca o trajeto real (linha via ORS) e a sequência de embarque de uma rota.
  previewRoute(projectId, routeId, tipo) {
    return requestJson(`/api/projects/${projectId}/routes/${routeId}/preview?tipo=${encodeURIComponent(tipo)}`);
  },

  // Baixa o zip via fetch (não navegação direta) para poder anexar o
  // cabeçalho de autenticação — uma navegação simples (window.location)
  // não permite enviar cabeçalhos customizados.
  async downloadZip(projectId) {
    const res = await fetch(`${API_URL}/api/projects/${projectId}/download`, { headers: authHeaders() });
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'rotas_kml_relatorio.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  },

  // Persistência opcional na base de conhecimento (Supabase). Só é chamado
  // quando o usuário clica explicitamente no botão — nunca automático.
  saveToKnowledgeBase(projectId) {
    return requestJson(`/api/projects/${projectId}/save-to-knowledge-base`, { method: 'POST' });
  },

  // Painel do histórico (item 6).
  getKnowledgeStats() {
    return requestJson('/api/knowledge/stats');
  }
};
