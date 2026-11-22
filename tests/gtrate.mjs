// How many keyless calls does the public price feed allow from this machine?
// Run by hand (the "probe" job). It only reads public prices and prints what it sees.

const GT = "https://api.geckoterminal.com/api/v2";
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function get(url) {
  try {
    const res = await fetch(url, { headers: { accept: "application/json", "user-agent": "PaperDesk/1.0" }, signal: AbortSignal.timeout(20000) });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, cache: res.headers.get("cf-cache-status") ?? "-", retryAfter: res.headers.get("retry-after"), body };
  } catch (err) {
    return { status: 0, cache: "-", body: null, error: String(err) };
  }
}

const first = await get(`${GT}/networks/solana/trending_pools?page=1`);
console.log("trending:", first.status, "cache", first.cache, "pools", first.body?.data?.length);
if (first.status !== 200) {
  console.log("the very first call was refused; nothing else to measure");
  process.exit(0);
}
const pools = first.body.data.map((d) => d.attributes.address);
const mints = first.body.data.map((d) => d.relationships.base_token.data.id.replace(/^solana_/, ""));

let serial = 0;
function nextUrl() {
  const k = serial % pools.length;
  const lap = Math.floor(serial / pools.length);
  serial += 1;
  return serial % 2 === 0
    ? `${GT}/networks/solana/pools/${pools[k]}/ohlcv/minute?aggregate=1&limit=${3 + lap}&currency=usd&token=${mints[k]}`
    : `${GT}/networks/solana/tokens/${mints[k]}/pools?page=${1 + lap}`;
}

async function phase(label, gapMs, maxCalls) {
  console.log(`--- ${label}: one call every ${gapMs} ms, up to ${maxCalls}`);
  const t0 = Date.now();
  let good = 0;
  for (let n = 1; n <= maxCalls; n += 1) {
    const url = nextUrl();
    const r = await get(url);
    console.log(`   #${n} t=${((Date.now() - t0) / 1000).toFixed(1)}s status ${r.status} cache ${r.cache}`);
    if (r.status === 200) good += 1;
    if (r.status === 429) {
      console.log(`   refused after ${good} good calls in ${((Date.now() - t0) / 1000).toFixed(1)}s (retry-after: ${r.retryAfter})`);
      const t1 = Date.now();
      for (;;) {
        await sleep(3000);
        const again = await get(url);
        if (again.status !== 429) {
          console.log(`   allowed again after ${Math.round((Date.now() - t1) / 1000)}s`);
          return;
        }
        if (Date.now() - t1 > 120000) {
          console.log("   still refused after 120s");
          return;
        }
      }
    }
    await sleep(gapMs);
  }
  console.log(`   no refusal in ${maxCalls} calls (${Math.round((Date.now() - t0) / 1000)}s)`);
}

await sleep(5000);
await phase("burst of four at once, as the Grok code sends them", 0, 4);
await sleep(65000);
await phase("fast", 1000, 35);
await sleep(65000);
await phase("the runner's starting pace", 2500, 30);
await sleep(65000);

// two details of the candle call
const now = Math.floor(Date.now() / 1000);
const edge = Math.floor(now / 60) * 60 - 180;
const b = await get(`${GT}/networks/solana/pools/${pools[0]}/ohlcv/minute?aggregate=1&limit=4&currency=usd&token=${mints[0]}&before_timestamp=${edge}`);
const starts = b.body?.data?.attributes?.ohlcv_list?.map((r) => r[0]) ?? [];
console.log("before_timestamp", edge, "-> candle starts", starts, "| includes the stamp itself:", starts.includes(edge));
await sleep(4000);
const fresh = await get(`${GT}/networks/solana/pools/${pools[0]}/ohlcv/minute?aggregate=1&limit=3&currency=usd&token=${mints[0]}`);
const rows = fresh.body?.data?.attributes?.ohlcv_list ?? [];
console.log("newest candles:", rows.map((r) => `start ${r[0]} (age ${Math.floor(Date.now() / 1000) - r[0]}s) close ${r[4]}`).join(" | "));
