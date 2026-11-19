import { useEffect, useMemo, useRef, useState } from 'react';
import { byOrder, dropTarget, moveItem, moveToPosition, reverseIds, sameIds } from './orderUtils.js';
import { legDistancesKm } from './geometry.js';

const km = (value) => value.toFixed(1).replace('.', ',');

// Lista da ordem de embarque de uma rota. Formas de reposicionar (todas
// aplicam NA HORA; o servidor é atualizado em segundo plano):
//  - arrastar a linha (dá para soltar até depois do último);
//  - botões ⤒ ↑ ↓ ⤓ por colaborador;
//  - clicar no número e digitar a posição desejada;
//  - Alt+↑ / Alt+↓ (e Alt+Home / Alt+End) com a linha em foco;
//  - "Inverter ordem" e "Definir clicando no mapa" na barra acima da lista.
export default function RouteOrderList({
  collaborators,
  destino,
  onReorder,
  onFocusCollaborator,
  onHoverCollaborator,
  onStartSequence,
  disabled = false
}) {
  const sorted = useMemo(() => [...collaborators].sort(byOrder), [collaborators]);
  const ids = sorted.map((c) => c.id);
  const legs = useMemo(() => legDistancesKm(sorted, destino), [sorted, destino]);
  // Só destaca o "maior trecho" quando há o que comparar.
  const longest = legs.length > 2 ? legs.indexOf(Math.max(...legs)) : -1;

  const [dragIndex, setDragIndex] = useState(null);
  const [dropAt, setDropAt] = useState(null); // 0..n: onde a linha cairia
  const [editingId, setEditingId] = useState(null);
  const [posValue, setPosValue] = useState('');
  const [focusId, setFocusId] = useState(null);
  const itemRefs = useRef(new Map());
  const submittedRef = useRef(false);

  // Depois de mover pelo teclado/botões, mantém o foco no item que se moveu
  // (permite apertar Alt+↑ várias vezes seguidas).
  useEffect(() => {
    if (focusId === null) return;
    itemRefs.current.get(focusId)?.focus();
    setFocusId(null);
  }, [ids.join(','), focusId]); // eslint-disable-line react-hooks/exhaustive-deps

  function commit(next, movedId = null) {
    if (disabled || sameIds(next, ids)) return;
    setFocusId(movedId);
    onReorder(next);
  }

  const moveBy = (index, delta) => commit(moveItem(ids, index, index + delta), ids[index]);
  const toStart = (index) => commit(moveItem(ids, index, 0), ids[index]);
  const toEnd = (index) => commit(moveItem(ids, index, ids.length - 1), ids[index]);

  function startEditing(id, index) {
    if (disabled) return;
    submittedRef.current = false;
    setPosValue(String(index + 1));
    setEditingId(id);
  }

  function submitPosition(id) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    const value = Number(posValue);
    if (posValue.trim() !== '' && Number.isFinite(value)) commit(moveToPosition(ids, id, value), id);
    setEditingId(null);
  }

  function resetDrag() {
    setDragIndex(null);
    setDropAt(null);
  }

  function onKeyDown(event, index) {
    if (!event.altKey) return;
    const actions = { ArrowUp: () => moveBy(index, -1), ArrowDown: () => moveBy(index, 1), Home: () => toStart(index), End: () => toEnd(index) };
    if (actions[event.key]) {
      event.preventDefault();
      actions[event.key]();
    }
  }

  if (sorted.length === 0) return <p className="muted small">Nenhum colaborador nesta rota.</p>;

  return (
    <div className="order-list-wrap">
      <div className="order-toolbar">
        <button type="button" className="mini" disabled={disabled || sorted.length < 2} onClick={() => commit(reverseIds(ids))}>
          ⇅ Inverter ordem
        </button>
        <button type="button" className="mini accent" disabled={disabled || sorted.length < 2} onClick={onStartSequence}>
          🖱 Definir clicando no mapa
        </button>
      </div>
      <p className="muted small">
        Arraste, use as setas ou clique no número para digitar a posição. Alt+↑/↓ move o item em foco. Distâncias em linha reta.
      </p>

      <ol className={`order-list ${disabled ? 'disabled' : ''}`} onMouseLeave={() => onHoverCollaborator && onHoverCollaborator(null)}>
        {sorted.map((c, index) => {
          const isLast = index === sorted.length - 1;
          const dropClass = dropAt === index ? 'drop-before' : dropAt === sorted.length && isLast ? 'drop-after' : '';
          return (
            <li
              key={c.id}
              ref={(el) => (el ? itemRefs.current.set(c.id, el) : itemRefs.current.delete(c.id))}
              data-id={c.id}
              tabIndex={0}
              draggable={!disabled && editingId !== c.id}
              className={`order-item ${dragIndex === index ? 'dragging' : ''} ${dropClass}`}
              onKeyDown={(e) => onKeyDown(e, index)}
              onMouseEnter={() => onHoverCollaborator && onHoverCollaborator(c.id)}
              onFocus={() => onHoverCollaborator && onHoverCollaborator(c.id)}
              onDragStart={(e) => {
                if (disabled) return;
                setDragIndex(index);
                if (e.dataTransfer) {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(c.id));
                }
              }}
              onDragOver={(e) => {
                if (dragIndex === null) return;
                e.preventDefault();
                const rect = e.currentTarget.getBoundingClientRect();
                setDropAt(e.clientY > rect.top + rect.height / 2 ? index + 1 : index);
              }}
              onDrop={(e) => {
                e.preventDefault();
                if (dragIndex !== null && dropAt !== null) commit(moveItem(ids, dragIndex, dropTarget(dragIndex, dropAt)), ids[dragIndex]);
                resetDrag();
              }}
              onDragEnd={resetDrag}
            >
              <div className="order-row">
                <span className="drag-handle" aria-hidden="true">⋮⋮</span>

                {editingId === c.id ? (
                  <input
                    className="pos-input"
                    type="number"
                    min="1"
                    max={sorted.length}
                    autoFocus
                    aria-label={`Nova posição de ${c.nome} (1 a ${sorted.length})`}
                    value={posValue}
                    onChange={(e) => setPosValue(e.target.value)}
                    onKeyDown={(e) => {
                      e.stopPropagation();
                      if (e.key === 'Enter') submitPosition(c.id);
                      else if (e.key === 'Escape') {
                        submittedRef.current = true;
                        setEditingId(null);
                      }
                    }}
                    onBlur={() => submitPosition(c.id)}
                  />
                ) : (
                  <button
                    type="button"
                    className="order-badge"
                    title="Clique para digitar a posição"
                    aria-label={`Posição ${index + 1} de ${sorted.length}. Clique para alterar`}
                    onClick={() => startEditing(c.id, index)}
                  >
                    {index + 1}
                  </button>
                )}

                <button type="button" className="order-name" title="Mostrar no mapa" onClick={() => onFocusCollaborator && onFocusCollaborator(c.id)}>
                  {c.nome}
                </button>

                <span className="order-actions">
                  <button type="button" aria-label={`Mover ${c.nome} para o início`} title="Para o início" disabled={disabled || index === 0} onClick={() => toStart(index)}>⤒</button>
                  <button type="button" aria-label={`Subir ${c.nome}`} title="Subir" disabled={disabled || index === 0} onClick={() => moveBy(index, -1)}>↑</button>
                  <button type="button" aria-label={`Descer ${c.nome}`} title="Descer" disabled={disabled || isLast} onClick={() => moveBy(index, 1)}>↓</button>
                  <button type="button" aria-label={`Mover ${c.nome} para o fim`} title="Para o fim" disabled={disabled || isLast} onClick={() => toEnd(index)}>⤓</button>
                </span>
              </div>
              <span className={`leg ${index === longest ? 'long' : ''}`}>
                {isLast ? '→ destino' : '↓'} {km(legs[index])} km{index === longest ? ' · maior trecho' : ''}
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
