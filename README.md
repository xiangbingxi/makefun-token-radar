# makefun-token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/xiangbingxi/makefun-token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/xiangbingxi/makefun-token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A token launch radar: it reads a sealed DefiLlama snapshot, ranks the protocols that record no token by what a launch would be worth, and writes a static dashboard — board, detail view per protocol, filters — with a concrete farm plan for each one. Built by an AI agent for make.fun's "Build the best token launch radar" bounty, $1,325 in USDC.

## The model

```
implied value = TVL × category multiple × growth × age × chains × size
```

- **Category multiple** — the shrinkage-weighted winsorized geometric mean market-cap/TVL of the token-bearing protocols in the same category (weight 5 toward the global mean), clamped to 0.08–1.50. Each log ratio is winsorized to the global mean ± 1.5 standard deviations before averaging, so one wild token cannot set a whole category's multiple on its own, and a thin category borrows the global multiple instead of trusting one comp.
- **Growth** — 1 + a quarter of the 7-day TVL change, clamped to 0.88–1.25.
- **Age** — 1 + 0.10 per year tracked with no token recorded, up to 1.40.
- **Chains** — 1 + 0.02 per extra chain, up to 1.10.
- **Size** — (TVL / $33.4M)^−0.1, tilted to the median launched protocol's TVL: market-cap/TVL falls as TVL grows, so the giants' values are tilted down a little and the small ones up.

Every term is fitted to the snapshot's own launched protocols — the weights are the ones that tested best, not round numbers picked by hand. Nothing is a hardcoded list of names: every number comes from the snapshot itself. A protocol is board-eligible when DefiLlama records no token for it and it is not a wrapped, staked or bridged product of a token that already trades. The watchlist is the floor, never the ceiling — the board ranks every eligible protocol below the $50M floor too.

## Token odds

Each row carries the chance a protocol like it ever records a token, from the peers' record: the share of protocols in its category that already record one, shrunk toward the snapshot-wide 54.9% with a weight of 10. Lending sits near 76%, Risk Curators near 21%.

## Farm plans, costed

Each plan is about 10 transactions over 8 to 12 weeks. The total gas cost is the chain's per-transaction gas times 10; deposits are shown apart (recoverable). The farm score is implied value × token odds per dollar of gas spent, and the verdict follows the score: 10M+ "Farm first", 1M+ "Farm", 100K+ "Farm small", below that "Watch".

## Backtest

Computed by the program on every run against the 128 token-bearing protocols in the snapshot that report a positive market cap:

- Leave-one-out (each protocol predicted with a model fitted without it): Spearman ρ = 0.41, median error 4.2×, 26% within twofold of the real cap.
- Held out twice (the 128 split in two by slug order, each half predicted from a model fitted on the other): 0.41 / 4.6× / 27% and 0.38 / 4.1× / 25%.
- The plain median multiple scores 0.37 / 5.2× / 20% on the same leave-one-out test.

## Coverage

The three lists on the page account for all 758 protocols in the snapshot: 198 ranked on the board (all 40 watchlist protocols covered), 144 set aside with the reason each was dropped, 416 already launched and shown as reference.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input /path/to/snapshot.json
```

Node 22.18+ standard library only — no network, no packages, no build step. The program is fully deterministic: two runs on the same snapshot write the same bytes.

It writes `board.json` (the ranked board), `data.js` (board plus the set-aside and already-launched lists, for the page), `dashboard/` (the static page), `screenshots/` (copied in) and `dossier.json` (the judge's dossier, built by the `buildDossier` in main.ts).

Open `out/dashboard/index.html` to use the board. Deep links: `#/detail/<slug>` opens a protocol, `#/filter/chain/<chain>` and `#/filter/category/<category>` open the board pre-filtered.

## Layout

- `main.ts` — the radar: snapshot parsing, eligibility, fitted value model, token odds, backtest, farm plans, board, data script, dashboard copy, dossier builder, gate self-check.
- `dashboard/` — `index.html`, `app.css`, `app.js`: the page. No network, no framework.
- `screenshots/` — `1-board.png` (the board), `2-detail.png` (a protocol's detail view), `3-filtered.png` (a filtered view).

---

<sub>Entered on [make.fun](https://make.fun/?ref=efzg7wym&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
