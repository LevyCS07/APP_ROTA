// Lista de colaboradores de uma rota na ordem de embarque, com controles
// para subir/descer cada colaborador na sequência.
export default function RouteOrderList({ collaborators, onReorder, disabled }) {
  const items = [...collaborators].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  function move(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= items.length) return;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    onReorder(next.map((c) => c.id));
  }

  if (!items.length) {
    return <p className="muted">Nenhum colaborador nesta rota ainda.</p>;
  }

  return (
    <ol className="order-list">
      {items.map((collab, index) => (
        <li key={collab.id}>
          <span className="order-badge">{index + 1}</span>
          <span className="order-name" title={collab.nome}>{collab.nome}</span>
          <div className="order-actions">
            <button
              type="button"
              className="mini"
              disabled={disabled || index === 0}
              onClick={() => move(index, -1)}
              aria-label={`Mover ${collab.nome} para cima`}
            >
              ↑
            </button>
            <button
              type="button"
              className="mini"
              disabled={disabled || index === items.length - 1}
              onClick={() => move(index, 1)}
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
