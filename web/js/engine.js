// Shoe, hands, dealer and the other seats at the table.
//
// The shoe is deterministic given (seed, shoeNumber): rebuilding it and
// dealing N cards into the void restores any position exactly. That is how
// session resume works, and it keeps the client free of stored state.

import { mulberry32, shuffle } from './rng.js';

export const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const SUITS = ['S', 'H', 'D', 'C'];

/** Rank as the chart and the counting systems address it: faces are 10s. */
export function countKey(rank) {
  if (rank === 'J' || rank === 'Q' || rank === 'K') return '10';
  return rank;
}

export function cardValue(rank) {
  if (rank === 'A') return 11;
  return countKey(rank) === '10' ? 10 : parseInt(rank, 10);
}

/** Best total for a hand, plus whether an ace is still counting as 11. */
export function handValue(cards) {
  let total = 0;
  let aces = 0;
  for (const c of cards) {
    total += cardValue(c.r);
    if (c.r === 'A') aces += 1;
  }
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return { total, soft: aces > 0 };
}

export function isBlackjack(cards) {
  return cards.length === 2 && handValue(cards).total === 21;
}

export function isPair(cards) {
  return cards.length === 2 && countKey(cards[0].r) === countKey(cards[1].r);
}

export class Shoe {
  constructor(seed, shoeNumber, decks, penetration) {
    this.decks = decks;
    this.penetration = penetration;
    this.shoeNumber = shoeNumber;
    this.cards = [];
    const rand = mulberry32((seed + shoeNumber * 7919) >>> 0);
    for (let d = 0; d < decks; d++) {
      for (const s of SUITS) for (const r of RANKS) this.cards.push({ r, s });
    }
    shuffle(this.cards, rand);
    this.index = 0;
    this.cutIndex = Math.floor(this.cards.length * penetration);
  }

  draw() {
    if (this.index >= this.cards.length) throw new Error('shoe exhausted');
    return this.cards[this.index++];
  }

  /** Fast-forward without dealing, for rebuilding a saved position. */
  advance(n) {
    const seen = this.cards.slice(this.index, this.index + n);
    this.index += n;
    return seen;
  }

  needsShuffle() {
    return this.index >= this.cutIndex;
  }

  get dealt() {
    return this.index;
  }
}

export class Hand {
  constructor(cards = [], { fromSplit = false, splitAces = false, bet = 1 } = {}) {
    this.cards = cards;
    this.fromSplit = fromSplit;
    this.splitAces = splitAces;
    this.bet = bet;
    this.doubled = false;
    this.surrendered = false;
    this.done = false;
  }

  get value() {
    return handValue(this.cards);
  }
  get total() {
    return this.value.total;
  }
  get soft() {
    return this.value.soft;
  }
  get busted() {
    return this.total > 21;
  }
  get isPair() {
    return isPair(this.cards);
  }
  get pairRank() {
    return this.isPair ? countKey(this.cards[0].r) : null;
  }
  get isBlackjack() {
    return !this.fromSplit && isBlackjack(this.cards);
  }
}

/** What the player is allowed to do with this hand right now. */
export function legalActions(hand, rules, handCount) {
  const two = hand.cards.length === 2;

  // A hand split from aces draws exactly one card. The only thing it may
  // still do is re-split, and only where the rules allow that — which is a
  // different rule from "draw to split aces", and much more common.
  if (hand.splitAces) {
    const canResplit =
      two && hand.isPair && rules.resplit_aces && handCount < rules.resplit_limit;
    return {
      hit: false,
      stand: !canResplit,
      double: false,
      split: canResplit,
      surrender: false,
    };
  }

  const canDoubleValue =
    rules.double_any_two || (!hand.soft && [9, 10, 11].includes(hand.total));
  return {
    hit: !hand.done && !hand.busted,
    stand: !hand.done && !hand.busted,
    double: two && canDoubleValue && (!hand.fromSplit || rules.das),
    split:
      two &&
      hand.isPair &&
      handCount < rules.resplit_limit &&
      (!hand.fromSplit || hand.pairRank !== 'A' || rules.resplit_aces),
    surrender: two && !hand.fromSplit && rules.surrender,
  };
}

export function dealerShouldHit(cards, rules) {
  const { total, soft } = handValue(cards);
  if (total < 17) return true;
  if (total === 17 && soft && rules.h17) return true;
  return false;
}

/** Settle one player hand against the dealer. Returns net units. */
export function settle(hand, dealerCards, rules) {
  if (hand.surrendered) return -0.5 * hand.bet;
  const bet = hand.bet * (hand.doubled ? 2 : 1);
  if (hand.busted) return -bet;

  const dealerBJ = isBlackjack(dealerCards);
  if (hand.isBlackjack && !dealerBJ) return hand.bet * rules.blackjack_pays;
  if (dealerBJ && !hand.isBlackjack) return -bet;
  if (dealerBJ && hand.isBlackjack) return 0;

  const d = handValue(dealerCards).total;
  if (d > 21) return bet;
  if (hand.total > d) return bet;
  if (hand.total < d) return -bet;
  return 0;
}
