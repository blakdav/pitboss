# pitboss

A self-hosted blackjack trainer. Drills basic strategy against a simulated
table with other players, grades every decision against a verified strategy
chart, and keeps the history server-side so you can see whether you are
actually getting better.

Built to be used one-handed on a phone.

## What it does

- **Simulated table.** Configurable other seats play perfect basic strategy,
  so cards burn between your decisions the way they do in a real game. That
  is the condition that makes counting hard, and drilling heads-up does not
  reproduce it.
- **Two modes.** *Tutor* corrects you on every hand. *Simulation* holds
  feedback until the end of the shoe, then shows a per-decision review.
- **Rules are data.** Deck count, S17/H17, DAS, surrender, penetration,
  number of other players, blackjack payout. Presets are ordinary rows, so a
  casino you play becomes a saved preset.
- **Everything server-side.** Settings and decision history live in SQLite.
  The browser holds only a short-lived outbound buffer.
- **Session resume.** A drill interrupted by your stop picks up where it left
  off, same shoe, same count.
- **Performance tracking.** One row per decision: hand, upcard, true count,
  your action, the correct action, error class, and latency. Every stat is a
  query over that table.

## Quick start

```bash
docker compose up -d --build
```

Then open `http://<your-host>:8420`.

The SQLite database lives in the `pitboss-data` volume, so it survives
rebuilds. Change the host port in `docker-compose.yml` if 8420 is taken, or
drop the port mapping and attach the container to your reverse proxy's
network instead.

To run it without Docker:

```bash
pip install -r requirements.txt
PITBOSS_DB=./pitboss.db uvicorn api.main:app --reload
```

## Keyboard

`H` hit · `S` stand · `D` double · `P` split · `R` surrender.

## How the strategy is resolved

There is one base chart — 4–8 decks, S17, DAS, late surrender — taken from
the [Wizard of Odds 4-to-8-deck strategy][woo]. Every other rule is a small
patch over it. Turning on H17, for example, applies exactly four published
changes: surrender 15, a pair of 8s and 17 against an ace; double 11 against
an ace; double soft 18 against a 2; double soft 19 against a 6.

The resolver runs server-side and hands the client a chart with no
rule-conditional codes left in it, so there is one source of truth for what
is correct and the browser only decides whether a double or split is legal
for the hand in front of it.

This is deliberately not a solver. A hand-entered delta set can be checked
against a published chart cell by cell; a solver that is subtly wrong about,
say, double-after-split EV would confidently teach the wrong play for weeks
before anyone noticed.

**Deck counts are limited to 4, 6 and 8** — the range the shipped chart is
verified for. Single- and double-deck games need their own published chart
and are rejected rather than approximated.

## Verification

`tests/test_strategy.py` re-derives all 417 chart cells from the published
prose rather than restating the table, so a typo fails a test instead of
quietly teaching a wrong play. It also asserts that H17 changes exactly the
four documented things and nothing else.

```bash
python -m pytest tests/ -q
```

The game engine was verified separately by simulation:

| check | result |
| --- | --- |
| Dealer outcome distribution vs an exact infinite-deck recursion | within 0.11 points, every upcard, S17 and H17 |
| Shoe rank distribution | exact to 4 decimal places |
| House edge, 6D S17 DAS LS, 5M hands | −0.411% ± 0.100 (published 0.41–0.45%) |
| House edge, 6D H17 DAS LS, 5M hands | −0.591% ± 0.100 (published 0.62–0.66%) |
| Illegal actions attempted | 0 in 10M hands |

## Offline behaviour

Decisions are buffered in IndexedDB and posted when the network returns,
then deleted on acknowledgement. Nothing is ever read back from it except by
the flush routine, so a cleared cache costs at most one tunnel's worth of
hands and the server stays the only place data lives. Posts are idempotent
on a client-generated id, so a replayed flush cannot double-count.

## Layout

```
api/          FastAPI app, SQLite schema, strategy resolver, counting systems
web/          static frontend, no build step
  js/engine   shoe, hands, dealer, table
  js/strategy decision lookup against the resolved chart
  js/counting running and true count
  js/cards    SVG card faces
  js/net      outbound buffer
tests/        chart verification
```

## Roadmap

Phase 1 (this) is basic strategy with count display and optional count
checks. Still to come:

- **Running-count drill** with paced dealing and periodic checks
- **True-count drill** adding deck estimation
- **Deviations** — Illustrious 18 and Fab 4, indexed to Hi-Lo, which needs
  basic strategy and true count working together
- **Bet ramping** by true count before the deal
- Counting systems beyond Hi-Lo are already defined as data in
  `api/counting.py` (KO, Hi-Opt I/II, Omega II, Zen, Wong Halves); the drill
  layers that use them are what is outstanding.

## Note

This is a training tool. Card counting is legal, but casinos are private
property and will bar players they believe are counting.

[woo]: https://wizardofodds.com/games/blackjack/strategy/4-decks/
