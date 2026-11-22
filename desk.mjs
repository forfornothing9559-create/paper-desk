// desk.mjs - the cloud runner for the paper desk.
//
// PAPER ONLY. This file holds no wallet, no key and no way to send an order.
// It reads public prices, runs the Grok desk's own rule files, and writes down
// what those rules decided.
//
// What is NOT in this file: the rules. They live in grok/src/lib/strategy.ts
// and the market read lives in grok/src/lib/market.ts, both byte for byte as
// they were pasted out of Grok, and both checked by fingerprint on every run.
//
// What IS in this file (the "glue", written for the cloud):
//   1. ingest()      - a copy of `ingest` in grok/src/lib/desk-store.ts, without
//                      the fields that only feed the screen.
//   2. the replay    - the Grok page reads prices once a minute while it is open.
//                      A cloud run happens every several minutes, so it steps
//                      through every minute since the last read, in order, and
//                      gives the rules that minute's published closing price for
//                      each coin the desk holds or is watching.
//   3. the transport - sends one call at a time, no faster than the free price
//                      feed allows, and retries a refusal.
//   4. the record    - an append-only, hash-chained ledger of every paper buy
//                      and sell, a line per run, and the status block in README.
//
// One rule runs through all of it: EVERY PRICE THE RULES ACT ON IS A PUBLISHED
// ONE-MINUTE CLOSE, HANDED OVER IN TIME ORDER. A live read takes minutes at the
// feed's pace, so its prices are never used: it supplies the trending list and,
// for each coin held, the pool, pool size, volume and buy/sell counts.

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const GT = "https://api.geckoterminal.com/api/v2";

/** market.ts refreshes only the first 12 held coins on a read (`mints.slice(0, 12)`). The replay does the same. */
export const HELD_READ_LIMIT = 12;
/**
 * One call to the candle endpoint returns at most 1000 one-minute candles.
 * The replay reaches back at most 990 minutes (16.5 hours) so one call always
 * covers it. Older minutes are not replayed; the Grok rules then write their
 * own "desk: pause" row for the gap.
 */
export const MAX_REPLAY_MINUTES = 990;
/** After this many runs in a row stopped by refused minute prices, a run goes ahead without the coins it could not price. */
export const SOFT_STOP_LIMIT = 3;

const START_CASH = 100;
const MINUTE = 60_000;
const STRATEGY_FILE = "grok/src/lib/strategy.ts";
const MARKET_FILE = "grok/src/lib/market.ts";
const BOOK_KEYS = [
  "cash", "positions", "watches", "log", "trades", "priorGap", "lastSig", "tradesTonight",
  "nightKey", "nightStartEquity", "paused", "settings", "locked", "lastScanAt",
];

/** Raised when the saved record or the frozen files are not what the last run left. The desk stops. */
export class Halt extends Error {}

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const realSleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ---------------------------------------------------------------------------
// The Grok files, loaded unedited
// ---------------------------------------------------------------------------

let grok = null;

export async function loadGrok() {
  if (!grok) {
    const strategy = await import(pathToFileURL(join(ROOT, STRATEGY_FILE)).href);
    const market = await import(pathToFileURL(join(ROOT, MARKET_FILE)).href);
    grok = { strategy, market };
  }
  return grok;
}

/** Tests only: a second copy of market.ts with empty caches, which is what every real run starts with. */
export async function freshMarket(tag) {
  return import(`${pathToFileURL(join(ROOT, MARKET_FILE)).href}?fresh=${tag}`);
}

// ---------------------------------------------------------------------------
// 1. ingest - the same steps as `ingest` in grok/src/lib/desk-store.ts
// ---------------------------------------------------------------------------

export function persisted(state) {
  const out = {};
  for (const key of BOOK_KEYS) out[key] = state[key];
  return out;
}

export function freshBook(strategy, now) {
  return {
    cash: START_CASH,
    positions: [],
    watches: [],
    log: [],
    trades: [],
    priorGap: null,
    lastSig: {},
    tradesTonight: 0,
    nightKey: strategy.pacificDateKey(now),
    nightStartEquity: START_CASH,
    paused: false,
    settings: { ...strategy.DEFAULT_SETTINGS },
    locked: true,
    lastScanAt: null,
  };
}

/** The list app.tsx sends with every read: open positions first, then the coins waiting on a dip. */
export function heldMints(book) {
  return [...book.positions.map((p) => p.mint), ...book.watches.map((w) => w.mint)];
}

export function ingest(strategy, cur, quotes, at, error) {
  if (error && quotes.length === 0) return cur; // desk-store: set the error, change nothing else
  const source =
    cur.lastScanAt != null && at - cur.lastScanAt >= strategy.PAUSE_MS
      ? strategy.noteResume(cur, quotes, at, cur.lastScanAt)
      : cur;
  const result = strategy.runDesk(source, quotes, at);
  return persisted({ ...cur, ...result.book, lastScanAt: at });
}

// ---------------------------------------------------------------------------
// 3. transport - one call at a time, at the feed's pace, refusals retried
// ---------------------------------------------------------------------------

export function installTransport(options = {}) {
  const cfg = {
    // Measured from a GitHub machine on 2026-11-22: the keyless feed answers
    // five calls, refuses the sixth, and lets go again about a minute after
    // the first. So: at most 5 calls in any 61 seconds, one at a time.
    perWindow: 5,
    windowMs: 61_000,
    gapMs: 700,
    attempts: 5,
    backoffMs: [20_000, 40_000, 61_000, 61_000], // after a refusal; the allowance also drops by one for the rest of the run
    timeoutMs: 15_000,
    deadlineMs: 13 * MINUTE, // no call is sent after this; the run then ends with what it has or decides nothing
    sleep: realSleep,
    ...options,
  };
  const previous = globalThis.fetch;
  const inner = cfg.fetch ?? previous;
  const stats = { calls: 0, answered: 0, refused: 0, retries: 0, gaveUp: [], perWindow: cfg.perWindow };
  const started = Date.now();
  const starts = []; // when each recent call was sent (or is due to be sent)
  let tail = Promise.resolve();
  let notBefore = -Infinity;

  async function one(url, init) {
    for (let attempt = 1; ; attempt += 1) {
      const now = Date.now();
      const afterGap = starts.length > 0 ? starts[starts.length - 1] + cfg.gapMs : -Infinity;
      const afterWindow = starts.length >= stats.perWindow ? starts[starts.length - stats.perWindow] + cfg.windowMs : -Infinity;
      const at = Math.max(now, afterGap, afterWindow, notBefore);
      if (at - started > cfg.deadlineMs) {
        stats.calls += 1;
        stats.gaveUp.push({ url: url.slice(GT.length), status: "out of time" });
        throw new Error("This run is out of time for more calls to the price feed.");
      }
      if (at > now) await cfg.sleep(at - now);
      starts.push(at);
      if (starts.length > 64) starts.shift();
      let res = null;
      let err = null;
      try {
        res = await inner(url, { headers: init?.headers, signal: AbortSignal.timeout(cfg.timeoutMs) });
      } catch (caught) {
        err = caught;
      }
      const status = res ? res.status : 0;
      const transient = !res || status === 429 || status >= 500;
      if (status === 429) {
        stats.refused += 1;
        stats.perWindow = Math.max(2, stats.perWindow - 1);
      }
      if (!transient || attempt >= cfg.attempts) {
        stats.calls += 1;
        if (transient) stats.gaveUp.push({ url: url.slice(GT.length), status });
        else stats.answered += 1;
        if (res) return res;
        throw err;
      }
      stats.retries += 1;
      notBefore = at + cfg.backoffMs[Math.min(attempt - 1, cfg.backoffMs.length - 1)];
      try {
        await res?.body?.cancel();
      } catch {
        // nothing to release
      }
    }
  }

  function paced(input, init) {
    const url = typeof input === "string" ? input : (input?.url ?? String(input));
    if (!url.startsWith(GT)) return inner(input, init);
    const job = tail.then(() => one(url, init));
    tail = job.then(() => undefined, () => undefined);
    return job;
  }

  globalThis.fetch = paced;
  return {
    stats,
    restore() {
      if (globalThis.fetch === paced) globalThis.fetch = previous;
    },
  };
}

// ---------------------------------------------------------------------------
// 2. the replay
// ---------------------------------------------------------------------------

/** Every minute boundary after the last read, up to this read. Oldest first. */
export function replayBoundaries(lastScanAt, stamp) {
  if (lastScanAt == null) return [];
  let first = (Math.floor(lastScanAt / MINUTE) + 1) * MINUTE;
  const last = Math.floor(stamp / MINUTE) * MINUTE;
  if (last < first) return [];
  if ((last - first) / MINUTE + 1 > MAX_REPLAY_MINUTES) first = last - (MAX_REPLAY_MINUTES - 1) * MINUTE;
  const out = [];
  for (let b = first; b <= last; b += MINUTE) out.push(b);
  return out;
}

/**
 * The newest `count` one-minute candles of one pool that START before `toSec`,
 * priced for `mint` in US dollars, oldest first, each as { end, close } with
 * `end` = start + 60 seconds. A minute with no trade has no candle, so the
 * list can reach back well before the minutes being replayed; that is what
 * gives a quiet coin its last traded price.
 * Closes are used exactly as published. Nothing is smoothed or filtered.
 */
export async function fetchCandles(pool, mint, toSec, count) {
  const limit = Math.max(1, Math.min(1000, count));
  const url =
    `${GT}/networks/solana/pools/${pool}/ohlcv/minute` +
    `?aggregate=1&limit=${limit}&before_timestamp=${toSec}&currency=usd&token=${mint}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json", "user-agent": "PaperDesk/1.0" } });
  } catch {
    return { ok: false, status: 0 };
  }
  if (res.status === 404) return { ok: true, candles: [], status: 404 }; // the feed does not know this pool
  if (!res.ok) return { ok: false, status: res.status };
  let doc;
  try {
    doc = await res.json();
  } catch {
    return { ok: false, status: -1 };
  }
  const rows = doc?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) return { ok: false, status: -2 };
  const byEnd = new Map();
  for (const row of rows) {
    const start = Number(row?.[0]);
    const close = Number(row?.[4]);
    if (!Number.isFinite(start) || start % 60 !== 0 || start >= toSec) continue; // never the minute still forming
    if (!Number.isFinite(close) || !(close > 0)) continue;
    byEnd.set(start + 60, close);
  }
  const candles = [...byEnd.entries()].map(([end, close]) => ({ end, close })).sort((a, b) => a.end - b.end);
  return { ok: true, candles, status: 200 };
}

/** Walks a coin's candles forward: for each minute asked, the last candle that had ended by then. */
function makePricer(candles) {
  let i = -1;
  return (boundarySec) => {
    while (i + 1 < candles.length && candles[i + 1].end <= boundarySec) i += 1;
    return i >= 0 ? candles[i] : null;
  };
}

// ---------------------------------------------------------------------------
// 4. the record
// ---------------------------------------------------------------------------

function paths(dataDir) {
  return {
    book: join(dataDir, "book.json"),
    twin: join(dataDir, "twin.json"),
    trades: join(dataDir, "trades.jsonl"),
    runs: join(dataDir, "runs"),
  };
}

export function checkLock(root = ROOT) {
  const lockText = readFileSync(join(root, "rules.lock.json"), "utf8");
  const lock = JSON.parse(lockText);
  for (const [rel, want] of Object.entries(lock.files)) {
    const got = sha256(readFileSync(join(root, rel)));
    if (got !== want) {
      throw new Halt(`${rel} is not the frozen file. Its fingerprint is ${got}, the lock says ${want}.`);
    }
  }
  return {
    lock,
    lockSha: sha256(lockText),
    frozenSha: lock.files["FROZEN.md"],
    rules: { strategy: lock.files[STRATEGY_FILE], market: lock.files[MARKET_FILE] },
  };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Every run line, oldest first, with the chain between them checked. */
function readRunLines(runsDir) {
  if (!existsSync(runsDir)) return { first: null, last: null, lastText: null, count: 0 };
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).sort();
  let first = null;
  let prevText = null;
  let count = 0;
  for (const file of files) {
    for (const text of readFileSync(join(runsDir, file), "utf8").split("\n")) {
      if (!text) continue;
      const line = JSON.parse(text);
      count += 1;
      if (prevText === null) {
        first = line;
        if (line.prev !== line.frozen) throw new Halt("The first run line does not start from the frozen rules.");
      } else if (line.prev !== sha256(prevText)) {
        throw new Halt(`Run line ${count} (${file}) does not follow the line before it. The run record was edited.`);
      }
      prevText = text;
    }
  }
  return { first, last: prevText ? JSON.parse(prevText) : null, lastText: prevText, count };
}

/** Read the saved record and refuse to go on if it is not exactly what the last run wrote. */
export function loadStore(dataDir, strategy, lockInfo) {
  const p = paths(dataDir);
  const have = { book: existsSync(p.book), twin: existsSync(p.twin), trades: existsSync(p.trades) };
  const runs = readRunLines(p.runs);
  if (!have.book && !have.twin && !have.trades && runs.count === 0) {
    return {
      p, genesis: true, book: null, twin: { feed: {}, trend: [] }, soft: 0, runCount: 0,
      lastRunHash: lockInfo.frozenSha, tradesText: "", tradeCount: 0, lastTradeHash: null, ledgerStart: lockInfo.frozenSha,
    };
  }
  if (!have.book || !have.twin || !have.trades || runs.count === 0) {
    throw new Halt("Part of the saved record is missing. The desk never starts a new book over an old one.");
  }
  const last = runs.last;
  const bookText = readFileSync(p.book, "utf8");
  const twinText = readFileSync(p.twin, "utf8");
  const tradesText = readFileSync(p.trades, "utf8");
  if (sha256(bookText) !== last.sha.book) throw new Halt("data/book.json is not the file the last run saved.");
  if (sha256(twinText) !== last.sha.twin) throw new Halt("data/twin.json is not the file the last run saved.");
  if (sha256(tradesText) !== last.sha.trades) throw new Halt("data/trades.jsonl is not the file the last run saved.");
  if (!sameJson(runs.first.rules, lockInfo.rules)) {
    throw new Halt("strategy.ts or market.ts is not the file this record began with. A changed rule file ends the record; it cannot carry on in the same ledger.");
  }
  if (last.lock !== lockInfo.lockSha && lockInfo.lock.follows !== last.lock) {
    throw new Halt(
      "rules.lock.json changed since the last run and does not name the lock it follows. " +
        "A change to the frozen text has to be made on purpose, in the open.",
    );
  }

  const check = checkLedger(tradesText, runs.first.frozen);
  if (!check.ok) throw new Halt(`data/trades.jsonl: ${check.why}`);

  const book = JSON.parse(bookText);
  if (!sameJson(book.settings, strategy.DEFAULT_SETTINGS)) throw new Halt("The settings in data/book.json are not the frozen settings.");
  if (book.paused !== false || book.locked !== true) throw new Halt("data/book.json is paused or unlocked. The cloud desk has no such switch.");

  return {
    p, genesis: false, book, twin: JSON.parse(twinText), soft: last.soft ?? 0, runCount: last.n,
    lastRunHash: sha256(runs.lastText), tradesText, tradeCount: check.count, lastTradeHash: check.lastHash,
    ledgerStart: runs.first.frozen,
  };
}

/**
 * Every ledger row names the fingerprint of the row before it. Row 1 names the
 * fingerprint FROZEN.md had when the desk made its first read.
 */
export function checkLedger(tradesText, startHash) {
  const lines = tradesText.split("\n").filter(Boolean);
  let prev = startHash;
  let lastAt = -Infinity;
  for (let i = 0; i < lines.length; i += 1) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      return { ok: false, why: `row ${i + 1} is not readable` };
    }
    if (row.seq !== i + 1) return { ok: false, why: `row ${i + 1} is numbered ${row.seq}` };
    if (row.prev !== prev) return { ok: false, why: `row ${i + 1} does not follow the row before it` };
    if (!(row.at >= lastAt)) return { ok: false, why: `row ${i + 1} is dated before the row above it` };
    lastAt = row.at;
    prev = sha256(lines[i]);
  }
  return { ok: true, count: lines.length, lastHash: lines.length > 0 ? prev : null };
}

/** Coin names come from strangers. Keep letters, digits and a few marks; cut the rest. */
export function clean(text, max = 40) {
  const s = String(text ?? "").replace(/[^A-Za-z0-9 ._$+-]/g, "?").trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/** For the desk's own short messages: also allow ordinary punctuation. */
function cleanText(text, max = 200) {
  const s = String(text ?? "").replace(/[^A-Za-z0-9 ._$+,:;()'/-]/g, "?").trim();
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function iso(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// One run
// ---------------------------------------------------------------------------

export async function runOnce(options = {}) {
  const dataDir = options.dataDir;
  const env = options.env ?? process.env;
  const { strategy } = await loadGrok();
  const market = options.market ?? (await loadGrok()).market;

  // Anything wrong with the frozen files or the saved record stops the desk, whatever the kind of error.
  let lockInfo;
  let store;
  try {
    lockInfo = checkLock();
    store = loadStore(dataDir, strategy, lockInfo);
  } catch (err) {
    if (err instanceof Halt) throw err;
    throw new Halt(`The frozen files or the saved record could not be read: ${err?.message ?? err}`);
  }

  // Tests that run two desks side by side share one transport so the calls stay spaced.
  const transport = options.sharedTransport ?? installTransport(options.transport);
  const before = { ...transport.stats, gaveUp: transport.stats.gaveUp.length };
  const startedAt = Date.now();
  const deskSha = sha256(readFileSync(fileURLToPath(import.meta.url)));

  const base = { n: store.runCount + 1, started: iso(startedAt), kind: "read" };
  const tail = () => ({
    api: {
      calls: transport.stats.calls - before.calls,
      refused: transport.stats.refused - before.refused,
      retries: transport.stats.retries - before.retries,
      gaveUp: transport.stats.gaveUp.length - before.gaveUp,
      perMinute: transport.stats.perWindow,
    },
    seconds: Math.round((Date.now() - startedAt) / 1000),
    ghRun: env.GITHUB_RUN_ID ?? null,
    head: env.DESK_HEAD ?? null,
    desk: deskSha.slice(0, 16),
    lock: lockInfo.lockSha,
    frozen: lockInfo.frozenSha,
    rules: lockInfo.rules,
  });

  try {
    // A first run is allowed only if no record ever existed. The outside check is GitHub's own history.
    if (store.genesis && options.priorRecord) {
      const had = await options.priorRecord();
      if (had === true) {
        throw new Halt("The data folder is empty, but GitHub's history shows this desk already had a book. The desk never starts a new book over an old one.");
      }
      if (had !== false) {
        return { ok: true, read: false, book: null, line: { ...base, kind: "no read", why: "Could not confirm that no earlier record exists. Nothing was started.", ...tail() } };
      }
    }

    let book = store.book ?? freshBook(strategy, startedAt);
    const twin = store.twin;
    const lastReadBefore = book.lastScanAt;
    const fills = [];

    // --- the live read, through the Grok desk's own market file ---------------
    // Two calls to the same function. The first, with nothing held, returns the
    // trending list alone. The second adds the deepest-pool read of each coin
    // the desk holds (market.ts keeps the trending list for 50 seconds, so it
    // is normally fetched once). Keeping the two apart lets the desk hand the
    // rules, after the replay below, what the open page would have been handed
    // for the coins it holds by then: a coin stopped out during the replay
    // must not come back in with a "held coin" quote.
    const failed = (r) => !r.ok || (r.error && r.quotes.length === 0);
    const stop = (why) => noRead(store, { ...base, kind: "no read", why, soft: store.soft, ...tail() }, options);
    const heldBefore = heldMints(book);
    const trendingOnly = await market.scanMarket({ data: { held: [] } });
    if (failed(trendingOnly)) return stop(trendingOnly.error ?? "The market read failed.");
    // `stamp` is when the live read was complete. Every value in it was read at or before this moment.
    let stamp = trendingOnly.scannedAt;
    const deepest = new Map(); // mint -> the quote read from that coin's deepest pool
    if (heldBefore.length > 0) {
      const withHeld = await market.scanMarket({ data: { held: heldBefore } });
      if (failed(withHeld)) return stop(withHeld.error ?? "The market read failed.");
      stamp = withHeld.scannedAt;
      const asked = new Set(heldBefore.slice(0, HELD_READ_LIMIT));
      for (const q of withHeld.quotes) {
        if (q.confirmedTop && asked.has(q.mint) && q.priceUsd != null && q.pool) deepest.set(q.mint, q);
      }
    }

    // --- the minutes since the last read --------------------------------------
    const boundaries = replayBoundaries(book.lastScanAt, stamp);
    const lastBoundary = boundaries.length > 0 ? boundaries[boundaries.length - 1] : null;
    const pricers = new Map(); // mint -> a walker over that coin's candles, or null when the feed would not give them
    const refused = [];
    let candlesSeen = 0;
    const pricerFor = async (mint) => {
      if (pricers.has(mint)) return pricers.get(mint);
      const f = twin.feed[mint];
      const got = await fetchCandles(f.q.pool, mint, lastBoundary / 1000, boundaries.length + 2);
      if (!got.ok) {
        refused.push({ mint, status: got.status });
        pricers.set(mint, null);
        return null;
      }
      candlesSeen += got.candles.length;
      const walker = makePricer(got.candles);
      pricers.set(mint, walker);
      return walker;
    };
    const stopForRefusal = () => refused.length > 0 && store.soft < SOFT_STOP_LIMIT;
    const refusalLine = () => ({
      ...base, kind: "no read", soft: store.soft + 1,
      why: "The feed would not give minute prices. Nothing was decided. The next run replays these minutes.",
      ...tail(),
    });

    // Fetch up front for the coins the desk reads first, so a refusal ends the run before anything is decided.
    if (lastBoundary != null) {
      for (const mint of heldBefore.slice(0, HELD_READ_LIMIT)) {
        const f = twin.feed[mint];
        if (!f || f.readAt > lastBoundary) continue;
        await pricerFor(mint);
        if (stopForRefusal()) return noRead(store, refusalLine(), options);
      }
    }

    /**
     * The price of one coin as of one minute boundary: the close of the last
     * candle that had ended by then. Only if its pool has no candle at all
     * that far back, the price read when the desk first looked the coin up.
     * Returns undefined when the coin cannot be read at this minute.
     */
    const priceFrom = new Map(); // mint -> where the price last handed to the rules came from
    const priceAt = async (mint, boundary) => {
      const f = twin.feed[mint];
      if (!f || f.readAt > boundary) return undefined; // not looked up yet as of this minute
      const walker = await pricerFor(mint);
      if (!walker) return undefined; // minute prices refused this run
      const candle = walker(boundary / 1000);
      const price = candle ? candle.close : f.q.priceUsd;
      if (price == null) return undefined;
      priceFrom.set(mint, candle ? { candleStart: iso((candle.end - 60) * 1000) } : { firstLookup: iso(f.readAt) });
      return price;
    };

    const note = (was, now, read) => {
      const count = now.trades.length - was.trades.length;
      if (count <= 0) return;
      const fresh = now.trades.slice(0, count).reverse(); // oldest first
      for (const fill of fresh) {
        const watch = was.watches.find((w) => w.mint === fill.mint);
        const pos = was.positions.find((p) => p.mint === fill.mint);
        fills.push({
          fill,
          read,
          priceFrom: priceFrom.get(fill.mint) ?? null,
          context:
            fill.reason === "dip buy"
              ? watch && { queuedAt: iso(watch.queuedAt), firstPrice: watch.firstPrice, highPrice: watch.highPrice, score: watch.score }
              : pos && { boughtAt: iso(pos.openedAt), entryPrice: pos.entryPrice, peakPrice: pos.peakPrice },
          equityAfterRead: strategy.equityOf(now),
          cashAfterRead: now.cash,
        });
      }
    };

    // In a replayed minute the trending list is not known. Coins are offered to the
    // rules in the order the page would use with the trending list of the last live read.
    const trendRank = new Map((twin.trend ?? []).map((mint, i) => [mint, i]));
    let minuteReads = 0;
    for (const boundary of boundaries) {
      const picked = [];
      const first = heldMints(book).slice(0, HELD_READ_LIMIT);
      for (let i = 0; i < first.length; i += 1) {
        const mint = first[i];
        const price = await priceAt(mint, boundary);
        if (stopForRefusal()) return noRead(store, refusalLine(), options);
        if (price === undefined) continue;
        // Everything but the price is the value last read from the coin's deepest pool.
        picked.push({ rank: trendRank.has(mint) ? trendRank.get(mint) : Infinity, i, quote: { ...twin.feed[mint].q, priceUsd: price, confirmedTop: true } });
      }
      picked.sort((x, y) => (x.rank === y.rank ? x.i - y.i : x.rank - y.rank));
      // Ingested even when no coin could be priced, so the desk's clock and its night roll-over keep to the minute.
      const next = ingest(strategy, book, picked.map((p) => p.quote), boundary, null);
      note(book, next, "minute close");
      book = next;
      if (picked.length > 0) minuteReads += 1;
    }

    // --- then the live read itself --------------------------------------------
    // Same shape as loadQuotes in market.ts: the trending list, with the deepest-pool
    // quote laid over it for each of the first 12 coins held. The price in each of
    // those quotes is the coin's last minute close, not the live number: the live
    // numbers were read minutes apart and would arrive out of time order.
    const firstNow = heldMints(book).slice(0, HELD_READ_LIMIT);
    const liveByMint = new Map(trendingOnly.quotes.map((q) => [q.mint, q]));
    let confirmed = 0;
    for (const mint of firstNow) {
      const q = deepest.get(mint);
      if (!q || lastBoundary == null) continue;
      const price = await priceAt(mint, lastBoundary);
      if (stopForRefusal()) return noRead(store, refusalLine(), options);
      if (price === undefined) continue; // its first read will be a minute close, next run
      liveByMint.set(mint, { ...q, priceUsd: price });
      confirmed += 1;
    }
    const liveQuotes = [...liveByMint.values()];
    {
      const next = ingest(strategy, book, liveQuotes, stamp, null);
      note(book, next, "live read");
      book = next;
    }
    for (const mint of firstNow) {
      const q = deepest.get(mint);
      if (q) twin.feed[mint] = { q: { ...q }, readAt: stamp };
    }
    twin.trend = trendingOnly.quotes.map((q) => q.mint);

    // --- look up the deepest pool of coins that just joined the watch list ----
    // Looked up, not acted on. The coin is read from the first whole minute after this lookup.
    const need = heldMints(book).slice(0, 2 * HELD_READ_LIMIT).filter((mint) => !twin.feed[mint]);
    const resolved = [];
    if (need.length > 0) {
      const look = await market.scanMarket({ data: { held: need } });
      if (look.ok) {
        for (const q of look.quotes) {
          if (need.includes(q.mint) && q.confirmedTop && q.priceUsd != null && q.pool) {
            twin.feed[q.mint] = { q: { ...q }, readAt: look.scannedAt };
            resolved.push({ q: { ...q }, readAt: look.scannedAt });
          }
        }
      }
    }
    const heldNow = new Set(heldMints(book));
    for (const mint of Object.keys(twin.feed)) if (!heldNow.has(mint)) delete twin.feed[mint];

    // --- write the record ------------------------------------------------------
    const p = store.p;
    mkdirSync(p.runs, { recursive: true });
    const bookText = `${JSON.stringify(persisted(book), null, 1)}\n`;
    const twinText = `${JSON.stringify(twin, null, 1)}\n`;
    let tradesText = store.tradesText;
    let prev = store.lastTradeHash ?? store.ledgerStart;
    let seq = store.tradeCount;
    for (const item of fills) {
      seq += 1;
      const f = item.fill;
      const row = {
        seq,
        at: f.at,
        utc: iso(f.at),
        pacific: f.pacific,
        side: f.reason === "dip buy" ? "buy" : "sell",
        reason: f.reason,
        symbol: clean(f.symbol),
        mint: f.mint,
        pool: f.pool,
        price: f.price,
        cash: f.cash,
        pnl: f.pnl,
        read: item.read,
        priceFrom: item.priceFrom,
        context: item.context ?? null,
        equityAfterRead: round2(item.equityAfterRead),
        cashAfterRead: round2(item.cashAfterRead),
        run: base.n,
        id: f.id,
        prev,
      };
      const line = JSON.stringify(row);
      tradesText += `${line}\n`;
      prev = sha256(line);
    }
    writeFileSync(p.book, bookText);
    writeFileSync(p.twin, twinText);
    writeFileSync(p.trades, tradesText);

    const line = {
      ...base,
      kind: store.genesis ? "first read" : "read",
      read: iso(stamp),
      lastReadBefore: lastReadBefore == null ? null : iso(lastReadBefore),
      minutes: boundaries.length,
      minuteReads,
      minuteCloses: candlesSeen,
      noMinutePrices: refused.map((r) => r.mint),
      seen: liveQuotes.length,
      confirmed,
      resolved: resolved.length,
      fills: fills.length,
      open: book.positions.length,
      waiting: book.watches.length,
      cash: round2(book.cash),
      equity: round2(strategy.equityOf(book)),
      soft: 0,
      ...tail(),
      sha: { book: sha256(bookText), twin: sha256(twinText), trades: sha256(tradesText) },
      prev: store.lastRunHash,
    };
    appendRunLine(p.runs, startedAt, line);
    const summary = `read ${line.read} | balance ${strategy.money(line.equity)} | open ${line.open} | waiting ${line.waiting} | new rows ${line.fills}`;
    finish(options, { book, line, tradesText, summary });
    return {
      ok: true, read: true, line, book, twin, fills,
      // What the live read returned, untouched. The tests give this to an independent desk.
      raw: { stamp, trending: trendingOnly.quotes, deepest: [...deepest.values()], resolved },
    };
  } finally {
    if (!options.sharedTransport) transport.restore();
  }
}

function appendRunLine(runsDir, startedAt, line) {
  mkdirSync(runsDir, { recursive: true });
  appendFileSync(join(runsDir, `${iso(startedAt).slice(0, 10)}.jsonl`), `${JSON.stringify(line)}\n`);
}

/** A run that decided nothing. The book, the watch list and the ledger are left exactly as they were. */
function noRead(store, line, options) {
  if (store.genesis) {
    // Nothing has been written yet, so there is nothing to add a line to. The next run tries again.
    return { ok: true, read: false, line, book: null };
  }
  const p = store.p;
  const full = {
    ...line,
    sha: {
      book: sha256(readFileSync(p.book, "utf8")),
      twin: sha256(readFileSync(p.twin, "utf8")),
      trades: sha256(readFileSync(p.trades, "utf8")),
    },
    prev: store.lastRunHash,
  };
  appendRunLine(p.runs, Date.parse(line.started), full);
  const summary = `no read ${line.started} | ${line.why}`;
  finish(options, { book: store.book, line: full, tradesText: store.tradesText, summary });
  return { ok: true, read: false, line: full, book: store.book };
}

function finish(options, { book, line, tradesText, summary }) {
  if (options.readmePath) {
    const bodyPath = options.readmeBodyPath ?? join(ROOT, "docs", "README.body.md");
    const body = existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : "";
    writeFileSync(options.readmePath, renderReadme(book, line, tradesText, body));
  }
  if (options.messagePath) writeFileSync(options.messagePath, `${summary}\n`);
}

// ---------------------------------------------------------------------------
// The status block at the top of README.md
// ---------------------------------------------------------------------------

export function closedTrades(tradesText) {
  const rows = tradesText.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const open = new Map();
  const closed = [];
  for (const row of rows) {
    if (row.side === "buy") open.set(row.mint, row);
    else if (open.has(row.mint)) {
      closed.push({ buy: open.get(row.mint), sell: row });
      open.delete(row.mint);
    }
  }
  return { rows, closed };
}

function pacificDay(ms) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit", day: "2-digit" }).format(ms);
}

export function renderReadme(book, line, tradesText, body) {
  const s = grok.strategy;
  const { rows, closed } = closedTrades(tradesText);
  const days = new Set(closed.map((c) => pacificDay(c.buy.at))).size;
  const out = [];
  out.push("# Paper Desk (cloud)");
  out.push("");
  out.push("**Paper money only. No wallet, no keys, no orders. Nothing here can spend anything.**");
  out.push("");
  out.push("<!-- The desk rewrites everything down to the line that says END OF STATUS after each run. -->");
  out.push("## Right now");
  out.push("");
  if (!book) {
    out.push("The desk has not made its first read yet.");
  } else {
    const equity = s.equityOf(book);
    const lastRead = book.lastScanAt == null ? "never" : s.pacificStamp(book.lastScanAt);
    out.push("| | |");
    out.push("|---|---|");
    out.push(`| Last read of the market | **${lastRead}** |`);
    if (line.kind === "no read") out.push(`| Last attempt | ${s.pacificStamp(Date.parse(line.started))}: no read. ${cleanText(line.why)} |`);
    out.push(`| Balance, by the desk's own count after costs | **${s.money(equity)}** (started at ${s.money(START_CASH)}) |`);
    out.push(`| Cash | ${s.money(book.cash)} |`);
    out.push(`| Open paper trades | ${book.positions.length} of ${book.settings.maxOpen} allowed |`);
    out.push(`| Coins waiting for a dip | ${book.watches.length} |`);
    out.push(`| Rows in the ledger | ${rows.length} (${closed.length} closed trades) |`);
    out.push("");
    out.push(
      closed.length >= 30 && days >= 5
        ? `**Score:** ${closed.length} closed trades over ${days} days. Enough to score. See FROZEN.md for the rule; the balance above is not the score.`
        : `**Score:** no verdict yet. The frozen rule needs 30 closed trades over 5 separate days. So far: ${closed.length} over ${days}. The balance above is the desk's own count, not the score.`,
    );
    out.push("");
    out.push("If *Last read* is more than about an hour old, the desk has stalled.");
    out.push("");
    out.push("### Open paper trades");
    out.push("");
    if (book.positions.length === 0) {
      out.push("None.");
    } else {
      out.push("| Coin | Bought (Pacific) | Paid | In at | Last price | Worth now, after costs |");
      out.push("|---|---|---|---|---|---|");
      for (const p of book.positions) {
        out.push(
          `| ${clean(p.symbol)} | ${s.pacificStamp(p.openedAt)} | ${s.money(p.sizeUsd)} | ${s.priceText(p.entryPrice)} | ${s.priceText(p.lastPrice)} | ${s.money(s.positionValue(p))} |`,
        );
      }
    }
    out.push("");
    out.push("### Last 10 rows of the ledger");
    out.push("");
    if (rows.length === 0) {
      out.push("No paper buy or sell yet.");
    } else {
      out.push("| # | Time (Pacific) | Coin | What | Price | Cash | After-cost result |");
      out.push("|---|---|---|---|---|---|---|");
      for (const r of rows.slice(-10).reverse()) {
        out.push(
          `| ${r.seq} | ${r.pacific} | ${clean(r.symbol)} | ${r.reason} | ${s.priceText(r.price)} | ${r.cash >= 0 ? "+" : "-"}${s.money(Math.abs(r.cash))} | ${r.pnl == null ? "" : `${r.pnl >= 0 ? "+" : "-"}${s.money(Math.abs(r.pnl))}`} |`,
        );
      }
    }
  }
  out.push("");
  out.push("<!-- END OF STATUS -->");
  out.push("");
  return `${out.join("\n")}\n${body}`;
}

// ---------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------

/** Has GitHub's history ever held a book for this desk? true, false, or null when it cannot be told. */
async function askGitHubForPriorRecord() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return null;
  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/commits?path=data%2Fbook.json&per_page=1`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "user-agent": "paper-desk" },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return null;
    const list = await res.json();
    return Array.isArray(list) ? list.length > 0 : null;
  } catch {
    return null;
  }
}

async function main(argv) {
  const cmd = argv[0];
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  if (cmd === "run") {
    const custom = flag("--data");
    if (!custom && process.env.GITHUB_ACTIONS !== "true") {
      console.error("Refusing. Only the cloud run writes the real record in ./data. For a trial, pass --data <some other folder>.");
      return 1;
    }
    if (!custom && process.env.GITHUB_REF_NAME !== "main") {
      console.error("Refusing. The real record lives on the main branch only.");
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "halt=true\n");
      return 2;
    }
    const dataDir = custom ?? join(ROOT, "data");
    try {
      const result = await runOnce({
        dataDir,
        readmePath: custom ? flag("--readme") : join(ROOT, "README.md"),
        messagePath: flag("--message"),
        priorRecord: custom ? undefined : askGitHubForPriorRecord,
      });
      console.log(JSON.stringify(result.line, null, 1));
      return 0;
    } catch (err) {
      if (err instanceof Halt) {
        console.error(`HALT: ${err.message}`);
        if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "halt=true\n");
        return 2;
      }
      throw err;
    }
  }
  if (cmd === "verify") {
    const { strategy } = await loadGrok();
    const store = loadStore(flag("--data") ?? join(ROOT, "data"), strategy, checkLock());
    console.log(store.genesis ? "No record yet." : `Record is intact: ${store.tradeCount} ledger rows, ${store.runCount} runs.`);
    return 0;
  }
  console.error("usage: node desk.mjs run [--data DIR] | verify [--data DIR]");
  return 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(err);
      process.exitCode = 1;
    },
  );
}
