import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Quote } from "@/lib/market";
import {
  DEFAULT_SETTINGS,
  equityOf,
  manualFlatten,
  noteResume,
  PAUSE_MS,
  pacificDateKey,
  runDesk,
  type Book,
  type BotSnap,
  type LogRow,
  type Position,
  type ScoreCard,
  type Settings,
  type Watch,
} from "@/lib/strategy";

type Print = { t: number; p: number };

type DeskState = Book & {
  tape: Record<string, Quote>;
  scores: Record<string, ScoreCard>;
  prints: Record<string, Print[]>;
  bots: BotSnap;
  scanning: boolean;
  error: string | null;
  lastScanAt: number | null;
  locked: boolean;
  ingest: (quotes: Quote[], at: number, error: string | null) => void;
  setScanning: (scanning: boolean) => void;
  setPaused: (paused: boolean) => void;
  setLocked: (locked: boolean) => void;
  patchSettings: (patch: Partial<Settings>) => void;
  flatten: (mint: string) => void;
};

const emptyBots: BotSnap = {
  scanner: { seen: 0, killed: 0, passed: 0, line: "Waiting for the first read." },
  analyst: { taken: 0, passed: 0, line: "Idle until a coin clears the scanner." },
  brain: { line: "Ticket locked at $10." },
  executor: { waiting: 0, line: "Idle. Buy and Sell stay unclicked." },
  risk: { blocked: false, line: "Guarding. Stop -25%. Trail 40%." },
};

function freshBook(): Book {
  return {
    cash: 100,
    positions: [],
    watches: [],
    log: [],
    trades: [],
    priorGap: null,
    lastSig: {},
    tradesTonight: 0,
    nightKey: pacificDateKey(Date.now()),
    nightStartEquity: 100,
    paused: false,
    settings: DEFAULT_SETTINGS,
  };
}

export const useDesk = create<DeskState>()(
  persist(
    (set, get) => ({
      ...freshBook(),
      tape: {},
      scores: {},
      prints: {},
      bots: emptyBots,
      scanning: false,
      error: null,
      lastScanAt: null,
      locked: true,
      setScanning: (scanning) => set({ scanning }),
      setPaused: (paused) => set({ paused }),
      setLocked: (locked) => set({ locked }),
      patchSettings: (patch) => {
        if (get().locked !== false) return;
        set({ settings: { ...get().settings, ...patch, ticketUsd: 10 } });
      },
      flatten: (mint) => {
        const next = manualFlatten(get(), mint, Date.now());
        if (next) set(next);
      },
      ingest: (quotes, at, error) => {
        const cur = get();
        if (error && quotes.length === 0) {
          set({ error, scanning: false });
          return;
        }
        const source =
          cur.lastScanAt != null && at - cur.lastScanAt >= PAUSE_MS
            ? noteResume(cur, quotes, at, cur.lastScanAt)
            : cur;
        const result = runDesk(source, quotes, at);
        const prints = { ...cur.prints };
        for (const q of quotes) {
          if (q.priceUsd == null) continue;
          const prev = prints[q.mint] ?? [];
          const last = prev[prev.length - 1];
          if (last && last.p === q.priceUsd) continue;
          prints[q.mint] = [...prev, { t: at, p: q.priceUsd }].slice(-36);
        }
        const tape = { ...cur.tape, ...result.tape };
        set({
          ...result.book,
          tape,
          scores: { ...cur.scores, ...result.scores },
          prints,
          bots: result.bots,
          error,
          scanning: false,
          lastScanAt: at,
        });
      },
    }),
    {
      name: "paper-desk-v1",
      skipHydration: true,
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<DeskState>;
        const next = { ...current, ...saved };
        const savedSettings = saved.settings ?? current.settings;
        const maxTrades = savedSettings.maxTrades <= 6 ? 20 : savedSettings.maxTrades;
        next.settings = { ...DEFAULT_SETTINGS, ...savedSettings, maxTrades, ticketUsd: 10 };
        if (!Array.isArray(saved.trades)) {
          next.trades = [];
          next.priorGap = "no record";
        }
        return next;
      },
      partialize: (s) => ({
        cash: s.cash,
        positions: s.positions,
        watches: s.watches,
        log: s.log,
        trades: s.trades,
        priorGap: s.priorGap,
        lastSig: s.lastSig,
        tradesTonight: s.tradesTonight,
        nightKey: s.nightKey,
        nightStartEquity: s.nightStartEquity,
        paused: s.paused,
        settings: s.settings,
        locked: s.locked,
        lastScanAt: s.lastScanAt,
      }),
    },
  ),
);

export function useEquity(): number {
  return useDesk((s) => equityOf(s));
}

export type { LogRow, Position, Watch, Settings };
