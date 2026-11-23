# Paper Desk (cloud)

**Paper money only. No wallet, no keys, no orders. Nothing here can spend anything.**

<!-- The desk rewrites everything down to the line that says END OF STATUS after each run. -->
## Right now

| | |
|---|---|
| Last read of the market | **Nov 23, 08:35:20 PT** |
| Balance, by the desk's own count after costs | **$82.72** (started at $100.00) |
| Cash | $45.01 |
| Open paper trades | 4 of 4 allowed |
| Coins waiting for a dip | 7 |
| Rows in the ledger | 34 (15 closed trades) |

**Score:** no verdict yet. The frozen rule needs 30 closed trades over 5 separate days. So far: 15 over 3. The balance above is the desk's own count, not the score.

If *Last read* is more than about an hour old, the desk has stalled.

### Open paper trades

| Coin | Bought (Pacific) | Paid | In at | Last price | Worth now, after costs |
|---|---|---|---|---|---|
| SI | Nov 23, 02:42:00 PT | $10.00 | $0.00698 | $0.00742 | $10.32 |
| FSDV15 | Nov 23, 06:06:00 PT | $10.00 | $0.000869 | $0.000813 | $9.07 |
| ZOL | Nov 23, 06:09:00 PT | $10.00 | $0.0000851 | $0.0000774 | $8.82 |
| FIONA | Nov 23, 07:08:00 PT | $10.00 | $0.00128 | $0.00126 | $9.50 |

### Last 10 rows of the ledger

| # | Time (Pacific) | Coin | What | Price | Cash | After-cost result |
|---|---|---|---|---|---|---|
| 34 | Nov 23, 07:08:00 PT | FIONA | dip buy | $0.00128 | -$10.00 |  |
| 33 | Nov 23, 07:08:00 PT | MCAT | stop | $0.000209 | +$7.12 | -$2.88 |
| 32 | Nov 23, 06:30:00 PT | MCAT | dip buy | $0.000285 | -$10.00 |  |
| 31 | Nov 23, 06:30:00 PT | OpenIndex | trail | $0.000264 | +$9.57 | -$0.43 |
| 30 | Nov 23, 06:09:00 PT | ZOL | dip buy | $0.0000851 | -$10.00 |  |
| 29 | Nov 23, 06:09:00 PT | Singularity | stop | $0.000329 | +$7.01 | -$2.99 |
| 28 | Nov 23, 06:06:00 PT | FSDV15 | dip buy | $0.000869 | -$10.00 |  |
| 27 | Nov 23, 06:06:00 PT | SIDOOR | trail | $0.000356 | +$24.59 | +$14.59 |
| 26 | Nov 23, 02:42:00 PT | SI | dip buy | $0.00698 | -$10.00 |  |
| 25 | Nov 23, 02:42:00 PT | FSDV15 | stop | $0.00184 | +$6.13 | -$3.87 |

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
