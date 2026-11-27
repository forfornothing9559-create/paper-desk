# Paper Desk (cloud)

**Paper money only. No wallet, no keys, no orders. Nothing here can spend anything.**

<!-- The desk rewrites everything down to the line that says END OF STATUS after each run. -->
## Right now

| | |
|---|---|
| Last read of the market | **Nov 27, 10:31:16 PT** |
| Balance, by the desk's own count after costs | **$41.41** (started at $100.00) |
| Cash | $9.91 |
| Open paper trades | 3 of 4 allowed |
| Coins waiting for a dip | 0 |
| Rows in the ledger | 87 (42 closed trades) |

**Score:** 42 closed trades over 6 days. Enough to score. See FROZEN.md for the rule; the balance above is not the score.

If *Last read* is more than about an hour old, the desk has stalled.

### Open paper trades

| Coin | Bought (Pacific) | Paid | In at | Last price | Worth now, after costs |
|---|---|---|---|---|---|
| mihao | Nov 24, 07:28:00 PT | $10.00 | $0.00501 | $0.00577 | $11.16 |
| WASTED | Nov 25, 15:55:00 PT | $10.00 | $0.000896 | $0.000842 | $9.13 |
| JIMMY | Nov 26, 16:02:00 PT | $10.00 | $0.000566 | $0.000654 | $11.22 |

### Last 10 rows of the ledger

| # | Time (Pacific) | Coin | What | Price | Cash | After-cost result |
|---|---|---|---|---|---|---|
| 87 | Nov 27, 01:58:00 PT | Rings | trail | $0.00162 | +$8.64 | -$1.36 |
| 86 | Nov 26, 16:02:00 PT | JIMMY | dip buy | $0.000566 | -$10.00 |  |
| 85 | Nov 26, 16:02:00 PT | Zero | trail | $0.0000992 | +$9.60 | -$0.40 |
| 84 | Nov 26, 11:33:00 PT | Zero | dip buy | $0.000100 | -$10.00 |  |
| 83 | Nov 26, 11:33:00 PT | PAIR | stop | $0.000134 | +$6.90 | -$3.10 |
| 82 | Nov 26, 11:03:00 PT | PAIR | dip buy | $0.000189 | -$10.00 |  |
| 81 | Nov 26, 10:29:00 PT | JIMMY | trail | $0.000786 | +$10.80 | +$0.80 |
| 80 | Nov 25, 17:44:00 PT | JIMMY | dip buy | $0.000706 | -$10.00 |  |
| 79 | Nov 25, 17:42:00 PT | FIONA | stop | $0.00192 | +$7.27 | -$2.73 |
| 78 | Nov 25, 15:55:00 PT | WASTED | dip buy | $0.000896 | -$10.00 |  |

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
