// Cores e ícones dos pontos no mapa. Isolado do MapEditor para poder ser
// testado e reaproveitado (legenda).

export const COLORS = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4',
  '#f032e6', '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324',
  '#800000', '#808000', '#000075', '#a9a9a9'
];

export function routeColor(routeId) {
  if (!routeId) return '#111';
  return COLORS[(routeId - 1) % COLORS.length];
}

// Cor de texto (preto ou branco) com MAIOR contraste sobre o fundo `hex`
// (luminância relativa WCAG). Antes o número era sempre branco, ilegível
// sobre cores claras como #bfef45 ou #fabed4.
export function readableTextColor(hex) {
  let clean = String(hex).replace('#', '');
  if (clean.length === 3) clean = clean.split('').map((ch) => ch + ch).join(''); // #111 -> #111111
  const [r, g, b] = [0, 2, 4]
    .map((i) => parseInt(clean.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const contrastWithWhite = 1.05 / (luminance + 0.05);
  const contrastWithBlack = (luminance + 0.05) / 0.05;
  return contrastWithWhite >= contrastWithBlack ? '#fff' : '#111';
}

// Zoom a partir do qual os números aparecem dentro dos marcadores (abaixo
// disso o mapa fica poluído e os pontos encolhem; ver .map-low-zoom no CSS).
export const NUMBER_MIN_ZOOM = 12;

// HTML do marcador. Atribuído a uma rota => círculo COM O NÚMERO DA ROTA
// (identificação além da cor); em edição de ordem => número de embarque;
// sem rota => quadrado pequeno e escuro. `size` é devolvido para o anchor.
export function pointIconSpec(routeId, { selected = false, order = null } = {}) {
  const color = routeColor(routeId);
  const hasOrder = order !== null && order !== undefined;
  // Tamanhos totais (com borda) iguais aos de antes: sem rota é maior para chamar atenção.
  const size = selected ? 26 : hasOrder ? 28 : routeId ? 20 : 22;
  const radius = hasOrder || routeId ? '50%' : '3px';
  const border = selected ? '#facc15' : '#fff';
  const text = hasOrder ? order : routeId || '';
  const digits = String(text).length;
  const fontSize = digits >= 3 ? 8 : digits === 2 ? 10 : 11;
  const textColor = readableTextColor(color);
  const label = text !== ''
    ? `<span class="pt-num" style="color:${textColor};font-size:${fontSize}px">${text}</span>`
    : '';
  const html =
    `<div class="pt" style="width:${size}px;height:${size}px;border-radius:${radius};background:${color};` +
    `border:2px solid ${border};box-shadow:0 1px 6px rgba(0,0,0,.55)">${label}</div>`;
  return { size, html };
}
