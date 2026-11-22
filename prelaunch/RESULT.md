# What the tests before launch showed

Written 2026-11-22 (UTC), before the desk's first run. Times are Pacific unless marked Z (UTC).

## 1. The exact tests: all 9 pass

`tests/offline.mjs`, run on GitHub against a made-up market, so every number can be reproduced. Run [44987492098](https://github.com/forfornothing9559-create/paper-desk/actions/runs/44987492098).

| Test | What it shows | Result |
|---|---|---|
| A | The rule files are the pasted Grok files, unedited | 5 fingerprints match |
| B | The runner's bookkeeping against the Grok app's own store file | 8,389 reads, 0 differences (99 sleeps, 64 failed reads, 6 midnights; 138 buys, 80 stops, 46 trails) |
| C | A desk that wakes now and then ends with the book of a desk that never slept | 113,966 prices handed to the rules, each equal to the last true trade. 654 runs, 25,206 replayed minutes, 0 differences. 420 fills, up to 17 coins held |
| C2 | Test C would notice wrong candles | A wrong minute and a wrong pool were both caught at the second run |
| C3 | A minute's price is not read before the feed has finished it | Feed publishing 235 seconds late: 19,850 prices, 0 differences. With the wait switched off the same test fails, as it must |
| D | A refused feed changes nothing | 184 runs, 48 refused, book matched after every run |
| D2 | After 3 refused runs the desk goes on without the coins it could not price | No trade made; the 6 unpriced coins were named |
| E | A record edited by hand stops the desk | 8 kinds of edit, each stopped it |
| F | Minute boundaries, call pacing, ledger chain | Behave as written |

## 2. The live side-by-side trial

[`shadow-20261122-0310/report.md`](shadow-20261122-0310/report.md). 75 minutes on live public prices, starting Nov 21 at 19:10. Three desks, each on its own GitHub machine with a fresh paper $100: the Grok desk as written, the Grok desk with its calls paced, and the cloud desk with a run every 12 minutes.

- **Same coins.** All three put the same 8 coins on the watch list.
- **Same buys.** Both buys the Grok desk made, the cloud desk also made. XV: same minute, same price. DCTY: two minutes earlier, 0.7% lower.
- **One extra buy.** The cloud desk bought Singularity at 19:34:00 at $0.000471. Neither Grok desk did.

The extra buy was checked afterwards against the public one-minute closes of the same pool (`58XqWPXDGp3GfU9DAFxs8C1GJwTLdHdQhJRofAF5yWTV`):

| Minute close | Price | Highest close since first watched | 15% under that |
|---|---|---|---|
| 19:27 | $0.00056047 | $0.00056047 | $0.00047640 |
| 19:28 | $0.00055311 | $0.00056047 | $0.00047640 |
| 19:29 | $0.00049080 | $0.00056047 | $0.00047640 |
| 19:33 | $0.00048524 | $0.00056047 | $0.00047640 |
| **19:34** | **$0.00047104** | $0.00056047 | $0.00047640 |
| 19:35 | $0.00046470 | $0.00056047 | $0.00047640 |

The 19:34 close was the first at or under the line, and the cloud desk's ledger row has exactly that minute and price. The same check on DCTY gives 19:37 at $0.00320662, also the cloud desk's row. So both rows follow the rule on the published closes.

Why the Grok desks did not make that buy was not recorded minute by minute. What is known:

- The feed refused 311 of the 592 calls made by the Grok desk as written (53%). On a refusal the Grok code reuses the last price it had.
- The paced Grok desk got every call answered but needed about two minutes per read, so it read each coin once every three minutes.

Both therefore skipped minutes. This is the difference written down in `FROZEN.md` section 3: the cloud desk acts on every published one-minute close, the page on the prices its calls happen to get.

The balances at the end ($98.98, $98.98, $100.96) mean nothing. They are two or three open paper trades over one hour.

## 3. How late the feed publishes a finished minute

Found while reading the trial. A one-minute candle asked for a few seconds after its minute ended is often missing that minute's last trades. It is filled in afterwards. A desk that read it at once would act on a close that later changes.

Measured on 2026-11-22 by asking for the same minute again and again after it ended (`tests/candlelag.mjs`):

| Where from | Checks | Finished minute was final |
|---|---|---|
| Ten GitHub machines, 05:01Z to 05:06Z, ten different pools | 20 | at 20 seconds after the minute, in all 20 |
| This PC, 04:44Z to 04:50Z | 3 | by 17, 17 and 32 seconds (not yet at 3 seconds) |
| This PC, 04:40Z | 1 | by 50 seconds (not yet at 30) |
| This PC, 04:36Z | 1 | **not yet at 75 seconds**; it was at 175 |

Before a close was final, its price differed from the final one by up to 0.33%.

So the feed is usually seconds behind and at times more than a minute behind. The longest delay seen was between 75 and 175 seconds, in 1 of 25 checks.

What the runner does about it (`SETTLE_MS` in `desk.mjs`):

1. **It waits.** No minute price is asked for until 240 seconds after the newest minute ended.
2. **It checks afterwards.** Each run looks again at the newest close it used the run before. If the feed has changed it, the run line names the coin, the minute, the old price and the new one (`changed`). `rechecked` says how many were looked at.

Test C3 covers both. With a made-up feed that publishes 235 seconds late, every price still matched the true trades and the check found nothing changed (764 looked at again). With the wait switched off, the check flagged 1,145 of 1,174.

The live trial in section 2 ran before this wait existed. Its three cloud buys were compared with the final public closes afterwards, as shown above, and match.
