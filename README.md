# Paper Desk (cloud)

**Paper money only. No wallet, no keys, no orders. Nothing here can spend anything.**

<!-- The desk rewrites everything down to the line that says END OF STATUS after each run. -->
## Right now

| | |
|---|---|
| Last read of the market | **Nov 22, 21:36:22 PT** |
| Balance, by the desk's own count after costs | **$89.99** (started at $100.00) |
| Cash | $48.21 |
| Open paper trades | 4 of 4 allowed |
| Coins waiting for a dip | 7 |
| Rows in the ledger | 18 (7 closed trades) |

**Score:** no verdict yet. The frozen rule needs 30 closed trades over 5 separate days. So far: 7 over 2. The balance above is the desk's own count, not the score.

If *Last read* is more than about an hour old, the desk has stalled.

### Open paper trades

| Coin | Bought (Pacific) | Paid | In at | Last price | Worth now, after costs |
|---|---|---|---|---|---|
| MCAT | Nov 22, 16:07:00 PT | $10.00 | $0.000473 | $0.000492 | $10.10 |
| SIDOOR | Nov 22, 18:20:00 PT | $10.00 | $0.000141 | $0.000173 | $11.93 |
| snowball | Nov 22, 19:21:00 PT | $10.00 | $0.0000982 | $0.000101 | $9.99 |
| OpenIndex | Nov 22, 21:10:00 PT | $10.00 | $0.000268 | $0.000269 | $9.76 |

### Last 10 rows of the ledger

| # | Time (Pacific) | Coin | What | Price | Cash | After-cost result |
|---|---|---|---|---|---|---|
| 18 | Nov 22, 21:10:00 PT | OpenIndex | dip buy | $0.000268 | -$10.00 |  |
| 17 | Nov 22, 19:49:00 PT | Singularity | stop | $0.000452 | +$7.12 | -$2.88 |
| 16 | Nov 22, 19:21:00 PT | snowball | dip buy | $0.0000982 | -$10.00 |  |
| 15 | Nov 22, 19:21:00 PT | FIONA | stop | $0.00105 | +$7.23 | -$2.77 |
| 14 | Nov 22, 18:20:00 PT | SIDOOR | dip buy | $0.000141 | -$10.00 |  |
| 13 | Nov 22, 18:20:00 PT | DCTY | stop | $0.00212 | +$7.22 | -$2.78 |
| 12 | Nov 22, 16:07:00 PT | MCAT | dip buy | $0.000473 | -$10.00 |  |
| 11 | Nov 22, 16:07:00 PT | greg | stop | $0.000223 | +$7.27 | -$2.73 |
| 10 | Nov 22, 11:01:00 PT | Singularity | dip buy | $0.000615 | -$10.00 |  |
| 9 | Nov 22, 10:40:00 PT | SIDOOR | stop | $0.000113 | +$6.17 | -$3.83 |

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
