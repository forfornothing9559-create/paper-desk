// Turns the three files written by tests/shadow.mjs into one plain report.
// Usage: node tests/shadow-report.mjs <folder with shadow-*.json> <output folder>
// It reports what happened. It sets no pass mark: the pass/fail tests are in tests/offline.mjs.

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clean, loadGrok } from "../desk.mjs";

const [inDir, outRoot] = process.argv.slice(2);
const { strategy } = await loadGrok();
const ROLES = ["grok-raw", "grok-paced", "cloud"];
const LABEL = { "grok-raw": "Grok desk as written", "grok-paced": "Grok desk, paced calls", cloud: "Cloud desk" };

const data = {};
for (const role of ROLES) {
  const file = join(inDir, `shadow-${role}.json`);
  if (existsSync(file)) data[role] = JSON.parse(readFileSync(file, "utf8"));
}
const have = ROLES.filter((r) => data[r]);
if (have.length === 0) {
  console.error("no shadow files found");
  process.exit(1);
}

const started = Math.min(...have.map((r) => data[r].started));
const stamp = new Date(started).toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
const outDir = join(outRoot, `shadow-${stamp}`);
mkdirSync(outDir, { recursive: true });
for (const role of have) copyFileSync(join(inDir, `shadow-${role}.json`), join(outDir, `${role}.json`));

const pt = (ms) => strategy.pacificStamp(ms);
const median = (xs) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const secs = (ms) => (ms == null ? "n/a" : `${Math.round(ms / 1000)}s`);
const short = (mint) => `${mint.slice(0, 4)}..${mint.slice(-4)}`;

function fillsOf(role) {
  const d = data[role];
  if (!d) return [];
  if (role === "cloud") return d.ledger.map((r) => ({ at: r.at, mint: r.mint, symbol: r.symbol, reason: r.reason, price: r.price, pnl: r.pnl, read: r.read }));
  return (d.final?.trades ?? []).map((f) => ({ at: f.at, mint: f.mint, symbol: f.symbol, reason: f.reason, price: f.price, pnl: f.pnl, read: "live" }));
}

const col = (fn) => have.map((r) => fn(data[r], r));
const row = (label, cells) => `| ${label} | ${cells.join(" | ")} |`;
const lines = [];
lines.push("# Side-by-side trial before launch");
lines.push("");
lines.push(`Started ${new Date(started).toISOString().slice(0, 16)}Z (${pt(started)}). Live public prices. Each desk began with a fresh paper $100 on its own machine. Nothing here touched the real record.`);
lines.push("");
lines.push("This report says what happened. It has no pass mark. The pass/fail tests are the exact ones in `tests/offline.mjs`.");
lines.push("");
lines.push(`| | ${have.map((r) => LABEL[r]).join(" | ")} |`);
lines.push(`|---|${have.map(() => "---").join("|")}|`);
lines.push(row("Minutes run", col((d) => String(Math.round((d.ended - d.started) / 60000)))));
lines.push(row("Reads attempted", col((d) => String(d.reads.length))));
lines.push(row("Reads that got data", col((d) => String(d.reads.filter((x) => x.ok).length))));
lines.push(row("Typical time between reads", col((d) => {
  const gaps = d.reads.slice(1).map((x, i) => x.at - d.reads[i].at);
  return gaps.length ? `${secs(median(gaps))} (longest ${secs(Math.max(...gaps))})` : "n/a";
})));
lines.push(row("Typical time one read took", col((d) => secs(median(d.reads.map((x) => x.ms))))));
lines.push(row("Calls to the price feed", col((d) => String(d.api?.calls ?? "n/a"))));
lines.push(row("Calls the feed refused", col((d) => String(d.api?.refused ?? "n/a"))));
lines.push(row("Held-coin prices asked for / received", col((d, r) => {
  if (r === "cloud") return `${d.reads.reduce((s, x) => s + Math.min(12, x.held ?? 0), 0)} / ${d.reads.reduce((s, x) => s + (x.confirmed ?? 0), 0)} (approx.)`;
  return `${d.reads.reduce((s, x) => s + (x.asked ?? 0), 0)} / ${d.reads.reduce((s, x) => s + (x.confirmed ?? 0), 0)}`;
})));
lines.push(row("Minutes replayed from one-minute closes", col((d, r) => (r === "cloud" ? String(d.reads.reduce((s, x) => s + (x.minutes ?? 0), 0)) : "not applicable"))));
lines.push(row("Coins put on the watch list", col((d) => String(new Set(d.watchEvents.map((w) => w.mint)).size))));
lines.push(row("Paper buys", col((d, r) => String(fillsOf(r).filter((f) => f.reason === "dip buy").length))));
lines.push(row("Paper sells", col((d, r) => String(fillsOf(r).filter((f) => f.reason !== "dip buy").length))));
lines.push(row("Still open at the end", col((d) => String(d.final?.open.length ?? "n/a"))));
lines.push(row("Still waiting at the end", col((d) => String(d.final?.waiting.length ?? "n/a"))));
lines.push(row("Balance at the end, desk's own count", col((d) => (d.final ? strategy.money(d.final.equity) : "n/a"))));
lines.push("");

// watch lists
const watched = new Map();
for (const role of have) {
  for (const w of data[role].watchEvents) {
    if (!watched.has(w.mint)) watched.set(w.mint, { symbol: w.symbol, at: {} });
    if (watched.get(w.mint).at[role] == null) watched.get(w.mint).at[role] = w.at;
  }
}
lines.push("## Coins each desk put on its watch list");
lines.push("");
if (watched.size === 0) {
  lines.push("None.");
} else {
  lines.push(`| Coin | Mint | ${have.map((r) => `${LABEL[r]}: first watched (Pacific)`).join(" | ")} |`);
  lines.push(`|---|---|${have.map(() => "---").join("|")}|`);
  const sorted = [...watched.entries()].sort((a, b) => Math.min(...Object.values(a[1].at)) - Math.min(...Object.values(b[1].at)));
  for (const [mint, w] of sorted) {
    lines.push(`| ${clean(w.symbol)} | ${short(mint)} | ${have.map((r) => (w.at[r] != null ? pt(w.at[r]) : "not watched")).join(" | ")} |`);
  }
  const inAll = sorted.filter(([, w]) => have.every((r) => w.at[r] != null)).length;
  lines.push("");
  lines.push(`${inAll} of ${watched.size} coins were watched by every desk.`);
}
lines.push("");

// trades
lines.push("## Every paper buy and sell");
lines.push("");
const all = have.flatMap((r) => fillsOf(r).map((f) => ({ ...f, role: r }))).sort((a, b) => a.at - b.at);
if (all.length === 0) {
  lines.push("No desk made a paper trade in this window.");
} else {
  lines.push("| Time (Pacific) | Desk | Coin | Mint | What | Price | After-cost result | Read |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const f of all) {
    lines.push(`| ${pt(f.at)} | ${LABEL[f.role]} | ${clean(f.symbol)} | ${short(f.mint)} | ${f.reason} | ${strategy.priceText(f.price)} | ${f.pnl == null ? "" : `${f.pnl >= 0 ? "+" : "-"}${strategy.money(Math.abs(f.pnl))}`} | ${f.read} |`);
  }
}
lines.push("");

// same coin bought by more than one desk
lines.push("## The same coin bought by more than one desk");
lines.push("");
const buys = new Map();
for (const f of all.filter((x) => x.reason === "dip buy")) {
  if (!buys.has(f.mint)) buys.set(f.mint, {});
  if (!buys.get(f.mint)[f.role]) buys.get(f.mint)[f.role] = f;
}
const shared = [...buys.entries()].filter(([, by]) => Object.keys(by).length > 1);
if (shared.length === 0) {
  lines.push("None in this window.");
} else {
  lines.push(`| Coin | ${have.map((r) => `${LABEL[r]}: time, price`).join(" | ")} | Widest gap in time | Widest gap in price |`);
  lines.push(`|---|${have.map(() => "---").join("|")}|---|---|`);
  for (const [, by] of shared) {
    const list = Object.values(by);
    const times = list.map((f) => f.at);
    const prices = list.map((f) => f.price);
    lines.push(`| ${clean(list[0].symbol)} | ${have.map((r) => (by[r] ? `${pt(by[r].at)}, ${strategy.priceText(by[r].price)}` : "did not buy")).join(" | ")} | ${Math.round((Math.max(...times) - Math.min(...times)) / 60000)} min | ${(((Math.max(...prices) - Math.min(...prices)) / Math.min(...prices)) * 100).toFixed(1)}% |`);
  }
}
lines.push("");
const boughtBy = Object.fromEntries(have.map((r) => [r, new Set(fillsOf(r).filter((f) => f.reason === "dip buy").map((f) => f.mint))]));
if (boughtBy["grok-paced"] && boughtBy.cloud) {
  const g = boughtBy["grok-paced"];
  const c = boughtBy.cloud;
  const both = [...g].filter((m) => c.has(m)).length;
  lines.push(`Coins bought: paced Grok desk ${g.size}, cloud desk ${c.size}, both ${both}.`);
  lines.push("");
}

writeFileSync(join(outDir, "report.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
console.log(`\nwritten to ${outDir}`);
