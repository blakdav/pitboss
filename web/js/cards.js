// Card faces as inline SVG. No image assets, no canvas — a card is legible
// at 48px wide and sharp at 300px with nothing swapped out.

const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
const RED = new Set(['H', 'D']);

// Pip layouts in a 0..1 box, by rank. Spot cards get real pip arrangements;
// faces and aces get one large centred glyph.
const COLUMNS = { left: 0.3, mid: 0.5, right: 0.7 };
const PIPS = {
  2: [[0.5, 0.22], [0.5, 0.78]],
  3: [[0.5, 0.22], [0.5, 0.5], [0.5, 0.78]],
  4: [[0.3, 0.22], [0.7, 0.22], [0.3, 0.78], [0.7, 0.78]],
  5: [[0.3, 0.22], [0.7, 0.22], [0.5, 0.5], [0.3, 0.78], [0.7, 0.78]],
  6: [[0.3, 0.22], [0.7, 0.22], [0.3, 0.5], [0.7, 0.5], [0.3, 0.78], [0.7, 0.78]],
  7: [
    [0.3, 0.22], [0.7, 0.22], [0.5, 0.36], [0.3, 0.5], [0.7, 0.5],
    [0.3, 0.78], [0.7, 0.78],
  ],
  8: [
    [0.3, 0.22], [0.7, 0.22], [0.5, 0.36], [0.3, 0.5], [0.7, 0.5],
    [0.5, 0.64], [0.3, 0.78], [0.7, 0.78],
  ],
  9: [
    [0.3, 0.2], [0.7, 0.2], [0.3, 0.4], [0.7, 0.4], [0.5, 0.5],
    [0.3, 0.6], [0.7, 0.6], [0.3, 0.8], [0.7, 0.8],
  ],
  10: [
    [0.3, 0.2], [0.7, 0.2], [0.5, 0.3], [0.3, 0.4], [0.7, 0.4],
    [0.3, 0.6], [0.7, 0.6], [0.5, 0.7], [0.3, 0.8], [0.7, 0.8],
  ],
};

const W = 100;
const H = 140;

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
}

/**
 * @param {{r: string, s: string}|null} card - null renders a face-down card
 * @param {{width?: number, className?: string}} opts
 */
export function cardSVG(card, { width = 64, className = '' } = {}) {
  const height = Math.round((width * H) / W);
  const open = `<svg class="card ${className}" viewBox="0 0 ${W} ${H}" width="${width}" height="${height}" role="img"`;

  if (!card) {
    return `${open} aria-label="face down card">
      <rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="9" class="c-face c-back"/>
      <rect x="9" y="9" width="${W - 18}" height="${H - 18}" rx="5" class="c-back-panel"/>
      <path d="M9 ${H / 2} L${W / 2} 9 L${W - 9} ${H / 2} L${W / 2} ${H - 9} Z" class="c-back-mark"/>
    </svg>`;
  }

  const red = RED.has(card.s);
  const glyph = SUIT_GLYPH[card.s];
  const label = `${card.r} of ${{ S: 'spades', H: 'hearts', D: 'diamonds', C: 'clubs' }[card.s]}`;
  const tone = red ? 'c-red' : 'c-black';
  const rankSize = card.r === '10' ? 20 : 24;

  let body;
  if (card.r === 'A') {
    body = `<text x="${W / 2}" y="${H / 2}" class="c-center-glyph ${tone}" text-anchor="middle" dominant-baseline="central">${glyph}</text>`;
  } else if (['J', 'Q', 'K'].includes(card.r)) {
    body = `
      <rect x="22" y="34" width="${W - 44}" height="${H - 68}" rx="4" class="c-court ${tone}"/>
      <text x="${W / 2}" y="${H / 2 - 8}" class="c-court-letter ${tone}" text-anchor="middle" dominant-baseline="central">${card.r}</text>
      <text x="${W / 2}" y="${H / 2 + 22}" class="c-court-glyph ${tone}" text-anchor="middle" dominant-baseline="central">${glyph}</text>`;
  } else {
    // Real cards invert the lower pips, but a rotated ♥ glyph reads as a ♠
    // and a rotated ♦ loses its orientation entirely, so pips stay upright.
    const pips = PIPS[card.r] || [];
    body = pips
      .map(
        ([x, y]) =>
          `<text x="${x * W}" y="${y * H}" class="c-pip ${tone}" text-anchor="middle" dominant-baseline="central">${glyph}</text>`
      )
      .join('');
  }

  return `${open} aria-label="${esc(label)}">
    <rect x="1.5" y="1.5" width="${W - 3}" height="${H - 3}" rx="9" class="c-face"/>
    <text x="9" y="8" class="c-rank ${tone}" font-size="${rankSize}" dominant-baseline="hanging">${card.r}</text>
    <text x="11" y="${rankSize + 12}" class="c-corner-glyph ${tone}" dominant-baseline="hanging">${glyph}</text>
    <g transform="rotate(180 ${W / 2} ${H / 2})">
      <text x="9" y="8" class="c-rank ${tone}" font-size="${rankSize}" dominant-baseline="hanging">${card.r}</text>
      <text x="11" y="${rankSize + 12}" class="c-corner-glyph ${tone}" dominant-baseline="hanging">${glyph}</text>
    </g>
    ${body}
  </svg>`;
}

/** A row of cards, overlapped so a long hand still fits a phone. */
export function handSVG(cards, { width = 64, hideFirst = false, overlap = 0.42 } = {}) {
  const step = Math.round(width * (1 - overlap));
  return cards
    .map((c, i) => {
      const shown = hideFirst && i === 0 ? null : c;
      const ml = i === 0 ? 0 : -(width - step);
      return `<span class="card-slot" style="margin-left:${ml}px">${cardSVG(shown, { width })}</span>`;
    })
    .join('');
}
