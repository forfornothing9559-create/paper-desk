// The tests that must pass before the desk is switched on, and after any change.
// They use a made-up market (tests/mockgt.mjs), so they are exact and repeatable.
//
//   A. The Grok files are the pasted files, and they run unedited.
//   B. Same reads in, same book out: the runner's copy of `ingest` against the
//      Grok app's own store file, read by read, over days of minute reads
//      including sleeps, failed reads and midnight.
//   C. The replay is exact: a desk that wakes only now and then and replays the
//      one-minute closes ends with exactly the book of a desk that never slept.
//   D. A refused price feed changes nothing.
//   E. A record that was edited by hand stops the desk.
//   F. Small parts: minute boundaries, call pacing, the ledger chain.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clock, makeMarket, mockFetch, rng, useTestClock } from "./mockgt.mjs";
import { newGrokDesk, zustandVersion } from "./grokstore.mjs";
import {
  GT, HELD_READ_LIMIT, Halt, MAX_REPLAY_MINUTES, SOFT_STOP_LIMIT,
  checkLedger, checkLock, freshBook, freshMarket, heldMints, ingest, installTransport,
  loadGrok, replayBoundaries, runOnce,
} from "../desk.mjs";

useTestClock();
const REAL_FETCH = globalThis.fetch;
const QUICK = { gapMs: 0, backoffMs: [0], sleep: async () => {} };
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
  if (d) assert.fail(`${where}: the two books differ at ${d}`);
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
 * The answer key for the replay: a desk built on the Grok app's own store that
 * never sleeps. Every minute it reads the coins it holds; whenever the cloud
 * desk does a live read, it does one too. It gets each minute's price straight
 * from the made-up market's trade list, not from the candle call, and it keeps
 * its book in memory, not in files.
 */
async function referenceStep(ref, feed, market, mkt, now) {
  const heldOf = (s) => [...s.positions.map((p) => p.mint), ...s.watches.map((w) => w.mint)];
  const last = ref.state().lastScanAt;
  if (last != null) {
    const end = Math.floor(now / 60_000) * 60_000;
    let b = Math.floor(last / 60_000) * 60_000 + 60_000;
    if (b < end - (MAX_REPLAY_MINUTES - 1) * 60_000) b = end - (MAX_REPLAY_MINUTES - 1) * 60_000;
    for (; b <= end; b += 60_000) {
      const quotes = [];
      for (const mint of heldOf(ref.state()).slice(0, 12)) {
        const f = feed[mint];
        if (!f) continue;
        const px = mkt.lastTradeIn(f.pool, b / 1000 - 60, b / 1000); // last trade of the minute that just ended
        if (px != null) f.priceUsd = px;
        if (f.priceUsd == null) continue;
        quotes.push({ ...f, confirmedTop: true });
      }
      if (quotes.length > 0) ref.ingest(quotes, b, null);
    }
  }
  const held = heldOf(ref.state());
  const live = await market.scanMarket({ data: { held } });
  ref.ingest(live.quotes, live.scannedAt, live.error);
  const first = held.slice(0, 12);
  for (const q of live.quotes) {
    if (q.confirmedTop && first.includes(q.mint) && q.priceUsd != null && q.pool) feed[q.mint] = { ...q };
  }
  const after = heldOf(ref.state());
  const need = after.slice(0, 24).filter((mint) => !feed[mint]);
  if (need.length > 0) {
    const look = await market.scanMarket({ data: { held: need } });
    if (look.ok) {
      for (const q of look.quotes) {
        if (need.includes(q.mint) && q.confirmedTop && q.priceUsd != null && q.pool) feed[q.mint] = { ...q };
      }
    }
  }
  const keep = new Set(after);
  for (const mint of Object.keys(feed)) if (!keep.has(mint)) delete feed[mint];
}

function nextGap(rand) {
  const r = rand();
  if (r < 0.85) return Math.floor((3 + rand() * 6) * 60_000); // the usual few minutes
  if (r < 0.95) return Math.floor((15 + rand() * 75) * 60_000); // a late run
  if (r < 0.99) return Math.floor((3 + rand() * 6) * 3_600_000); // hours late
  return Math.floor((17 + rand() * 3) * 3_600_000); // longer than the replay can reach back
}

async function replayIsExact({ seed, days, beforeInclusive = false, withRefusals = false }) {
  const { strategy } = await loadGrok();
  const mkt = makeMarket({ seed, startMs: T0 - 2 * 3_600_000, minutes: days * 1440 + 1800, beforeInclusive });
  const fetchImpl = mockFetch(mkt);
  const dir = mkdtempSync(join(tmpdir(), "desk-c-"));
  const transport = { ...QUICK, fetch: fetchImpl };
  try {
    clock.t = T0 + 17_321;
    const ref = await newGrokDesk(freshBook(strategy, clock.t));
    const feed = {};
    const rand = rng(seed * 977 + 5);
    const end = T0 + days * 86_400_000;
    const stats = { runs: 0, reads: 0, noReads: 0, minutes: 0, longest: 0, maxHeld: 0, beyondReach: 0 };
    let inARow = 0;
    while (clock.t < end) {
      let kind = null;
      if (withRefusals && stats.runs > 0 && inARow < 2 && rand() < 0.3) kind = rand() < 0.6 ? "/ohlcv/" : "trending_pools";
      mkt.fail = kind ? (path) => (path.includes(kind) ? 429 : null) : null;
      const result = await runOnce({ dataDir: dir, market: await freshMarket(`c${seed}-${stats.runs}`), transport });
      mkt.fail = null;
      stats.runs += 1;
      const bookFile = join(dir, "book.json");
      if (result.read) {
        inARow = 0;
        stats.reads += 1;
        stats.minutes += result.line.minutes;
        stats.longest = Math.max(stats.longest, result.line.minutes);
        if (result.line.minutes === MAX_REPLAY_MINUTES) stats.beyondReach += 1;
        globalThis.fetch = fetchImpl;
        await referenceStep(ref, feed, await freshMarket(`a${seed}-${stats.runs}`), mkt, clock.t);
        globalThis.fetch = REAL_FETCH;
      } else {
        inARow += 1;
        stats.noReads += 1;
      }
      const where = `seed ${seed}, run ${stats.runs}, ${new Date(clock.t).toISOString()}`;
      if (existsSync(bookFile)) {
        const mine = JSON.parse(readFileSync(bookFile, "utf8"));
        sameOrExplain(mine, ref.state(), where);
        const twin = JSON.parse(readFileSync(join(dir, "twin.json"), "utf8"));
        sameOrExplain(twin.feed, JSON.parse(JSON.stringify(feed)), `${where} (last deepest-pool reads)`);
        stats.maxHeld = Math.max(stats.maxHeld, heldMints(mine).length);
      }
      clock.t += nextGap(rand);
    }
    // the permanent ledger must hold exactly the fills in the Grok desk's own Trades list, oldest first
    const tradesText = readFileSync(join(dir, "trades.jsonl"), "utf8");
    const chain = checkLedger(tradesText);
    assert.ok(chain.ok, chain.why);
    const rows = tradesText.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const theirs = [...ref.state().trades].reverse();
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
    // every run left a line, and the lines chain
    const runFiles = readdirSync(join(dir, "runs")).sort();
    const runLines = runFiles.flatMap((f) => readFileSync(join(dir, "runs", f), "utf8").split("\n").filter(Boolean));
    assert.equal(runLines.length, stats.runs, "one line per run");
    return { ...stats, rows: rows.length, reads2: reads, reasons, cash: ref.state().cash };
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
  for (const cfg of [{ seed: 21, days: 5 }, { seed: 22, days: 5, beforeInclusive: true }, { seed: 23, days: 5 }]) {
    const r = await replayIsExact(cfg);
    runs += r.reads;
    minutes += r.minutes;
    longest = Math.max(longest, r.longest);
    beyond += r.beyondReach;
    maxHeld = Math.max(maxHeld, r.maxHeld);
    for (const [k, v] of r.reasons) reasons.set(k, (reasons.get(k) ?? 0) + v);
    for (const [k, v] of r.reads2) kinds.set(k, (kinds.get(k) ?? 0) + v);
    parts.push(`seed ${cfg.seed}: ${r.reads} runs, ${r.rows} ledger rows`);
  }
  assert.ok((kinds.get("minute close") ?? 0) > 0, "no fill came from a replayed minute; the test market is too quiet");
  for (const reason of ["dip buy", "stop", "trail"]) assert.ok((reasons.get(reason) ?? 0) > 0, `no "${reason}" in the replay test`);
  assert.ok(beyond > 0, "no gap longer than the replay limit was tried");
  assert.ok(maxHeld > HELD_READ_LIMIT, `never held more than ${HELD_READ_LIMIT} coins at once (most: ${maxHeld}); the 12-coin limit was not exercised`);
  return `${runs} cloud runs replaying ${minutes} minutes (longest gap replayed ${longest} min, ${beyond} gaps beyond reach), compared after every run, 0 differences. Fills by read: ${show(kinds)}. By reason: ${show(reasons)}. Most coins held at once: ${maxHeld}. ${parts.join("; ")}`;
});

// --------------------------------------------------------------------------- D

await test("D. a refused price feed changes nothing, and the next run catches up exactly", async () => {
  const r = await replayIsExact({ seed: 31, days: 4, withRefusals: true });
  assert.ok(r.noReads > 5, `only ${r.noReads} refused runs; the test did not exercise refusals`);
  return `${r.runs} runs, ${r.noReads} of them refused by the feed; the book matched the never-asleep desk after every run (${r.rows} ledger rows)`;
});

await test(`D2. after ${SOFT_STOP_LIMIT} refused runs in a row the desk goes ahead and says which coins it could not replay`, async () => {
  const mkt = makeMarket({ seed: 41, startMs: T0 - 2 * 3_600_000, minutes: 3000 });
  const fetchImpl = mockFetch(mkt);
  const dir = mkdtempSync(join(tmpdir(), "desk-d-"));
  const transport = { ...QUICK, fetch: fetchImpl };
  try {
    clock.t = T0 + 5000;
    let run = 0;
    const go = async () => runOnce({ dataDir: dir, market: await freshMarket(`d${(run += 1)}`), transport });
    let last = await go();
    // run normally until the desk holds something
    for (let i = 0; i < 400 && heldMints(last.book).length === 0; i += 1) {
      clock.t += 5 * 60_000;
      last = await go();
    }
    assert.ok(heldMints(last.book).length > 0, "the test desk never held a coin");
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
    assert.ok(forced.line.noMinutePrices.length > 0, "it should name the coins it could not replay");
    assert.equal(forced.line.soft, 0);
    mkt.fail = null;
    clock.t += 5 * 60_000;
    const normal = await go();
    assert.equal(normal.read, true);
    assert.equal(normal.line.noMinutePrices.length, 0);
    return `3 refused runs left the book byte-for-byte unchanged; run 4 went ahead and listed ${forced.line.noMinutePrices.length} coin(s) without minute prices`;
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
    const go = async () => runOnce({ dataDir: dir, market: await freshMarket(`e${(run += 1)}`), transport });
    let last = await go();
    for (let i = 0; i < 900 && last.book.trades.length < 2; i += 1) {
      clock.t += 6 * 60_000;
      last = await go();
    }
    assert.ok(last.book.trades.length >= 2, "the test desk made fewer than two fills");
    const stops = async (what) => {
      clock.t += 6 * 60_000;
      await assert.rejects(go, (err) => err instanceof Halt, `${what} should stop the desk`);
    };
    const bookPath = join(dir, "book.json");
    const tradesPath = join(dir, "trades.jsonl");
    const twinPath = join(dir, "twin.json");
    const book = readFileSync(bookPath, "utf8");
    const trades = readFileSync(tradesPath, "utf8");
    const twin = readFileSync(twinPath, "utf8");

    const richer = JSON.parse(book);
    richer.cash += 50;
    writeFileSync(bookPath, `${JSON.stringify(richer, null, 1)}\n`);
    await stops("adding cash to the book");
    writeFileSync(bookPath, book);

    const lines = trades.split("\n").filter(Boolean);
    const row = JSON.parse(lines[0]);
    row.price *= 0.5;
    writeFileSync(tradesPath, `${[JSON.stringify(row), ...lines.slice(1)].join("\n")}\n`);
    await stops("rewriting a ledger price");
    writeFileSync(tradesPath, `${lines.slice(1).join("\n")}\n`);
    await stops("deleting a ledger row");
    writeFileSync(tradesPath, trades);

    rmSync(twinPath);
    await stops("deleting part of the record");
    writeFileSync(twinPath, twin);

    rmSync(bookPath);
    await stops("deleting the book to start over");
    writeFileSync(bookPath, book);

    const looser = JSON.parse(book);
    looser.settings.stopPct = 50;
    writeFileSync(bookPath, `${JSON.stringify(looser, null, 1)}\n`);
    await stops("changing a setting");
    writeFileSync(bookPath, book);

    clock.t += 6 * 60_000;
    const again = await go();
    assert.equal(again.read, true, "with the record restored the desk should run again");
    return "six kinds of hand edit each stopped the desk; with the files put back it ran again";
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

  // pacing and retries
  const sleeps = [];
  let calls = 0;
  const flaky = async () => {
    calls += 1;
    return new Response("{}", { status: calls <= 2 ? 429 : 200 });
  };
  const tr = installTransport({ fetch: flaky, sleep: async (ms) => sleeps.push(ms), gapMs: 1000, backoffMs: [5, 6, 7] });
  try {
    const res = await fetch(`${GT}/anything`);
    assert.equal(res.status, 200);
    assert.equal(tr.stats.refused, 2);
    assert.equal(tr.stats.retries, 2);
    assert.equal(tr.stats.gapMs, 2250, "the pause grows by half after each refusal");
    assert.deepEqual(sleeps, [5, 1500, 6, 2250]);
  } finally {
    tr.restore();
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
  assert.deepEqual(checkLedger(""), { ok: true, count: 0, lastHash: null });
  assert.equal(checkLedger('{"seq":2,"at":1,"prev":"x"}\n').ok, false);
  return "boundaries, pacing, retries and the ledger chain behave as written";
});

// ---------------------------------------------------------------------------

const failed = results.filter((r) => !r.ok);
console.log("");
console.log(failed.length === 0 ? `ALL ${results.length} TESTS PASSED` : `${failed.length} OF ${results.length} TESTS FAILED: ${failed.map((r) => r.name).join(" | ")}`);
process.exitCode = failed.length === 0 ? 0 : 1;
