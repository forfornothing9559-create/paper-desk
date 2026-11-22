# Frozen before the first run

Written and committed before the desk made its first read. The first line the desk ever writes carries this file's fingerprint, and the desk checks that fingerprint before every run. If this file or a rule file is changed, the desk stops.

**Paper only.** No wallet, no keys, no orders. Nothing here can spend anything.

## 1. What is frozen

| File | What it is |
|---|---|
| `grok/src/lib/strategy.ts` | The rules. Byte for byte as pasted out of the Grok "Paper Desk" app on 2026-11-21. |
| `grok/src/lib/market.ts` | How the desk reads the public price feed. Byte for byte as pasted. |
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
4. **Risk, first check.** A coin that passed is not put on the watch list while cash is under $10, while 20 tickets have been opened that night, or while the night is down $25. It is looked at again on the next read. Having 4 trades open does not keep a coin off the watch list.
5. **Executor.** Puts the coin on the watch list. The first price read from the coin's deepest pool becomes its starting price and its high. The desk buys on a later read where the price is 15% or more under that high. The fill is the price just read.
6. **Risk, second check.** At that moment all four limits are checked: cash, tickets that night, the night's loss, and 4 open trades. A coin blocked then stays on the watch list.

A coin leaves the watch list without a buy if its price falls under half its starting price, if its pool falls under $10,000, or if its score falls under 55. The score check is skipped on a read that carries no one-hour price change and no buy count.

A trade is sold on the first read at or under its stop. The fill is the price just read, which can be well past the line. After-cost value of a trade is `$10 x (price now / entry price) x 0.985 x 0.985`.

On each read the desk asks for the deepest pool of the first 12 coins it holds (open trades first, then the watch list in the order coins joined). Coins further down wait their turn.

## 3. How the cloud desk applies those rules

The Grok desk is a web page. It reads prices once a minute while the page is open and does nothing while it is closed. The cloud desk has no page, so it works like this.

**A run every several minutes.** Each run does one live read through `market.ts`, then starts the next run, which waits several minutes before it begins. GitHub's own timer is only a backup, because on this account it starts jobs hours late.

**Every price the rules act on is a published one-minute close, handed over in time order.** For each minute since the last read, in order, the run gives the rules that minute's closing price for each coin the desk holds or is watching. So a late run still checks every stop, trail and dip at one-minute steps, the way an open page would.

**The live read supplies everything except the price.** The free price feed answers about five calls a minute from one machine (measured from a GitHub machine on 2026-11-22) and refuses the sixth. Reading 12 coins therefore takes a few minutes, so the live prices are minutes apart and cannot be handed to the rules as one moment. The live read is used for the trending list, where new coins are found, and for each held coin's deepest pool, pool size, volume and buy and sell counts.

What that means in detail:

- **Minute prices** are the one-minute candle closes that GeckoTerminal publishes, in US dollars, for the coin's deepest pool as confirmed at the last live read. A minute with no trade has no candle, and the last close stands. If the pool has no candle at all up to that minute, the price read when the desk first looked the coin up is used.
- **Closes are used exactly as published.** A bad print is not filtered out.
- **A minute's close is read only after the feed has had time to finish it.** The feed publishes a finished minute late (measured before launch, see `prelaunch/RESULT.md`). So a run waits until four minutes after the newest minute ended before it asks for minute prices. Each run also looks again at the newest close it used the run before, and its run line names any close the feed changed afterwards. A decision already made on such a close is not undone.
- **Only the price moves between live reads.** Pool size, volume, buys and sells are known only at a live read. Until the next one, each coin carries the values from its last live read. So the score and the pool-size checks that can drop a coin from the watch list are re-done at each live read, not every minute.
- **New coins are found only at a live read.** The open Grok page looks at the trending list every minute. The cloud desk looks every several minutes. This is the main way the two can differ: the cloud desk can meet a coin later, or miss one that trended only briefly.
- **A newly watched coin is first read at the first whole minute after the desk has looked up its deepest pool.** That is usually one to a few minutes after it was first seen. The page would read it one minute after.
- **A coin that moves up into the first 12 during a replay** is read from that minute on, with the pool numbers from when it was last looked up. They are refreshed at the next live read that asks for it.
- **Order within one minute.** When two coins qualify in the same minute and there is room for only one, the rules take them in the order of the list they are handed. The page's list starts with the trending list. For a replayed minute the trending list is not known, so the one from the last live read is used.
- **A replayed buy or sell is written at the minute it happened, not when the run found it.** Each decision uses only prices up to its own minute. The price is that minute's close.
- **Every minute is handed to the rules, even one with no coin to price.** So the night rolls over at the right minute, and the Grok rules' "desk: pause" row appears only for a real gap.
- **Reach.** A run can replay at most 990 minutes (16.5 hours). If the desk was down longer, the older minutes are not checked, and the Grok rules write their own "desk: pause" row saying so.
- **Calls are paced to what the feed allows.** The Grok code asks for the trending list plus up to 12 coins every minute, four at a time, and when a call is refused it quietly reuses the last numbers it had. The cloud desk sends one call at a time, at most five in any 61 seconds, and retries a refusal. A run that holds many coins takes several minutes.
- **The two desks will not make exactly the same trades.** The page acts on the prices its calls happen to get: about one a minute for each coin when the feed answers, and an older price when it does not. The cloud desk acts on every published one-minute close. So the cloud desk sees highs, dips and stops that the page can miss, and is expected to make some trades the page does not. The trial before launch (`prelaunch/RESULT.md`) showed one such buy.
- **If the feed still refuses** the trending list or the minute prices, the run decides nothing and changes nothing. The next run replays the same minutes. After three such runs in a row the desk goes ahead without the coins it could not price: they are not read at all in that run, and its run line names them.

Other differences from the Grok page:

- No one can pause it, flatten a trade by hand, unlock the settings or reset the book. Those buttons do not exist here.
- The book starts fresh at $100. It has no "earlier gain" line.
- Your Grok desk and this desk hold different books, so they will not make the same trades even on the same coin. They are two separate records.

## 4. The record

| File | What it holds |
|---|---|
| `data/trades.jsonl` | The permanent ledger. One row for every paper buy and sell: time, coin, mint, pool, price, dollars, reason, and which candle the price came from. Rows are only ever added. |
| `data/book.json` | The desk's book, in the same shape the Grok app saves in the browser. |
| `data/twin.json` | The last deepest-pool read of each coin held, and the last trending list. |
| `data/runs/` | One line for every run, including runs that decided nothing. |

- Each ledger row carries the fingerprint of the row before it. Row 1 carries the fingerprint of this file. Each run line carries the fingerprints of the book, the ledger, the rule files, and the run line before it.
- Every run is saved as a commit, so GitHub's commit time is an outside clock on every row.
- Before each run the desk checks that the files are exactly what the last run saved, that the ledger chain and the run-line chain are whole, that the settings are the frozen ones, and that the frozen files match their fingerprints. If any check fails it stops and writes nothing.
- It never starts a new book over an old one. A first run is allowed only when the data folder is empty and GitHub's own history shows this desk never had a book.
- These checks catch accidents and careless edits. They cannot stop someone with write access from rewriting everything consistently. The outside record for that is the commit history.

## 5. The scoring rule

Declared on 2026-11-21, before any ledger existed, and copied here from the working notes:

> Score only rows in the permanent Trades list. Re-price each from public minute closes of the most liquid pool: buy = first public close at or after the logged buy time, sell = first public close at or after the logged sell time, $10 ticket. Headline uses the desk's own 1.5% per side; 5% per side is shown beside it as a stress figure only. NO VERDICT under 30 closed trades or under 5 separate days. PASS (candidate only, still paper) = headline total above zero and still above zero without the best 3 trades; otherwise FAIL. A row that appears later with a time before the last row already recorded is flagged and left out.

The desk's own balance is not the score and is not evidence. The score is computed from public prices, separately.

Applied to this desk, with the points the note left open fixed now, before any trade exists:

1. **The list** is `data/trades.jsonl`.
2. **Which close.** The close of the one-minute candle that contains the logged time. If that minute has no candle, the next candle that exists. Every fill of this desk is logged at the start of a minute with the close of the minute before, so the re-price is the close one minute after the price the desk acted on.
3. **Which pool and which numbers.** GeckoTerminal one-minute candles of the pool written on the row, in US dollars, priced for the row's coin (`currency=usd&token=<mint>`, the same call the desk uses). The scorer also looks up the coin's most liquid pool when it scores; if that is a different pool, the row is flagged and both prices are shown. The headline uses the row's pool.
4. **A closed trade** is a buy and the next sell of the same coin. **Days** are the Pacific calendar dates of the buys of closed trades.
5. **No price to be had.** If the pool has no candle in the 24 hours after a logged sell, that trade is scored as a total loss of the $10. If it has none in the 24 hours after a logged buy, the trade is left out and listed.
6. **Back-dated rows.** A row dated before the last row of an earlier commit is flagged and left out.
7. **Open trades** are not in the score. They are listed beside it at the last public close.
8. **This ledger and the Grok desk's Trades list are scored separately** by the same rule and never added together.
9. **Shown beside the verdict, not part of it:** the total at 5% per side, and the total without the best single day. The pass rule looks at single trades and cannot see a result that is one good day.
10. **What counts toward 30 and 5.** Only trades that are actually scored, after the exclusions in points 5 and 6. The days come from those trades' buys.
11. **When the verdict is taken.** Once. It is computed on the ledger as it stands at the first commit where 30 scored closed trades over 5 Pacific days exist. Later re-computations are shown as a running figure and never replace it.

Points 2, 3, 4, 5, 9, 10 and 11 were not spelled out in the note. They were chosen here without any data. The owner may change them by a dated addendum, but only before the first score is computed.

**What is expected to decide it** (written in advance, so it can be checked afterwards). With equal $10 tickets the headline is above zero exactly when the average re-priced sell-over-buy ratio is above 1.0307, which is what 1.5% a side costs. The verdict is expected to turn on that number, and on the same number without the best 3 trades. If the verdict ends up resting on something else, such as unpriceable rows or one day, the score report must say so in its first line.

A PASS would mean only this: on paper, after costs, re-priced from public data, the rules did not lose over the sample. It is a candidate for more testing. It is not a reason to trade.

## 6. Changes

- A change to `strategy.ts` or `market.ts` ends this record. The desk enforces it: it stops if either file differs from the one the record began with. A changed rule set needs a new record, and the two are never scored together.
- A change to this file has to be a dated addendum at the bottom, and the new `rules.lock.json` has to name the fingerprint of the lock it replaces. Otherwise the desk stops.
- A change to the runner (`desk.mjs`) is allowed only to fix how the desk reads, replays or records. It must be listed in `CHANGES.md` with the reason, and the tests in `tests/offline.mjs` must pass. Every run line records the fingerprint of the runner that wrote it.
