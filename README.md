# Paper Desk (cloud)

**Paper money only. No wallet, no keys, no orders. Nothing here can spend anything.**

<!-- The desk rewrites everything down to the line that says END OF STATUS after each run. -->
## Right now

| | |
|---|---|
| Last read of the market | **Nov 25, 05:12:24 PT** |
| Balance, by the desk's own count after costs | **$61.76** (started at $100.00) |
| Cash | $18.77 |
| Open paper trades | 4 of 4 allowed |
| Coins waiting for a dip | 7 |
| Rows in the ledger | 68 (32 closed trades) |

**Score:** 32 closed trades over 5 days. Enough to score. See FROZEN.md for the rule; the balance above is not the score.

If *Last read* is more than about an hour old, the desk has stalled.

### Open paper trades

| Coin | Bought (Pacific) | Paid | In at | Last price | Worth now, after costs |
|---|---|---|---|---|---|
| mihao | Nov 24, 07:28:00 PT | $10.00 | $0.00501 | $0.00464 | $8.99 |
| Rings | Nov 24, 08:05:00 PT | $10.00 | $0.00182 | $0.00181 | $9.63 |
| JIMMY | Nov 25, 01:48:00 PT | $10.00 | $0.00116 | $0.00185 | $15.48 |
| FIONA | Nov 25, 02:28:00 PT | $10.00 | $0.00257 | $0.00235 | $8.90 |

### Last 10 rows of the ledger

| # | Time (Pacific) | Coin | What | Price | Cash | After-cost result |
|---|---|---|---|---|---|---|
| 68 | Nov 25, 02:28:00 PT | FIONA | dip buy | $0.00257 | -$10.00 |  |
| 67 | Nov 25, 02:28:00 PT | GROKIA | trail | $0.000324 | +$8.28 | -$1.72 |
| 66 | Nov 25, 01:48:00 PT | JIMMY | dip buy | $0.00116 | -$10.00 |  |
| 65 | Nov 25, 01:48:00 PT | DUVAL | stop | $0.0000914 | +$7.08 | -$2.92 |
| 64 | Nov 25, 00:39:00 PT | DUVAL | dip buy | $0.000125 | -$10.00 |  |
| 63 | Nov 25, 00:33:00 PT | GROKIA | dip buy | $0.000380 | -$10.00 |  |
| 62 | Nov 24, 22:27:00 PT | DUVAL | trail | $0.000119 | +$8.16 | -$1.84 |
| 61 | Nov 24, 21:44:00 PT | FIONA | stop | $0.00223 | +$7.25 | -$2.75 |
| 60 | Nov 24, 14:29:00 PT | DUVAL | dip buy | $0.000141 | -$10.00 |  |
| 59 | Nov 24, 12:37:00 PT | GROKIA | trail | $0.00161 | +$8.78 | -$1.22 |

<!-- END OF STATUS -->

## What this is

A paper-trading desk that runs on GitHub's machines, so it keeps going when the PC is off. It is the cloud twin of a small web app (the "Paper Desk") built in Grok. It follows that app's rules by running the app's own rule files, unedited.

- It trades imaginary money: a $100 book and $10 tickets.
- It has no wallet, no keys and no way to place an order. It only reads public prices.
- Every paper buy and sell is written to a ledger that is never edited or reset.

## How to check on it

Look at **Right now** at the top of this page. The desk rewrites it after every run.

- **Last read of the market** should be less than half an hour old. If it is more than about an hour old, the desk has stalled. It restarts itself within a few hours; the Actions tab shows what happened.
- **Balance** is the desk's own count after costs. It is not the score. See below.
- The full ledger is [`data/trades.jsonl`](data/trades.jsonl), one row per paper buy or sell.

## How it is scored

Not by its own balance. Each row of the ledger is re-priced from public one-minute prices, costs are taken off, and the rule in [`FROZEN.md`](FROZEN.md) decides pass or fail. That rule was written down before the first run. No verdict is given before 30 closed trades over 5 separate days.

## How to stop it

Actions tab, **desk**, the **...** menu, **Disable workflow**. To start it again: **Enable workflow**, then **Run workflow**.

## What is in here

| Path | What it is |
|---|---|
| [`FROZEN.md`](FROZEN.md) | The rules, how the cloud desk applies them, and the scoring rule. Frozen before the first run. |
| `grok/src/` | The Grok app's source, byte for byte as pasted. `strategy.ts` is the rules. `market.ts` is the price read. |
| `desk.mjs` | The runner: replays missed minutes, does the live read, writes the record. |
| `rules.lock.json` | Fingerprints of the frozen files. The desk stops if one changes. |
| `data/` | The record. Written only by the desk. |
| `tests/` | The tests the runner had to pass before it was switched on. |
| `prelaunch/` | What the tests before launch showed ([`RESULT.md`](prelaunch/RESULT.md)), with the side-by-side trial against the Grok desk. |
| [`CHANGES.md`](CHANGES.md) | Every change to the runner after launch, with the reason. |

Prices come from the public GeckoTerminal API.
