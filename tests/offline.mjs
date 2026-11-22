// The tests that must pass before the desk is switched on, and after any change.
// They use a made-up market (tests/mockgt.mjs), so they are exact and repeatable.
//
//   A.  The Grok files are the pasted files, and they run unedited.
//   B.  Same reads in, same book out: the runner's copy of `ingest` against the
//       Grok app's own store file, read by read, over days of minute reads
//       including sleeps, failed reads and midnight.
//   C.  The replay is exact: a desk that wakes only now and then ends with
//       exactly the book of a desk that never slept. Time passes inside each
//       run the way it does for real (five calls a minute), so a read of many
//       coins is spread over minutes.
//   C2. The comparison in C would notice a wrong minute or a wrong pool.
//   C3. A minute's price is not asked for before the feed has published it.
//   D.  A refused price feed changes nothing.
//   E.  A record edited by hand stops the desk.
//   F.  Small parts: minute boundaries, call pacing, the ledger chain.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, makeMarket, mockFetch, rng, useTestClock } from "./mockgt.mjs";
import { newGrokDesk, zustandVersion } from "./grokstore.mjs";
import {
  GT, HELD_READ_LIMIT, Halt, MAX_REPLAY_MINUTES, SETTLE_MS, SOFT_STOP_LIMIT,
  checkLedger, checkLock, fetchCandles, freshBook, freshMarket, heldMints, ingest, installTransport,
  loadGrok, replayBoundaries, runOnce,
} from "../desk.mjs";

useTestClock();
const REAL_FETCH = globalThis.fetch;
/** No waiting at all: for tests that are not about timing. */
const QUICK = { gapMs: 0, perWindow: 1e9, backoffMs: [0], deadlineMs: Infinity, sleep: async () => {} };
/** The runner's real pacing, with the test clock moved forward instead of waiting. */
const pacedOn = (fetchImpl) => ({ fetch: fetchImpl, sleep: async (ms) => { clock.t += ms; } });
const T0 = Date.UTC(2026, 10, 20, 9, 0, 0);

const results = [];
async function test(name, fn) {
  const began = process.hrtime.bigint();
  try {
    const detail = await fn();
    const secs = Number(process.hrtime.bigint() - began) / 1e9;
    results.push({ name, ok: true });
    console.log(`PASS  ${name}  (${secs.toFixed(1)}s)`);
    if (detail) console.log(`      ${detail}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}`);
    console.log(String(err?.stack ?? err).split("\n").slice(0, 40).map((l) => `      ${l}`).join("\n"));
  } finally {
    globalThis.fetch = REAL_FETCH;
  }
}

/** Where two values first differ, in words short enough to read in a log. */
function firstDifference(a, b, path = "") {
  if (Object.is(a, b)) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return `${path || "(top)"}: runner ${JSON.stringify(a)?.slice(0, 200)} | grok ${JSON.stringify(b)?.slice(0, 200)}`;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: one is a list, the other is not`;
  if (Array.isArray(a)) {
    for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
      const d = firstDifference(a[i], b[i], `${path}[${i}]`);
      if (d) return `${d}  (lengths ${a.length} / ${b.length})`;
    }
    return null;
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  for (const key of keys) {
    const d = firstDifference(a[key], b[key], path ? `${path}.${key}` : key);
    if (d) return d;
  }
  return null;
}

function sameOrExplain(mine, theirs, where) {
  const d = firstDifference(mine, theirs);
  if (d) assert.fail(`${where}: the two differ at ${d}`);
}

function tally(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function show(map) {
  return [...map.entries()].sort((x, y) => y[1] - x[1]).map(([k, v]) => `${k} ${v}`).join(", ");
}

// --------------------------------------------------------------------------- A

await test("A. the Grok files are the pasted files, and they run unedited", async () => {
  const info = checkLock();
  const { strategy, market } = await loadGrok();
  assert.equal(typeof strategy.runDesk, "function");
  assert.equal(typeof strategy.noteResume, "function");
  assert.equal(typeof market.scanMarket, "function");
  assert.deepEqual(strategy.DEFAULT_SETTINGS, {
    minLiquidity: 20000, minMarketCap: 12000, maxMarketCap: 8000000, passScore: 70, dipPct: 15,
    stopPct: 25, trailPct: 40, maxTrades: 20, maxOpen: 4, nightLossStop: 25, ticketUsd: 10,
  });
  assert.equal(strategy.COST_RATE, 0.015);
  assert.equal(strategy.PAUSE_MS, 150000);
  return `${Object.keys(info.lock.files).length} frozen files match their fingerprints; node ${process.version}; zustand ${await zustandVersion()} (tests only)`;
});

// --------------------------------------------------------------------------- B

async function sameReadsSameBook(seed, hours) {
  const { strategy } = await loadGrok();
  const mkt = makeMarket({ seed, startMs: T0 - 2 * 3_600_000, minutes: hours * 60 + 400 });
  const market = await freshMarket(`b-${seed}`);
  globalThis.fetch = mockFetch(mkt);
  clock.t = T0 + 4321;
  const first = freshBook(strategy, clock.t);
  const grokDesk = await newGrokDesk(structuredClone(first));
  let mine = structuredClone(first);
  const rand = rng(seed * 31 + 7);
  const rules = new Map();
  const seenRows = new Set();
  const nights = new Set();
  let reads = 0;
  let sleeps = 0;
  let failedReads = 0;
  const end = T0 + hours * 3_600_000;
  while (clock.t < end) {
    let result;
    if (reads > 0 && rand() < 0.01) {
      failedReads += 1;
      result = { ok: false, error: "The public tape is rate limited. The next read will try again.", quotes: [], scannedAt: clock.t };
    } else {
      // exactly what app.tsx does every tick
      result = await market.scanMarket({ data: { held: heldMints(mine) } });
    }
    grokDesk.ingest(result.quotes, result.scannedAt, result.error);
    // The runner saves to a file and loads it again between runs, so do that on every read here.
    mine = JSON.parse(JSON.stringify(ingest(strategy, mine, result.quotes, result.scannedAt, result.error)));
    sameOrExplain(mine, grokDesk.state(), `seed ${seed}, read ${reads}, ${new Date(clock.t).toISOString()}`);
    for (const row of mine.log) {
      if (seenRows.has(row.id)) continue;
      seenRows.add(row.id);
      tally(rules, row.rule);
    }
    nights.add(mine.nightKey);
    reads += 1;
    if (rand() < 0.012) {
      sleeps += 1;
      clock.t += (3 + Math.floor(rand() * 45)) * 60_000; // the page was closed for a while
    } else {
      clock.t += 60_000 + Math.floor(rand() * 900);
    }
  }
  const reasons = new Map();
  for (const fill of mine.trades) tally(reasons, fill.reason);
  return { reads, sleeps, failedReads, rules, reasons, nights: nights.size, cash: mine.cash };
}

await test("B. same reads in, same book out (runner's ingest vs the Grok app's own store file)", async () => {
  const totalRules = new Map();
  const totalReasons = new Map();
  let reads = 0;
  let sleeps = 0;
  let failed = 0;
  let nights = 0;
  for (const seed of [11, 12, 13]) {
    const r = await sameReadsSameBook(seed, 60);
    reads += r.reads;
    sleeps += r.sleeps;
    failed += r.failedReads;
    nights += r.nights - 1;
    for (const [k, v] of r.rules) totalRules.set(k, (totalRules.get(k) ?? 0) + v);
    for (const [k, v] of r.reasons) totalReasons.set(k, (totalReasons.get(k) ?? 0) + v);
  }
  // The comparison only means something if the reads exercised the rules.
  for (const reason of ["dip buy", "stop", "trail"]) {
    assert.ok((totalReasons.get(reason) ?? 0) > 0, `no "${reason}" happened in the test market; widen it`);
  }
  for (const rule of ["executor: dip wait", "executor: drop watch", "desk: pause", "risk: mark after pause", "analyst: score", "scanner: liquidity", "scanner: market cap"]) {
    assert.ok((totalRules.get(rule) ?? 0) > 0, `the rule "${rule}" never fired in the test market; widen it`);
  }
  assert.ok(nights > 0, "no midnight was crossed");
  return `${reads} reads compared one by one, 0 differences. ${sleeps} sleeps, ${failed} failed reads, ${nights} midnights. Fills: ${show(totalReasons)}. Log rules: ${show(totalRules)}`;
});

// --------------------------------------------------------------------------- C

/**
 * The answer key for the replay: a desk built on the Grok app's own store file
 * that never sleeps. It steps through every minute and, at each one, takes each
 * coin's price straight from the made-up market's trade list ("the last trade
 * before this minute"), not from any candle call. It keeps its book in memory,
 * not in files, and works out the minutes for itself.
 *
 * What it is handed from the cloud run is only what cannot be known any other
 * way: the live read exactly as market.ts returned it (the trending list, each
 * held coin's deepest-pool quote, the lookups of newly watched coins) and the
 * moment each was complete. The runner reads those minutes apart; the test
 * clock moves during a run just as the real one does.
 */
function referenceStep(ref, mkt, raw) {
  const heldOf = (s) => [...s.positions.map((p) => p.mint), ...s.watches.map((w) => w.mint)];
  const state = () => ref.desk.state();
  ref.trace = [];
  const priceAsOf = (mint, boundary) => {
    const f = ref.feed[mint];
    if (!f || f.readAt > boundary) return undefined; // not looked up yet as of this minute
    const traded = mkt.lastTradeBefore(f.q.pool, boundary / 1000);
    const price = traded != null ? traded : f.q.priceUsd;
    if (price == null) return undefined;
    ref.trace.push({ at: boundary, mint, price, traded: traded != null });
    return price;
  };

  const last = state().lastScanAt;
  let lastBoundary = null;
  if (last != null) {
    const end = Math.floor(raw.stamp / 60_000) * 60_000;
    let b = Math.floor(last / 60_000) * 60_000 + 60_000;
    if (b < end - (MAX_REPLAY_MINUTES - 1) * 60_000) b = end - (MAX_REPLAY_MINUTES - 1) * 60_000;
    const rank = new Map(ref.trend.map((mint, i) => [mint, i]));
    for (; b <= end; b += 60_000) {
      const picked = [];
      heldOf(state()).slice(0, 12).forEach((mint, i) => {
        const price = priceAsOf(mint, b);
        if (price === undefined) return;
        picked.push({ r: rank.has(mint) ? rank.get(mint) : 1e9, i, q: { ...ref.feed[mint].q, priceUsd: price, confirmedTop: true } });
      });
      picked.sort((x, y) => x.r - y.r || x.i - y.i);
      ref.desk.ingest(picked.map((p) => p.q), b, null);
      lastBoundary = b;
    }
  }

  const firstNow = heldOf(state()).slice(0, 12);
  const deepest = new Map(raw.deepest.map((q) => [q.mint, q]));
  const list = new Map(raw.trending.map((q) => [q.mint, q]));
  for (const mint of firstNow) {
    const q = deepest.get(mint);
    if (!q || lastBoundary == null) continue;
    const price = priceAsOf(mint, lastBoundary);
    if (price === undefined) continue;
    list.set(mint, { ...q, priceUsd: price });
  }
  ref.desk.ingest([...list.values()], raw.stamp, null);
  for (const mint of firstNow) {
    const q = deepest.get(mint);
    if (q) ref.feed[mint] = { q: { ...q }, readAt: raw.stamp };
  }
  ref.trend = raw.trending.map((q) => q.mint);

  const after = heldOf(state());
  const need = new Set(after.slice(0, 24).filter((mint) => !ref.feed[mint]));
  for (const r of raw.resolved) {
    if (need.has(r.q.mint)) ref.feed[r.q.mint] = { q: { ...r.q }, readAt: r.readAt };
  }
  const keep = new Set(after);
  for (const mint of Object.keys(ref.feed)) if (!keep.has(mint)) delete ref.feed[mint];
}

function nextGap(rand) {
  const r = rand();
  if (r < 0.85) return Math.floor((3 + rand() * 9) * 60_000); // the usual wait between runs
  if (r < 0.95) return Math.floor((15 + rand() * 75) * 60_000); // a late run
  if (r < 0.99) return Math.floor((3 + rand() * 6) * 3_600_000); // hours late
  return Math.floor((17 + rand() * 3) * 3_600_000); // longer than the replay can reach back
}

async function replayIsExact({ seed, days, tokens = 36, beforeInclusive = false, withRefusals = false, skew = null, candleLagSec = 0, settleMs = undefined }) {
  const { strategy } = await loadGrok();
  const frozenSha = checkLock().frozenSha;
  const mkt = makeMarket({ seed, tokens, startMs: T0 - 2 * 3_600_000, minutes: days * 1440 + 1800, beforeInclusive, skew, candleLagSec });
  const fetchImpl = mockFetch(mkt);
  const dir = mkdtempSync(join(tmpdir(), "desk-c-"));
  const transport = pacedOn(fetchImpl);
  try {
    clock.t = T0 + 17_321;
    const ref = { desk: await newGrokDesk(freshBook(strategy, clock.t)), feed: {}, trend: [] };
    const rand = rng(seed * 977 + 5);
    const end = T0 + days * 86_400_000;
    const stats = { runs: 0, reads: 0, noReads: 0, minutes: 0, longest: 0, maxHeld: 0, beyondReach: 0, slowest: 0, apiCalls: 0, prices: 0, fromCandles: 0, rechecked: 0, changed: 0, waited: 0 };
    let inARow = 0;
    while (clock.t < end) {
      let kind = null;
      if (withRefusals && stats.runs > 0 && inARow < 2 && rand() < 0.3) kind = rand() < 0.6 ? "/ohlcv/" : "trending_pools";
      mkt.fail = kind ? (path) => (path.includes(kind) ? 429 : null) : null;
      const began = clock.t;
      const trace = [];
      const result = await runOnce({ dataDir: dir, market: await freshMarket(`c${seed}-${stats.runs}`), transport, trace, settleMs });
      mkt.fail = null;
      stats.runs += 1;
      stats.slowest = Math.max(stats.slowest, clock.t - began);
      stats.apiCalls += result.line.api.calls;
      const bookFile = join(dir, "book.json");
      if (result.read) {
        inARow = 0;
        stats.reads += 1;
        stats.minutes += result.line.minutes;
        stats.longest = Math.max(stats.longest, result.line.minutes);
        if (result.line.minutes === MAX_REPLAY_MINUTES) stats.beyondReach += 1;
        stats.rechecked += result.line.rechecked;
        stats.changed += result.line.changed.length;
        stats.waited += result.line.waited;
        referenceStep(ref, mkt, result.raw);
        // Price by price: what the runner handed the rules against the last true trade.
        const tag = `seed ${seed}, run ${stats.runs}`;
        for (let i = 0; i < Math.max(trace.length, ref.trace.length); i += 1) {
          const mine = trace[i];
          const truth = ref.trace[i];
          if (!mine || !truth || mine.at !== truth.at || mine.mint !== truth.mint || mine.price !== truth.price) {
            assert.fail(`${tag}: the prices handed to the rules differ at entry ${i}: runner ${JSON.stringify(mine)} | true ${JSON.stringify(truth)} (${trace.length} / ${ref.trace.length} prices this run)`);
          }
          stats.prices += 1;
          if (mine.candleEnd != null) stats.fromCandles += 1;
          if (truth.traded && mine.candleEnd == null) assert.fail(`${tag}: the coin had traded but the runner used no candle: ${JSON.stringify(mine)}`);
        }
      } else {
        inARow += 1;
        stats.noReads += 1;
      }
      const where = `seed ${seed}, run ${stats.runs}, ${new Date(clock.t).toISOString()}`;
      if (existsSync(bookFile)) {
        const mine = JSON.parse(readFileSync(bookFile, "utf8"));
        sameOrExplain(mine, ref.desk.state(), where);
        const twin = JSON.parse(readFileSync(join(dir, "twin.json"), "utf8"));
        sameOrExplain(twin.feed, JSON.parse(JSON.stringify(ref.feed)), `${where} (last deepest-pool reads)`);
        sameOrExplain(twin.trend, ref.trend, `${where} (last trending list)`);
        stats.maxHeld = Math.max(stats.maxHeld, heldMints(mine).length);
      }
      clock.t += nextGap(rand);
    }
    // the permanent ledger must hold exactly the fills in the Grok desk's own Trades list, oldest first
    const tradesText = readFileSync(join(dir, "trades.jsonl"), "utf8");
    const chain = checkLedger(tradesText, frozenSha);
    assert.ok(chain.ok, chain.why);
    const rows = tradesText.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const theirs = [...ref.desk.state().trades].reverse();
    assert.equal(rows.length, theirs.length, "ledger length differs from the Grok desk's Trades list");
    const reads = new Map();
    const reasons = new Map();
    rows.forEach((row, i) => {
      const fill = theirs[i];
      for (const key of ["id", "at", "mint", "pool", "price", "cash", "pnl", "reason"]) {
        assert.deepStrictEqual(row[key], fill[key], `ledger row ${i + 1} field ${key}`);
      }
      tally(reads, row.read);
      tally(reasons, row.reason);
    });
    // every run left a line
    const runFiles = readdirSync(join(dir, "runs")).sort();
    const runLines = runFiles.flatMap((f) => readFileSync(join(dir, "runs", f), "utf8").split("\n").filter(Boolean));
    assert.equal(runLines.length, stats.runs, "one line per run");
    // An honest feed never changes a close after the desk has used it, so the after-the-fact check must stay silent.
    assert.equal(stats.changed, 0, `the runner reported ${stats.changed} closes as changed after use, but every price matched the true trades`);
    assert.ok(stats.rechecked > 0, "the after-the-fact check of the newest close never ran");
    return { ...stats, rows: rows.length, reads2: reads, reasons, cash: ref.desk.state().cash };
  } finally {
    globalThis.fetch = REAL_FETCH;
    rmSync(dir, { recursive: true, force: true });
  }
}

await test("C. the replay is exact (a desk that wakes now and then = a desk that never slept)", async () => {
  const parts = [];
  const reasons = new Map();
  const kinds = new Map();
  let runs = 0;
  let minutes = 0;
  let longest = 0;
  let beyond = 0;
  let maxHeld = 0;
  let slowest = 0;
  let prices = 0;
  let fromCandles = 0;
  for (const cfg of [{ seed: 21, days: 6 }, { seed: 22, days: 6, beforeInclusive: true }, { seed: 23, days: 6, tokens: 60 }]) {
    const r = await replayIsExact(cfg);
    prices += r.prices;
    fromCandles += r.fromCandles;
    runs += r.reads;
    minutes += r.minutes;
    longest = Math.max(longest, r.longest);
    beyond += r.beyondReach;
    maxHeld = Math.max(maxHeld, r.maxHeld);
    slowest = Math.max(slowest, r.slowest);
    for (const [k, v] of r.reasons) reasons.set(k, (reasons.get(k) ?? 0) + v);
    for (const [k, v] of r.reads2) kinds.set(k, (kinds.get(k) ?? 0) + v);
    parts.push(`seed ${cfg.seed}: ${r.reads} runs, ${r.rows} ledger rows`);
  }
  assert.ok((kinds.get("minute close") ?? 0) > 0, "no fill came from a replayed minute; the test market is too quiet");
  for (const reason of ["dip buy", "stop", "trail"]) assert.ok((reasons.get(reason) ?? 0) > 0, `no "${reason}" in the replay test`);
  assert.ok(beyond > 0, "no gap longer than the replay limit was tried");
  assert.ok(maxHeld > HELD_READ_LIMIT, `never held more than ${HELD_READ_LIMIT} coins at once (most: ${maxHeld}); the 12-coin limit was not exercised`);
  assert.ok(slowest > 120_000, "no run took longer than two minutes of test time; the spread-out live read was not exercised");
  assert.ok(fromCandles > 0.9 * prices, `only ${fromCandles} of ${prices} prices came from a candle; the replay is not being exercised`);
  return `${prices} prices handed to the rules, each equal to the last true trade (${fromCandles} from a one-minute candle, ${prices - fromCandles} from a coin's first lookup). ${runs} cloud runs replaying ${minutes} minutes (longest gap replayed ${longest} min, ${beyond} gaps beyond reach), compared after every run, 0 differences. Slowest run ${Math.round(slowest / 1000)}s of test time. Fills by read: ${show(kinds)}. By reason: ${show(reasons)}. Most coins held at once: ${maxHeld}. ${parts.join("; ")}`;
});

await test("C2. the comparison in C would notice a wrong minute or a wrong pool", async () => {
  // Feed the runner candles that are deliberately wrong and check that test C's comparison fails.
  // If it still "matched", test C would be proving nothing.
  const caught = [];
  for (const skew of [{ shiftSec: 60 }, { flatPool: true }]) {
    let message = null;
    let stats = null;
    try {
      stats = await replayIsExact({ seed: 21, days: 3, skew });
    } catch (err) {
      message = String(err?.message ?? err);
    }
    if (!(message && message.includes("differ"))) {
      // Say exactly what the runner saw, so a miss can be understood from the log.
      const mkt = makeMarket({ seed: 21, startMs: T0 - 2 * 3_600_000, minutes: 3 * 1440 + 1800, skew });
      const tr = installTransport({ ...QUICK, fetch: mockFetch(mkt) });
      let probe = "";
      try {
        clock.t = T0 + 3_600_000 + 30_000;
        const boundary = Math.floor(clock.t / 60_000) * 60_000;
        for (const tok of mkt.list.slice(0, 4)) {
          const pool = tok.pools[0];
          const got = await fetchCandles(pool.address, tok.mint, boundary / 1000, 6);
          const lastEnd = got.candles?.length ? got.candles[got.candles.length - 1] : null;
          probe += ` | ${tok.symbol}: newest candle end ${lastEnd ? lastEnd.end - boundary / 1000 : "none"}s from the boundary, close ${lastEnd?.close}, true last trade ${mkt.lastTradeBefore(pool.address, boundary / 1000)}`;
        }
      } finally {
        tr.restore();
      }
      const { reads2, reasons, ...plain } = stats ?? {};
      assert.fail(`candles skewed by ${JSON.stringify(skew)} were not noticed. error: ${message}. run: ${JSON.stringify(plain)} fills ${reasons ? show(reasons) : "-"}. probe:${probe}`);
    }
    caught.push(`${JSON.stringify(skew)} caught: ${message.slice(0, 110)}`);
  }
  return caught.join(" || ");
});

await test("C3. a minute's price is not asked for before the feed has published it", async () => {
  // The made-up feed now publishes late: a trade reaches the candles only some
  // seconds after it happened, so a candle asked for too soon is missing or not final.
  const lagSec = Math.round(SETTLE_MS / 1000) - 5;
  assert.ok(lagSec >= 5, "the wait is too short for this test to mean anything");
  const r = await replayIsExact({ seed: 21, days: 3, candleLagSec: lagSec });
  assert.ok(r.prices > 1000 && r.rows > 0, "the late-feed run was too quiet to prove anything");
  // The same again with the wait switched off. The comparison must then fail,
  // or this test would be proving nothing.
  let message = null;
  try {
    await replayIsExact({ seed: 21, days: 3, candleLagSec: lagSec, settleMs: 0 });
  } catch (err) {
    message = String(err?.message ?? err);
  }
  assert.ok(message && message.includes("differ"), `with the wait switched off, candles published ${lagSec}s late went unnoticed: ${message}`);

  // The runner's own after-the-fact check: each run looks again at the newest
  // close it used last time. With the wait it must find nothing changed; with
  // the wait switched off against the same late feed it must find some.
  const lateFeed = async (settleMs) => {
    const mkt = makeMarket({ seed: 26, startMs: T0 - 2 * 3_600_000, minutes: 24 * 60 + 400, candleLagSec: lagSec });
    const dir = mkdtempSync(join(tmpdir(), "desk-late-"));
    const transport = pacedOn(mockFetch(mkt));
    const rand = rng(1234);
    const seen = { runs: 0, rechecked: 0, changed: 0 };
    try {
      clock.t = T0 + 17_321;
      const end = T0 + 24 * 3_600_000;
      while (clock.t < end) {
        const result = await runOnce({ dataDir: dir, market: await freshMarket(`late-${settleMs}-${seen.runs}`), transport, settleMs });
        seen.runs += 1;
        if (result.read) {
          seen.rechecked += result.line.rechecked;
          seen.changed += result.line.changed.length;
        }
        clock.t += Math.floor((3 + rand() * 9) * 60_000);
      }
      return seen;
    } finally {
      globalThis.fetch = REAL_FETCH;
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const patient = await lateFeed(undefined);
  const hasty = await lateFeed(0);
  assert.ok(patient.rechecked > 50, `the check ran only ${patient.rechecked} times in a day of runs`);
  assert.equal(patient.changed, 0, "with the wait in place, the runner still used a close that the feed changed afterwards");
  assert.ok(hasty.changed > 0, "with the wait switched off against a late feed, the runner's own check noticed nothing");
  return `feed publishing ${lagSec}s late: ${r.prices} prices over ${r.reads} runs, each equal to the last true trade, ${r.rows} ledger rows, 0 differences (the runner waits ${SETTLE_MS / 1000}s after a minute ends before asking for it; it waited ${Math.round(r.waited / r.reads)}s a run on average). With the wait switched off the same comparison fails, as it must: ${message.slice(0, 110)} || The runner's own check of closes it had already used: ${patient.rechecked} looked at again, ${patient.changed} changed with the wait; ${hasty.changed} of ${hasty.rechecked} changed without it.`;
});

// --------------------------------------------------------------------------- D

await test("D. a refused price feed changes nothing, and the next run catches up exactly", async () => {
  const r = await replayIsExact({ seed: 31, days: 5, withRefusals: true });
  assert.ok(r.noReads > 5, `only ${r.noReads} refused runs; the test did not exercise refusals`);
  return `${r.runs} runs, ${r.noReads} of them refused by the feed; the book matched the never-asleep desk after every run (${r.rows} ledger rows)`;
});

await test(`D2. after ${SOFT_STOP_LIMIT} refused runs in a row the desk goes ahead and says which coins it could not price`, async () => {
  const mkt = makeMarket({ seed: 41, startMs: T0 - 2 * 3_600_000, minutes: 3000 });
  const fetchImpl = mockFetch(mkt);
  const dir = mkdtempSync(join(tmpdir(), "desk-d-"));
  const transport = { ...QUICK, fetch: fetchImpl };
  try {
    clock.t = T0 + 5000;
    let run = 0;
    const go = async () => runOnce({ dataDir: dir, market: await freshMarket(`d${(run += 1)}`), transport });
    let last = await go();
    // run normally until the desk holds something it has looked up
    for (let i = 0; i < 400 && Object.keys(last.twin?.feed ?? {}).length === 0; i += 1) {
      clock.t += 5 * 60_000;
      last = await go();
    }
    assert.ok(Object.keys(last.twin.feed).length > 0, "the test desk never held a coin");
    const bookBefore = readFileSync(join(dir, "book.json"), "utf8");
    mkt.fail = (path) => (path.includes("/ohlcv/") ? 429 : null);
    for (let i = 1; i <= SOFT_STOP_LIMIT; i += 1) {
      clock.t += 5 * 60_000;
      const r = await go();
      assert.equal(r.read, false, `refused run ${i} should decide nothing`);
      assert.equal(r.line.soft, i);
      assert.equal(readFileSync(join(dir, "book.json"), "utf8"), bookBefore, "a refused run changed the book");
    }
    clock.t += 5 * 60_000;
    const forced = await go();
    assert.equal(forced.read, true, "the run after the limit should go ahead");
    assert.ok(forced.line.noMinutePrices.length > 0, "it should name the coins it could not price");
    assert.equal(forced.line.fills, 0, "a coin with no minute price must not be traded");
    assert.equal(forced.line.soft, 0);
    mkt.fail = null;
    clock.t += 5 * 60_000;
    const normal = await go();
    assert.equal(normal.read, true);
    assert.equal(normal.line.noMinutePrices.length, 0);
    return `3 refused runs left the book byte-for-byte unchanged; run 4 went ahead, traded nothing, and listed ${forced.line.noMinutePrices.length} coin(s) without minute prices`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- E

await test("E. a record edited by hand stops the desk", async () => {
  const mkt = makeMarket({ seed: 51, startMs: T0 - 2 * 3_600_000, minutes: 6000 });
  const fetchImpl = mockFetch(mkt);
  const dir = mkdtempSync(join(tmpdir(), "desk-e-"));
  const transport = { ...QUICK, fetch: fetchImpl };
  try {
    clock.t = T0 + 5000;
    let run = 0;
    const go = async (extra = {}) => runOnce({ dataDir: dir, market: await freshMarket(`e${(run += 1)}`), transport, ...extra });
    let last = await go();
    for (let i = 0; i < 900 && last.book.trades.length < 2; i += 1) {
      clock.t += 6 * 60_000;
      last = await go();
    }
    assert.ok(last.book.trades.length >= 2, "the test desk made fewer than two fills");
    const stops = async (what, extra) => {
      clock.t += 6 * 60_000;
      await assert.rejects(() => go(extra), (err) => err instanceof Halt, `${what} should stop the desk`);
    };
    const bookPath = join(dir, "book.json");
    const tradesPath = join(dir, "trades.jsonl");
    const twinPath = join(dir, "twin.json");
    const runsDir = join(dir, "runs");
    const book = readFileSync(bookPath, "utf8");
    const trades = readFileSync(tradesPath, "utf8");
    const twin = readFileSync(twinPath, "utf8");
    const runFiles = readdirSync(runsDir).sort().map((f) => [join(runsDir, f), readFileSync(join(runsDir, f), "utf8")]);
    const putBack = () => {
      writeFileSync(bookPath, book);
      writeFileSync(tradesPath, trades);
      writeFileSync(twinPath, twin);
      for (const [path, text] of runFiles) writeFileSync(path, text);
    };

    const richer = JSON.parse(book);
    richer.cash += 50;
    writeFileSync(bookPath, `${JSON.stringify(richer, null, 1)}\n`);
    await stops("adding cash to the book");
    putBack();

    const lines = trades.split("\n").filter(Boolean);
    const row = JSON.parse(lines[0]);
    row.price *= 0.5;
    writeFileSync(tradesPath, `${[JSON.stringify(row), ...lines.slice(1)].join("\n")}\n`);
    await stops("rewriting a ledger price");
    writeFileSync(tradesPath, `${lines.slice(1).join("\n")}\n`);
    await stops("deleting a ledger row");
    putBack();

    rmSync(twinPath);
    await stops("deleting part of the record");
    putBack();

    rmSync(bookPath);
    await stops("deleting the book");
    putBack();

    const looser = JSON.parse(book);
    looser.settings.stopPct = 50;
    writeFileSync(bookPath, `${JSON.stringify(looser, null, 1)}\n`);
    await stops("changing a setting");
    putBack();

    // an early run line rewritten: the chain between run lines must notice
    const [firstPath, firstText] = runFiles[0];
    const runLines = firstText.split("\n").filter(Boolean);
    const edited = JSON.parse(runLines[1] ?? runLines[0]);
    edited.equity = 999;
    writeFileSync(firstPath, `${[runLines[0], JSON.stringify(edited), ...runLines.slice(2)].join("\n")}\n`);
    await stops("rewriting an old run line");
    putBack();

    // the whole data folder wiped: GitHub's history still says a book existed
    rmSync(dir, { recursive: true, force: true });
    await stops("wiping the whole record to start over", { priorRecord: async () => true });
    assert.equal(existsSync(bookPath), false, "nothing may be written when a wiped record is found");
    // ...and when that history cannot be read, nothing is started either
    clock.t += 6 * 60_000;
    const unsure = await go({ priorRecord: async () => null });
    assert.equal(unsure.read, false);
    assert.equal(existsSync(bookPath), false, "nothing may be started while the history cannot be read");

    return "eight kinds of hand edit each stopped the desk, including a wiped record";
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------- F

await test("F. small parts: minute boundaries, call pacing, ledger chain", async () => {
  const m = 60_000;
  assert.deepEqual(replayBoundaries(null, 10 * m), []);
  assert.deepEqual(replayBoundaries(10 * m + 5, 10 * m + 50), [], "same minute: nothing to replay");
  assert.deepEqual(replayBoundaries(10 * m + 5, 12 * m + 1), [11 * m, 12 * m]);
  assert.deepEqual(replayBoundaries(10 * m, 12 * m), [11 * m, 12 * m], "a read exactly on a boundary is not replayed twice");
  const long = replayBoundaries(0, 5000 * m + 7);
  assert.equal(long.length, MAX_REPLAY_MINUTES);
  assert.equal(long[long.length - 1], 5000 * m);

  // pacing and retries. The test clock stands still, so each sleep is measured from the same instant.
  const sleeps = [];
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    return new Response("{}", { status: calls <= 2 ? 429 : 200 });
  };
  const tr = installTransport({ fetch: flaky, sleep: async (ms) => sleeps.push(ms), perWindow: 3, windowMs: 1000, gapMs: 100, backoffMs: [50, 60] });
  try {
    const res = await fetch(`${GT}/anything`);
    assert.equal(res.status, 200);
    assert.equal(tr.stats.refused, 2);
    assert.equal(tr.stats.retries, 2);
    assert.equal(tr.stats.perWindow, 2, "each refusal lowers the allowance by one, never under two");
    // try 2 waits out the gap (100); try 3 waits until the first call is a full window old (1000)
    assert.deepEqual(sleeps, [100, 1000]);
  } finally {
    tr.restore();
  }
  // five calls go at once, the sixth waits for the window, and nothing is sent after the deadline
  const waits = [];
  const tr3 = installTransport({ fetch: async () => new Response("{}", { status: 200 }), sleep: async (ms) => waits.push(ms), gapMs: 0, deadlineMs: 100_000 });
  try {
    for (let i = 0; i < 10; i += 1) await fetch(`${GT}/call-${i}`);
    assert.deepEqual(waits, [61_000, 61_000, 61_000, 61_000, 61_000], "calls 6 to 10 wait until calls 1 to 5 are 61 seconds old");
    assert.equal(tr3.stats.refused, 0);
    await assert.rejects(() => fetch(`${GT}/call-11`), /out of time/, "call 11 would start 122 seconds in, past the deadline");
    assert.equal(tr3.stats.gaveUp.length, 1);
  } finally {
    tr3.restore();
  }
  let always = 0;
  const tr2 = installTransport({ fetch: async () => { always += 1; return new Response("{}", { status: 429 }); }, sleep: async () => {}, gapMs: 0, attempts: 3 });
  try {
    const res = await fetch(`${GT}/anything`);
    assert.equal(res.status, 429, "after the last try the refusal is handed back, not hidden");
    assert.equal(always, 3);
    assert.equal(tr2.stats.gaveUp.length, 1);
  } finally {
    tr2.restore();
  }

  // ledger chain
  assert.deepEqual(checkLedger("", "start"), { ok: true, count: 0, lastHash: null });
  assert.equal(checkLedger('{"seq":2,"at":1,"prev":"start"}\n', "start").ok, false, "a ledger must start at row 1");
  assert.equal(checkLedger('{"seq":1,"at":1,"prev":"other"}\n', "start").ok, false, "row 1 must name the frozen rules it started from");
  assert.equal(checkLedger('{"seq":1,"at":1,"prev":"start"}\n', "start").ok, true);
  return "boundaries, pacing, retries, the deadline and the ledger chain behave as written";
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(failed.length === 0 ? `ALL ${results.length} TESTS PASSED` : `${failed.length} OF ${results.length} TESTS FAILED: ${failed.map((r) => r.name).join(" | ")}`);
process.exitCode = failed.length === 0 ? 0 : 1;
