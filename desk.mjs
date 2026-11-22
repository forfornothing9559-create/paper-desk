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
//                      A cloud run happens every few minutes, so before its own
//                      live read it steps through every one-minute close since
//                      the last read, in order, for the coins the desk holds or
//                      is watching. A late run therefore still checks every stop.
//   3. the transport - spaces out the calls to the free price feed and retries
//                      refusals, so one busy minute does not blind the desk.
//   4. the record    - an append-only, hash-chained ledger of every paper buy
//                      and sell, a line per run, and the status block in README.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ROOT = dirname(fileURLToPath(import.meta.url));
export const GT = "https://api.geckoterminal.com/api/v2";

/** market.ts refreshes only the first 12 held coins on a read (`mints.slice(0, 12)`). The replay does the same. */
export const HELD_READ_LIMIT = 12;
/**
 * One call to the candle endpoint returns at most 1000 one-minute candles.
 * The replay asks for at most 990 minutes (16.5 hours) so one call always
 * covers it. Minutes older than that are not replayed; the Grok rules then
 * write their own "desk: pause" row for the gap.
 */
export const MAX_REPLAY_MINUTES = 990;
/** After this many runs in a row stopped by refused minute prices, a run goes ahead without them. */
export const SOFT_STOP_LIMIT = 3;

const START_CASH = 100;
const MINUTE = 60_000;
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
    const strategy = await import(pathToFileURL(join(ROOT, "grok/src/lib/strategy.ts")).href);
    const market = await import(pathToFileURL(join(ROOT, "grok/src/lib/market.ts")).href);
    grok = { strategy, market };
  }
  return grok;
}

/** Tests only: a second copy of market.ts with empty caches, which is what every real run starts with. */
export async function freshMarket(tag) {
  return import(`${pathToFileURL(join(ROOT, "grok/src/lib/market.ts")).href}?fresh=${tag}`);
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
// 3. transport - one call at a time, spaced out, refusals retried
// ---------------------------------------------------------------------------

export function installTransport(options = {}) {
  const cfg = {
    gapMs: 2500,       // pause between calls to the price feed
    gapMaxMs: 9000,    // the pause grows toward this each time the feed refuses
    grow: 1.5,
    attempts: 6,
    backoffMs: [6000, 10000, 15000, 20000, 30000],
    timeoutMs: 15000,
    budgetMs: 9 * MINUTE,
    sleep: realSleep,
    ...options,
  };
  const previous = globalThis.fetch;
  const inner = cfg.fetch ?? previous;
  const stats = { calls: 0, answered: 0, refused: 0, retries: 0, gaveUp: [], gapMs: cfg.gapMs };
  const started = Date.now();
  let tail = Promise.resolve();
  let lastAt = -Infinity;

  async function one(url, init) {
    for (let attempt = 1; ; attempt += 1) {
      const wait = lastAt + stats.gapMs - Date.now();
      if (wait > 0) await cfg.sleep(wait);
      lastAt = Date.now();
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
        stats.gapMs = Math.min(cfg.gapMaxMs, Math.round(stats.gapMs * cfg.grow));
      }
      const outOfTime = Date.now() - started > cfg.budgetMs;
      if (!transient || attempt >= cfg.attempts || outOfTime) {
        stats.calls += 1;
        if (transient) stats.gaveUp.push({ url: url.slice(GT.length), status });
        else stats.answered += 1;
        if (res) return res;
        throw err;
      }
      stats.retries += 1;
      try {
        await res?.body?.cancel();
      } catch {
        // nothing to release
      }
      await cfg.sleep(cfg.backoffMs[Math.min(attempt - 1, cfg.backoffMs.length - 1)]);
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
export function replayBoundaries(lastScanAt, scannedAt) {
  if (lastScanAt == null) return [];
  let first = (Math.floor(lastScanAt / MINUTE) + 1) * MINUTE;
  const last = Math.floor(scannedAt / MINUTE) * MINUTE;
  if (last < first) return [];
  if ((last - first) / MINUTE + 1 > MAX_REPLAY_MINUTES) first = last - (MAX_REPLAY_MINUTES - 1) * MINUTE;
  const out = [];
  for (let b = first; b <= last; b += MINUTE) out.push(b);
  return out;
}

/**
 * Closes of the one-minute candles of one pool that START in [fromSec, toSec),
 * priced for `mint` in US dollars. A minute with no trade has no candle.
 * Closes are used exactly as published. Nothing is smoothed or filtered.
 */
export async function fetchCloses(pool, mint, fromSec, toSec) {
  const want = Math.round((toSec - fromSec) / 60);
  const limit = Math.max(1, Math.min(1000, want + 2));
  const url =
    `${GT}/networks/solana/pools/${pool}/ohlcv/minute` +
    `?aggregate=1&limit=${limit}&before_timestamp=${toSec}&currency=usd&token=${mint}`;
  let res;
  try {
    res = await fetch(url, { headers: { accept: "application/json", "user-agent": "PaperDesk/1.0" } });
  } catch {
    return { ok: false, status: 0 };
  }
  if (res.status === 404) return { ok: true, closes: new Map(), status: 404 }; // the feed does not know this pool
  if (!res.ok) return { ok: false, status: res.status };
  let doc;
  try {
    doc = await res.json();
  } catch {
    return { ok: false, status: -1 };
  }
  const rows = doc?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) return { ok: false, status: -2 };
  const closes = new Map();
  for (const row of rows) {
    const start = Number(row?.[0]);
    const close = Number(row?.[4]);
    if (!Number.isFinite(start) || start % 60 !== 0) continue;
    if (start < fromSec || start >= toSec) continue;
    if (!Number.isFinite(close) || !(close > 0)) continue;
    closes.set(start, close);
  }
  return { ok: true, closes, status: 200 };
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
  return { lock, lockSha: sha256(lockText), frozenSha: lock.files["FROZEN.md"] };
}

function sameJson(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function lastRunLine(runsDir) {
  if (!existsSync(runsDir)) return null;
  const files = readdirSync(runsDir).filter((f) => f.endsWith(".jsonl")).sort();
  for (let i = files.length - 1; i >= 0; i -= 1) {
    const lines = readFileSync(join(runsDir, files[i]), "utf8").split("\n").filter(Boolean);
    if (lines.length > 0) return lines[lines.length - 1];
  }
  return null;
}

/** Read the saved record and refuse to go on if it is not exactly what the last run wrote. */
export function loadStore(dataDir, strategy, lockInfo) {
  const p = paths(dataDir);
  const have = { book: existsSync(p.book), twin: existsSync(p.twin), trades: existsSync(p.trades) };
  const runLine = lastRunLine(p.runs);
  if (!have.book && !have.twin && !have.trades && !runLine) {
    return {
      p, genesis: true, book: null, twin: { feed: {}, src: {} }, soft: 0, runCount: 0,
      lastRunHash: lockInfo.frozenSha, tradesText: "", tradeCount: 0, lastTradeHash: lockInfo.frozenSha,
    };
  }
  if (!have.book || !have.twin || !have.trades || !runLine) {
    throw new Halt("Part of the saved record is missing. The desk never starts a new book over an old one.");
  }
  const last = JSON.parse(runLine);
  const bookText = readFileSync(p.book, "utf8");
  const twinText = readFileSync(p.twin, "utf8");
  const tradesText = readFileSync(p.trades, "utf8");
  if (sha256(bookText) !== last.sha.book) throw new Halt("data/book.json is not the file the last run saved.");
  if (sha256(twinText) !== last.sha.twin) throw new Halt("data/twin.json is not the file the last run saved.");
  if (sha256(tradesText) !== last.sha.trades) throw new Halt("data/trades.jsonl is not the file the last run saved.");
  if (last.lock !== lockInfo.lockSha && lockInfo.lock.follows !== last.lock) {
    throw new Halt(
      "rules.lock.json changed since the last run and does not name the lock it follows. " +
        "A change to the frozen files has to be made on purpose, in the open.",
    );
  }

  const check = checkLedger(tradesText);
  if (!check.ok) throw new Halt(`data/trades.jsonl: ${check.why}`);

  const book = JSON.parse(bookText);
  if (!sameJson(book.settings, strategy.DEFAULT_SETTINGS)) throw new Halt("The settings in data/book.json are not the frozen settings.");
  if (book.paused !== false || book.locked !== true) throw new Halt("data/book.json is paused or unlocked. The cloud desk has no such switch.");

  return {
    p, genesis: false, book, twin: JSON.parse(twinText), soft: last.soft ?? 0, runCount: last.n,
    lastRunHash: sha256(runLine), tradesText, tradeCount: check.count,
    lastTradeHash: check.lastHash ?? lockInfo.frozenSha,
  };
}

/**
 * Every ledger row names the fingerprint of the row before it. Row 1 names the
 * fingerprint of FROZEN.md as it stood when that first paper trade was written.
 */
export function checkLedger(tradesText) {
  const lines = tradesText.split("\n").filter(Boolean);
  let prev = null;
  let lastAt = -Infinity;
  for (let i = 0; i < lines.length; i += 1) {
    let row;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      return { ok: false, why: `row ${i + 1} is not readable` };
    }
    if (row.seq !== i + 1) return { ok: false, why: `row ${i + 1} is numbered ${row.seq}` };
    if (i === 0 ? !/^[0-9a-f]{64}$/.test(String(row.prev)) : row.prev !== prev) {
      return { ok: false, why: `row ${i + 1} does not follow the row before it` };
    }
    if (!(row.at >= lastAt)) return { ok: false, why: `row ${i + 1} is dated before the row above it` };
    lastAt = row.at;
    prev = sha256(lines[i]);
  }
  return { ok: true, count: lines.length, lastHash: prev };
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
  const lockInfo = checkLock();
  const store = loadStore(dataDir, strategy, lockInfo);
  // Tests that run two desks side by side share one transport so the calls stay spaced.
  const transport = options.sharedTransport ?? installTransport(options.transport);
  const before = { ...transport.stats, gaveUp: transport.stats.gaveUp.length };
  const startedAt = Date.now();
  const deskSha = sha256(readFileSync(fileURLToPath(import.meta.url)));

  const base = {
    n: store.runCount + 1,
    started: iso(startedAt),
    kind: "read",
  };
  const tail = () => ({
    api: {
      calls: transport.stats.calls - before.calls,
      refused: transport.stats.refused - before.refused,
      retries: transport.stats.retries - before.retries,
      gaveUp: transport.stats.gaveUp.length - before.gaveUp,
      pauseMs: transport.stats.gapMs,
    },
    seconds: Math.round((Date.now() - startedAt) / 1000),
    ghRun: env.GITHUB_RUN_ID ?? null,
    head: env.DESK_HEAD ?? null,
    desk: deskSha.slice(0, 16),
    lock: lockInfo.lockSha,
    frozen: lockInfo.frozenSha,
  });

  try {
    let book = store.book ?? freshBook(strategy, startedAt);
    const twin = store.twin;
    const lastReadBefore = book.lastScanAt;
    const fills = [];

    // --- the live read, through the Grok desk's own market file ---------------
    // Two calls to the same function. The first, with nothing held, returns the
    // trending list alone. The second adds the deepest-pool price of each coin
    // the desk holds. The trending list is fetched once: market.ts keeps it for
    // 50 seconds. Keeping the two apart lets the desk hand the rules, after the
    // replay below, exactly what the open page would have been handed for the
    // coins it holds by then - a coin stopped out during the replay must not
    // come back in with a "held coin" price.
    const failed = (r) => !r.ok || (r.error && r.quotes.length === 0);
    const stop = (why) => noRead(store, { ...base, kind: "no read", why, soft: store.soft, ...tail() }, options);
    const heldBefore = heldMints(book);
    const trendingOnly = await market.scanMarket({ data: { held: [] } });
    if (failed(trendingOnly)) return stop(trendingOnly.error ?? "The market read failed.");
    let withHeld = trendingOnly;
    if (heldBefore.length > 0) {
      withHeld = await market.scanMarket({ data: { held: heldBefore } });
      if (failed(withHeld)) return stop(withHeld.error ?? "The market read failed.");
    }
    let scannedAt = withHeld.scannedAt;
    const asked = new Set(heldBefore.slice(0, HELD_READ_LIMIT));
    const deepest = new Map(); // mint -> the quote read from that coin's deepest pool
    for (const q of withHeld.quotes) if (q.confirmedTop) deepest.set(q.mint, q);

    // --- replay every one-minute close since the last read -------------------
    const boundaries = replayBoundaries(book.lastScanAt, scannedAt);
    const candles = new Map(); // mint -> Map(start second -> close), or null when the feed would not give them
    const refused = [];
    let closesSeen = 0;
    const closesFor = async (mint) => {
      if (candles.has(mint)) return candles.get(mint);
      const f = twin.feed[mint];
      const got = await fetchCloses(f.pool, mint, boundaries[0] / 1000 - 60, boundaries[boundaries.length - 1] / 1000);
      if (!got.ok) {
        refused.push({ mint, status: got.status });
        candles.set(mint, null);
        return null;
      }
      closesSeen += got.closes.size;
      candles.set(mint, got.closes);
      return got.closes;
    };
    const stopForRefusal = () => refused.length > 0 && store.soft < SOFT_STOP_LIMIT;
    const refusalLine = () => ({
      ...base, kind: "no read", soft: store.soft + 1,
      why: `The feed would not give minute prices for ${refused.length} coin(s). Nothing was decided. The next run replays these minutes.`,
      ...tail(),
    });

    if (boundaries.length > 0) {
      for (const mint of heldMints(book).slice(0, HELD_READ_LIMIT)) {
        if (twin.feed[mint]) await closesFor(mint);
      }
      if (stopForRefusal()) return noRead(store, refusalLine(), options);
    }

    const note = (before, after, read) => {
      const count = after.trades.length - before.trades.length;
      if (count <= 0) return;
      const fresh = after.trades.slice(0, count).reverse(); // oldest first
      for (const fill of fresh) {
        const watch = before.watches.find((w) => w.mint === fill.mint);
        const pos = before.positions.find((p) => p.mint === fill.mint);
        fills.push({
          fill,
          read,
          priceFrom: read === "live" ? { kind: "live read" } : (twin.src[fill.mint] ?? null),
          context:
            fill.reason === "dip buy"
              ? watch && { queuedAt: iso(watch.queuedAt), firstPrice: watch.firstPrice, highPrice: watch.highPrice, score: watch.score }
              : pos && { boughtAt: iso(pos.openedAt), entryPrice: pos.entryPrice, peakPrice: pos.peakPrice },
          equityAfter: strategy.equityOf(after),
          cashAfter: after.cash,
        });
      }
    };

    let minuteReads = 0;
    for (const boundary of boundaries) {
      const quotes = [];
      for (const mint of heldMints(book).slice(0, HELD_READ_LIMIT)) {
        const f = twin.feed[mint];
        if (!f) continue; // no deepest-pool read of this coin yet
        const closes = await closesFor(mint);
        if (stopForRefusal()) return noRead(store, refusalLine(), options);
        if (!closes) continue; // minute prices unavailable this run; the live read below still covers it
        const start = boundary / 1000 - 60;
        const close = closes.get(start);
        if (close != null) {
          f.priceUsd = close;
          twin.src[mint] = { kind: "minute close", candleStart: iso(start * 1000) };
        }
        if (f.priceUsd == null) continue;
        // Everything but the price is the last value actually read from the deepest pool.
        quotes.push({ ...f, confirmedTop: true });
      }
      if (quotes.length === 0) continue;
      const next = ingest(strategy, book, quotes, boundary, null);
      note(book, next, "minute close");
      book = next;
      minuteReads += 1;
    }

    // --- then the live read itself -------------------------------------------
    // The page asks for the first 12 coins it holds. If the replay moved a coin
    // into those 12 that was not asked for above, ask for it now.
    const firstNow = heldMints(book).slice(0, HELD_READ_LIMIT);
    const late = firstNow.filter((mint) => !asked.has(mint));
    if (late.length > 0) {
      const more = await market.scanMarket({ data: { held: late } });
      if (more.ok) {
        for (const q of more.quotes) if (q.confirmedTop && late.includes(q.mint)) deepest.set(q.mint, q);
        scannedAt = more.scannedAt;
      }
    }
    // Same shape as loadQuotes in market.ts: the trending list, with the
    // deepest-pool quote laid over it for each of the first 12 coins held.
    const liveByMint = new Map(trendingOnly.quotes.map((q) => [q.mint, q]));
    let confirmed = 0;
    for (const mint of firstNow) {
      const q = deepest.get(mint);
      if (!q) continue;
      liveByMint.set(mint, q);
      confirmed += 1;
    }
    const liveQuotes = [...liveByMint.values()];
    {
      const next = ingest(strategy, book, liveQuotes, scannedAt, null);
      note(book, next, "live");
      book = next;
    }
    for (const mint of firstNow) {
      const q = deepest.get(mint);
      if (q && q.priceUsd != null && q.pool) {
        twin.feed[mint] = { ...q };
        twin.src[mint] = { kind: "live read", at: iso(scannedAt) };
      }
    }

    // --- find the deepest pool of coins that just joined the watch list ------
    // Looked up, not acted on: the desk's next read of them is the first minute close after this one.
    const need = heldMints(book).slice(0, 2 * HELD_READ_LIMIT).filter((mint) => !twin.feed[mint]);
    let resolved = 0;
    if (need.length > 0) {
      const look = await market.scanMarket({ data: { held: need } });
      if (look.ok) {
        for (const q of look.quotes) {
          if (need.includes(q.mint) && q.confirmedTop && q.priceUsd != null && q.pool) {
            twin.feed[q.mint] = { ...q };
            twin.src[q.mint] = { kind: "live read", at: iso(look.scannedAt) };
            resolved += 1;
          }
        }
      }
    }
    const heldNow = new Set(heldMints(book));
    for (const mint of Object.keys(twin.feed)) if (!heldNow.has(mint)) delete twin.feed[mint];
    for (const mint of Object.keys(twin.src)) if (!heldNow.has(mint)) delete twin.src[mint];

    // --- write the record ----------------------------------------------------
    const p = store.p;
    mkdirSync(p.runs, { recursive: true });
    const bookText = `${JSON.stringify(persisted(book), null, 1)}\n`;
    const twinText = `${JSON.stringify(twin, null, 1)}\n`;
    let tradesText = store.tradesText;
    let prev = store.lastTradeHash;
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
        equityAfter: round2(item.equityAfter),
        cashAfter: round2(item.cashAfter),
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
      read: iso(scannedAt),
      lastReadBefore: lastReadBefore == null ? null : iso(lastReadBefore),
      minutes: boundaries.length,
      minuteReads,
      minuteCloses: closesSeen,
      noMinutePrices: refused.map((r) => r.mint),
      seen: liveQuotes.length,
      confirmed,
      resolved,
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
    finish(options, { book, line, tradesText, strategy, summary });
    return { ok: true, read: true, line, book, twin, fills };
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
  finish(options, { book: store.book, line: full, tradesText: store.tradesText, strategy: null, summary });
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
    const dataDir = custom ?? join(ROOT, "data");
    try {
      const result = await runOnce({
        dataDir,
        readmePath: custom ? flag("--readme") : join(ROOT, "README.md"),
        messagePath: flag("--message"),
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
