import { useEffect, useRef, useState, type ReactNode } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  Bot,
  ChevronLeft,
  Copy,
  ExternalLink,
  Home,
  Minus,
  Plus,
  ScrollText,
  Receipt,
  Shield,
  UserRound,
} from "lucide-react";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { scanMarket } from "@/lib/market";
import { useDesk } from "@/lib/desk-store";
import {
  ageLabel,
  compactUsd,
  equityOf,
  money,
  positionValue,
  priceText,
  type LogRow,
  type Fill,
  type Position,
  type Watch,
} from "@/lib/strategy";

type Tab = "home" | "bots" | "log" | "trades" | "account";
const EMPTY_PRINTS: { t: number; p: number }[] = [];

function pnlClass(n: number): string {
  if (n > 0) return "text-profit";
  if (n < 0) return "text-loss";
  return "text-muted";
}

function signedMoney(n: number): string {
  const body = money(Math.abs(n));
  if (n > 0) return `+${body}`;
  if (n < 0) return `-${body}`;
  return body;
}

export function DeskApp() {
  const [tab, setTab] = useState<Tab>("home");
  const [mint, setMint] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const scan = useServerFn(scanMarket);
  const scanRef = useRef(scan);
  scanRef.current = scan;

  useEffect(() => {
    let cancel = false;
    let timer = 0;
    let running = false;

    async function tick() {
      if (running || cancel) return;
      running = true;
      const desk = useDesk.getState();
      desk.setScanning(true);
      const held = [
        ...desk.positions.map((p) => p.mint),
        ...desk.watches.map((w) => w.mint),
      ];
      try {
        const result = await scanRef.current({ data: { held } });
        if (!cancel) useDesk.getState().ingest(result.quotes, result.scannedAt, result.error);
      } catch (err) {
        if (!cancel) {
          const message = err instanceof Error ? err.message : "Market read failed";
          useDesk.getState().ingest([], Date.now(), message);
        }
      } finally {
        running = false;
      }
    }

    async function start() {
      await useDesk.persist.rehydrate();
      if (cancel) return;
      setReady(true);
      await tick();
      timer = window.setInterval(() => void tick(), 60000);
    }

    void start();
    return () => {
      cancel = true;
      window.clearInterval(timer);
    };
  }, []);

  const open = (next: string) => setMint(next);

  return (
    <div className="mx-auto min-h-screen max-w-3xl bg-bg text-fg">
      <main className="px-4 pt-6 pb-28">
        {tab === "home" ? <HomeView ready={ready} onOpen={open} /> : null}
        {tab === "bots" ? <BotsView /> : null}
        {tab === "log" ? <LogView onOpen={open} /> : null}
        {tab === "trades" ? <TradesView /> : null}
        {tab === "account" ? <AccountView /> : null}
      </main>
      {mint ? <CoinSheet mint={mint} onClose={() => setMint(null)} /> : null}
      <nav className="fixed inset-x-0 bottom-0 border-t border-line bg-bg/95 backdrop-blur">
        <div className="mx-auto grid max-w-3xl grid-cols-5">
          <NavButton label="Home" active={tab === "home"} onClick={() => setTab("home")}>
            <Home className="size-5" />
          </NavButton>
          <NavButton label="Bots" active={tab === "bots"} onClick={() => setTab("bots")}>
            <Bot className="size-5" />
          </NavButton>
          <NavButton label="Log" active={tab === "log"} onClick={() => setTab("log")}>
            <ScrollText className="size-5" />
          </NavButton>
          <NavButton label="Trades" active={tab === "trades"} onClick={() => setTab("trades")}>
            <Receipt className="size-5" />
          </NavButton>
          <NavButton label="Account" active={tab === "account"} onClick={() => setTab("account")}>
            <UserRound className="size-5" />
          </NavButton>
        </div>
      </nav>
    </div>
  );
}

function NavButton({
  label,
  active,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex min-h-14 flex-col items-center justify-center gap-1 text-xs ${active ? "text-fg" : "text-faint"}`}
    >
      {children}
      {label}
    </button>
  );
}

function HomeView({ ready, onOpen }: { ready: boolean; onOpen: (mint: string) => void }) {
  const cash = useDesk((s) => s.cash);
  const positions = useDesk((s) => s.positions);
  const watches = useDesk((s) => s.watches);
  const log = useDesk((s) => s.log);
  const bots = useDesk((s) => s.bots);
  const scanning = useDesk((s) => s.scanning);
  const error = useDesk((s) => s.error);
  const lastScanAt = useDesk((s) => s.lastScanAt);
  const nightStart = useDesk((s) => s.nightStartEquity);
  const equity = useDesk((s) => equityOf(s));
  const night = equity - nightStart;
  const priorGap = useDesk((s) => s.priorGap);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Overnight desk</p>
          <h1 className="text-2xl font-semibold tracking-tight">Paper Desk</h1>
        </div>
        <span className="rounded-full bg-warn px-3 py-1 font-mono text-xs font-medium text-bg">PAPER</span>
      </header>

      <section>
        <p className="font-mono text-4xl font-semibold tabular-nums tracking-tight">{money(equity)}</p>
        <p className={`mt-1 font-mono text-sm tabular-nums ${pnlClass(night)}`}>
          {signedMoney(night)} tonight
          <span className="text-muted"> · cash {money(cash)}</span>
        </p>
        {priorGap === "no record" ? (
          <p className="mt-2 text-sm text-warn">Earlier realized gain: no record. New buys and sells are kept on Trades.</p>
        ) : null}
        <div className="mt-4 border-t border-dashed border-accent/70" />
        <p className="mt-3 text-sm text-pretty text-muted">
          Five bots have to agree, in order. The executor writes the order in the log and stops. No wallet, no click, no order.
          Results are after 1.5% on the buy and 1.5% on the sell.
        </p>
      </section>

      <p className="font-mono text-xs text-faint">
        {error ? error : scanning && !lastScanAt ? "Reading public Solana pairs…" : scanning ? "Reading again…" : "PAPER. No orders sent."}
        {lastScanAt ? ` · ${scanAgo(lastScanAt)}` : ready ? "" : ""}
      </p>

      <div className="grid grid-cols-2 gap-2">
        <MiniBot name="Scanner" line={bots.scanner.line} />
        <MiniBot name="Analyst" line={bots.analyst.line} />
        <MiniBot name="Brain" line="Ticket locked at $10" />
        <MiniBot name="Risk" line={bots.risk.line} hot={bots.risk.blocked} />
      </div>

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted">Paper positions</h2>
        {positions.length === 0 ? (
          <Empty>No paper position yet. A coin has to clear every gate, then dip, before $10 is marked.</Empty>
        ) : (
          <div className="flex gap-3 overflow-x-auto pb-1">
            {positions.map((p) => (
              <PositionCard key={p.mint} position={p} onOpen={() => onOpen(p.mint)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-muted">Waiting on a dip</h2>
        {watches.length === 0 ? (
          <Empty>Nothing is armed. The executor only watches coins the analyst scores at the pass mark or better.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {watches.map((w) => (
              <WatchRow key={w.mint} watch={w} onOpen={() => onOpen(w.mint)} />
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="mb-2 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-muted">Latest decisions</h2>
          <span className="text-xs text-faint">{log.length} rows</span>
        </div>
        {log.length === 0 ? (
          <Empty>The log starts with this line and stays empty until the scanner finishes a read.</Empty>
        ) : (
          <div className="flex flex-col gap-2">
            {log.slice(0, 5).map((row) => (
              <LogCard key={row.id} row={row} onOpen={() => onOpen(row.mint)} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function MiniBot({ name, line, hot }: { name: string; line: string; hot?: boolean }) {
  return (
    <div className="rounded-2xl bg-surface p-3">
      <p className={`text-xs font-medium ${hot ? "text-loss" : "text-accent"}`}>{name}</p>
      <p className="mt-1 line-clamp-3 text-xs text-pretty text-muted">{line}</p>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-2xl bg-surface px-3 py-4 text-sm text-pretty text-muted">{children}</p>;
}

function PositionCard({ position, onOpen }: { position: Position; onOpen: () => void }) {
  const value = positionValue(position);
  const pnl = value - position.sizeUsd;
  const pct = position.lastPrice != null ? ((position.lastPrice - position.entryPrice) / position.entryPrice) * 100 : null;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="min-w-56 shrink-0 rounded-2xl bg-surface p-3 text-left"
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-semibold">{position.symbol}</span>
        <span className={`font-mono text-sm tabular-nums ${pnlClass(pnl)}`}>{signedMoney(pnl)}</span>
      </div>
      <p className="mt-1 text-xs text-faint">After 1.5% each side</p>
      <p className="mt-2 font-mono text-lg tabular-nums">{priceText(position.lastPrice)}</p>
      <p className="text-xs text-muted">
        in at {priceText(position.entryPrice)}
        {pct != null ? ` · market ${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%` : " · no price"}
      </p>
    </button>
  );
}

function WatchRow({ watch, onOpen }: { watch: Watch; onOpen: () => void }) {
  const dip = useDesk((s) => s.settings.dipPct);
  const off = ((watch.lastPrice - watch.highPrice) / watch.highPrice) * 100;
  return (
    <button type="button" onClick={onOpen} className="rounded-2xl bg-surface px-3 py-3 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">{watch.symbol}</span>
        <span className="font-mono text-xs text-warn tabular-nums">
          {off.toFixed(1)}% off high · need -{dip}%
        </span>
      </div>
      <p className="mt-1 text-xs text-muted">
        Score {watch.score} · {compactUsd(watch.marketCap)} cap · {compactUsd(watch.liquidity)} liq · {priceText(watch.lastPrice)}
      </p>
    </button>
  );
}

function LogCard({ row, onOpen }: { row: LogRow; onOpen: () => void }) {
  const filled = row.paperSize > 0 && row.side !== "mark";
  const sideClass = row.side === "sell" ? "text-loss" : row.side === "mark" ? "text-warn" : filled ? "text-profit" : "text-muted";
  return (
    <button type="button" onClick={onOpen} className="rounded-2xl bg-surface px-3 py-3 text-left">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-semibold">
          {row.symbol} <span className={sideClass}>{row.side}</span>
        </span>
        <span className="font-mono text-xs text-faint tabular-nums">{row.pacific}</span>
      </div>
      <p className="mt-1 font-mono text-xs text-muted">
        {row.rule} · {row.paperSize > 0 ? money(row.paperSize) : "$0"} · {priceText(row.paperPrice)}
      </p>
      <p className="mt-1 break-all font-mono text-[11px] leading-4 text-faint">
        {row.mint}
        <br />
        pool {row.pool || "n/a"}
      </p>
      <p className="mt-1 text-sm text-pretty text-fg">{row.why}</p>
    </button>
  );
}

function BotsView() {
  const bots = useDesk((s) => s.bots);
  const paused = useDesk((s) => s.paused);
  const setPaused = useDesk((s) => s.setPaused);
  const settings = useDesk((s) => s.settings);
  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold">Bots</h1>
        <p className="mt-1 text-sm text-muted">They only talk through the book. A paper buy needs all five.</p>
      </header>
      <BotCard
        name="Scanner"
        tone="accent"
        stat={`${bots.scanner.seen} read · ${bots.scanner.killed} killed · ${bots.scanner.passed} passed`}
        line={bots.scanner.line}
      />
      <BotCard
        name="Analyst"
        tone="accent"
        stat={`${bots.analyst.taken} scored · pass at ${settings.passScore}`}
        line={bots.analyst.line}
      />
      <BotCard name="Brain" tone="muted" stat="Size locked" line={bots.brain.line} />
      <BotCard
        name="Executor"
        tone="warn"
        stat={`${bots.executor.waiting} waiting`}
        line={bots.executor.line}
      />
      <BotCard
        name="Risk"
        tone={bots.risk.blocked ? "loss" : "profit"}
        stat={`Stop -${settings.stopPct}% · trail ${settings.trailPct}%`}
        line={bots.risk.line}
      />
      <button
        type="button"
        onClick={() => setPaused(!paused)}
        className="min-h-12 rounded-2xl bg-surface px-4 text-left text-sm"
      >
        <span className="font-medium">{paused ? "Resume new paper tickets" : "Pause new paper tickets"}</span>
        <span className="mt-1 block text-muted">
          {paused ? "Paused. Open paper stops still run." : "Risk keeps guarding either way. Pause only blocks new paper buys."}
        </span>
      </button>
    </div>
  );
}

function BotCard({
  name,
  stat,
  line,
  tone,
}: {
  name: string;
  stat: string;
  line: string;
  tone: "accent" | "warn" | "profit" | "loss" | "muted";
}) {
  const toneClass = {
    accent: "text-accent",
    warn: "text-warn",
    profit: "text-profit",
    loss: "text-loss",
    muted: "text-muted",
  }[tone];
  return (
    <article className="rounded-2xl bg-surface p-4">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className={`font-medium ${toneClass}`}>{name}</h2>
        <Shield className={`size-4 ${toneClass}`} />
      </div>
      <p className="mt-2 font-mono text-xs text-muted">{stat}</p>
      <p className="mt-2 text-sm text-pretty">{line}</p>
    </article>
  );
}

function logText(log: LogRow[]): string {
  const lines = ["PAPER. No orders sent."];
  lines.push("time\tmint\tpool\tmarket cap\tliquidity\trule\tside\tpaper size\tpaper price\twhy");
  for (const row of [...log].reverse()) {
    lines.push(
      [
        row.pacific,
        row.mint,
        row.pool || "n/a",
        row.marketCap ?? "n/a",
        row.liquidity ?? "n/a",
        row.rule,
        row.side,
        row.paperSize,
        row.paperPrice ?? "no price",
        row.why,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function writeClipboard(text: string): boolean {
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.focus();
  area.select();
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  document.body.removeChild(area);
  return ok;
}

function LogView({ onOpen }: { onOpen: (mint: string) => void }) {
  const log = useDesk((s) => s.log);
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  function copy() {
    const text = logText(log);
    const ok = writeClipboard(text);
    setCopied(ok);
    setBlocked(true);
    window.setTimeout(() => {
      box.current?.focus();
      box.current?.select();
    }, 0);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Log</h1>
          <p className="mt-1 font-mono text-sm text-warn">PAPER. No orders sent.</p>
        </div>
        <button
          type="button"
          onClick={copy}
          className="flex min-h-11 items-center gap-2 rounded-full bg-surface px-3 text-sm"
        >
          <Copy className="size-4" />
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <p className="text-sm text-muted">
        Pacific time, the full mint, and the pool address are on every row. A buy fills the deepest pool’s current price. Size is $10 on a paper buy and $0 when the coin is skipped. Results are after 1.5% each side. Missing prices stay “no price”.
      </p>
      {blocked ? (
        <textarea
          ref={box}
          readOnly
          value={logText(log)}
          className="h-64 w-full rounded-2xl bg-surface p-3 font-mono text-xs"
        />
      ) : null}
      {blocked ? (
        <p className="text-sm text-warn">
          {copied ? "Copied. If paste is empty, click the box and press Ctrl+C." : "Click the box, press Ctrl+C, then paste."}
        </p>
      ) : null}
      {log.length === 0 ? (
        <Empty>No rows yet. The first scan writes a row for every coin it kills, queues, or marks.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {log.map((row) => (
            <LogCard
              key={row.id}
              row={row}
              onOpen={() => {
                if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(row.mint)) onOpen(row.mint);
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function tradeText(trades: Fill[]): string {
  const lines = [
    "PAPER. No orders sent.",
    "Earlier realized gain: no record.",
    "time\tcoin\tmint\tpool\treason\tprice\tcash\tafter-cost pnl",
  ];
  for (const trade of [...trades].reverse()) {
    lines.push(
      [
        trade.pacific,
        trade.symbol,
        trade.mint,
        trade.pool,
        trade.reason,
        trade.price,
        trade.cash,
        trade.pnl == null ? "n/a" : trade.pnl,
      ].join("\t"),
    );
  }
  return lines.join("\n");
}

function TradesView() {
  const trades = useDesk((s) => s.trades ?? []);
  const priorGap = useDesk((s) => s.priorGap);
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const box = useRef<HTMLTextAreaElement>(null);

  function copy() {
    const ok = writeClipboard(tradeText(trades));
    setCopied(ok);
    setBlocked(true);
    window.setTimeout(() => {
      box.current?.focus();
      box.current?.select();
    }, 0);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Trades</h1>
          <p className="mt-1 font-mono text-sm text-warn">PAPER. No orders sent.</p>
        </div>
        <button
          type="button"
          onClick={copy}
          className="flex min-h-11 items-center gap-2 rounded-full bg-surface px-3 text-sm"
        >
          <Copy className="size-4" />
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <p className="text-sm text-muted">
        Only real paper buys and sells. These rows are never deleted. Dip waits are not listed. A buy shows the $10 cash out. A sell shows the cash returned after 1.5% each side.
      </p>
      {priorGap === "no record" ? (
        <p className="rounded-2xl bg-surface px-3 py-4 text-sm text-warn">Earlier realized gain: no record.</p>
      ) : null}
      {blocked ? (
        <textarea
          ref={box}
          readOnly
          value={tradeText(trades)}
          className="h-64 w-full rounded-2xl bg-surface p-3 font-mono text-xs"
        />
      ) : null}
      {blocked ? (
        <p className="text-sm text-warn">
          {copied ? "Copied. If paste is empty, click the box and press Ctrl+C." : "Click the box, press Ctrl+C, then paste."}
        </p>
      ) : null}
      {trades.length === 0 ? (
        <Empty>No fills yet. The next paper buy or sell is the first row.</Empty>
      ) : (
        <div className="flex flex-col gap-2">
          {trades.map((trade) => (
            <article key={trade.id} className="rounded-2xl bg-surface p-3">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-semibold">{trade.symbol}</span>
                <span className="font-mono text-xs text-muted">{trade.reason}</span>
              </div>
              <p className="mt-1 font-mono text-xs text-faint">{trade.pacific}</p>
              <p className="mt-2 font-mono text-sm">
                {priceText(trade.price)} · cash {trade.cash >= 0 ? "+" : ""}
                {money(trade.cash)}
                {trade.pnl == null ? "" : ` · after-cost ${trade.pnl >= 0 ? "+" : ""}${money(trade.pnl)}`}
              </p>
              <p className="mt-1 break-all font-mono text-xs text-faint">{trade.mint}</p>
              <p className="break-all font-mono text-xs text-faint">pool {trade.pool}</p>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function AccountView() {
  const settings = useDesk((s) => s.settings);
  const tradesTonight = useDesk((s) => s.tradesTonight);
  const openCount = useDesk((s) => s.positions.length);
  const patch = useDesk((s) => s.patchSettings);
  const locked = useDesk((s) => s.locked !== false);
  const setLocked = useDesk((s) => s.setLocked);
  const [phrase, setPhrase] = useState("");
  const [miss, setMiss] = useState(false);

  function tryUnlock() {
    if (phrase.trim().toLowerCase() === "unlock") {
      setLocked(false);
      setPhrase("");
      setMiss(false);
      return;
    }
    setMiss(true);
  }

  return (
    <div className="flex flex-col gap-5">
      <header>
        <h1 className="text-2xl font-semibold">Account</h1>
        <p className="mt-1 text-sm text-muted">Imaginary $100. The live switch does not exist here on purpose.</p>
      </header>
      <section className="rounded-2xl bg-surface p-4">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Mode</p>
            <p className="text-xs text-muted">Live stays off. This desk cannot connect a wallet.</p>
          </div>
          <span className="rounded-full bg-warn px-3 py-1 font-mono text-xs text-bg">PAPER</span>
        </div>
        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-line pt-4 font-mono text-sm">
          <Stat label="Book" value="$100" />
          <Stat label="Ticket" value="$10" />
          <Stat label="Trades tonight" value={String(tradesTonight)} />
          <Stat label="Open" value={String(openCount)} />
        </div>
      </section>
      <section>
        <h2 className="mb-1 text-sm font-medium text-muted">{locked ? "Rules are frozen" : "Rules are unlocked"}</h2>
        <div className="rounded-2xl bg-surface px-3">
          <Stepper
            disabled={locked}            label="Min liquidity"
            hint="Scanner kills thinner pools"
            value={compactUsd(settings.minLiquidity)}
            onDec={() => patch({ minLiquidity: clampStep(settings.minLiquidity - 5000, 0, 250000) })}
            onInc={() => patch({ minLiquidity: clampStep(settings.minLiquidity + 5000, 0, 250000) })}
          />
          <Stepper
            disabled={locked}            label="Max market cap"
            hint="Ceiling for a trench coin"
            value={compactUsd(settings.maxMarketCap)}
            onDec={() => patch({ maxMarketCap: clampStep(settings.maxMarketCap - 500000, 100000, 50000000) })}
            onInc={() => patch({ maxMarketCap: clampStep(settings.maxMarketCap + 500000, 100000, 50000000) })}
          />
          <Stepper
            disabled={locked}            label="Analyst pass"
            hint="Green at this score or better"
            value={String(settings.passScore)}
            onDec={() => patch({ passScore: clampStep(settings.passScore - 5, 40, 95) })}
            onInc={() => patch({ passScore: clampStep(settings.passScore + 5, 40, 95) })}
          />
          <Stepper
            disabled={locked}            label="Dip wait"
            hint="Off the high since it cleared"
            value={`${settings.dipPct}%`}
            onDec={() => patch({ dipPct: clampStep(settings.dipPct - 5, 5, 40) })}
            onInc={() => patch({ dipPct: clampStep(settings.dipPct + 5, 5, 40) })}
          />
          <Stepper
            disabled={locked}            label="Hard stop"
            hint="Triggers on the market move. The fill is the price just read."
            value={`${settings.stopPct}%`}
            onDec={() => patch({ stopPct: clampStep(settings.stopPct - 5, 10, 60) })}
            onInc={() => patch({ stopPct: clampStep(settings.stopPct + 5, 10, 60) })}
          />
          <Stepper
            disabled={locked}            label="Trail"
            hint="Arms after this gain, then gives back the same percent"
            value={`${settings.trailPct}%`}
            onDec={() => patch({ trailPct: clampStep(settings.trailPct - 5, 15, 70) })}
            onInc={() => patch({ trailPct: clampStep(settings.trailPct + 5, 15, 70) })}
          />
          <Stepper
            disabled={locked}            label="Max tickets tonight"
            hint="High scores still buy until cash, 4 open, or the night loss stop"
            value={String(settings.maxTrades)}
            onDec={() => patch({ maxTrades: clampStep(settings.maxTrades - 1, 1, 40) })}
            onInc={() => patch({ maxTrades: clampStep(settings.maxTrades + 1, 1, 40) })}
          />
          <Stepper
            disabled={locked}            label="Max open"
            value={String(settings.maxOpen)}
            onDec={() => patch({ maxOpen: clampStep(settings.maxOpen - 1, 1, 8) })}
            onInc={() => patch({ maxOpen: clampStep(settings.maxOpen + 1, 1, 8) })}
          />
          <Stepper
            disabled={locked}            label="Night loss stop"
            hint="No new tickets after this drawdown"
            value={money(settings.nightLossStop, 0)}
            onDec={() => patch({ nightLossStop: clampStep(settings.nightLossStop - 5, 10, 80) })}
            onInc={() => patch({ nightLossStop: clampStep(settings.nightLossStop + 5, 10, 80) })}
          />
        </div>
      </section>
      {locked ? (
        <form
          className="rounded-2xl bg-surface p-4"
          onSubmit={(event) => {
            event.preventDefault();
            tryUnlock();
          }}
        >
          <p className="text-sm">Type unlock to change the rules. There is no reset.</p>
          <div className="mt-3 flex gap-2">
            <input
              value={phrase}
              onChange={(event) => {
                setPhrase(event.target.value);
                setMiss(false);
              }}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              aria-label="Type unlock"
              placeholder="unlock"
              className="min-h-12 flex-1 rounded-2xl bg-surface-2 px-3 text-sm"
            />
            <button type="submit" className="min-h-12 rounded-2xl bg-surface-2 px-4 text-sm">
              Check
            </button>
          </div>
          {miss ? <p className="mt-2 text-xs text-loss">That was not unlock. Rules stay frozen.</p> : null}
        </form>
      ) : (
        <button type="button" onClick={() => setLocked(true)} className="min-h-12 rounded-2xl bg-surface px-4 text-left text-sm">
          <span className="font-medium">Freeze the rules again</span>
          <span className="mt-1 block text-muted">This does not wipe the book.</span>
        </button>
      )}
      <p className="text-xs text-pretty text-faint">
        Every paper buy takes 1.5% and every paper sell takes 1.5%. The balance and each PnL are after those costs. A stop or trail closes at the price just read, even when that is far past the line. Social and wallet checks stay off because there is no FOMO session.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-faint">{label}</p>
      <p className="tabular-nums">{value}</p>
    </div>
  );
}

function Stepper({
  label,
  hint,
  value,
  disabled,
  onDec,
  onInc,
}: {
  label: string;
  hint?: string;
  value: string;
  disabled?: boolean;
  onDec: () => void;
  onInc: () => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line py-3 last:border-b-0">
      <div className="min-w-0">
        <p className="text-sm">{label}</p>
        {hint ? <p className="text-xs text-pretty text-faint">{hint}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          aria-label={`Decrease ${label}`}
          disabled={disabled}
          onClick={onDec}
          className="flex size-11 items-center justify-center rounded-full bg-surface-2 disabled:opacity-40"
        >
          <Minus className="size-4" />
        </button>
        <span className="w-16 text-center font-mono text-xs tabular-nums">{value}</span>
        <button
          type="button"
          aria-label={`Increase ${label}`}
          disabled={disabled}
          onClick={onInc}
          className="flex size-11 items-center justify-center rounded-full bg-surface-2 disabled:opacity-40"
        >
          <Plus className="size-4" />
        </button>
      </div>
    </div>
  );
}

function clampStep(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function CoinSheet({ mint, onClose }: { mint: string; onClose: () => void }) {
  const quote = useDesk((s) => s.tape[mint]);
  const score = useDesk((s) => s.scores[mint]);
  const prints = useDesk((s) => s.prints[mint]);
  const position = useDesk((s) => s.positions.find((p) => p.mint === mint));
  const watch = useDesk((s) => s.watches.find((w) => w.mint === mint));
  const log = useDesk((s) => s.log);
  const flatten = useDesk((s) => s.flatten);
  const series = prints ?? EMPTY_PRINTS;
  const rows = log.filter((row) => row.mint === mint);
  const now = Date.now();
  const symbol = position?.symbol ?? watch?.symbol ?? quote?.symbol ?? rows[0]?.symbol ?? "Coin";
  const name = position?.name ?? watch?.name ?? quote?.name ?? rows[0]?.name ?? "";
  const price = position?.lastPrice ?? watch?.lastPrice ?? quote?.priceUsd ?? null;
  const created = position?.pairCreatedAt ?? watch?.pairCreatedAt ?? quote?.pairCreatedAt ?? null;
  const url = position?.url ?? watch?.url ?? quote?.url;
  const dex = position?.dex ?? watch?.dex ?? quote?.dex ?? "solana";
  const mcap = position?.marketCap ?? watch?.marketCap ?? quote?.marketCap ?? null;
  const liq = position?.liquidity ?? watch?.liquidity ?? quote?.liquidityUsd ?? null;

  const up =
    position?.lastPrice != null ? position.lastPrice >= position.entryPrice : series.length > 1 ? series[series.length - 1].p >= series[0].p : true;

  return (
    <div className="fixed inset-0 z-20 overflow-y-auto bg-bg">
      <div className="mx-auto min-h-screen max-w-3xl px-4 pt-4 pb-16">
        <button type="button" onClick={onClose} className="flex min-h-11 items-center gap-1 text-sm text-accent">
          <ChevronLeft className="size-4" />
          Back
        </button>
        <p className="mt-2 text-sm text-muted">
          {name} · {dex} · {ageLabel(created, now)}
        </p>
        <div className="mt-1 flex items-end justify-between gap-3">
          <h1 className="text-3xl font-semibold">{symbol}</h1>
          <span className="rounded-full bg-surface px-3 py-1 text-xs text-muted">Public tape only</span>
        </div>
        <p className="mt-3 font-mono text-4xl font-semibold tabular-nums">{priceText(price)}</p>
        {position ? (
          <p className={`mt-1 font-mono text-sm tabular-nums ${pnlClass(positionValue(position) - position.sizeUsd)}`}>
            {signedMoney(positionValue(position) - position.sizeUsd)} on {money(position.sizeUsd, 0)} paper, after 1.5% each side
          </p>
        ) : null}
        <div className="mt-4 h-36 rounded-2xl bg-surface px-2 py-3">
          {series.length < 2 ? (
            <p className="px-2 text-sm text-muted">
              {price == null ? "No live price on this coin." : "One live print. The line shows up on the next read. Nothing is drawn in."}
            </p>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={series.map((p) => ({ t: p.t, p: p.p }))}>
                <YAxis hide domain={["dataMin", "dataMax"]} />
                <Line
                  type="monotone"
                  dataKey="p"
                  dot={false}
                  strokeWidth={2}
                  stroke={up ? "var(--color-profit)" : "var(--color-loss)"}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-surface p-3">
            <p className="text-xs text-faint">Market cap</p>
            <p className="font-mono tabular-nums">{compactUsd(mcap)}</p>
          </div>
          <div className="rounded-2xl bg-surface p-3">
            <p className="text-xs text-faint">Liquidity</p>
            <p className="font-mono tabular-nums">{compactUsd(liq)}</p>
          </div>
        </div>
        {score ? (
          <section className="mt-3 rounded-2xl bg-surface p-4">
            <div className="flex items-baseline justify-between">
              <h2 className="text-sm font-medium">Analyst</h2>
              <span className={`font-mono tabular-nums ${score.total >= 70 ? "text-profit" : "text-loss"}`}>{score.total}</span>
            </div>
            <div className="mt-3 flex flex-col gap-2">
              {score.layers.map((layer) => (
                <div key={layer.name}>
                  <div className="flex justify-between text-xs text-muted">
                    <span>{layer.name}</span>
                    <span className="tabular-nums">
                      {layer.points}/{layer.max}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-surface-2">
                    <div
                      className={layer.points >= 16 ? "h-full bg-profit" : "h-full bg-faint"}
                      style={{ width: `${(layer.points / layer.max) * 100}%` }}
                    />
                  </div>
                  <p className="mt-1 text-xs text-faint">{layer.note}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        <div className="mt-3 flex flex-col gap-2">
          {url ? (
            <a
              href={url}
              target="_blank"
              rel="noreferrer"
              className="flex min-h-12 items-center justify-between rounded-2xl bg-surface px-4 text-sm"
            >
              Chart on DexScreener
              <ExternalLink className="size-4 text-muted" />
            </a>
          ) : null}
          {position ? (
            <button
              type="button"
              disabled={position.lastPrice == null}
              onClick={() => flatten(position.mint)}
              className="min-h-12 rounded-2xl bg-loss px-4 text-left text-sm font-medium text-bg disabled:opacity-50"
            >
              Paper flatten
              <span className="mt-1 block font-normal text-bg/80">Writes a sell row. Does not click Sell.</span>
            </button>
          ) : null}
        </div>
        <section className="mt-4">
          <h2 className="mb-2 text-sm text-muted">Rows for this mint</h2>
          <div className="flex flex-col gap-2">
            {rows.map((row) => (
              <article key={row.id} className="rounded-2xl bg-surface px-3 py-3">
                <p className="font-mono text-xs text-faint">{row.pacific}</p>
                <p className="mt-1 text-sm">{row.why}</p>
              </article>
            ))}
          </div>
        </section>
        <p className="mt-4 break-all font-mono text-xs text-faint">
          {mint}
          {quote?.pool || position?.pool ? (
            <>
              <br />
              pool {quote?.pool || position?.pool}
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

function scanAgo(at: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (seconds < 20) return "just now";
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}
