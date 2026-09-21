// Decision lookup against the chart the server resolved.
//
// The server has already applied the rule deltas and collapsed every
// rule-conditional code, so nothing here knows about H17 or DAS. All this
// does is pick the right row and downgrade a double or split the hand
// itself cannot legally make.

import { countKey, legalActions } from './engine.js';

export const ACTION_LABEL = {
  hit: 'Hit',
  stand: 'Stand',
  double: 'Double',
  split: 'Split',
  surrender: 'Surrender',
};

/** The correct play for this hand under this chart. */
export function correctAction(chart, rules, hand, upcardRank, handCount) {
  const up = countKey(upcardRank);
  const i = chart.upcards.indexOf(up);
  const legal = legalActions(hand, rules, handCount);

  // A hand split from aces has no decision to make: it drew its one card.
  // Where re-splitting aces is allowed it takes that, otherwise it stands.
  // Without this the chart would be asked about a soft 12 and answer "hit",
  // which the hand is not allowed to do.
  if (hand.splitAces) return legal.split ? 'split' : 'stand';

  // Surrender first: it is only ever offered on the first two cards, and
  // where it applies it outranks the chart cell underneath it.
  if (legal.surrender) {
    const key = hand.isPair ? `pair:${hand.pairRank}` : `hard:${hand.total}`;
    const cells = chart.surrender[key];
    if (cells && cells.includes(up) && !hand.soft) return 'surrender';
  }

  // Pairs, while the hand can still be split.
  if (hand.isPair && legal.split) {
    const code = chart.pair[hand.pairRank][i];
    if (code === 'P') return 'split';
    return downgrade(code, legal);
  }

  const group = hand.soft ? 'soft' : 'hard';
  const row = chart[group][String(hand.total)];
  if (!row) return 'stand'; // totals above the chart are always stands
  return downgrade(row[i], legal);
}

function downgrade(code, legal) {
  switch (code) {
    case 'H':
      return 'hit';
    case 'S':
      return 'stand';
    case 'D':
      return legal.double ? 'double' : 'hit';
    case 'DS':
      return legal.double ? 'double' : 'stand';
    case 'P':
      return legal.split ? 'split' : 'hit';
    default:
      return 'hit';
  }
}

/** Basic strategy for the other seats. They never surrender — real players
 *  rarely do, and a surrendered hand takes cards out of the shoe flow. */
export function botAction(chart, rules, hand, upcardRank, handCount) {
  const a = correctAction(
    chart,
    { ...rules, surrender: false },
    hand,
    upcardRank,
    handCount
  );
  return a === 'surrender' ? 'hit' : a;
}

/** Plain-language reason a play is right, for the feedback panel. */
export function explain(chart, rules, hand, upcardRank, action) {
  const up = countKey(upcardRank);
  const dealerWeak = ['4', '5', '6'].includes(up);
  const dealerStiff = ['2', '3', '4', '5', '6'].includes(up);
  const t = hand.total;

  if (action === 'surrender')
    return `${t} against ${up} loses more than half the time; giving back half the bet beats playing it out.`;
  if (action === 'split' && hand.pairRank === 'A')
    return 'Two aces played separately each start from 11. Always split them.';
  if (action === 'split' && hand.pairRank === '8')
    return 'A hard 16 is the worst hand in the game. Two hands starting from 8 beat it against any upcard.';
  if (action === 'split')
    return `Splitting ${hand.pairRank}s against ${up} turns one weak total into two hands with a live dealer bust card showing.`;
  if (action === 'double' && hand.soft)
    return `Soft ${t} can't bust on one card, and ${up} busts often enough to justify the extra bet.`;
  if (action === 'double')
    return `${t} is a strong doubling total against ${up}${dealerWeak ? ', the dealer\'s weakest range' : ''}.`;
  if (action === 'stand' && !hand.soft && t >= 12 && t <= 16)
    return `${t} busts on most draws. Against ${up} the dealer has to draw to a stiff hand, so let them.`;
  if (action === 'stand' && hand.soft)
    return `Soft ${t} is already better than the dealer's average made hand.`;
  if (action === 'stand') return `${t} is strong enough to stand on against anything.`;
  if (action === 'hit' && !hand.soft && t >= 12)
    return `${up} is a strong upcard${dealerStiff ? '' : ' that rarely busts'}, so ${t} isn't enough to win standing.`;
  if (action === 'hit' && hand.soft)
    return `Soft ${t} can't bust — taking a card is free.`;
  return `${t} against ${up} calls for a hit.`;
}
