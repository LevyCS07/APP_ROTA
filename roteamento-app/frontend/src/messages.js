// Converte erros técnicos (texto cru do servidor, falhas de rede) em mensagens
// que uma pessoa entende, guardando o texto original para "detalhes técnicos".

const NETWORK_RE = /failed to fetch|networkerror|load failed|network request failed/i;

export function friendlyError(err, fallback = 'Algo deu errado. Tente novamente.') {
  const raw = err && err.message ? String(err.message).trim() : '';
  if (!raw) return { message: fallback, details: '' };

  if (err instanceof TypeError || NETWORK_RE.test(raw)) {
    return {
      message: 'Não foi possível falar com o servidor. Verifique a conexão e tente novamente.',
      details: raw
    };
  }

  // O backend devolve {"detail": "..."} (ou uma lista de erros de validação).
  try {
    const parsed = JSON.parse(raw);
    const detail = parsed && (parsed.detail ?? parsed.message);
    if (typeof detail === 'string' && detail.trim()) return { message: detail.trim(), details: '' };
    if (Array.isArray(detail) && detail.length) {
      const text = detail.map((item) => (item && item.msg) || String(item)).join(' · ');
      return { message: text, details: raw };
    }
  } catch {
    /* não era JSON: segue com o texto cru */
  }

  if (raw.length > 220) return { message: `${raw.slice(0, 220)}…`, details: raw };
  return { message: raw, details: '' };
}
