# Frozen before the first run

Written and committed before the desk made its first read. The first line the desk ever writes carries this file's fingerprint, and the desk checks that fingerprint before every run. If this file or a rule file is changed, the desk stops.

**Paper only.** No wallet, no keys, no orders. Nothing here can spend anything.

## 1. What is frozen

| File | What it is |
|---|---|
| `grok/src/lib/strategy.ts` | The rules. Byte for byte as pasted out of the Grok "Paper Desk" app on 2026-11-21. |
| `grok/src/lib/market.ts` | How the desk reads public prices. Byte for byte as pasted. |
| `grok/src/lib/desk-store.ts` | The Grok app's own bookkeeping file. Not run by the desk. Kept as the answer key for the tests. |
| `grok/node_modules/@tanstack/react-start/index.js` | A 30-line stand-in for one Grok platform function that `market.ts` imports, so that file runs unedited outside Grok. |
| `FROZEN.md` | This file. |

Their fingerprints are in `rules.lock.json`. The other pasted files (`app.tsx` and the page files) are the screen. They are stored under `grok/` for reference and are not run.

**The rule files are the rules.** Section 2 describes them in plain words. If the words and the code ever disagree, the code is what runs and the words are wrong.

## 2. The rules, as the code has them

Nothing below was tuned, improved or re-derived. These are the Grok desk's own numbers.

| Setting | Value |
|---|---|
| Starting paper money | $100 |
| Ticket (every buy) | $10 |
| Cost | 1.5% taken on every buy and 1.5% on every sell |
| Scanner: smallest pool | $20,000 liquidity |
| Scanner: market cap | between $12,000 and $8,000,000 (checked when a coin is first seen, not after) |
| Analyst pass mark | 70 out of 100 |
| Buy trigger | price 15% or more under the highest price seen since the coin was first confirmed |
| Hard stop | price 25% under the entry |
| Trail | once a trade has been 40% up, sell when it falls 40% from its highest price |
| Open trades at once | 4 |
| New tickets per night | 20 (a "night" is a Pacific calendar day) |
| Night loss stop | no new tickets once the night is down $25 |

How a coin gets bought, in order:

1. **Scanner.** Reads GeckoTerminal's list of trending Solana pools. Drops a coin with no price, with a pool under $20,000, or with a market cap outside the range.
2. **Analyst.** Scores the coin 0 to 100 from four parts worth 25 each: pool size, one-hour volume against pool size, one-hour price change, and one-hour buys against sells. Under 70 is dropped.
3. **Brain.** Sets the ticket. It is always $10.
4. **Risk.** Blocks a new ticket when cash is under $10, when 20 tickets were opened that night, when the night is down $25, or when 4 trades are open.
5. **Executor.** Puts the coin on a watch list. The first price read from the coin's deepest pool becomes its starting price and its high. The desk buys on a later read where the price is 15% or more under that high, if Risk allows at that moment. The fill is the price just read.

A coin leaves the watch list without a buy if its price falls under half its starting price, if its pool falls under $10,000, or if its score falls under 55.

A trade is sold on the first read at or under its stop. The fill is the price just read, which can be well past the line. After-cost value of a trade is `$10 x (price now / entry price) x 0.985 x 0.985`.

On each read the desk asks for the deepest-pool price of the first 12 coins it holds (open trades first, then the watch list in the order coins joined). Coins further down wait their turn.

## 3. How the cloud desk applies those rules

The Grok desk is a web page. It reads prices once a minute while the page is open and does nothing while it is closed. The cloud desk has no page, so it works like this.

**A run every several minutes.** Each run does one live read through `market.ts`, then starts the next run, which waits a few minutes before it begins. GitHub's own timer is only a backup, because on this account it starts jobs hours late.

**Before the live read, the run replays every minute it missed.** For each minute since the last read, in order, it gives the rules the closing price of that minute for each coin the desk holds or is watching. So a late run still checks every stop, trail and dip at one-minute steps, the way an open page would.

What that means in detail:

- **Minute prices** are the one-minute candle closes that GeckoTerminal publishes for the coin's deepest pool. The pool is the one confirmed at the last live read. A minute with no trade has no candle, and the last price stands.
- **Closes are used exactly as published.** A bad print is not filtered out.
- **Only the price moves during the replay.** Pool size, volume, buys and sells are known only at a live read. During the replay each coin carries the values from its last live read. So the score and the pool-size checks that can drop a coin from the watch list are re-done at each live read, not every minute.
- **New coins are found only at a live read.** The open Grok page looks at the trending list every minute. The cloud desk looks every few minutes. This is the main way the two can differ: the cloud desk can meet a coin a few minutes later, or miss one that trended only briefly.
- **A replayed buy or sell is written at the minute it happened, not when the run found it.** Each decision uses only prices up to its own minute. The price is that minute's close.
- **Reach.** A run can replay at most 990 minutes (16.5 hours). If the desk was down longer, the older minutes are not checked, and the Grok rules write their own "desk: pause" row saying so.
- **Calls are paced to what the feed allows.** Measured from a GitHub machine on 2026-11-22, the free price feed answers about five calls a minute and refuses the sixth. The Grok code asks for the trending list plus up to 12 coins every minute, four at a time, and when a call is refused it quietly reuses the last price it had. The cloud desk sends one call at a time, at most five in any 61 seconds, and retries a refusal. So a run that holds many coins takes a few minutes, and the prices in one live read can be up to a few minutes apart.
- **If the feed still refuses** the trending list or the minute prices, the run decides nothing and changes nothing. The next run replays the same minutes. After three such runs in a row the desk goes ahead without minute prices for the coins it could not get, and its run line names them.

Other differences from the Grok page:

- No one can pause it, flatten a trade by hand, unlock the settings or reset the book. Those buttons do not exist here.
- The book starts fresh at $100. It has no "earlier gain" line.
- Your Grok desk and this desk hold different books, so they will not make the same trades even on the same coin. They are two separate records.

## 4. The record

| File | What it holds |
|---|---|
| `data/trades.jsonl` | The permanent ledger. One row for every paper buy and sell: time, coin, mint, pool, price, dollars, reason, and where the price came from. Rows are only ever added. |
| `data/book.json` | The desk's book, in the same shape the Grok app saves in the browser. |
| `data/twin.json` | The last deepest-pool read of each coin held, used by the replay. |
| `data/runs/` | One line for every run, including runs that decided nothing. |

- Each ledger row carries the fingerprint of the row before it. Each run line carries the fingerprints of the book, the ledger, and the run line before it.
- Every run is saved as a commit, so GitHub's commit time is an outside clock on every row.
- Before each run the desk checks that the files are exactly what the last run saved, that the ledger chain is whole, that the settings are the frozen ones, and that the frozen files match their fingerprints. If any check fails it stops and writes nothing. It never starts a new book over an old one.

## 5. The scoring rule

Declared on 2026-11-21, before any ledger existed, and copied here from the working notes:

> Score only rows in the permanent Trades list. Re-price each from public minute closes of the most liquid pool: buy = first public close at or after the logged buy time, sell = first public close at or after the logged sell time, $10 ticket. Headline uses the desk's own 1.5% per side; 5% per side is shown beside it as a stress figure only. NO VERDICT under 30 closed trades or under 5 separate days. PASS (candidate only, still paper) = headline total above zero and still above zero without the best 3 trades; otherwise FAIL. A row that appears later with a time before the last row already recorded is flagged and left out.

The desk's own balance is not the score and is not evidence. The score is computed from public prices, separately.

Applied to this desk, with the points the note left open fixed now, before any trade exists:

1. **The list** is `data/trades.jsonl`.
2. **Which close.** The close of the one-minute candle that contains the logged time. If that minute has no candle, the next candle that exists. For a replayed fill the logged time is the start of a minute, so the re-price is the close one minute after the price the desk acted on.
3. **Which pool.** The pool written on the row. The scorer also looks up the coin's most liquid pool when it scores; if that is a different pool, the row is flagged and both prices are shown. The headline uses the row's pool.
4. **A closed trade** is a buy and the next sell of the same coin. **Days** are the Pacific calendar dates of the buys of closed trades.
5. **No price to be had.** If the pool has no candle in the 24 hours after a logged sell, that trade is scored as a total loss of the $10. If it has none in the 24 hours after a logged buy, the trade is left out and listed.
6. **Back-dated rows.** A row dated before the last row of an earlier commit is flagged and left out.
7. **Open trades** are not in the score. They are listed beside it at the last public close.
8. **This ledger and the Grok desk's Trades list are scored separately** by the same rule and never added together.
9. **Shown beside the verdict, not part of it:** the total at 5% per side, and the total without the best single day. The pass rule looks at single trades and cannot see a result that is one good day.

Points 2, 3, 4, 5 and 9 were not spelled out in the note. They were chosen here without any data. The owner may change them by a dated addendum, but only before the first score is computed.

**What is expected to decide it** (written in advance, so it can be checked afterwards). With equal $10 tickets the headline is above zero exactly when the average re-priced sell-over-buy ratio is above 1.0307, which is what 1.5% a side costs. The verdict is expected to turn on that number, and on the same number without the best 3 trades. If the verdict ends up resting on something else, such as unpriceable rows or one day, the score report must say so in its first line.

A PASS would mean only this: on paper, after costs, re-priced from public data, the rules did not lose over the sample. It is a candidate for more testing. It is not a reason to trade.

## 6. Changes

- A change to `strategy.ts` or `market.ts` ends this record. Trades before and after are never scored together.
- A change to this file has to be a dated addendum at the bottom, and the new `rules.lock.json` has to name the fingerprint of the lock it replaces. Otherwise the desk stops.
- A change to the runner (`desk.mjs`) is allowed only to fix how the desk reads, replays or records. It must be listed in `CHANGES.md` with the reason, and the tests in `tests/offline.mjs` must pass. Every run line records the fingerprint of the runner that wrote it.
