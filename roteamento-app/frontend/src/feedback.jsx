import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { friendlyError } from './messages.js';

// Avisos não bloqueantes (toasts) e diálogo de confirmação próprio, no lugar
// de alert()/confirm()/prompt() do navegador:
//   const { toast, confirm } = useFeedback();
//   toast.success('Salvo.');                    toast.info(msg, { action: { label, onClick } });
//   toast.fail('Não foi possível baixar', err); // erro amigável + "detalhes técnicos"
//   if (await confirm({ title, message, confirmLabel, danger: true })) { ... }

const FeedbackContext = createContext(null);

export function useFeedback() {
  const ctx = useContext(FeedbackContext);
  if (!ctx) throw new Error('useFeedback precisa estar dentro de <FeedbackProvider>.');
  return ctx;
}

const MAX_TOASTS = 4;
const DEFAULT_DURATION = { success: 4000, info: 6000, error: 10000 };
const ICONS = { success: '✓', info: 'ℹ', error: '⚠' };

function Toast({ toast, onDismiss }) {
  const [paused, setPaused] = useState(false);
  const duration = toast.duration ?? DEFAULT_DURATION[toast.type];

  // O tempo recomeça quando o mouse sai de cima (dá tempo de ler/clicar).
  useEffect(() => {
    if (paused || !duration) return undefined;
    const timer = setTimeout(() => onDismiss(toast.id), duration);
    return () => clearTimeout(timer);
  }, [paused, duration, toast.id, onDismiss]);

  return (
    <div
      className={`toast ${toast.type}`}
      role={toast.type === 'error' ? 'alert' : 'status'}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <span className="toast-icon" aria-hidden="true">{ICONS[toast.type]}</span>
      <div className="toast-body">
        <p className="toast-title">{toast.message}</p>
        {toast.description && <p className="toast-desc">{toast.description}</p>}
        {toast.details && (
          <details className="toast-details">
            <summary>Detalhes técnicos</summary>
            <pre>{toast.details}</pre>
          </details>
        )}
        {toast.action && (
          <button
            type="button"
            className="toast-action"
            onClick={() => {
              onDismiss(toast.id);
              toast.action.onClick();
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>
      <button type="button" className="toast-close" aria-label="Fechar aviso" onClick={() => onDismiss(toast.id)}>
        ×
      </button>
    </div>
  );
}

function ConfirmDialog({ dialog, onAnswer }) {
  const confirmRef = useRef(null);
  const cancelRef = useRef(null);

  // Em ações destrutivas o foco inicial vai para "Cancelar" (evita Enter sem querer).
  useEffect(() => {
    (dialog.danger ? cancelRef : confirmRef).current?.focus();
  }, [dialog]);

  function onKeyDown(event) {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onAnswer(false);
    } else if (event.key === 'Tab') {
      // Mantém o foco dentro do diálogo (só há dois botões).
      const first = cancelRef.current;
      const last = confirmRef.current;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  return (
    <div className="confirm-overlay" onMouseDown={(e) => e.target === e.currentTarget && onAnswer(false)}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby="confirm-message"
        onKeyDown={onKeyDown}
      >
        <h2 id="confirm-title">{dialog.title}</h2>
        {dialog.message && <p id="confirm-message">{dialog.message}</p>}
        <div className="confirm-actions">
          <button type="button" ref={cancelRef} className="confirm-cancel" onClick={() => onAnswer(false)}>
            {dialog.cancelLabel}
          </button>
          <button
            type="button"
            ref={confirmRef}
            className={`confirm-ok ${dialog.danger ? 'danger' : ''}`}
            onClick={() => onAnswer(true)}
          >
            {dialog.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function FeedbackProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const [dialog, setDialog] = useState(null);
  const nextId = useRef(1);

  const dismiss = useCallback((id) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const push = useCallback((type, message, options = {}) => {
    const id = nextId.current++;
    const item = { id, type, message, ...options };
    setToasts((list) => {
      // `key` repete o mesmo aviso (ex.: erro ao salvar a cada tecla) sem empilhar.
      const base = options.key ? list.filter((t) => t.key !== options.key) : list;
      return [...base, item].slice(-MAX_TOASTS);
    });
    return id;
  }, []);

  const toast = useMemo(
    () => ({
      success: (message, options) => push('success', message, options),
      info: (message, options) => push('info', message, options),
      error: (message, options) => push('error', message, options),
      // Erro vindo de uma exceção: mensagem amigável + texto técnico recolhido.
      fail: (title, err, options = {}) => {
        const { message, details } = friendlyError(err);
        return push('error', title, { description: message, details, ...options });
      },
      dismiss
    }),
    [push, dismiss]
  );

  const confirm = useCallback(
    (options) =>
      new Promise((resolve) => {
        setDialog({
          title: 'Confirmar',
          message: '',
          confirmLabel: 'Confirmar',
          cancelLabel: 'Cancelar',
          danger: false,
          ...options,
          resolve
        });
      }),
    []
  );

  function answer(value) {
    if (dialog) dialog.resolve(value);
    setDialog(null);
  }

  const value = useMemo(() => ({ toast, confirm }), [toast, confirm]);

  return (
    <FeedbackContext.Provider value={value}>
      {children}
      <div className="toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <Toast key={t.id} toast={t} onDismiss={dismiss} />
        ))}
      </div>
      {dialog && <ConfirmDialog dialog={dialog} onAnswer={answer} />}
    </FeedbackContext.Provider>
  );
}
