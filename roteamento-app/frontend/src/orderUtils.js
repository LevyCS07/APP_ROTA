// Utilidades puras para a ordem de embarque dos colaboradores de uma rota.

export const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id - b.id;

// Ids dos colaboradores da rota, na ordem de embarque.
export function orderedIds(collaborators, routeId) {
  return collaborators.filter((c) => c.routeId === routeId).sort(byOrder).map((c) => c.id);
}

export const sameIds = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

// Move o item da posição `from` para a posição final `to` (índices 0-based).
export function moveItem(ids, from, to) {
  if (from === to || from < 0 || from >= ids.length) return ids;
  const target = Math.max(0, Math.min(ids.length - 1, to));
  const next = [...ids];
  const [moved] = next.splice(from, 1);
  next.splice(target, 0, moved);
  return next;
}

// Coloca `id` na posição `position` (1 = primeiro). Aceita qualquer número:
// valores fora da faixa viram o início/fim.
export function moveToPosition(ids, id, position) {
  const from = ids.indexOf(id);
  if (from === -1) return ids;
  return moveItem(ids, from, Math.round(position) - 1);
}

// Ao soltar uma linha arrastada: `insertAt` é onde o indicador de queda está
// (0..n, contando a lista ANTES de remover o item); devolve o índice final.
export function dropTarget(dragIndex, insertAt) {
  return dragIndex < insertAt ? insertAt - 1 : insertAt;
}

export const reverseIds = (ids) => [...ids].reverse();

// Modo "clicar no mapa": os escolhidos vêm primeiro, na ordem dos cliques; os
// que não foram clicados seguem depois, mantendo a ordem relativa anterior.
export function completeSequence(picked, currentIds) {
  const chosen = new Set(picked);
  return [...picked, ...currentIds.filter((id) => !chosen.has(id))];
}

// Aplica `ids` como a nova ordem da rota (order = índice) sem tocar nos demais.
export function applyOrder(collaborators, routeId, ids) {
  const position = new Map(ids.map((id, index) => [id, index]));
  return collaborators.map((c) => (c.routeId === routeId && position.has(c.id) ? { ...c, order: position.get(c.id) } : c));
}
