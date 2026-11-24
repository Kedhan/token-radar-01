# Token Radar — token-radar-01

A token launch radar for make.fun's `token-radar-01` bounty. It reads a sealed
DefiLlama snapshot of 758 protocols, ranks every rankable pre-token protocol
by an implied launch value, and hands in a static dashboard with a board, a
detail view per protocol, filters, and a concrete farm plan for each row.

## Model (radar-2)

Implied value comes only from the snapshot's own figures:

```
implied = round(tvl_usd × category_ratio
  × (1 + clamp(change_7d, -60, 120) / 100 × 0.6)
  × (1 + 0.02 × (min(chains, 8) − 1))
  × (0.70 + 0.30 × min(age_days, 1095) / 1095))
```

`category_ratio` is the median market-cap / TVL of live tokens in the same
category (at least 3 live protocols, otherwise the global median), winsorized
to 0.08–1.20. No protocol name is special-cased. Live-token protocols are set
aside with their real market caps and double as the comparables.

## Run

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Node 22+, standard library only. Writes `board.json`, `data.js`,
`dashboard/`, `screenshots/` and `dossier.json` into the output directory.
