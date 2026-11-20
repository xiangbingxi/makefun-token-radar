# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/xiangbingxi/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/xiangbingxi/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot, ranks the protocols that record no token by what a launch would be worth, and writes a static dashboard — board, detail view per protocol, filters — with a concrete farm plan for each one. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## The model

```
implied value = TVL × category multiple × growth × age × chains
```

- **Category multiple** — the geometric mean market-cap/TVL of the token-bearing protocols in the same category (the global geometric mean when a category has fewer than three such comps), clamped to 0.08–1.50. Each log ratio is winsorized to the global mean ± 1.5 standard deviations before averaging, so one wild token cannot set a whole category's multiple on its own.
- **Growth** — 1 + half the 7-day TVL change, clamped to 0.75–1.50.
- **Age** — 1 + 0.15 per year tracked with no token recorded, up to 1.60.
- **Chains** — 1 + 0.02 per extra chain, up to 1.10.

Nothing is a hardcoded list of names: every number comes from the snapshot itself. A protocol is board-eligible when DefiLlama records no token for it and it is not a wrapped, staked or bridged product of a token that already trades. The watchlist is the floor, never the ceiling — the board ranks every eligible protocol below the $50M floor too.

## Backtest

The multiple was checked against the 128 token-bearing protocols in the snapshot that report a positive market cap, leave-one-out (each one's multiple computed without it): Spearman ρ = 0.41 against the real market caps, median error 0.64 orders of magnitude, 23% within twofold. The plain median multiple it replaces scored 0.38, 0.73 and 17% on the same test. A size adjustment was tried and dropped: market-cap/TVL falls with TVL across the whole sample, but among protocols above the $50M floor the slope is nearly flat (−0.07).

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Node 22.18+ standard library only — no network, no packages, no build step. The program is fully deterministic: two runs on the same snapshot write the same bytes.

It writes `board.json` (the ranked board), `data.js` (board plus the set-aside and already-launched lists, for the page), `dashboard/` (the static page), `screenshots/` (copied in) and `dossier.json` (the judge's dossier, built by the `buildDossier` in main.ts).

Open `out/dashboard/index.html` to use the board. Deep links: `#/detail/<slug>` opens a protocol, `#/filter/chain/<chain>` and `#/filter/category/<category>` open the board pre-filtered.

## Layout

- `main.ts` — the radar: snapshot parsing, eligibility, value model, farm plans, board, data script, dashboard copy, dossier builder, gate self-check.
- `dashboard/` — `index.html`, `app.css`, `app.js`: the page. No network, no framework.
- `screenshots/` — `1-board.png` (the board), `2-detail.png` (a protocol's detail view), `3-filtered.png` (a filtered view).

---

<sub>Entered on [make.fun](https://make.fun/?ref=efzg7wym&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
