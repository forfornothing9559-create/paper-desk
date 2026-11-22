import type { Quote } from "@/lib/market";

export const COST_RATE = 0.015;
export const PAUSE_MS = 150_000;

export type Settings = {
  minLiquidity: number;
  minMarketCap: number;
  maxMarketCap: number;
  passScore: number;
  dipPct: number;
  stopPct: number;
  trailPct: number;
  maxTrades: number;
  maxOpen: number;
  nightLossStop: number;
  ticketUsd: number;
};

export const DEFAULT_SETTINGS: Settings = {
  minLiquidity: 20000,
  minMarketCap: 12000,
  maxMarketCap: 8000000,
  passScore: 70,
  dipPct: 15,
  stopPct: 25,
  trailPct: 40,
  maxTrades: 20,
  maxOpen: 4,
  nightLossStop: 25,
  ticketUsd: 10,
};

export type Layer = {
  name: string;
  points: number;
  max: number;
  note: string;
};

export type ScoreCard = {
  total: number;
  layers: Layer[];
};

export type Position = {
  mint: string;
  symbol: string;
  name: string;
  entryPrice: number;
  sizeUsd: number;
  openedAt: number;
  peakPrice: number;
  lastPrice: number | null;
  marketCap: number | null;
  liquidity: number | null;
  score: number;
  url: string;
  dex: string;
  pairCreatedAt: number | null;
  pool?: string;
};

export type Watch = {
  mint: string;
  symbol: string;
  name: string;
  firstPrice: number;
  highPrice: number;
  lastPrice: number;
  score: number;
  queuedAt: number;
  marketCap: number | null;
  liquidity: number | null;
  url: string;
  dex: string;
  pairCreatedAt: number | null;
  pool?: string;
  /** Set once a deepest-pool price has anchored the dip. */
  anchored?: boolean;
};

export type Fill = {
  id: string;
  at: number;
  pacific: string;
  symbol: string;
  name: string;
  mint: string;
  pool: string;
  price: number;
  cash: number;
  pnl: number | null;
  reason: "dip buy" | "stop" | "trail" | "flatten";
};

export type LogRow = {
  id: string;
  at: number;
  pacific: string;
  mint: string;
  pool: string;
  symbol: string;
  name: string;
  marketCap: number | null;
  liquidity: number | null;
  rule: string;
  side: "buy" | "sell" | "mark";
  paperSize: number;
  paperPrice: number | null;
  why: string;
};

export type BotSnap = {
  scanner: { seen: number; killed: number; passed: number; line: string };
  analyst: { taken: number; passed: number; line: string };
  brain: { line: string };
  executor: { waiting: number; line: string };
  risk: { blocked: boolean; line: string };
};

export type Book = {
  cash: number;
  positions: Position[];
  watches: Watch[];
  log: LogRow[];
  trades: Fill[];
  priorGap: "no record" | null;
  lastSig: Record<string, string>;
  tradesTonight: number;
  nightKey: string;
  nightStartEquity: number;
  paused: boolean;
  settings: Settings;
};

export function pacificStamp(ms: number): string {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return `${fmt.format(ms)} PT`;
}

export function pacificDateKey(ms: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}

export function money(n: number, digits = 2): string {
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function compactUsd(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "n/a";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}

export function priceText(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n <= 0) return "no price";
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.01) return `$${n.toFixed(4)}`;
  return `$${n.toPrecision(3)}`;
}

export function ageLabel(created: number | null, now: number): string {
  if (!created) return "age unknown";
  const mins = Math.max(0, Math.round((now - created) / 60000));
  if (mins < 90) return `${mins}m old`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h old`;
  return `${Math.round(hrs / 24)}d old`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function scoreQuote(q: Quote, settings: Settings): ScoreCard {
  const liq = q.liquidityUsd ?? 0;
  let liqPts = 0;
  let liqNote = "no liquidity";
  if (liq > 0) {
    liqPts = clamp(Math.round(6 + Math.log10(Math.max(liq, 1000) / 1000) * 7), 0, 25);
    liqNote = compactUsd(liq);
    if (liq < settings.minLiquidity) {
      liqPts = Math.min(liqPts, 8);
      liqNote = `${compactUsd(liq)} under the floor`;
    }
  }

  const vol = q.volumeH1 ?? 0;
  const turn = liq > 0 ? vol / liq : 0;
  let turnPts = 0;
  let turnNote = "no hour volume";
  if (turn > 0) {
    if (turn >= 0.35 && turn <= 5) {
      turnPts = 25;
      turnNote = `${turn.toFixed(2)}x liquidity in an hour`;
    } else if (turn >= 0.12 && turn <= 8) {
      turnPts = 16;
      turnNote = `${turn.toFixed(2)}x liquidity in an hour`;
    } else if (turn > 8) {
      turnPts = 6;
      turnNote = "turnover looks washed";
    } else {
      turnPts = 8;
      turnNote = "quiet tape";
    }
  }

  const ch = q.changeH1;
  let momPts = 0;
  let momNote = "no 1h change";
  if (ch != null) {
    if (ch >= 2 && ch <= 35) {
      momPts = 25;
      momNote = `${ch.toFixed(1)}% in 1h`;
    } else if (ch > 35 && ch <= 90) {
      momPts = 12;
      momNote = "already extended";
    } else if (ch > 90) {
      momPts = 4;
      momNote = "chasing a spike";
    } else if (ch >= -10) {
      momPts = 14;
      momNote = "flat";
    } else {
      momPts = 3;
      momNote = "falling";
    }
  }

  const buys = q.buysH1 ?? 0;
  const sells = q.sellsH1 ?? 0;
  const totalTx = buys + sells;
  let flowPts = 0;
  let flowNote = "no prints";
  if (totalTx >= 30) {
    const ratio = buys / totalTx;
    if (ratio >= 0.52 && ratio <= 0.7) {
      flowPts = 25;
    } else if (ratio >= 0.45 && ratio <= 0.78) {
      flowPts = 16;
    } else {
      flowPts = 7;
    }
    flowNote = `${buys} buys / ${sells} sells`;
  } else if (totalTx > 0) {
    flowPts = 6;
    flowNote = "thin print count";
  }

  return {
    total: liqPts + turnPts + momPts + flowPts,
    layers: [
      { name: "Liquidity", points: liqPts, max: 25, note: liqNote },
      { name: "Turnover", points: turnPts, max: 25, note: turnNote },
      { name: "Momentum", points: momPts, max: 25, note: momNote },
      { name: "Flow", points: flowPts, max: 25, note: flowNote },
    ],
  };
}

export function positionValue(p: Position): number {
  if (!(p.entryPrice > 0) || p.lastPrice == null || !(p.lastPrice > 0)) return p.sizeUsd * (1 - COST_RATE);
  const gross = p.sizeUsd * (p.lastPrice / p.entryPrice);
  return gross * (1 - COST_RATE) * (1 - COST_RATE);
}

export function equityOf(book: Pick<Book, "cash" | "positions">): number {
  return book.positions.reduce((sum, p) => sum + positionValue(p), book.cash);
}

function row(partial: Omit<LogRow, "id" | "pacific"> & { at: number }): LogRow {
  return {
    ...partial,
    id: `${partial.at}-${partial.mint.slice(0, 6)}-${partial.rule}`,
    pacific: pacificStamp(partial.at),
  };
}

function gapLabel(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 90) return `${mins} minutes`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hours < 48) return rem === 0 ? `${hours} hours` : `${hours} hours ${rem} minutes`;
  return `${Math.floor(hours / 24)} days`;
}

function movePct(entry: number, price: number): string {
  const pct = ((price - entry) / entry) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function pushLog(log: LogRow[], lastSig: Record<string, string>, next: LogRow, sig: string) {
  if (lastSig[next.mint] === sig) return;
  lastSig[next.mint] = sig;
  log.unshift(next);
}

export function runDesk(
  book: Book,
  quotes: Quote[],
  now: number,
): { book: Book; tape: Record<string, Quote>; scores: Record<string, ScoreCard>; bots: BotSnap } {
  const settings = { ...DEFAULT_SETTINGS, ...book.settings, ticketUsd: 10 };
  const nightKey = pacificDateKey(now);
  let nightStartEquity = book.nightStartEquity;
  let tradesTonight = book.tradesTonight;
  if (nightKey !== book.nightKey) {
    tradesTonight = 0;
    nightStartEquity = equityOf(book);
  }

  const positions = book.positions.map((p) => ({ ...p }));
  const watches = book.watches.map((w) => ({ ...w }));
  const log = book.log.slice(0, 200);
  const trades = [...(book.trades ?? [])];
  const lastSig = { ...book.lastSig };
  let cash = book.cash;

  const tape: Record<string, Quote> = {};
  const scores: Record<string, ScoreCard> = {};
  for (const q of quotes) tape[q.mint] = q;

  const byMint = tape;
  let killed = 0;
  let passed = 0;
  let analystTaken = 0;

  const freshBook = (): Book => ({
    ...book,
    cash,
    positions,
    watches,
    log: log.slice(0, 200),
    trades,
    lastSig,
    tradesTonight,
    nightKey,
    nightStartEquity,
    settings,
  });

  const blockText = () => {
    const eq = equityOf({ cash, positions });
    if (book.paused) return "Paused. No new paper buys. Stops still live.";
    if (cash < settings.ticketUsd) return "Cash is under the $10 ticket.";
    if (tradesTonight >= settings.maxTrades) return "Max new tickets for tonight.";
    if (eq - nightStartEquity <= -settings.nightLossStop) return "Night loss stop. No new tickets.";
    if (positions.length >= settings.maxOpen) return "Max open paper positions.";
    return null;
  };

  const closed = new Set<string>();
  for (const pos of positions) {
    const q = byMint[pos.mint];
    if (!q?.confirmedTop || q.priceUsd == null || !q.pool) continue;
    pos.lastPrice = q.priceUsd;
    pos.marketCap = q.marketCap;
    pos.liquidity = q.liquidityUsd;
    pos.pool = q.pool;
    pos.peakPrice = Math.max(pos.peakPrice, q.priceUsd);
    const hard = pos.entryPrice * (1 - settings.stopPct / 100);
    const armed = pos.peakPrice >= pos.entryPrice * (1 + settings.trailPct / 100);
    const trail = armed ? pos.peakPrice * (1 - settings.trailPct / 100) : null;
    const stop = trail != null ? Math.max(hard, trail) : hard;
    if (q.priceUsd > stop) continue;
    const useTrail = trail != null && trail >= hard;
    const rule = useTrail ? `risk: trail ${settings.trailPct}%` : `risk: stop -${settings.stopPct}%`;
    const net = positionValue({ ...pos, lastPrice: q.priceUsd });
    const pnl = net - pos.sizeUsd;
    cash += net;
    closed.add(pos.mint);
    const kind = useTrail ? "Trail" : "Stop";
    const reason = useTrail ? "trail" : "stop";
    trades.unshift({
      id: `${now}-fill-${pos.mint.slice(0, 6)}-${reason}`,
      at: now,
      pacific: pacificStamp(now),
      symbol: pos.symbol,
      name: pos.name,
      mint: pos.mint,
      pool: q.pool,
      price: q.priceUsd,
      cash: Math.round(net * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      reason,
    });
    pushLog(
      log,
      lastSig,
      row({
        at: now,
        mint: pos.mint,
        pool: q.pool,
        symbol: pos.symbol,
        name: pos.name,
        marketCap: q.marketCap,
        liquidity: q.liquidityUsd,
        rule,
        side: "sell",
        paperSize: Math.round(net * 100) / 100,
        paperPrice: q.priceUsd,
        why: `PAPER ONLY. ${kind} was crossed. The fill is the price just read, ${priceText(q.priceUsd)}, which is ${movePct(pos.entryPrice, q.priceUsd)} from the entry. It is not filled at the -${settings.stopPct}% line. Pool ${q.pool}. 1.5% was taken on the buy and 1.5% on this sell. After-cost PnL ${pnl >= 0 ? "+" : ""}${money(pnl)}. No order sent.`,
      }),
      rule,
    );
  }

  for (let i = positions.length - 1; i >= 0; i -= 1) {
    if (closed.has(positions[i].mint)) positions.splice(i, 1);
  }

  for (const q of quotes) {
    if (positions.some((p) => p.mint === q.mint) || closed.has(q.mint)) continue;

    const watchIdx = watches.findIndex((w) => w.mint === q.mint);
    if (q.priceUsd == null) {
      killed += 1;
      pushLog(
        log,
        lastSig,
        row({
          at: now,
          mint: q.mint,
          pool: q.pool || "n/a",
          symbol: q.symbol,
          name: q.name,
          marketCap: q.marketCap,
          liquidity: q.liquidityUsd,
          rule: "scanner: no price",
          side: "buy",
          paperSize: 0,
          paperPrice: null,
          why: "No live price on this read. Nothing invented, and no paper fill.",
        }),
        "scanner: no price",
      );
      continue;
    }

    const card = scoreQuote(q, settings);
    scores[q.mint] = card;
    const thinTape = q.changeH1 == null && q.buysH1 == null;

    if (watchIdx >= 0) {
      const w = watches[watchIdx];
      if (!q.confirmedTop || !q.pool) continue;
      if (!w.anchored) {
        w.firstPrice = q.priceUsd;
        w.highPrice = q.priceUsd;
        w.anchored = true;
      } else {
        w.highPrice = Math.max(w.highPrice, q.priceUsd);
      }
      w.lastPrice = q.priceUsd;
      w.pool = q.pool;
      w.marketCap = q.marketCap;
      w.liquidity = q.liquidityUsd;
      w.score = thinTape ? w.score : card.total;
      const offHigh = (q.priceUsd - w.highPrice) / w.highPrice;
      const rugged = q.priceUsd < w.firstPrice * 0.5;
      const liqGone = (q.liquidityUsd ?? 0) < settings.minLiquidity * 0.5;
      if (rugged || liqGone || (!thinTape && card.total < settings.passScore - 15)) {
        const why = rugged
          ? "Dropped off the watch. Price fell 50% from the first confirmed print, so the dip rule will not buy a rug. No order sent."
          : liqGone
            ? "Dropped off the watch. Liquidity fell under half the floor. No order sent."
            : `Dropped off the watch. Score fell to ${card.total}. No order sent.`;
        pushLog(
          log,
          lastSig,
          row({
            at: now,
            mint: q.mint,
            pool: q.pool || "n/a",
            symbol: q.symbol,
            name: q.name,
            marketCap: q.marketCap,
            liquidity: q.liquidityUsd,
            rule: "executor: drop watch",
            side: "buy",
            paperSize: 0,
            paperPrice: q.priceUsd,
            why,
          }),
          `drop:${rugged ? "rug" : liqGone ? "liq" : "score"}`,
        );
        watches.splice(watchIdx, 1);
        continue;
      }
      const dipped = offHigh <= -settings.dipPct / 100;
      const blocked = blockText();
      if (!dipped || blocked) continue;
      cash -= settings.ticketUsd;
      tradesTonight += 1;
      positions.push({
        mint: q.mint,
        pool: q.pool || "n/a",
        symbol: q.symbol,
        name: q.name,
        entryPrice: q.priceUsd,
        sizeUsd: settings.ticketUsd,
        openedAt: now,
        peakPrice: q.priceUsd,
        lastPrice: q.priceUsd,
        marketCap: q.marketCap,
        liquidity: q.liquidityUsd,
        score: card.total,
        url: q.url,
        dex: q.dex,
        pairCreatedAt: q.pairCreatedAt,
      });
      watches.splice(watchIdx, 1);
      trades.unshift({
        id: `${now}-fill-${q.mint.slice(0, 6)}-dip`,
        at: now,
        pacific: pacificStamp(now),
        symbol: q.symbol,
        name: q.name,
        mint: q.mint,
        pool: q.pool || "n/a",
        price: q.priceUsd,
        cash: -settings.ticketUsd,
        pnl: null,
        reason: "dip buy",
      });
      pushLog(
        log,
        lastSig,
        row({
          at: now,
          mint: q.mint,
          pool: q.pool || "n/a",
          symbol: q.symbol,
          name: q.name,
          marketCap: q.marketCap,
          liquidity: q.liquidityUsd,
          rule: "executor: paper buy",
          side: "buy",
          paperSize: settings.ticketUsd,
          paperPrice: q.priceUsd,
          why: `PAPER ONLY. All five gates said yes and price is ${settings.dipPct}% under the high on the deepest pool. Fill is ${priceText(q.priceUsd)} in pool ${q.pool}, not a lower print from a smaller pool. 1.5% buy cost is taken. A later sell takes another 1.5%. No order sent. Ticket stays $10.`,
        }),
        "executor: paper buy",
      );
      continue;
    }

    let kill: { rule: string; why: string } | null = null;
    if ((q.liquidityUsd ?? 0) < settings.minLiquidity) {
      kill = {
        rule: "scanner: liquidity",
        why: `Liquidity ${compactUsd(q.liquidityUsd)} is under the ${compactUsd(settings.minLiquidity)} floor. No order sent.`,
      };
    } else if ((q.marketCap ?? 0) < settings.minMarketCap) {
      kill = {
        rule: "scanner: market cap",
        why: `Market cap ${compactUsd(q.marketCap)} is under the ${compactUsd(settings.minMarketCap)} floor. No order sent.`,
      };
    } else if ((q.marketCap ?? 0) > settings.maxMarketCap) {
      kill = {
        rule: "scanner: market cap",
        why: `Market cap ${compactUsd(q.marketCap)} is over the ${compactUsd(settings.maxMarketCap)} ceiling. This desk hunts smaller coins. No order sent.`,
      };
    }

    if (kill) {
      killed += 1;
      pushLog(
        log,
        lastSig,
        row({
          at: now,
          mint: q.mint,
          pool: q.pool || "n/a",
          symbol: q.symbol,
          name: q.name,
          marketCap: q.marketCap,
          liquidity: q.liquidityUsd,
          rule: kill.rule,
          side: "buy",
          paperSize: 0,
          paperPrice: q.priceUsd,
          why: kill.why,
        }),
        kill.rule,
      );
      continue;
    }

    analystTaken += 1;
    if (card.total < settings.passScore) {
      killed += 1;
      const weak = [...card.layers].sort((a, b) => a.points - b.points)[0];
      pushLog(
        log,
        lastSig,
        row({
          at: now,
          mint: q.mint,
          pool: q.pool || "n/a",
          symbol: q.symbol,
          name: q.name,
          marketCap: q.marketCap,
          liquidity: q.liquidityUsd,
          rule: "analyst: score",
          side: "buy",
          paperSize: 0,
          paperPrice: q.priceUsd,
          why: `Score ${card.total}, need ${settings.passScore}. Weakest layer: ${weak?.name ?? "score"} (${weak?.note ?? ""}). No order sent.`,
        }),
        `analyst: score`,
      );
      continue;
    }

    passed += 1;
    const blocked = blockText();
    if (blocked && (book.paused || cash < settings.ticketUsd || tradesTonight >= settings.maxTrades || equityOf({ cash, positions }) - nightStartEquity <= -settings.nightLossStop)) {
      pushLog(
        log,
        lastSig,
        row({
          at: now,
          mint: q.mint,
          pool: q.pool || "n/a",
          symbol: q.symbol,
          name: q.name,
          marketCap: q.marketCap,
          liquidity: q.liquidityUsd,
          rule: "risk: block",
          side: "buy",
          paperSize: 0,
          paperPrice: q.priceUsd,
          why: `${blocked} Score was ${card.total}. No order sent.`,
        }),
        `risk:${blocked}`,
      );
      continue;
    }

    watches.push({
      mint: q.mint,
      symbol: q.symbol,
      name: q.name,
      firstPrice: q.priceUsd,
      highPrice: q.priceUsd,
      lastPrice: q.priceUsd,
      score: card.total,
      queuedAt: now,
      marketCap: q.marketCap,
      liquidity: q.liquidityUsd,
      url: q.url,
      dex: q.dex,
      pairCreatedAt: q.pairCreatedAt,
      pool: q.pool,
      anchored: false,
    });
    pushLog(
      log,
      lastSig,
      row({
        at: now,
        mint: q.mint,
        pool: q.pool || "n/a",
        symbol: q.symbol,
        name: q.name,
        marketCap: q.marketCap,
        liquidity: q.liquidityUsd,
        rule: "executor: dip wait",
        side: "buy",
        paperSize: 0,
        paperPrice: q.priceUsd,
        why: `Cleared scanner, analyst (${card.total}), brain, and risk. Executor is waiting for a ${settings.dipPct}% dip off the deepest-pool high. The queue price is not a fill. No order sent. Ticket stays $10.`,
      }),
      "executor: dip wait",
    );
  }

  const block = blockText();
  const bots: BotSnap = {
    scanner: {
      seen: quotes.length,
      killed,
      passed,
      line:
        quotes.length === 0
          ? "No pairs on this read."
          : `Read ${quotes.length}. ${watches.length} waiting on a dip.`,
    },
    analyst: {
      taken: analystTaken,
      passed,
      line:
        analystTaken === 0
          ? "Nothing new reached scoring this pass. Coins already waiting are not in this count."
          : `This pass scored ${analystTaken} new coins. ${passed} of those are at ${settings.passScore} or better. Coins already waiting are not in this count.`,
    },
    brain: {
      line: `Ticket locked at ${money(settings.ticketUsd, 0)}. A score of 80 or more would be full size on a live desk. Paper mode does not raise it.`,
    },
    executor: {
      waiting: watches.length,
      line:
        watches.length > 0
          ? `${watches.length} waiting on a ${settings.dipPct}% dip. No click.`
          : positions.length > 0
            ? `${positions.length} paper position${positions.length === 1 ? "" : "s"}. No click.`
            : "Idle. Buy and Sell stay unclicked.",
    },
    risk: {
      blocked: block != null,
      line: block ?? `Guarding. Stop -${settings.stopPct}%. Trail ${settings.trailPct}% after a ${settings.trailPct}% gain.`,
    },
  };

  return {
    book: freshBook(),
    tape,
    scores,
    bots,
  };
}

export function manualFlatten(book: Book, mint: string, now: number): Book | null {
  const pos = book.positions.find((p) => p.mint === mint);
  if (!pos || pos.lastPrice == null) return null;
  const net = positionValue(pos);
  const pnl = net - pos.sizeUsd;
  const next = row({
    at: now,
    mint: pos.mint,
    pool: pos.pool || "n/a",
    symbol: pos.symbol,
    name: pos.name,
    marketCap: pos.marketCap,
    liquidity: pos.liquidity,
    rule: "executor: paper flatten",
    side: "sell",
    paperSize: Math.round(net * 100) / 100,
    paperPrice: pos.lastPrice,
    why: `PAPER ONLY. You closed this paper position by hand. The fill is the last price read, ${priceText(pos.lastPrice)}, which is ${movePct(pos.entryPrice, pos.lastPrice)} from the entry. It is not filled at the stop line. 1.5% was taken on the buy and 1.5% on this sell. After-cost PnL ${pnl >= 0 ? "+" : ""}${money(pnl)}. No order sent.`,
  });
  return {
    ...book,
    cash: book.cash + net,
    positions: book.positions.filter((p) => p.mint !== mint),
    log: [next, ...book.log].slice(0, 200),
    trades: [
      {
        id: `${now}-fill-${pos.mint.slice(0, 6)}-flatten`,
        at: now,
        pacific: pacificStamp(now),
        symbol: pos.symbol,
        name: pos.name,
        mint: pos.mint,
        pool: pos.pool || "n/a",
        price: pos.lastPrice,
        cash: Math.round(net * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
        reason: "flatten" as const,
      },
      ...(book.trades ?? []),
    ],
    lastSig: { ...book.lastSig, [mint]: "executor: paper flatten" },
  };
}

export function noteResume(book: Book, quotes: Quote[], now: number, lastAt: number): Book {
  const log = book.log.slice(0, 200);
  const lastSig = { ...book.lastSig };
  const byMint = new Map(quotes.map((q) => [q.mint, q]));
  const gap = gapLabel(now - lastAt);
  pushLog(
    log,
    lastSig,
    row({
      at: now,
      mint: "pause",
      pool: "n/a",
      symbol: "DESK",
      name: "Paper desk",
      marketCap: null,
      liquidity: null,
      rule: "desk: pause",
      side: "mark",
      paperSize: 0,
      paperPrice: null,
      why: `The page was not reading prices for ${gap}. Stops were not checked during that gap. No order sent.`,
    }),
    `pause:${lastAt}`,
  );
  const positions = book.positions.map((p) => ({ ...p }));
  for (const pos of positions) {
    const q = byMint.get(pos.mint);
    const price = q?.confirmedTop && q.priceUsd != null && q.pool ? q.priceUsd : null;
    if (price == null || !q?.pool) {
      pushLog(
        log,
        lastSig,
        row({
          at: now,
          mint: pos.mint,
          pool: q?.pool || pos.pool || "n/a",
          symbol: pos.symbol,
          name: pos.name,
          marketCap: pos.marketCap,
          liquidity: pos.liquidity,
          rule: "risk: mark after pause",
          side: "mark",
          paperSize: 0,
          paperPrice: null,
          why: `This position was open while the page was not running (${gap}). No confirmed price from the deepest pool on this read, so it is not marked and not closed. No order sent.`,
        }),
        `mark-miss:${lastAt}`,
      );
      continue;
    }
    pos.lastPrice = price;
    pos.peakPrice = Math.max(pos.peakPrice, price);
    pos.marketCap = q.marketCap;
    pos.liquidity = q.liquidityUsd;
    pos.pool = q.pool;
    pushLog(
      log,
      lastSig,
      row({
        at: now,
        mint: pos.mint,
        pool: q.pool,
        symbol: pos.symbol,
        name: pos.name,
        marketCap: q.marketCap,
        liquidity: q.liquidityUsd,
        rule: "risk: mark after pause",
        side: "mark",
        paperSize: 0,
        paperPrice: price,
        why: `Marked after ${gap} offline. Real price just read is ${priceText(price)}, ${movePct(pos.entryPrice, price)} from the paper entry. Pool ${q.pool}. This is a mark, not a fill at the stop line. No order sent.`,
      }),
      `mark:${lastAt}`,
    );
  }
  return { ...book, positions, log: log.slice(0, 200), lastSig };
}
