// A made-up market that answers the three GeckoTerminal calls the desk uses,
// in the same JSON shape as the real feed (checked against saved real answers).
// It exists so the tests can run thousands of minutes in a second, the same way
// every time. Prices here mean nothing. Only the comparisons between desks do.

export const clock = { t: 0 };

/** Make Date.now() follow the test clock. market.ts and the runner both read the time that way. */
export function useTestClock() {
  Date.now = () => clock.t;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const OTHER = {
  SOL: { mint: "So11111111111111111111111111111111111111112", price: 150 },
  USDC: { mint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", price: 1 },
};

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand) {
  let u = 0;
  while (u === 0) u = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

function poisson(rand, lambda) {
  const floor = Math.exp(-lambda);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= rand();
  } while (p > floor && k < 80);
  return k - 1;
}

function address(rand) {
  let s = "";
  for (let i = 0; i < 44; i += 1) s += B58[Math.floor(rand() * 58)];
  return s;
}

function hash01(a, b) {
  let h = (Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 7, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return h / 4294967296;
}

/** How many entries of a sorted list are <= x. */
function upto(list, x) {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid] <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function isoSec(sec) {
  return new Date(sec * 1000).toISOString().replace(".000Z", "Z");
}

function makeToken(rand, index, startSec, minutes) {
  const mint = address(rand);
  const p0 = 10 ** (-6 + 4 * rand());
  const supply = 10 ** (4 + 3.1 * rand()) / p0;
  const liq0 = 10 ** (3.9 + 1.7 * rand());
  const lambda = 10 ** (-0.4 + 1.6 * rand());
  const sigma = 0.012 + 0.045 * rand();
  const mu = (rand() - 0.5) * 0.003;
  const buyP = 0.42 + 0.3 * rand();
  const rugMin = rand() < 0.18 ? Math.floor(rand() * minutes) : Infinity;
  const pumpMin = rand() < 0.35 ? Math.floor(rand() * minutes) : Infinity;
  const hasMcap = rand() < 0.7;
  const createdSec = startSec - Math.floor(rand() * 40 * 86400);
  const poolCount = 1 + Math.floor(rand() * 3);
  const pools = [];
  for (let j = 0; j < poolCount; j += 1) {
    pools.push({
      address: address(rand),
      factor: 1 + (rand() - 0.5) * 0.01, // each pool trades a hair away from the others
      weightA: 0.2 + rand(),
      weightB: 0.2 + rand(),
      switchSec: startSec + Math.floor(rand() * minutes * 60), // the deepest pool can change
      side: rand() < 0.15 ? "quote" : "base", // sometimes the coin is the second name in the pair
      other: rand() < 0.85 ? "SOL" : "USDC",
      dex: ["pumpswap", "raydium", "meteora"][Math.floor(rand() * 3)],
    });
  }
  const tSec = [];
  const price = [];
  const usdAt = [];
  const cumUsd = [0];
  const cumBuys = [0];
  const cumSells = [0];
  let p = p0;
  for (let m = 0; m < minutes; m += 1) {
    let step = mu + sigma * gauss(rand);
    if (m === rugMin) step += Math.log(0.12 + 0.2 * rand());
    if (m >= pumpMin && m < pumpMin + 45) step += 0.025;
    p *= Math.exp(step);
    const count = poisson(rand, lambda);
    const offsets = [];
    for (let q = 0; q < count; q += 1) offsets.push(Math.floor(rand() * 60));
    offsets.sort((x, y) => x - y);
    for (const off of offsets) {
      const isBuy = rand() < buyP;
      const usd = liq0 * 0.002 * (0.2 + 3 * rand());
      tSec.push(startSec + m * 60 + off);
      price.push(p * Math.exp(0.004 * gauss(rand)));
      usdAt.push(usd);
      cumUsd.push(cumUsd[cumUsd.length - 1] + usd);
      cumBuys.push(cumBuys[cumBuys.length - 1] + (isBuy ? 1 : 0));
      cumSells.push(cumSells[cumSells.length - 1] + (isBuy ? 0 : 1));
    }
  }
  const tok = { index, mint, symbol: `T${index}`, supply, hasMcap, createdSec, pools, tSec, price, usdAt };
  tok.spot = (t) => {
    const k = upto(tSec, t);
    return k === 0 ? p0 : price[k - 1];
  };
  tok.window = (t, width) => {
    const a = upto(tSec, t - width);
    const b = upto(tSec, t);
    return { usd: cumUsd[b] - cumUsd[a], buys: cumBuys[b] - cumBuys[a], sells: cumSells[b] - cumSells[a] };
  };
  tok.change = (t, width) => (tok.spot(t) / tok.spot(t - width) - 1) * 100;
  tok.liquidity = (t) => liq0 * Math.sqrt(tok.spot(t) / p0) * (t >= startSec + rugMin * 60 ? 0.05 : 1);
  tok.share = (pool, t) => {
    let total = 0;
    for (const other of pools) total += t < other.switchSec ? other.weightA : other.weightB;
    return (t < pool.switchSec ? pool.weightA : pool.weightB) / total;
  };
  return tok;
}

function poolItem(tok, pool, t) {
  const spot = tok.spot(t) * pool.factor;
  const other = OTHER[pool.other];
  const coinIsBase = pool.side === "base";
  const h1 = tok.window(t, 3600);
  const m5 = tok.window(t, 300);
  // The real feed reports market cap for the FIRST coin in the pair, so a pair
  // listed the other way round carries the other coin's (huge) figure.
  const fdv = coinIsBase ? spot * tok.supply : 80e9;
  return {
    id: `solana_${pool.address}`,
    type: "pool",
    attributes: {
      base_token_price_usd: String(coinIsBase ? spot : other.price),
      base_token_price_native_currency: "0",
      quote_token_price_usd: String(coinIsBase ? other.price : spot),
      quote_token_price_native_currency: "0",
      base_token_price_quote_token: "0",
      quote_token_price_base_token: "0",
      address: pool.address,
      name: coinIsBase ? `${tok.symbol} / ${pool.other}` : `${pool.other} / ${tok.symbol}`,
      pool_created_at: isoSec(tok.createdSec),
      fdv_usd: String(fdv),
      market_cap_usd: coinIsBase && tok.hasMcap ? String(fdv) : null,
      price_change_percentage: { m5: String(tok.change(t, 300)), h1: String(tok.change(t, 3600)) },
      transactions: {
        m5: { buys: m5.buys, sells: m5.sells, buyers: m5.buys, sellers: m5.sells },
        h1: { buys: h1.buys, sells: h1.sells, buyers: h1.buys, sellers: h1.sells },
      },
      volume_usd: { m5: String(m5.usd), h1: String(h1.usd) },
      reserve_in_usd: String(tok.liquidity(t) * tok.share(pool, t)),
    },
    relationships: {
      base_token: { data: { id: `solana_${coinIsBase ? tok.mint : other.mint}`, type: "token" } },
      quote_token: { data: { id: `solana_${coinIsBase ? other.mint : tok.mint}`, type: "token" } },
      dex: { data: { id: pool.dex, type: "dex" } },
    },
  };
}

export function makeMarket({ seed = 1, tokens = 36, startMs, minutes, beforeInclusive = false, skew = null }) {
  const rand = rng(seed);
  const startSec = Math.floor(startMs / 1000);
  const list = [];
  for (let i = 0; i < tokens; i += 1) list.push(makeToken(rand, i, startSec, minutes));
  const byMint = new Map(list.map((tok) => [tok.mint, tok]));
  const byPool = new Map();
  for (const tok of list) for (const pool of tok.pools) byPool.set(pool.address, { tok, pool });

  // `skew` makes the candle call lie on purpose (test G): candles labelled a
  // minute late, or priced without the pool's own offset. The live calls and
  // the ground truth stay honest, so a desk that trusts the skewed candles
  // must end up with a different book.
  const market = { list, byMint, byPool, calls: 0, fail: null, beforeInclusive, skew };

  market.trending = (t) => {
    const epoch = Math.floor(t / 600);
    const ranked = list
      .map((tok) => ({ tok, score: tok.window(t, 3600).usd * (0.4 + hash01(tok.index, epoch)) }))
      .sort((x, y) => y.score - x.score)
      .slice(0, 20);
    const out = [];
    ranked.forEach(({ tok }, rank) => {
      const j = Math.floor(hash01(tok.index * 7 + 3, epoch) * tok.pools.length);
      out.push(poolItem(tok, tok.pools[j], t));
      // now and then the same coin trends through two pools at once
      if (rank % 6 === 0 && tok.pools.length > 1) out.push(poolItem(tok, tok.pools[(j + 1) % tok.pools.length], t));
    });
    return out.slice(0, 20);
  };

  /**
   * Ground truth for the tests, read straight from the trade list and not from
   * any candle: the price of the last trade strictly before `sec` in this pool,
   * however long ago, or null if the coin had not traded yet.
   */
  market.lastTradeBefore = (poolAddress, sec) => {
    const hit = byPool.get(poolAddress);
    if (!hit) return null;
    const { tok, pool } = hit;
    const k = upto(tok.tSec, sec - 0.5);
    return k === 0 ? null : tok.price[k - 1] * pool.factor;
  };

  market.candles = (poolAddress, t, { limit, before, token }) => {
    const hit = byPool.get(poolAddress);
    if (!hit) return null;
    const { tok, pool } = hit;
    const priced =
      token === tok.mint ||
      (token === "base" && pool.side === "base") ||
      (token === "quote" && pool.side === "quote") ||
      (token == null && pool.side === "base");
    const rows = [];
    let cur = null;
    const lateBy = market.skew?.shiftSec ?? 0;
    const factor = market.skew?.flatPool ? 1 : pool.factor;
    for (let k = upto(tok.tSec, t) - 1; k >= 0; k -= 1) {
      const start = Math.floor(tok.tSec[k] / 60) * 60 + lateBy;
      if (before != null && (beforeInclusive ? start > before : start >= before)) continue;
      const px = priced ? tok.price[k] * factor : OTHER[pool.other].price;
      if (!cur || cur[0] !== start) {
        if (cur) rows.push(cur);
        if (rows.length >= limit) {
          cur = null;
          break;
        }
        cur = [start, px, px, px, px, 0]; // walking backwards: the first trade met is the close
      }
      cur[1] = px;
      cur[2] = Math.max(cur[2], px);
      cur[3] = Math.min(cur[3], px);
      cur[5] += tok.usdAt[k];
    }
    if (cur && rows.length < limit) rows.push(cur);
    return rows; // newest first, like the real feed
  };

  return market;
}

function answer(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export function mockFetch(market) {
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    market.calls += 1;
    const t = clock.t / 1000;
    const path = url.pathname.replace("/api/v2", "");
    const forced = market.fail ? market.fail(path, url) : null;
    if (forced === "throw") throw new Error("network down (test)");
    if (forced) return answer(forced, { status: { error_code: forced, error_message: "refused (test)" } });
    let m;
    if (path === "/networks/solana/trending_pools") return answer(200, { data: market.trending(t) });
    if ((m = path.match(/^\/networks\/solana\/tokens\/([^/]+)\/pools$/))) {
      const tok = market.byMint.get(m[1]);
      if (!tok) return answer(404, { errors: [{ status: "404", title: "Not Found" }] });
      return answer(200, { data: tok.pools.map((pool) => poolItem(tok, pool, t)) });
    }
    if ((m = path.match(/^\/networks\/solana\/pools\/([^/]+)\/ohlcv\/minute$/))) {
      const q = url.searchParams;
      const rows = market.candles(m[1], t, {
        limit: Number(q.get("limit") ?? 100),
        before: q.has("before_timestamp") ? Number(q.get("before_timestamp")) : null,
        token: q.get("token"),
      });
      if (!rows) return answer(404, { errors: [{ status: "404", title: "Not Found" }] });
      return answer(200, { data: { id: "x", type: "ohlcv_request_response", attributes: { ohlcv_list: rows } }, meta: {} });
    }
    return answer(404, { errors: [{ status: "404", title: "Not Found" }] });
  };
}
