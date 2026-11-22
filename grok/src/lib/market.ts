import { createServerFn } from "@tanstack/react-start";

export type Quote = {
  mint: string;
  pool: string;
  /** True only when this price came from that mint's deepest pool, not a trending print. */
  confirmedTop: boolean;
  symbol: string;
  name: string;
  priceUsd: number | null;
  marketCap: number | null;
  liquidityUsd: number | null;
  volumeH1: number | null;
  changeM5: number | null;
  changeH1: number | null;
  buysH1: number | null;
  sellsH1: number | null;
  pairCreatedAt: number | null;
  dex: string;
  url: string;
};

const IGNORE = new Set(["USDC", "USDT", "SOL", "WSOL", "USD1", "WETH", "WBTC"]);
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const GT = "https://api.geckoterminal.com/api/v2";

type GtItem = {
  id?: string;
  attributes?: Record<string, unknown>;
  relationships?: {
    base_token?: { data?: { id?: string } };
    quote_token?: { data?: { id?: string } };
    dex?: { data?: { id?: string } };
  };
};

let cache: { at: number; quotes: Quote[] } | null = null;
const poolCache = new Map<string, { at: number; quote: Quote | null }>();

function num(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function mintFromId(id: string | undefined): string | null {
  if (!id) return null;
  const mint = id.startsWith("solana_") ? id.slice("solana_".length) : id;
  return BASE58.test(mint) ? mint : null;
}

function poolAddress(item: GtItem): string | null {
  const attr = item.attributes ?? {};
  if (typeof attr.address === "string" && BASE58.test(attr.address)) return attr.address;
  const id = item.id ?? "";
  const raw = id.startsWith("solana_") ? id.slice("solana_".length) : id;
  return BASE58.test(raw) ? raw : null;
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "PaperDesk/1.0" },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 429) {
    throw new Error("The public tape is rate limited. The next read will try again.");
  }
  if (!res.ok) throw new Error(`Market read failed (${res.status})`);
  return res.json();
}

function quoteFromPool(item: GtItem, onlyMint: string | undefined, confirmedTop: boolean): Quote | null {
  const pool = poolAddress(item);
  if (!pool) return null;
  const attr = item.attributes ?? {};
  const poolName = typeof attr.name === "string" ? attr.name : "";
  const [leftRaw, rightRaw] = poolName.split("/");
  const left = leftRaw?.trim() ?? "";
  const right = rightRaw?.trim() ?? "";
  const sides = [
    {
      mint: mintFromId(item.relationships?.base_token?.data?.id),
      symbol: left,
      price: num(attr.base_token_price_usd),
    },
    {
      mint: mintFromId(item.relationships?.quote_token?.data?.id),
      symbol: right,
      price: num(attr.quote_token_price_usd),
    },
  ];
  const pick = sides.find((side) => {
    if (!side.mint || !side.symbol) return false;
    if (onlyMint && side.mint !== onlyMint) return false;
    if (IGNORE.has(side.symbol.toUpperCase())) return false;
    return true;
  });
  if (!pick || !pick.mint) return null;
  const change = (attr.price_change_percentage ?? {}) as Record<string, unknown>;
  const volume = (attr.volume_usd ?? {}) as Record<string, unknown>;
  const tx = ((attr.transactions ?? {}) as { h1?: { buys?: number; sells?: number } }).h1;
  const created = typeof attr.pool_created_at === "string" ? Date.parse(attr.pool_created_at) : NaN;
  const price = pick.price;
  return {
    mint: pick.mint,
    pool,
    confirmedTop,
    symbol: pick.symbol,
    name: pick.symbol,
    priceUsd: price != null && price > 0 ? price : null,
    marketCap: num(attr.market_cap_usd) ?? num(attr.fdv_usd),
    liquidityUsd: num(attr.reserve_in_usd),
    volumeH1: num(volume.h1),
    changeM5: num(change.m5),
    changeH1: num(change.h1),
    buysH1: num(tx?.buys),
    sellsH1: num(tx?.sells),
    pairCreatedAt: Number.isFinite(created) ? created : null,
    dex: item.relationships?.dex?.data?.id?.replace(/^solana_/, "") || "solana",
    url: `https://dexscreener.com/solana/${pick.mint}`,
  };
}

function keepDeepest(quotes: Quote[]): Quote[] {
  const best = new Map<string, Quote>();
  for (const quote of quotes) {
    const prev = best.get(quote.mint);
    if (!prev || (quote.liquidityUsd ?? -1) > (prev.liquidityUsd ?? -1)) best.set(quote.mint, quote);
  }
  return [...best.values()];
}

async function trending(): Promise<Quote[]> {
  const now = Date.now();
  if (cache && now - cache.at < 50000) return cache.quotes;
  const payload = (await getJson(`${GT}/networks/solana/trending_pools?page=1`)) as { data?: GtItem[] };
  const quotes = keepDeepest(
    (payload.data ?? [])
      .map((item) => quoteFromPool(item, undefined, false))
      .filter((q): q is Quote => q != null),
  );
  cache = { at: now, quotes };
  return quotes;
}

async function topPool(mint: string): Promise<Quote | null> {
  const now = Date.now();
  const hit = poolCache.get(mint);
  if (hit && now - hit.at < 45000) return hit.quote;
  try {
    const payload = (await getJson(`${GT}/networks/solana/tokens/${mint}/pools?page=1`)) as { data?: GtItem[] };
    const quotes = (payload.data ?? [])
      .map((item) => quoteFromPool(item, mint, true))
      .filter((q): q is Quote => q != null && q.priceUsd != null);
    const best = keepDeepest(quotes)[0] ?? null;
    const quote = best ? { ...best, confirmedTop: true } : null;
    poolCache.set(mint, { at: now, quote });
    return quote;
  } catch {
    if (hit) return hit.quote;
    poolCache.set(mint, { at: now, quote: null });
    return null;
  }
}

async function refreshHeld(mints: string[]): Promise<Map<string, Quote>> {
  const out = new Map<string, Quote>();
  const queue = mints.slice(0, 12);
  async function worker() {
    while (queue.length > 0) {
      const mint = queue.shift();
      if (!mint) return;
      const quote = await topPool(mint);
      if (quote) out.set(mint, quote);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  return out;
}

async function loadQuotes(held: string[]): Promise<Quote[]> {
  let base: Quote[] = [];
  try {
    base = await trending();
  } catch (err) {
    if (cache) base = cache.quotes;
    else throw err;
  }
  const byMint = new Map(base.map((q) => [q.mint, q]));
  const tops = await refreshHeld(held);
  for (const [mint, quote] of tops) byMint.set(mint, quote);
  return [...byMint.values()];
}

export const scanMarket = createServerFn({ method: "POST" })
  .validator((input: unknown) => {
    const src = (input ?? {}) as { held?: unknown };
    const held = Array.isArray(src.held)
      ? src.held.filter((v): v is string => typeof v === "string" && BASE58.test(v)).slice(0, 24)
      : [];
    return { held };
  })
  .handler(async ({ data }) => {
    try {
      const quotes = await loadQuotes(data.held);
      return {
        ok: true as const,
        error: quotes.length === 0 ? "No Solana pairs on this read." : null,
        quotes,
        scannedAt: Date.now(),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Market read failed";
      return {
        ok: false as const,
        error: message,
        quotes: [] as Quote[],
        scannedAt: Date.now(),
      };
    }
  });
