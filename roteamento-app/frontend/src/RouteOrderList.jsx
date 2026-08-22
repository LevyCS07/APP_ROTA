import { useState } from 'react';

// Lista de colaboradores de uma rota na ordem de embarque.
// Suporta arrastar-e-soltar (uma única requisição por reorganização, mesmo
// movendo um item de posição 10 para 2) e setas para ajustes finos de 1 posição.
export default function RouteOrderList({ collaborators, onReorder, disabled }) {
  const [dragIndex, setDragIndex] = useState(null);
  const [overIndex, setOverIndex] = useState(null);

  const items = [...collaborators].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  function commitMove(from, to) {
    if (from === null || to === null || from === to) return;
    const next = [...items];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onReorder(next.map((c) => c.id));
  }

  function handleDrop(index) {
    commitMove(dragIndex, index);
    setDragIndex(null);
    setOverIndex(null);
  }

  if (!items.length) {
    return <p className="muted">Nenhum colaborador nesta rota ainda.</p>;
  }

  return (
    <ol className="order-list">
      {items.map((collab, index) => (
        <li
          key={collab.id}
          draggable={!disabled}
          onDragStart={() => setDragIndex(index)}
          onDragOver={(e) => {
            e.preventDefault();
            if (overIndex !== index) setOverIndex(index);
          }}
          onDrop={() => handleDrop(index)}
          onDragEnd={() => {
            setDragIndex(null);
            setOverIndex(null);
          }}
          className={[
            dragIndex === index ? 'dragging' : '',
            overIndex === index && dragIndex !== null && dragIndex !== index ? 'drag-over' : ''
          ].filter(Boolean).join(' ')}
        >
          <span className="drag-handle" title="Arraste para reordenar">⠿</span>
          <span className="order-badge">{index + 1}</span>
          <span className="order-name" title={collab.nome}>{collab.nome}</span>
          <div className="order-actions">
            <button
              type="button"
              className="mini"
              disabled={disabled || index === 0}
              onClick={() => commitMove(index, index - 1)}
              aria-label={`Mover ${collab.nome} para cima`}
            >
              ↑
            </button>
            <button
              type="button"
              className="mini"
              disabled={disabled || index === items.length - 1}
              onClick={() => commitMove(index, index + 1)}
              aria-label={`Mover ${collab.nome} para baixo`}
            >
              ↓
            </button>
          </div>
        </li>
      ))}
    </ol>
  );
}
