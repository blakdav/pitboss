// Running and true count for whichever system the session selected.
// Systems arrive from the server as data; nothing here is system-specific.

import { countKey } from './engine.js';

export class Counter {
  constructor(system, decks) {
    this.system = system;
    this.decks = decks;
    this.reset();
  }

  reset() {
    this.running = this.system.irc || 0;
    this.seen = 0;
  }

  see(card) {
    this.running += this.system.tags[countKey(card.r)] || 0;
    this.seen += 1;
  }

  decksRemaining() {
    const left = this.decks * 52 - this.seen;
    return Math.max(left / 52, 0.25);
  }

  // Unbalanced systems (KO) are used on the running count directly; a true
  // count for them is not meaningful, so it is reported as the running count.
  trueCount() {
    if (!this.system.balanced) return this.running;
    return this.running / this.decksRemaining();
  }

  snapshot() {
    return {
      running: this.running,
      true: Math.round(this.trueCount() * 100) / 100,
      decksLeft: Math.round(this.decksRemaining() * 100) / 100,
      seen: this.seen,
    };
  }
}
