// Side-by-side trial on LIVE public prices, run once before the desk is
// switched on. Nothing here touches the real record in ./data.
//
// Three desks start together, each on its own machine, each with a fresh
// paper $100:
//
//   grok-raw    The Grok desk exactly as written: its own store file, its own
//               market file, one read every 60 seconds, calls sent the way the
//               Grok code sends them (up to four at once, no pauses).
//   grok-paced  The same Grok desk, but its calls go through the runner's
//               paced transport, so a busy price feed does not blind it.
//   cloud       The cloud runner as it will run for real: a run every few
//               minutes that replays the one-minute closes in between.
//
// Usage: node tests/shadow.mjs --role <role> --minutes <n> --out <file.json> [--every <seconds>]

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshBook, freshMarket, heldMints, installTransport, loadGrok, runOnce } from "../desk.mjs";

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const role = arg("--role");
const minutes = Number(arg("--minutes", "60"));
const out = arg("--out", `shadow-${role}.json`);
const every = Number(arg("--every", role === "cloud" ? "300" : "60")) * 1000;
if (!["grok-raw", "grok-paced", "cloud"].includes(role)) {
  console.error("unknown --role");
  process.exit(1);
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const { strategy, market } = await loadGrok();
const started = Date.now();
const deadline = started + minutes * 60_000;
const reads = [];
const watchEvents = [];
let knownWatches = new Set();
let knownPositions = new Set();

function noteBook(book, at) {
  const watches = new Set(book.watches.map((w) => w.mint));
  const positions = new Set(book.positions.map((p) => p.mint));
  for (const w of book.watches) {
    if (!knownWatches.has(w.mint) && !knownPositions.has(w.mint)) {
      watchEvents.push({ at, mint: w.mint, symbol: w.symbol, score: w.score, queuedAt: w.queuedAt });
    }
  }
  knownWatches = watches;
  knownPositions = positions;
}

function summary(book) {
  return {
    cash: book.cash,
    equity: strategy.equityOf(book),
    open: book.positions.map((p) => ({ mint: p.mint, symbol: p.symbol, entryPrice: p.entryPrice, lastPrice: p.lastPrice, openedAt: p.openedAt })),
    waiting: book.watches.map((w) => ({ mint: w.mint, symbol: w.symbol, anchored: !!w.anchored, firstPrice: w.firstPrice, highPrice: w.highPrice, lastPrice: w.lastPrice })),
    trades: [...book.trades].reverse(),
    lastScanAt: book.lastScanAt,
  };
}

let finalBook = null;
let api = null;

if (role === "cloud") {
  // The runner exactly as the cloud job calls it, with its book in a scratch folder.
  const dir = mkdtempSync(join(tmpdir(), "shadow-cloud-"));
  const lines = [];
  let n = 0;
  let next = started;
  while (Date.now() < deadline) {
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    n += 1;
    const t0 = Date.now();
    let result;
    try {
      // a real run is a new process each time, so it starts with empty caches
      result = await runOnce({ dataDir: dir, market: await freshMarket(`shadow-${n}`) });
    } catch (err) {
      console.log(`run ${n} threw: ${err?.message ?? err}`);
      reads.push({ at: t0, ok: false, error: String(err?.message ?? err), ms: Date.now() - t0 });
      next = Math.max(next + every, Date.now());
      continue;
    }
    const line = result.line;
    lines.push(line);
    if (result.read) {
      finalBook = result.book;
      noteBook(result.book, Date.parse(line.read));
    }
    reads.push({
      at: t0, ok: result.read, error: result.read ? null : line.why, ms: Date.now() - t0,
      minutes: line.minutes ?? 0, minuteReads: line.minuteReads ?? 0, minuteCloses: line.minuteCloses ?? 0,
      seen: line.seen ?? 0, confirmed: line.confirmed ?? 0, held: (line.open ?? 0) + (line.waiting ?? 0),
      api: line.api, fills: line.fills ?? 0,
    });
    console.log(`cloud run ${n}: ${result.read ? "read" : "NO READ"} | replayed ${line.minutes ?? 0} min | held ${(line.open ?? 0) + (line.waiting ?? 0)} | fills ${line.fills ?? 0} | calls ${line.api.calls} refused ${line.api.refused} | ${Math.round((Date.now() - t0) / 1000)}s`);
    next = Math.max(next + every, Date.now());
  }
  const ledgerText = (() => {
    try {
      return readFileSync(join(dir, "trades.jsonl"), "utf8");
    } catch {
      return "";
    }
  })();
  api = {
    calls: lines.reduce((s, l) => s + l.api.calls, 0),
    refused: lines.reduce((s, l) => s + l.api.refused, 0),
    retries: lines.reduce((s, l) => s + l.api.retries, 0),
    gaveUp: lines.reduce((s, l) => s + l.api.gaveUp, 0),
  };
  writeFileSync(out, JSON.stringify({
    role, started, ended: Date.now(), every, reads, watchEvents, api,
    ledger: ledgerText.split("\n").filter(Boolean).map((l) => JSON.parse(l)),
    final: finalBook ? summary(finalBook) : null,
  }, null, 1));
} else {
  // The Grok desk: its own store file, ticked the way app.tsx ticks it.
  const { newGrokDesk } = await import("./grokstore.mjs");
  const desk = await newGrokDesk(freshBook(strategy, started));
  const counts = { calls: 0, ok: 0, refused: 0, otherErrors: 0, threw: 0 };
  let transport = null;
  if (role === "grok-paced") {
    // one transport for the whole trial, so it must never run out of time
    transport = installTransport({ deadlineMs: Infinity });
  } else {
    // count what the price feed answers, without changing how the Grok code calls it
    const real = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      counts.calls += 1;
      try {
        const res = await real(input, init);
        if (res.status === 429) counts.refused += 1;
        else if (res.ok) counts.ok += 1;
        else counts.otherErrors += 1;
        return res;
      } catch (err) {
        counts.threw += 1;
        throw err;
      }
    };
  }
  let n = 0;
  let next = started;
  let skipped = 0;
  while (Date.now() < deadline) {
    const wait = next - Date.now();
    if (wait > 0) await sleep(wait);
    n += 1;
    const t0 = Date.now();
    const before = desk.state();
    const held = heldMints(before);
    let result;
    try {
      result = await market.scanMarket({ data: { held } });
      desk.ingest(result.quotes, result.scannedAt, result.error);
    } catch (err) {
      result = { ok: false, error: err instanceof Error ? err.message : "Market read failed", quotes: [], scannedAt: Date.now() };
      desk.ingest([], Date.now(), result.error);
    }
    const after = desk.state();
    noteBook(after, result.scannedAt);
    const confirmed = result.quotes.filter((q) => q.confirmedTop).length;
    reads.push({
      at: t0, ok: result.quotes.length > 0, error: result.error, ms: Date.now() - t0,
      seen: result.quotes.length, confirmed, held: held.length, asked: Math.min(12, held.length),
      fills: after.trades.length - before.trades.length,
    });
    if (n % 5 === 1 || after.trades.length !== before.trades.length) {
      console.log(`${role} read ${n}: quotes ${result.quotes.length} | held ${held.length} confirmed ${confirmed} | fills so far ${after.trades.length} | ${result.error ?? "ok"} | ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    // app.tsx: setInterval every 60 s; a tick that would start while one is still running is dropped
    next += every;
    while (next < Date.now()) {
      next += every;
      skipped += 1;
    }
  }
  finalBook = desk.state();
  api = transport
    ? { calls: transport.stats.calls, refused: transport.stats.refused, retries: transport.stats.retries, gaveUp: transport.stats.gaveUp.length, perMinute: transport.stats.perWindow }
    : counts;
  writeFileSync(out, JSON.stringify({ role, started, ended: Date.now(), every, skippedTicks: skipped, reads, watchEvents, api, final: summary(finalBook) }, null, 1));
}

console.log(`${role}: done. ${reads.length} reads, ${reads.filter((r) => !r.ok).length} without data. api ${JSON.stringify(api)}`);
