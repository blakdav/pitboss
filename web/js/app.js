// Drill orchestration and UI.

import {
  Shoe, Hand, legalActions, dealerShouldHit, settle, countKey, handValue,
} from './engine.js';
import { correctAction, botAction, explain, ACTION_LABEL } from './strategy.js';
import { Counter } from './counting.js';
import { handSVG } from './cards.js';
import { api, outbox, uid, installFlushTriggers } from './net.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

const S = {
  boot: null,
  session: null,
  rules: null,
  chart: null,
  system: null,
  mode: 'tutor',
  showCount: false,
  countChecks: false,
  shoe: null,
  counter: null,
  shoeNumber: 0,
  handIndex: 0,
  bankroll: 0,
  tally: { total: 0, correct: 0 },
  shoeLog: [],
  pendingResolve: null,
  actionArmedAt: 0,
  table: null,
};

// --- boot ------------------------------------------------------------------

async function boot() {
  S.boot = await api('/bootstrap');
  renderSetup();
  installFlushTriggers(renderSyncBadge);
  await outbox.flush();
  renderSyncBadge();

  if (S.boot.resume && S.boot.resume.session.state) {
    showResumeBanner(S.boot.resume);
  }
  show('setup');
}

function show(screen) {
  $$('.screen').forEach((el) => el.classList.toggle('active', el.id === `screen-${screen}`));
  $$('.nav-btn').forEach((b) => b.classList.toggle('on', b.dataset.screen === screen));
}

function renderSyncBadge(r) {
  const n = r ? r.pending : outbox.pending;
  const el = $('#sync');
  if (!el) return;
  const offline = !navigator.onLine;
  el.textContent = offline ? `offline · ${n} queued` : n ? `${n} queued` : 'synced';
  el.className = `sync ${offline ? 'warn' : n ? 'busy' : 'ok'}`;
}

// --- setup -----------------------------------------------------------------

function renderSetup() {
  const sel = $('#rule-set');
  sel.innerHTML = S.boot.rule_sets
    .map((r) => `<option value="${r.id}">${r.name}</option>`)
    .join('');
  const def = S.boot.rule_sets.find((r) => r.is_default) || S.boot.rule_sets[0];
  if (def) sel.value = def.id;
  renderRuleSummary();

  $('#sys').innerHTML = S.boot.counting_systems
    .map((s) => `<option value="${s.key}">${s.name}</option>`)
    .join('');
}

function currentRuleSet() {
  const id = Number($('#rule-set').value);
  return S.boot.rule_sets.find((r) => r.id === id);
}

function renderRuleSummary() {
  const r = currentRuleSet();
  if (!r) return;
  const bits = [
    `${r.decks} decks`,
    r.h17 ? 'H17' : 'S17',
    r.das ? 'DAS' : 'no DAS',
    r.surrender ? 'late surrender' : 'no surrender',
    `${Math.round(r.penetration * 100)}% pen`,
    `${r.other_players} other ${r.other_players === 1 ? 'player' : 'players'}`,
    r.blackjack_pays === 1.5 ? 'BJ 3:2' : 'BJ 6:5',
  ];
  $('#rule-summary').textContent = bits.join(' · ');
}

function showResumeBanner(resume) {
  const st = resume.session.state;
  const el = $('#resume');
  el.hidden = false;
  el.querySelector('.resume-text').textContent =
    `Session from ${resume.session.started_at.slice(0, 16).replace('T', ' ')} — ` +
    `${st.handIndex} hands, shoe ${st.shoeNumber + 1}, ${st.tally.correct}/${st.tally.total} correct.`;
  el.querySelector('[data-act="resume"]').onclick = () => startSession({ resume });
  el.querySelector('[data-act="discard"]').onclick = async () => {
    await api(`/sessions/${resume.session.id}/end`, { method: 'POST' });
    el.hidden = true;
  };
}

// --- session ---------------------------------------------------------------

async function startSession({ resume = null } = {}) {
  let payload;
  if (resume) {
    payload = resume;
  } else {
    payload = await api('/sessions', {
      method: 'POST',
      body: {
        rule_set_id: Number($('#rule-set').value),
        mode: $('#mode').value,
        counting_system: $('#sys').value,
        layers: $('#count-checks').checked ? ['basic', 'running_count'] : ['basic'],
      },
    });
  }

  S.session = payload.session;
  S.chart = payload.chart;
  S.rules = payload.chart.rules;
  S.mode = payload.session.mode;
  S.system = payload.counting.systems.find((s) => s.key === payload.session.counting_system);
  S.countChecks = payload.session.layers.includes('running_count');
  S.showCount = S.countChecks || $('#show-count').checked;

  const st = payload.session.state;
  S.shoeNumber = st ? st.shoeNumber : 0;
  S.handIndex = st ? st.handIndex : 0;
  S.bankroll = st ? st.bankroll : 0;
  S.tally = st ? st.tally : { total: 0, correct: 0 };

  newShoe({ advanceTo: st ? st.cardsDealt : 0 });
  $('#resume').hidden = true;
  show('table');
  runHand();
}

function newShoe({ advanceTo = 0 } = {}) {
  S.shoe = new Shoe(S.session.seed, S.shoeNumber, S.rules.decks, S.rules.penetration);
  S.counter = new Counter(S.system, S.rules.decks);
  S.shoeLog = [];
  if (advanceTo > 0) {
    // Rebuild a saved position: every card dealt before the save was face
    // up by the time the hand finished, so the count restores exactly.
    for (const c of S.shoe.advance(advanceTo)) S.counter.see(c);
  }
}

async function saveState() {
  try {
    await api(`/sessions/${S.session.id}/state`, {
      method: 'PUT',
      body: {
        state: {
          shoeNumber: S.shoeNumber,
          cardsDealt: S.shoe.dealt,
          handIndex: S.handIndex,
          bankroll: S.bankroll,
          tally: S.tally,
        },
      },
    });
  } catch (e) {
    /* offline; the next hand will save */
  }
}

// --- round -----------------------------------------------------------------

function deal() {
  const c = S.shoe.draw();
  S.counter.see(c);
  return c;
}

function dealHidden() {
  return S.shoe.draw(); // counted when revealed
}

async function runHand() {
  if (S.shoe.needsShuffle()) {
    if (S.mode === 'simulation' && S.shoeLog.length) {
      await showShoeReview();
    }
    S.shoeNumber += 1;
    newShoe();
    flash('Shuffle — new shoe, count resets');
  }

  const n = S.rules.other_players;
  const before = Math.floor(n / 2);
  const after = n - before;

  const table = {
    before: Array.from({ length: before }, () => [new Hand()]),
    after: Array.from({ length: after }, () => [new Hand()]),
    hero: [new Hand()],
    dealer: { cards: [], hole: null, revealed: false },
    activeHero: 0,
  };
  S.table = table;

  const seats = [...table.before, table.hero, ...table.after];

  // Two rounds of dealing, dealer's second card face down.
  for (const seat of seats) seat[0].cards.push(deal());
  table.dealer.cards.push(deal());
  for (const seat of seats) seat[0].cards.push(deal());
  table.dealer.hole = dealHidden();

  render();

  const upcard = table.dealer.cards[0].r;
  const dealerHasBJ =
    handValue([table.dealer.cards[0], table.dealer.hole]).total === 21;

  // Peek: a dealt-through blackjack ends the round before anyone acts.
  if (S.rules.peek && ['A', '10', 'J', 'Q', 'K'].includes(upcard) && dealerHasBJ) {
    revealHole();
    render();
    await finishRound(table, 'Dealer blackjack.');
    return;
  }

  for (const seat of table.before) playBot(seat, upcard);
  render();

  if (S.countChecks && Math.random() < 0.12) await countCheck();

  await playHero(table, upcard);

  for (const seat of table.after) playBot(seat, upcard);
  render();

  // Dealer only draws if at least one hand is still live.
  const live = table.hero.some((h) => !h.busted && !h.surrendered);
  const botsLive = [...table.before, ...table.after].some((s) =>
    s.some((h) => !h.busted)
  );
  revealHole();
  if (live || botsLive) {
    while (dealerShouldHit(dealerCards(table), S.rules)) {
      table.dealer.cards.push(deal());
      render();
      await sleep(260);
    }
  }
  render();
  await finishRound(table);
}

function dealerCards(table) {
  return table.dealer.revealed
    ? [...table.dealer.cards, table.dealer.hole]
    : table.dealer.cards;
}

function revealHole() {
  const t = S.table;
  if (t.dealer.revealed) return;
  t.dealer.revealed = true;
  S.counter.see(t.dealer.hole);
}

function playBot(seat, upcard) {
  let guard = 0;
  while (guard++ < 24) {
    const hand = seat.find((h) => !h.done && !h.busted);
    if (!hand) break;
    const a = botAction(S.chart, S.rules, hand, upcard, seat.length);
    applyAction(seat, hand, a);
  }
}

function applyAction(seat, hand, action) {
  switch (action) {
    case 'hit':
      hand.cards.push(deal());
      if (hand.busted || hand.total === 21) hand.done = true;
      break;
    case 'stand':
      hand.done = true;
      break;
    case 'double':
      hand.doubled = true;
      hand.cards.push(deal());
      hand.done = true;
      break;
    case 'surrender':
      hand.surrendered = true;
      hand.done = true;
      break;
    case 'split': {
      const moved = hand.cards.pop();
      const aces = countKey(hand.cards[0].r) === 'A';
      const next = new Hand([moved], {
        fromSplit: true, splitAces: aces, bet: hand.bet,
      });
      hand.fromSplit = true;
      hand.splitAces = hand.splitAces || aces;
      hand.cards.push(deal());
      next.cards.push(deal());
      seat.splice(seat.indexOf(hand) + 1, 0, next);
      if (aces) {
        // One card each. A hand stays live only if it can be re-split.
        for (const h of [hand, next]) {
          h.done = !(
            S.rules.resplit_aces &&
            h.isPair &&
            seat.length < S.rules.resplit_limit
          );
        }
      }
      break;
    }
  }
}

async function playHero(table, upcard) {
  let guard = 0;
  while (guard++ < 24) {
    const idx = table.hero.findIndex((h) => !h.done && !h.busted);
    if (idx === -1) break;
    table.activeHero = idx;
    const hand = table.hero[idx];

    const legal = legalActions(hand, S.rules, table.hero.length);
    const correct = correctAction(S.chart, S.rules, hand, upcard, table.hero.length);

    render();
    const { action, latency, inputType } = await awaitAction(legal);

    const ok = action === correct;
    S.tally.total += 1;
    if (ok) S.tally.correct += 1;

    const record = {
      client_uid: uid(),
      hand_index: S.handIndex,
      cards_dealt: S.shoe.dealt,
      player_cards: hand.cards.map((c) => c.r),
      player_total: hand.total,
      is_soft: hand.soft,
      is_pair: hand.isPair,
      from_split: hand.fromSplit,
      dealer_upcard: countKey(upcard),
      running_count: S.counter.running,
      true_count: S.counter.snapshot().true,
      action,
      correct_action: correct,
      error_class: ok ? 'correct' : 'strategy_error',
      latency_ms: latency,
      input_type: inputType,
      mode: S.mode,
    };
    await outbox.queueDecision(S.session.id, record);
    renderSyncBadge();

    const entry = {
      cards: hand.cards.map((c) => `${c.r}${c.s}`),
      total: hand.total,
      soft: hand.soft,
      upcard: countKey(upcard),
      action,
      correct,
      ok,
      tc: record.true_count,
    };
    S.shoeLog.push(entry);

    if (!ok && S.mode === 'tutor') {
      await showCorrection(hand, upcard, action, correct);
    } else if (!ok) {
      flash('Noted — review at end of shoe', 'muted');
    }

    applyAction(table.hero, hand, action);
    render();
    await sleep(180);
  }
}

function awaitAction(legal) {
  return new Promise((resolve) => {
    S.actionArmedAt = performance.now();
    setActionButtons(legal, (action, ev) => {
      const latency = Math.round(performance.now() - S.actionArmedAt);
      const inputType =
        ev && ev.type === 'keydown'
          ? 'key'
          : ev && ev.pointerType
            ? ev.pointerType
            : 'mouse';
      setActionButtons(null);
      resolve({ action, latency, inputType });
    });
  });
}

const KEYMAP = { h: 'hit', s: 'stand', d: 'double', p: 'split', r: 'surrender' };

function setActionButtons(legal, onPick) {
  const bar = $('#actions');
  if (!legal) {
    bar.querySelectorAll('button').forEach((b) => (b.disabled = true));
    document.onkeydown = null;
    return;
  }
  bar.querySelectorAll('button').forEach((b) => {
    const a = b.dataset.action;
    b.disabled = !legal[a];
    b.onclick = (ev) => legal[a] && onPick(a, ev);
  });
  document.onkeydown = (ev) => {
    const a = KEYMAP[ev.key.toLowerCase()];
    if (a && legal[a]) {
      ev.preventDefault();
      onPick(a, ev);
    }
  };
}

async function finishRound(table) {
  const dealer = dealerCards(table);
  let net = 0;
  for (const h of table.hero) net += settle(h, dealer, S.rules);
  S.bankroll += net;
  S.handIndex += 1;

  render(net);
  await saveState();
  outbox.flush().then(renderSyncBadge);
  await sleep(S.mode === 'tutor' ? 900 : 650);
  runHand();
}

// --- count check -----------------------------------------------------------

function countCheck() {
  return new Promise((resolve) => {
    const snap = S.counter.snapshot();
    const t0 = performance.now();
    const panel = $('#overlay');
    panel.hidden = false;
    panel.innerHTML = `
      <div class="sheet">
        <h2>Running count?</h2>
        <p class="muted">${snap.decksLeft} decks left in the shoe.</p>
        <input id="rc-input" type="number" inputmode="numeric" placeholder="running count" autofocus>
        <button class="primary" id="rc-go">Check</button>
      </div>`;
    const submit = async () => {
      const reported = Number($('#rc-input').value);
      const latency = Math.round(performance.now() - t0);
      await outbox.queueCountCheck(S.session.id, {
        client_uid: uid(),
        cards_dealt: S.shoe.dealt,
        decks_left: snap.decksLeft,
        reported_rc: reported,
        actual_rc: snap.running,
        reported_tc: null,
        actual_tc: snap.true,
        latency_ms: latency,
      });
      const ok = reported === snap.running;
      panel.innerHTML = `
        <div class="sheet ${ok ? 'good' : 'bad'}">
          <h2>${ok ? 'Correct' : `Off by ${Math.abs(reported - snap.running)}`}</h2>
          <p>Running count is <strong>${snap.running}</strong>, true count
             <strong>${snap.true}</strong> with ${snap.decksLeft} decks left.</p>
          <button class="primary" id="rc-ok">Keep playing</button>
        </div>`;
      $('#rc-ok').onclick = () => {
        panel.hidden = true;
        resolve();
      };
    };
    $('#rc-go').onclick = submit;
    $('#rc-input').onkeydown = (e) => e.key === 'Enter' && submit();
    $('#rc-input').focus();
  });
}

// --- feedback --------------------------------------------------------------

function showCorrection(hand, upcard, played, correct) {
  return new Promise((resolve) => {
    const panel = $('#overlay');
    panel.hidden = false;
    const desc = hand.isPair
      ? `a pair of ${hand.pairRank}s`
      : `${hand.soft ? 'soft' : 'hard'} ${hand.total}`;
    panel.innerHTML = `
      <div class="sheet bad">
        <h2>${ACTION_LABEL[correct]}, not ${ACTION_LABEL[played]}</h2>
        <p class="hand-line">${desc} vs dealer ${countKey(upcard)}</p>
        <p>${explain(S.chart, S.rules, hand, upcard, correct)}</p>
        <button class="primary" id="fb-ok">Got it</button>
      </div>`;
    const done = () => {
      panel.hidden = true;
      document.onkeydown = null;
      resolve();
    };
    $('#fb-ok').onclick = done;
    document.onkeydown = (e) => {
      e.preventDefault();
      done();
    };
  });
}

function showShoeReview() {
  return new Promise((resolve) => {
    const misses = S.shoeLog.filter((e) => !e.ok);
    const panel = $('#overlay');
    panel.hidden = false;
    const rows = misses
      .map(
        (e) => `<tr><td>${e.soft ? 'soft ' : ''}${e.total}${e.cards.length === 2 && e.total ? '' : ''}</td>
                <td>${e.upcard}</td>
                <td class="bad-cell">${ACTION_LABEL[e.action]}</td>
                <td class="good-cell">${ACTION_LABEL[e.correct]}</td>
                <td>${e.tc}</td></tr>`
      )
      .join('');
    panel.innerHTML = `
      <div class="sheet wide">
        <h2>End of shoe</h2>
        <p>${S.shoeLog.length - misses.length}/${S.shoeLog.length} correct this shoe.</p>
        ${
          misses.length
            ? `<table class="review"><thead><tr><th>Hand</th><th>Up</th><th>Played</th><th>Correct</th><th>TC</th></tr></thead><tbody>${rows}</tbody></table>`
            : '<p class="good-cell">No strategy errors this shoe.</p>'
        }
        <button class="primary" id="rv-ok">Next shoe</button>
      </div>`;
    $('#rv-ok').onclick = () => {
      panel.hidden = true;
      resolve();
    };
  });
}

function flash(text, tone = '') {
  const el = $('#flash');
  el.textContent = text;
  el.className = `flash show ${tone}`;
  setTimeout(() => (el.className = 'flash'), 1600);
}

// --- render ----------------------------------------------------------------

function render(net = null) {
  const t = S.table;
  if (!t) return;
  const snap = S.counter.snapshot();

  $('#hud-hands').textContent = S.handIndex;
  $('#hud-acc').textContent = S.tally.total
    ? `${Math.round((100 * S.tally.correct) / S.tally.total)}%`
    : '—';
  $('#hud-bank').textContent = (S.bankroll >= 0 ? '+' : '') + S.bankroll.toFixed(1);
  $('#hud-count').hidden = !S.showCount;
  $('#hud-rc').textContent = snap.running;
  $('#hud-tc').textContent = snap.true.toFixed(1);

  const pen = Math.min(S.shoe.dealt / S.shoe.cutIndex, 1);
  $('#pen-bar').style.width = `${pen * 100}%`;

  const dealerTotal = t.dealer.revealed
    ? handValue(dealerCards(t)).total
    : handValue(t.dealer.cards).total;
  $('#dealer').innerHTML = `
    <div class="seat-label">Dealer <span class="total">${t.dealer.revealed ? dealerTotal : `${dealerTotal}+`}</span></div>
    <div class="cards">${handSVG(
      t.dealer.revealed ? [...t.dealer.cards, t.dealer.hole] : [...t.dealer.cards, null],
      { width: cardWidth(), hideFirst: false }
    )}</div>`;

  const others = [...t.before, ...t.after];
  $('#others').innerHTML = others.length
    ? others
        .map(
          (seat, i) => `
      <div class="other-seat">
        <div class="seat-label">Seat ${i + 1}</div>
        ${seat
          .map(
            (h) =>
              `<div class="cards small">${handSVG(h.cards, { width: 34 })}
               <span class="total ${h.busted ? 'bust' : ''}">${h.total}</span></div>`
          )
          .join('')}
      </div>`
        )
        .join('')
    : '<div class="other-seat empty">Heads-up</div>';

  $('#hero').innerHTML = t.hero
    .map((h, i) => {
      const active = i === t.activeHero && !h.done && !h.busted;
      const tag = h.surrendered
        ? 'surrendered'
        : h.busted
          ? 'bust'
          : h.isBlackjack
            ? 'blackjack'
            : h.doubled
              ? 'doubled'
              : '';
      return `<div class="hero-hand ${active ? 'active' : ''}">
        <div class="cards">${handSVG(h.cards, { width: cardWidth() })}</div>
        <div class="hero-meta">
          <span class="total big ${h.busted ? 'bust' : ''}">${h.soft && h.total <= 21 ? 'soft ' : ''}${h.total}</span>
          ${tag ? `<span class="tag ${tag}">${tag}</span>` : ''}
        </div>
      </div>`;
    })
    .join('');

  $('#result').textContent =
    net === null ? '' : net > 0 ? `+${net.toFixed(1)}` : net < 0 ? net.toFixed(1) : 'push';
  $('#result').className = `result ${net === null ? '' : net > 0 ? 'win' : net < 0 ? 'lose' : 'push'}`;
}

function cardWidth() {
  const w = Math.min(window.innerWidth, 620);
  const hands = S.table ? S.table.hero.length : 1;
  return Math.max(40, Math.min(76, Math.floor((w - 48) / (hands * 3.2))));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- stats -----------------------------------------------------------------

async function renderStats() {
  const d = await api('/stats/summary');
  const o = d.overall;
  const acc = o.decisions ? Math.round((100 * o.correct) / o.decisions) : 0;

  $('#stat-tiles').innerHTML = `
    <div class="tile"><span class="v">${o.decisions || 0}</span><span class="k">decisions</span></div>
    <div class="tile"><span class="v">${acc}%</span><span class="k">accuracy</span></div>
    <div class="tile"><span class="v">${o.avg_latency ? Math.round(o.avg_latency) : '—'}<small>ms</small></span><span class="k">avg decision</span></div>
    <div class="tile"><span class="v">${d.count_accuracy.n || 0}</span><span class="k">count checks</span></div>`;

  const days = d.by_day.slice(-21);
  const max = Math.max(1, ...days.map((x) => x.n));
  $('#trend').innerHTML = days.length
    ? days
        .map((x) => {
          const a = Math.round((100 * x.correct) / x.n);
          return `<div class="bar" title="${x.day}: ${a}% of ${x.n}">
            <div class="bar-fill" style="height:${a}%"></div>
            <div class="bar-vol" style="height:${(100 * x.n) / max}%"></div>
          </div>`;
        })
        .join('')
    : '<p class="muted">No sessions recorded yet.</p>';
  $('#trend-caption').textContent = days.length
    ? `Accuracy by day (bar height), volume behind it. Last ${days.length} days.`
    : '';

  $('#worst').innerHTML = d.worst.length
    ? `<table class="review"><thead><tr><th>Hand</th><th>Up</th><th>Played</th><th>Correct</th><th>×</th></tr></thead><tbody>${d.worst
        .map(
          (w) => `<tr>
          <td>${w.is_pair ? 'pair' : w.is_soft ? 'soft' : 'hard'} ${w.player_total}</td>
          <td>${w.dealer_upcard}</td>
          <td class="bad-cell">${ACTION_LABEL[w.action] || w.action}</td>
          <td class="good-cell">${ACTION_LABEL[w.correct_action] || w.correct_action}</td>
          <td>${w.n}</td></tr>`
        )
        .join('')}</tbody></table>`
    : '<p class="muted">Nothing missed yet.</p>';

  $('#by-input').innerHTML = d.by_input
    .map(
      (r) =>
        `<li><strong>${r.input_type}</strong> — ${r.n} decisions,
         ${Math.round((100 * r.correct) / r.n)}% correct,
         ${r.avg_latency ? Math.round(r.avg_latency) : '—'}ms avg</li>`
    )
    .join('');

  $('#sessions').innerHTML = d.sessions
    .map(
      (s) =>
        `<li>${s.started_at.slice(0, 16).replace('T', ' ')} — ${s.mode}, ${s.rule_set},
         ${s.decisions} decisions ${s.active ? '<em>(active)</em>' : ''}</li>`
    )
    .join('');
}

// --- chart reference -------------------------------------------------------

async function renderChart() {
  const rsId = S.session ? S.session.rule_set_id : Number($('#rule-set').value);
  const chart = S.chart && S.session ? S.chart : await api(`/strategy/${rsId}`);
  const CLASS = { H: 'a-h', S: 'a-s', D: 'a-d', DS: 'a-d', P: 'a-p' };
  const LABEL = { H: 'H', S: 'S', D: 'D', DS: 'Ds', P: 'P' };

  const table = (title, group, keys, label) => `
    <h3>${title}</h3>
    <table class="chart">
      <thead><tr><th></th>${chart.upcards.map((u) => `<th>${u}</th>`).join('')}</tr></thead>
      <tbody>${keys
        .map(
          (k) =>
            `<tr><th>${label(k)}</th>${chart[group][k]
              .map((c) => `<td class="${CLASS[c] || ''}">${LABEL[c] || c}</td>`)
              .join('')}</tr>`
        )
        .join('')}</tbody>
    </table>`;

  const hardKeys = Object.keys(chart.hard).map(Number).filter((k) => k >= 8 && k <= 17).sort((a, b) => a - b).map(String);
  const softKeys = Object.keys(chart.soft).map(Number).filter((k) => k >= 13 && k <= 20).sort((a, b) => a - b).map(String);
  const pairKeys = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10'];

  const surr = Object.entries(chart.surrender)
    .map(([k, ups]) => `${k.replace('hard:', '').replace('pair:', 'pair of ')} vs ${ups.join(', ')}`)
    .join(' · ');

  $('#chart-body').innerHTML = `
    <p class="muted">${chart.rules.decks} decks · ${chart.rules.h17 ? 'H17' : 'S17'} ·
      ${chart.rules.das ? 'DAS' : 'no DAS'} ·
      ${chart.rules.surrender ? 'late surrender' : 'no surrender'}
      ${chart.deltas.length ? `· deltas applied: ${chart.deltas.join(', ')}` : ''}</p>
    ${table('Hard totals', 'hard', hardKeys, (k) => k)}
    ${table('Soft totals', 'soft', softKeys, (k) => `A,${Number(k) - 11}`)}
    ${table('Pairs', 'pair', pairKeys, (k) => `${k},${k}`)}
    <h3>Surrender</h3>
    <p>${surr || 'Not offered under these rules.'}</p>
    <p class="muted small">Ds = double if allowed, otherwise stand.</p>`;
}

// --- wiring ----------------------------------------------------------------

$('#rule-set').addEventListener('change', renderRuleSummary);
$('#start').addEventListener('click', () => startSession());
$$('.nav-btn').forEach((b) =>
  b.addEventListener('click', () => {
    const s = b.dataset.screen;
    show(s);
    if (s === 'stats') renderStats();
    if (s === 'chart') renderChart();
  })
);
$('#end-session').addEventListener('click', async () => {
  if (S.session) {
    await outbox.flush();
    await api(`/sessions/${S.session.id}/end`, { method: 'POST' });
    S.session = null;
    S.table = null;
  }
  location.reload();
});
window.addEventListener('resize', () => render());

boot().catch((e) => {
  document.body.innerHTML = `<pre class="fatal">Failed to start: ${e.message}</pre>`;
});
