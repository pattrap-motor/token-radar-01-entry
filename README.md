# Launch Radar — token launch radar (make.fun token-radar-01)

A Node 22 program (standard library only) that reads the competition's
sealed DefiLlama snapshot, ranks the protocols that record no token yet by
the value their launch would carry, and writes a static dashboard that
shows the board, a detail view per protocol and the steps to farm each one.

## Run it

```
mkdir -p out
MAKEFUN_OUTPUT_DIR=out node main.ts --input <kit>/input/snapshot.json
```

Outputs in `out/`: `board.json` (the ranked board), `data.js` (the
dashboard's data), `dashboard/` (the page), `screenshots/` and
`dossier.json` (built with `vendor/makefun-board.ts`).

## The model

Comparables, from the snapshot's own figures only — no hand-picked names:

1. Every protocol whose token already trades gives a price-to-TVL multiple.
   A category's launch multiple is the **median** of its traded protocols'
   multiples, shrunk toward the global median by peer count (weight
   n/(n+3)) because the snapshot carries a market cap for barely a third of
   its traded protocols; the global median prices a category with none.
2. Base value = TVL x category multiple.
3. Momentum: the 7-day TVL change, clamped to -40%..+60%, tilts the base.
4. Seasoning: a saturating age term (0.80x -> 1.25x) rewards time run with
   no token recorded.
5. The range: each category's peer multiples also give a middle half
   (first to third quartile), shrunk toward the global middle half by the
   same weight. Pricing a row's TVL with those quartiles gives a low and
   a high around the point value, so the board states how far its own
   evidence agrees — a row priced off one peer carries a wide range, a
   row priced off many agreeing peers a narrow one.

`lib/model.ts` holds the model; `dashboard/app.js` carries the same
arithmetic and recomputes every row it draws, so page and board cannot
drift. Farm plans are generated per protocol from its category, chains,
TVL, age and seven-day momentum, each step with a cost and a time; a
sharp TVL move or a run across four or more chains earns the plan an
extra step of its own.

MIT licensed.
