# Side-by-side trial before launch

Started 2026-11-22T03:10Z (Nov 21, 19:10:03 PT). Live public prices. Each desk began with a fresh paper $100 on its own machine. Nothing here touched the real record.

This report says what happened. It has no pass mark. The pass/fail tests are the exact ones in `tests/offline.mjs`.

| | Grok desk as written | Grok desk, paced calls | Cloud desk |
|---|---|---|---|
| Minutes run | 75 | 77 | 76 |
| Reads attempted | 76 | 27 | 7 |
| Reads that got data | 76 | 27 | 7 |
| Typical time between reads | 60s (longest 60s) | 180s (longest 180s) | 720s (longest 720s) |
| Typical time one read took | 0s | 125s | 204s |
| Calls to the price feed | 592 | 212 | 104 |
| Calls the feed refused | 311 | 2 | 10 |
| Held-coin prices asked for / received | 516 / 515 | 185 / 185 | 51 / 43 (approx.) |
| Minutes replayed from one-minute closes | not applicable | not applicable | 73 |
| Coins put on the watch list | 8 | 8 | 8 |
| Paper buys | 2 | 2 | 3 |
| Paper sells | 0 | 0 | 0 |
| Still open at the end | 2 | 2 | 3 |
| Still waiting at the end | 6 | 6 | 5 |
| Balance at the end, desk's own count | $98.98 | $98.98 | $100.96 |

## Coins each desk put on its watch list

| Coin | Mint | Grok desk as written: first watched (Pacific) | Grok desk, paced calls: first watched (Pacific) | Cloud desk: first watched (Pacific) |
|---|---|---|---|---|
| DCTY | 9hjB..pump | Nov 21, 19:10:03 PT | Nov 21, 19:10:05 PT | Nov 21, 19:10:04 PT |
| Singularity | 7R4M..pump | Nov 21, 19:10:03 PT | Nov 21, 19:10:05 PT | Nov 21, 19:10:04 PT |
| FIONA | B34n..pump | Nov 21, 19:10:03 PT | Nov 21, 19:10:05 PT | Nov 21, 19:10:04 PT |
| mihao | 4Cxj..pump | Nov 21, 19:10:03 PT | Nov 21, 19:10:05 PT | Nov 21, 19:10:04 PT |
| FLOAT | Bv1a..BMmr | Nov 21, 19:10:03 PT | Nov 21, 19:10:05 PT | Nov 21, 19:10:04 PT |
| jingyu | DUZr..pump | Nov 21, 19:10:03 PT | Nov 21, 19:10:05 PT | Nov 21, 19:10:04 PT |
| XV | Bjnx..pump | Nov 21, 19:10:03 PT | Nov 21, 19:10:05 PT | Nov 21, 19:10:04 PT |
| Rings | 65iH..ring | Nov 21, 19:47:03 PT | Nov 21, 19:51:07 PT | Nov 21, 19:59:26 PT |

8 of 8 coins were watched by every desk.

## Every paper buy and sell

| Time (Pacific) | Desk | Coin | Mint | What | Price | After-cost result | Read |
|---|---|---|---|---|---|---|---|
| Nov 21, 19:27:00 PT | Cloud desk | XV | Bjnx..pump | dip buy | $0.0000820 |  | minute close |
| Nov 21, 19:27:03 PT | Grok desk as written | XV | Bjnx..pump | dip buy | $0.0000820 |  | live |
| Nov 21, 19:27:06 PT | Grok desk, paced calls | XV | Bjnx..pump | dip buy | $0.0000820 |  | live |
| Nov 21, 19:34:00 PT | Cloud desk | Singularity | 7R4M..pump | dip buy | $0.000471 |  | minute close |
| Nov 21, 19:37:00 PT | Cloud desk | DCTY | 9hjB..pump | dip buy | $0.00321 |  | minute close |
| Nov 21, 19:39:03 PT | Grok desk as written | DCTY | 9hjB..pump | dip buy | $0.00323 |  | live |
| Nov 21, 19:42:09 PT | Grok desk, paced calls | DCTY | 9hjB..pump | dip buy | $0.00323 |  | live |

## The same coin bought by more than one desk

| Coin | Grok desk as written: time, price | Grok desk, paced calls: time, price | Cloud desk: time, price | Widest gap in time | Widest gap in price |
|---|---|---|---|---|---|
| XV | Nov 21, 19:27:03 PT, $0.0000820 | Nov 21, 19:27:06 PT, $0.0000820 | Nov 21, 19:27:00 PT, $0.0000820 | 0 min | 0.0% |
| DCTY | Nov 21, 19:39:03 PT, $0.00323 | Nov 21, 19:42:09 PT, $0.00323 | Nov 21, 19:37:00 PT, $0.00321 | 5 min | 0.7% |

Coins bought: paced Grok desk 2, cloud desk 3, both 2.

