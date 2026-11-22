// Run by hand (workflow "lag"). Measures how long after a minute ends the public
// feed keeps changing that minute's one-minute candle. The runner's wait
// (SETTLE_MS in desk.mjs) is set from this. Reads public prices only.
//
// Usage: node tests/candlelag.mjs <which busy pool: 0, 1, 2 ...> [rounds=2]
//
// For each round: pick a minute boundary, then ask for that pool's candles at
// several moments after it and once more much later. Each answer is compared
// with the last one: was the minute that had just ended already final?

const GT = "https://api.geckoterminal.com/api/v2";
const OFFSETS = [20, 45, 75, 105, 135, 165, 195, 240, 300]; // seconds after the minute ended
const FINAL = 480; // the answer taken as final
const ROUND_GAP = 240; // seconds between the rounds' boundaries
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function get(url) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    let res = null;
    try {
      res = await fetch(url, { headers: { accept: "application/json", "user-agent": "PaperDesk/1.0" }, signal: AbortSignal.timeout(15_000) });
    } catch {
      res = null;
    }
    if (res && res.ok) return res.json();
    await sleep(7000 * (attempt + 1));
  }
  return null;
}

async function look(pool, mint, boundary, limit) {
  const doc = await get(`${GT}/networks/solana/pools/${pool}/ohlcv/minute?aggregate=1&limit=${limit}&before_timestamp=${boundary}&currency=usd&token=${mint}`);
  const after = Math.round(Date.now() / 1000 - boundary);
  const rows = doc?.data?.attributes?.ohlcv_list;
  if (!Array.isArray(rows)) return { after, failed: true };
  const row = rows.find((r) => Number(r[0]) === boundary - 60);
  return {
    after,
    present: !!row,
    close: row ? Number(row[4]) : null,
    volume: row ? Number(row[5]) : null,
    later: rows.some((r) => Number(r[0]) >= boundary), // the feed already shows a trade after the minute ended
  };
}

async function round(pool, boundary, tag) {
  const seen = [];
  for (let i = 0; i < OFFSETS.length; i += 1) {
    const wait = (boundary + OFFSETS[i]) * 1000 - Date.now();
    if (wait > 0) await sleep(wait);
    seen.push(await look(pool.address, pool.mint, boundary, 3 + i));
  }
  const wait = (boundary + FINAL) * 1000 - Date.now();
  if (wait > 0) await sleep(wait);
  const final = await look(pool.address, pool.mint, boundary, 3 + OFFSETS.length);
  if (final.failed) {
    console.log(`LAG ${tag} | pool ${pool.name} | no final answer; round dropped`);
    return;
  }
  const same = (s) => !s.failed && s.present === final.present && s.close === final.close && s.volume === final.volume;
  let settled = final.after;
  for (let i = seen.length - 1; i >= 0; i -= 1) {
    if (seen[i].failed) continue;
    if (!same(seen[i])) break;
    settled = seen[i].after;
  }
  const marks = seen.map((s) => `+${s.after}s:${s.failed ? "??" : same(s) ? "final" : s.present ? "NOT" : "absent"}${s.later ? "*" : ""}`).join(" ");
  const moved = seen.filter((s) => !s.failed && s.present && final.close && s.close !== final.close).map((s) => Math.abs(s.close / final.close - 1) * 100);
  console.log(
    `LAG ${tag} | ${pool.name} (${pool.count} trades in 5 min) | minute ending ${new Date(boundary * 1000).toISOString().slice(11, 19)}Z | ${marks} | ` +
      `final from +${settled}s | largest price gap before final ${moved.length ? Math.max(...moved).toFixed(3) : "0"}% | traded in that minute: ${final.present ? `$${Math.round(final.volume)}` : "nothing"}`,
  );
}

const which = Number(process.argv[2] ?? 0);
const rounds = Number(process.argv[3] ?? 2);
const doc = await get(`${GT}/networks/solana/trending_pools?page=1`);
const pools = (doc?.data ?? [])
  .map((item) => {
    const a = item.attributes ?? {};
    const m5 = a.transactions?.m5 ?? {};
    return {
      address: a.address,
      name: a.name,
      mint: String(item.relationships?.base_token?.data?.id ?? "").replace("solana_", ""),
      count: (m5.buys ?? 0) + (m5.sells ?? 0),
    };
  })
  .filter((p) => p.address && p.mint)
  .sort((x, y) => y.count - x.count);
if (pools.length === 0) {
  console.log("LAG | could not read the trending list; nothing measured");
  process.exit(0);
}
const pool = pools[which % pools.length];
const first = (Math.floor(Date.now() / 60_000) + 1) * 60 + (Date.now() % 60_000 > 50_000 ? 60 : 0);
console.log(`measuring pool #${which}: ${pool.name}, ${pool.count} trades in the last 5 minutes. "*" = the feed already showed a later trade.`);
await Promise.all(Array.from({ length: rounds }, (_, k) => round(pool, first + k * ROUND_GAP, `machine ${which} round ${k + 1}`)));
