# Paper Desk (cloud)

**Paper money only. No wallet, no keys, no orders. Nothing here can spend anything.**

<!-- The desk rewrites everything down to the line that says END OF STATUS after each run. -->
## Right now

| | |
|---|---|
| Last read of the market | **Nov 25, 14:05:40 PT** |
| Balance, by the desk's own count after costs | **$51.38** (started at $100.00) |
| Cash | $12.78 |
| Open paper trades | 4 of 4 allowed |
| Coins waiting for a dip | 8 |
| Rows in the ledger | 74 (35 closed trades) |

**Score:** 35 closed trades over 5 days. Enough to score. See FROZEN.md for the rule; the balance above is not the score.

If *Last read* is more than about an hour old, the desk has stalled.

### Open paper trades

| Coin | Bought (Pacific) | Paid | In at | Last price | Worth now, after costs |
|---|---|---|---|---|---|
| mihao | Nov 24, 07:28:00 PT | $10.00 | $0.00501 | $0.00476 | $9.21 |
| Rings | Nov 24, 08:05:00 PT | $10.00 | $0.00182 | $0.00200 | $10.65 |
| FIONA | Nov 25, 02:28:00 PT | $10.00 | $0.00257 | $0.00244 | $9.25 |
| 4CHAN | Nov 25, 13:59:00 PT | $10.00 | $0.000191 | $0.000187 | $9.50 |

### Last 10 rows of the ledger

| # | Time (Pacific) | Coin | What | Price | Cash | After-cost result |
|---|---|---|---|---|---|---|
| 74 | Nov 25, 13:59:00 PT | 4CHAN | dip buy | $0.000191 | -$10.00 |  |
| 73 | Nov 25, 13:59:00 PT | JIMMY | stop | $0.000645 | +$6.86 | -$3.14 |
| 72 | Nov 25, 12:57:00 PT | JIMMY | dip buy | $0.000913 | -$10.00 |  |
| 71 | Nov 25, 12:57:00 PT | 4CHAN | stop | $0.000246 | +$7.09 | -$2.91 |
| 70 | Nov 25, 10:39:00 PT | 4CHAN | dip buy | $0.000337 | -$10.00 |  |
| 69 | Nov 25, 10:39:00 PT | JIMMY | trail | $0.00120 | +$10.06 | +$0.06 |
| 68 | Nov 25, 02:28:00 PT | FIONA | dip buy | $0.00257 | -$10.00 |  |
| 67 | Nov 25, 02:28:00 PT | GROKIA | trail | $0.000324 | +$8.28 | -$1.72 |
| 66 | Nov 25, 01:48:00 PT | JIMMY | dip buy | $0.00116 | -$10.00 |  |
| 65 | Nov 25, 01:48:00 PT | DUVAL | stop | $0.0000914 | +$7.08 | -$2.92 |

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
