// Daily price refresh. Runs in GitHub Actions (or any cron) with Node 18+.
// Writes data/prices.json (latest snapshot) and appends to data/history.json.
// Usage: node scripts/update-prices.mjs

import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const HISTORY_DAYS = 365 * 5 + 10;

const getJson = async (url, timeoutMs = 15000) => {
  const res = await fetch(url, {
    headers: { accept: "application/json", "user-agent": "precious-rates-updater" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  return res.json();
};

const readJson = async (file, fallback) => {
  try { return JSON.parse(await readFile(path.join(DATA, file), "utf8")); }
  catch { return fallback; }
};

const writeJson = (file, value) =>
  writeFile(path.join(DATA, file), JSON.stringify(value, null, 2) + "\n");

const isPrice = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

const fetchMetals = async () => {
  try {
    const [gold, silver] = await Promise.all([
      getJson("https://api.gold-api.com/price/XAU"),
      getJson("https://api.gold-api.com/price/XAG"),
    ]);
    if (isPrice(gold.price) && isPrice(silver.price)) {
      return { gold: gold.price, silver: silver.price, as_of: gold.updatedAt ?? new Date().toISOString(), source: "gold-api.com" };
    }
    throw new Error("gold-api.com returned no price");
  } catch (err) {
    console.warn(`Primary metals source failed: ${err.message}. Trying xaus.com.`);
    const spot = await getJson("https://xaus.com/api/v1/spot?compact=1");
    if (!isPrice(spot.spot_usd_oz) || !isPrice(spot.silver_usd_oz)) throw new Error("xaus.com returned no price");
    return { gold: spot.spot_usd_oz, silver: spot.silver_usd_oz, as_of: spot.price_as_of ?? spot.updated_at ?? new Date().toISOString(), source: "xaus.com" };
  }
};

const fetchFx = async () => {
  const fx = await getJson("https://open.er-api.com/v6/latest/USD");
  if (fx.result !== "success" || !fx.rates) throw new Error("exchange rates unavailable");
  return { rates: fx.rates, as_of: fx.time_last_update_utc ?? null };
};

// Seeds up to five years of gold closes the first time, so the chart is useful on day one.
const fetchGoldBackfill = async () => {
  const hist = await getJson("https://xaus.com/api/v1/history", 30000);
  return (hist.points ?? []).filter((p) => p && p.d && isPrice(p.c)).map((p) => ({ d: p.d, gold: p.c }));
};

const fetchDiamondFeed = async () => {
  const url = process.env.DIAMOND_FEED_URL;
  if (!url) return null;
  const headers = process.env.DIAMOND_FEED_TOKEN ? { authorization: `Bearer ${process.env.DIAMOND_FEED_TOKEN}` } : {};
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`diamond feed answered ${res.status}`);
  const feed = await res.json();
  if (!Array.isArray(feed.natural_per_carat) || !feed.color || !feed.clarity) throw new Error("diamond feed is missing required fields");
  return feed;
};

const mergeHistory = (points, incoming) => {
  const byDay = new Map(points.map((p) => [p.d, { ...p }]));
  for (const p of incoming) byDay.set(p.d, { ...byDay.get(p.d), ...p });
  const sorted = [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d));
  return sorted.slice(-HISTORY_DAYS);
};

export const run = async () => {
  const today = new Date().toISOString().slice(0, 10);
  const previous = await readJson("prices.json", {});
  const history = await readJson("history.json", { points: [] });
  const errors = [];

  let metals = null;
  try { metals = await fetchMetals(); } catch (err) { errors.push(`metals: ${err.message}`); }

  let fx = null;
  try { fx = await fetchFx(); } catch (err) { errors.push(`fx: ${err.message}`); }

  if (!metals && !fx) {
    console.error(`Nothing updated. ${errors.join("; ")}`);
    process.exitCode = 1;
    return;
  }

  let incoming = [];
  const goldDays = history.points.filter((p) => isPrice(p.gold)).length;
  if (goldDays < 30) {
    try { incoming = await fetchGoldBackfill(); console.log(`Backfilled ${incoming.length} days of gold history.`); }
    catch (err) { errors.push(`backfill: ${err.message}`); }
  }
  if (metals) incoming.push({ d: today, gold: round(metals.gold), silver: round(metals.silver) });

  const snapshot = {
    updated_at: new Date().toISOString(),
    metals_as_of: metals?.as_of ?? previous.metals_as_of ?? null,
    source: metals?.source ?? previous.source ?? null,
    gold_usd_oz: metals ? round(metals.gold) : previous.gold_usd_oz ?? null,
    silver_usd_oz: metals ? round(metals.silver) : previous.silver_usd_oz ?? null,
    fx_as_of: fx?.as_of ?? previous.fx_as_of ?? null,
    fx: fx?.rates ?? previous.fx ?? null,
  };

  await writeJson("prices.json", snapshot);
  await writeJson("history.json", { points: mergeHistory(history.points, incoming) });

  try {
    const feed = await fetchDiamondFeed();
    if (feed) {
      await writeJson("diamonds.json", { ...feed, as_of: today });
      console.log("Diamond table refreshed from DIAMOND_FEED_URL.");
    }
  } catch (err) { errors.push(`diamonds: ${err.message}`); }

  console.log(`Saved gold ${snapshot.gold_usd_oz}, silver ${snapshot.silver_usd_oz} USD/oz from ${snapshot.source}.`);
  if (errors.length) console.warn(`Partial update: ${errors.join("; ")}`);
};

const round = (n) => Math.round(n * 100) / 100;

if (import.meta.url === `file://${process.argv[1]}`) await run();
