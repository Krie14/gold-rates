"use strict";

const LIVE_INTERVAL_MS = 60_000;
const GRAMS = { g: 1, "10g": 10, tola: 11.6638038, oz: 31.1034768, kg: 1000 };
const UNIT_LABEL = { g: "per gram", "10g": "per 10 g", tola: "per tola", oz: "per troy oz", kg: "per kg" };
const TROY_OZ_G = GRAMS.oz;

const PURITIES = {
  gold: [
    { id: "24", label: "24K", detail: "999", factor: 1 },
    { id: "22", label: "22K", detail: "916", factor: 22 / 24 },
    { id: "18", label: "18K", detail: "750", factor: 0.75 },
    { id: "14", label: "14K", detail: "585", factor: 0.585 },
    { id: "10", label: "10K", detail: "417", factor: 0.417 },
  ],
  silver: [
    { id: "999", label: "Fine silver", detail: "999", factor: 1 },
    { id: "925", label: "Sterling", detail: "925", factor: 0.925 },
    { id: "900", label: "Coin silver", detail: "900", factor: 0.9 },
  ],
};

const PREFERRED_CURRENCIES = ["USD", "EUR", "GBP", "NPR", "INR", "AED", "SAR", "QAR", "KWD", "PKR", "BDT", "CAD", "AUD", "NZD", "SGD", "HKD", "MYR", "JPY", "CNY", "CHF", "ZAR", "NGN", "TRY"];
const REGION_CURRENCY = {
  US: "USD", GB: "GBP", IN: "INR", AE: "AED", SA: "SAR", QA: "QAR", KW: "KWD", PK: "PKR", BD: "BDT",
  CA: "CAD", AU: "AUD", NZ: "NZD", SG: "SGD", HK: "HKD", MY: "MYR", JP: "JPY", CN: "CNY", CH: "CHF",
  ZA: "ZAR", NG: "NGN", TR: "TRY", DE: "EUR", FR: "EUR", IT: "EUR", ES: "EUR", NL: "EUR", IE: "EUR",
  BE: "EUR", AT: "EUR", PT: "EUR", FI: "EUR", GR: "EUR",
};

const state = {
  usdOz: { gold: null, silver: null },
  markets: null,
  market: null,
  mode: "local",
  fx: null,
  currency: "USD",
  unit: "g",
  history: [],
  diamonds: null,
  savedAt: null,
  liveAt: null,
  source: null,
  chartMetal: "gold",
  chartRange: 365,
};

const $ = (id) => document.getElementById(id);

/* ---------- country markets ---------- */
const marketInfo = (key = state.market) => (key && state.markets && state.markets.markets[key]) || null;
const activeMarket = () => (state.mode === "local" ? marketInfo() : null);
const marketSteps = (metal, jewellery = false) => {
  const m = activeMarket();
  if (!m) return [];
  return [...(m[metal] || []), ...(jewellery ? m.jewellery || [] : [])];
};
const marketFactor = (metal, jewellery = false) =>
  marketSteps(metal, jewellery).reduce((f, step) => f * (1 + step.pct / 100), 1);
const marketForCurrency = (code) => (state.markets && state.markets.currency_market[code]) || null;
const unitName = (unit) => {
  const m = marketInfo();
  if (unit === "tola" && m && m.unit_name) return m.unit_name;
  return { g: "gram", "10g": "10 g", tola: "tola", oz: "troy oz", kg: "kg" }[unit];
};
const unitLabel = (unit) => `per ${unitName(unit)}`;
const lowerFirst = (text) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);
const listText = (items) => items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/* ---------- storage (best effort) ---------- */
const prefs = {
  get(key) { try { return localStorage.getItem(`pr.${key}`); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(`pr.${key}`, value); } catch { /* private mode */ } },
};

/* ---------- fetching ---------- */
const getJson = async (url, { timeout = 12000, fresh = false } = {}) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: fresh ? "no-cache" : "default" });
    if (!res.ok) throw new Error(`${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
};

const isPrice = (n) => typeof n === "number" && Number.isFinite(n) && n > 0;

const fetchLiveMetals = async () => {
  try {
    const [g, s] = await Promise.all([
      getJson("https://api.gold-api.com/price/XAU", { fresh: true }),
      getJson("https://api.gold-api.com/price/XAG", { fresh: true }),
    ]);
    if (isPrice(g.price) && isPrice(s.price)) return { gold: g.price, silver: s.price, source: "gold-api.com" };
  } catch { /* fall through to backup */ }
  const x = await getJson("https://xaus.com/api/v1/spot?compact=1", { fresh: true });
  if (isPrice(x.spot_usd_oz) && isPrice(x.silver_usd_oz)) return { gold: x.spot_usd_oz, silver: x.silver_usd_oz, source: "xaus.com" };
  throw new Error("No live price available");
};

const fetchLiveFx = async () => {
  const fx = await getJson("https://open.er-api.com/v6/latest/USD");
  if (fx.result !== "success") throw new Error("FX unavailable");
  return fx.rates;
};

const fetchGoldHistoryLive = async () => {
  const h = await getJson("https://xaus.com/api/v1/history", { timeout: 20000 });
  return (h.points || []).filter((p) => isPrice(p.c)).map((p) => ({ d: p.d, gold: p.c }));
};

/* ---------- money ---------- */
const rate = () => (state.fx && state.fx[state.currency]) || (state.currency === "USD" ? 1 : null);

const formatters = new Map();
const money = (value, { compact = false } = {}) => {
  if (value == null || !Number.isFinite(value)) return "—";
  const digits = value >= 1000 ? 0 : value >= 10 ? 2 : 3;
  const notation = compact && value >= 100000 ? "compact" : "standard";
  const key = `${state.currency}|${digits}|${compact}|${notation}`;
  if (!formatters.has(key)) {
    formatters.set(key, new Intl.NumberFormat(undefined, {
      style: "currency", currency: state.currency,
      maximumFractionDigits: notation === "compact" ? 2 : digits,
      minimumFractionDigits: notation === "compact" ? 0 : Math.min(digits, 2),
      notation,
    }));
  }
  return formatters.get(key).format(value);
};

const pricePerGram = (metal) => {
  const usd = state.usdOz[metal];
  const r = rate();
  return isPrice(usd) && r ? (usd / TROY_OZ_G) * r : null;
};

const spotFor = (metal, unit, factor = 1) => {
  const g = pricePerGram(metal);
  return g == null ? null : g * GRAMS[unit] * factor;
};
const priceFor = (metal, unit, factor = 1, jewellery = false) => {
  const spot = spotFor(metal, unit, factor);
  return spot == null ? null : spot * marketFactor(metal, jewellery);
};

/* ---------- diamonds ---------- */
const bandPrice = (table, carat) => {
  let price = table[0].price;
  for (const row of table) if (carat >= row.min) price = row.price;
  return price;
};

const estimateDiamondUsd = ({ carat, color, clarity, cut, origin }) => {
  const d = state.diamonds;
  if (!d || !(carat > 0)) return null;
  const lab = origin === "lab";
  const table = lab ? d.lab_per_carat : d.natural_per_carat;
  const damp = (m) => (lab ? 1 + (m - 1) * (d.lab_grade_damping ?? 0.35) : m);
  const perCarat = bandPrice(table, carat) * damp(d.color[color] ?? 1) * damp(d.clarity[clarity] ?? 1) * damp(d.cut[cut] ?? 1);
  const mid = perCarat * carat;
  const spread = d.spread ?? 0.18;
  return { low: mid * (1 - spread), mid, high: mid * (1 + spread) };
};

/* ---------- rendering ---------- */
const lastClose = (metal) => {
  const today = new Date().toISOString().slice(0, 10);
  for (let i = state.history.length - 1; i >= 0; i--) {
    const p = state.history[i];
    if (p.d < today && isPrice(p[metal])) return p[metal];
  }
  return null;
};

const flash = (el, prevText, direction) => {
  if (!prevText || prevText === "—" || prevText === el.textContent) return;
  el.classList.remove("tick-up", "tick-down");
  void el.offsetWidth;
  el.classList.add(direction >= 0 ? "tick-up" : "tick-down");
  setTimeout(() => el.classList.remove("tick-up", "tick-down"), 900);
};

const renderBoard = (previousUsd = {}) => {
  for (const metal of ["gold", "silver"]) {
    const fig = $(`${metal}-figure`);
    const before = fig.textContent;
    fig.textContent = money(priceFor(metal, state.unit));
    if (previousUsd[metal] != null) flash(fig, before, state.usdOz[metal] - previousUsd[metal]);

    const changeEl = $(`${metal}-change`);
    const close = lastClose(metal);
    const now = state.usdOz[metal];
    const label = unitLabel(state.unit);
    if (isPrice(close) && isPrice(now) && rate()) {
      const diffUsd = now - close;
      const pct = (diffUsd / close) * 100;
      const diffLocal = (diffUsd / TROY_OZ_G) * GRAMS[state.unit] * rate() * marketFactor(metal);
      const cls = diffUsd >= 0 ? "up" : "down";
      const sign = diffUsd >= 0 ? "+" : "−";
      changeEl.innerHTML = `${label}. <span class="${cls}">${sign}${money(Math.abs(diffLocal))} (${sign}${Math.abs(pct).toFixed(2)}%)</span> since the last close`;
    } else {
      changeEl.textContent = label;
    }
  }
  const est = estimateDiamondUsd({ carat: 1, color: "G", clarity: "VS2", cut: "Excellent", origin: "natural" });
  $("diamond-figure").textContent = est && rate() ? money(est.mid * rate()) : "—";
};

const renderPurity = () => {
  const units = ["g", "10g", "tola", "oz"];
  const heads = document.querySelectorAll(".purity thead th");
  if (heads.length === 5) heads[3].textContent = `Per ${unitName("tola")}`;
  const m = activeMarket();
  $("purity-lede").textContent = m
    ? `${m.name} buying prices for bars, coins and the metal in jewellery. Making charges are extra.`
    : "International spot value of the metal itself, before local taxes, dealer premiums and making charges.";
  const rows = [];
  for (const metal of ["gold", "silver"]) {
    PURITIES[metal].forEach((p, i) => {
      const cells = units.map((u) => `<td>${money(priceFor(metal, u, p.factor))}</td>`).join("");
      const name = metal === "gold" ? `Gold ${p.label}` : p.label;
      const cls = [`metal-${metal}`, i === 0 && metal === "silver" ? "group-start" : ""].join(" ");
      rows.push(`<tr class="${cls}"><th scope="row">${name}<small>${p.detail}</small></th>${cells}</tr>`);
    });
  }
  $("purity-body").innerHTML = rows.join("");
};

const renderMetalCalc = () => {
  const metal = $("mc-metal").value;
  const purity = PURITIES[metal].find((p) => p.id === $("mc-purity").value) || PURITIES[metal][0];
  const weight = parseFloat($("mc-weight").value);
  const unit = $("mc-unit").value;
  const jewellery = $("mc-kind").value === "jewellery";
  $("mc-making-field").hidden = !jewellery;
  const making = jewellery ? Math.max(0, parseFloat($("mc-making").value) || 0) : 0;

  const metalValue = weight > 0 ? priceFor(metal, unit, purity.factor * weight) : null;
  if (metalValue == null) { $("mc-result").textContent = "—"; $("mc-detail").textContent = ""; return; }

  const makingValue = metalValue * (making / 100);
  const m = activeMarket();
  const extra = jewellery && m ? m.jewellery || [] : [];
  let total = metalValue + makingValue;
  const parts = [`Metal ${money(metalValue)}`];
  if (making) parts.push(`making charge ${making}% ${money(makingValue)}`);
  for (const step of extra) {
    const add = total * (step.pct / 100);
    parts.push(`${lowerFirst(step.label)} ${step.pct}% ${money(add)}`);
    total += add;
  }
  $("mc-result").textContent = money(total);
  $("mc-result-label").textContent = state.mode === "local" && m ? "You'd pay about" : "Spot value";
  $("mc-detail").textContent = parts.length > 1 ? `${parts.join(" + ")}.` : (m ? "Includes local duty, taxes and dealer premium." : "");
};

const fillPurityOptions = () => {
  const metal = $("mc-metal").value;
  $("mc-purity").innerHTML = PURITIES[metal].map((p) => `<option value="${p.id}">${metal === "gold" ? p.label : p.label} (${p.detail})</option>`).join("");
  if (metal === "gold") $("mc-purity").value = "22";
};

const renderDiamondCalc = () => {
  const input = {
    carat: parseFloat($("dc-carat").value),
    color: $("dc-color").value,
    clarity: $("dc-clarity").value,
    cut: $("dc-cut").value,
    origin: $("dc-origin").value,
  };
  const est = estimateDiamondUsd(input);
  const r = rate();
  $("dc-result").textContent = est && r ? `${money(est.low * r)} – ${money(est.high * r)}` : "—";
  if (state.diamonds) {
    const when = new Date(state.diamonds.as_of + "T00:00:00Z").toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
    $("dc-note").textContent = input.carat < 0.3
      ? "Estimates start at 0.30 carat."
      : `Round brilliant with a grading report. Reference table dated ${when}.`;
  }
};

/* ---------- chart ---------- */
const chartPoints = () => {
  const metal = state.chartMetal;
  const pts = state.history.filter((p) => isPrice(p[metal]));
  if (pts.length === 0) return [];
  const last = new Date(pts[pts.length - 1].d + "T00:00:00Z");
  const cutoff = new Date(last.getTime() - state.chartRange * 86400000).toISOString().slice(0, 10);
  const r = rate() || 1;
  const k = (GRAMS[state.unit] / TROY_OZ_G) * r * marketFactor(metal);
  const inRange = pts.filter((p) => p.d >= cutoff).map((p) => ({ d: p.d, v: p[metal] * k }));
  // Today's live price extends the line to now.
  const today = new Date().toISOString().slice(0, 10);
  if (isPrice(state.usdOz[metal]) && state.liveAt && inRange.length && inRange[inRange.length - 1].d < today) {
    inRange.push({ d: today, v: state.usdOz[metal] * k });
  }
  return inRange;
};

const niceTicks = (min, max, count = 4) => {
  const span = max - min || max || 1;
  const step0 = span / count;
  const mag = 10 ** Math.floor(Math.log10(step0));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= count + 1) || mag * 10;
  const start = Math.floor(min / step) * step;
  const ticks = [];
  for (let v = start; v <= max + step * 0.5; v += step) ticks.push(v);
  return ticks;
};

const dateLabel = (d, long = false) =>
  new Date(d + "T00:00:00Z").toLocaleDateString(undefined, long
    ? { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }
    : state.chartRange > 400 ? { month: "short", year: "numeric", timeZone: "UTC" } : { day: "numeric", month: "short", timeZone: "UTC" });

const renderChart = () => {
  const box = $("chart");
  const pts = chartPoints();
  const metalName = state.chartMetal === "gold" ? "Gold" : "Silver";
  if (pts.length < 2) {
    const saved = state.history.filter((p) => isPrice(p[state.chartMetal])).length;
    box.innerHTML = `<p class="empty">${metalName} history builds up one day at a time. ${saved} ${saved === 1 ? "day" : "days"} saved so far; the chart appears after the second.</p>`;
    $("chart-summary").textContent = "";
    return;
  }

  const W = Math.max(320, box.clientWidth - 32);
  const H = 300;
  const vals = pts.map((p) => p.v);
  const ticks = niceTicks(Math.min(...vals), Math.max(...vals));
  const tickLabels = ticks.map((t) => money(t, { compact: true }));
  const pad = { l: 14, r: 16 + Math.max(...tickLabels.map((l) => l.length)) * 7, t: 12, b: 28 };
  const yMin = ticks[0];
  const yMax = ticks[ticks.length - 1];
  const x = (i) => pad.l + (i / (pts.length - 1)) * (W - pad.l - pad.r);
  const y = (v) => pad.t + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - pad.t - pad.b);

  const line = pts.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join("");
  const area = `${line}L${x(pts.length - 1).toFixed(1)},${H - pad.b}L${pad.l},${H - pad.b}Z`;
  const color = state.chartMetal === "gold" ? "var(--gold)" : "var(--silver)";
  const fractions = W < 520 ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1];
  const xTickIdx = fractions.map((f) => Math.round(f * (pts.length - 1)));
  const lastTick = xTickIdx.length - 1;

  box.innerHTML = `
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${metalName} price chart">
      <g class="grid">${ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="axis">
        ${ticks.map((t, i) => `<text x="${W - pad.r + 8}" y="${y(t) + 4}">${tickLabels[i]}</text>`).join("")}
        ${xTickIdx.map((i, n) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${n === 0 ? "start" : n === lastTick ? "end" : "middle"}">${dateLabel(pts[i].d)}</text>`).join("")}
      </g>
      <path d="${area}" fill="${color}" opacity=".08"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round"/>
      <line id="hover-line" y1="${pad.t}" y2="${H - pad.b}" stroke="var(--ink)" stroke-opacity=".25" visibility="hidden"/>
      <circle id="hover-dot" r="4.5" fill="${color}" stroke="#fff" stroke-width="2" visibility="hidden"/>
      <rect x="${pad.l}" y="0" width="${W - pad.l - pad.r}" height="${H}" fill="transparent" id="hover-zone"/>
    </svg>
    <div class="tip" id="tip" hidden></div>`;

  const first = pts[0].v;
  const last = pts[pts.length - 1].v;
  const pct = ((last - first) / first) * 100;
  $("chart-summary").textContent =
    `${metalName} ${unitLabel(state.unit)} moved ${pct >= 0 ? "up" : "down"} ${Math.abs(pct).toFixed(1)}% from ${money(first)} to ${money(last)} between ${dateLabel(pts[0].d, true)} and ${dateLabel(pts[pts.length - 1].d, true)}.` +
    [state.currency !== "USD" ? " Converted at today's exchange rate." : "",
     activeMarket() ? ` Past prices use today's ${activeMarket().name} taxes and premiums.` : ""].join("");

  const svg = box.querySelector("svg");
  const zone = $("hover-zone");
  const tip = $("tip");
  const hl = $("hover-line");
  const dot = $("hover-dot");
  const show = (evt) => {
    const rect = svg.getBoundingClientRect();
    const sx = ((evt.clientX - rect.left) / rect.width) * W;
    const i = Math.max(0, Math.min(pts.length - 1, Math.round(((sx - pad.l) / (W - pad.l - pad.r)) * (pts.length - 1))));
    const px = x(i), py = y(pts[i].v);
    hl.setAttribute("x1", px); hl.setAttribute("x2", px); hl.setAttribute("visibility", "visible");
    dot.setAttribute("cx", px); dot.setAttribute("cy", py); dot.setAttribute("visibility", "visible");
    tip.hidden = false;
    tip.textContent = `${dateLabel(pts[i].d, true)}: ${money(pts[i].v)}`;
    tip.style.left = `${16 + (px / W) * rect.width}px`;
    tip.style.top = `${16 + (py / H) * rect.height}px`;
  };
  const hide = () => { tip.hidden = true; hl.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); };
  zone.addEventListener("pointermove", show);
  zone.addEventListener("pointerdown", show);
  zone.addEventListener("pointerleave", hide);
};

/* ---------- status ---------- */
const timeFmt = (iso, withDate = false) =>
  new Date(iso).toLocaleString(undefined, withDate
    ? { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }
    : { hour: "2-digit", minute: "2-digit", second: "2-digit" });

const setStatus = (kind, text) => {
  const el = $("status");
  el.dataset.state = kind;
  el.textContent = text;
};

const renderMarketLine = () => {
  const m = activeMarket();
  const info = marketInfo();
  const el = $("market-line");
  if (m) {
    el.innerHTML = `<strong>${m.name} buying price</strong>, including ${listText(m.gold.filter((s) => s.pct > 0).map((s) => lowerFirst(s.label)))}. Compare with: ${m.benchmark}.`;
  } else if (state.mode === "spot") {
    el.innerHTML = `<strong>International spot price</strong>, before local duty, taxes and dealer premiums.${info ? ` Switch Price to “Local price” for ${info.name}.` : ""}`;
  } else {
    el.innerHTML = `<strong>International spot price.</strong> Local taxes aren't set up for ${state.currency} yet, so add your local duty and dealer premium on top.`;
  }
};

const breakdownRows = (metal) => {
  const spot = spotFor(metal, state.unit);
  if (spot == null) return "";
  let running = spot;
  const rows = [`<tr><th scope="row">International spot</th><td>${money(spot)}</td></tr>`];
  for (const step of marketSteps(metal)) {
    const add = running * (step.pct / 100);
    running += add;
    const sign = add < 0 ? "−" : "+";
    rows.push(`<tr><th scope="row">${step.label}<span class="pct">${step.pct > 0 ? "+" : ""}${step.pct}%</span></th><td>${sign}${money(Math.abs(add))}</td></tr>`);
  }
  rows.push(`<tr><th scope="row">${metal === "gold" ? "Gold" : "Silver"} buying price</th><td>${money(running)}</td></tr>`);
  return `<caption>${metal === "gold" ? "Gold, 24 karat" : "Silver, 999 fine"}, ${unitLabel(state.unit)}</caption>${rows.join("")}`;
};

const renderBreakdown = () => {
  const m = activeMarket();
  $("breakdown-block").hidden = !m;
  if (!m) return;
  $("breakdown-title").textContent = `How today's ${m.name} price is made up`;
  $("breakdown-lede").textContent = m.note;
  $("breakdown-gold").innerHTML = breakdownRows("gold");
  $("breakdown-silver").innerHTML = breakdownRows("silver");
};

const renderAll = (previousUsd) => {
  renderMarketLine();
  renderBreakdown();
  renderBoard(previousUsd);
  renderPurity();
  renderMetalCalc();
  renderDiamondCalc();
  renderChart();
};

/* ---------- live loop ---------- */
let liveTimer = null;
const refreshLive = async () => {
  try {
    const live = await fetchLiveMetals();
    const before = { ...state.usdOz };
    state.usdOz = { gold: live.gold, silver: live.silver };
    state.liveAt = new Date().toISOString();
    state.source = live.source;
    renderAll(before);
    setStatus("live", `Live prices, updated at ${timeFmt(state.liveAt)}`);
  } catch {
    if (isPrice(state.usdOz.gold)) {
      const when = state.liveAt || state.savedAt;
      setStatus("saved", `Showing the rate saved ${when ? timeFmt(when, true) : "today"}. Live prices retry every minute.`);
    } else {
      setStatus("error", "Prices didn't load. Check your connection; the page tries again every minute.");
    }
  }
};

const startLive = () => {
  clearInterval(liveTimer);
  liveTimer = setInterval(refreshLive, LIVE_INTERVAL_MS);
};

/* ---------- setup ---------- */
const fillCurrencies = () => {
  const available = state.fx ? Object.keys(state.fx) : ["USD"];
  const preferred = PREFERRED_CURRENCIES.filter((c) => available.includes(c));
  const rest = available.filter((c) => !preferred.includes(c)).sort();
  let names;
  try { names = new Intl.DisplayNames(undefined, { type: "currency" }); } catch { names = null; }
  const opt = (c) => `<option value="${c}">${c}${names ? ` – ${names.of(c)}` : ""}</option>`;
  $("currency").innerHTML =
    `<optgroup label="Common">${preferred.map(opt).join("")}</optgroup>` +
    (rest.length ? `<optgroup label="All currencies">${rest.map(opt).join("")}</optgroup>` : "");
  if (!available.includes(state.currency)) applyCurrency("USD", { resetUnit: true });
  $("currency").value = state.currency;
};

const detectCurrency = () => {
  // Time zone is the best signal: many people use an "en-US" browser outside the US.
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const key = state.markets && state.markets.timezone_market[tz];
    if (key) return state.markets.markets[key].currency;
  } catch { /* older browsers */ }
  const lang = (navigator.languages && navigator.languages[0]) || navigator.language || "en-US";
  const region = (lang.split("-")[1] || "").toUpperCase();
  if (region === "NP") return "NPR";
  return REGION_CURRENCY[region] || "USD";
};

const applyCurrency = (code, { resetUnit = false } = {}) => {
  state.currency = code;
  state.market = marketForCurrency(code);
  prefs.set("currency", code);
  const m = marketInfo();
  if (resetUnit && m && GRAMS[m.unit]) {
    state.unit = m.unit;
    $("unit").value = m.unit;
    prefs.set("unit", m.unit);
  }
  const tolaOpt = $("unit").querySelector('option[value="tola"]');
  if (tolaOpt) tolaOpt.textContent = unitLabel("tola");
  const mcTola = $("mc-unit").querySelector('option[value="tola"]');
  if (mcTola) mcTola.textContent = unitName("tola");
};

const fillDiamondOptions = () => {
  const d = state.diamonds;
  if (!d) return;
  const opts = (obj, selected) => Object.keys(obj).map((k) => `<option${k === selected ? " selected" : ""}>${k}</option>`).join("");
  $("dc-color").innerHTML = opts(d.color, "G");
  $("dc-clarity").innerHTML = opts(d.clarity, "VS2");
  $("dc-cut").innerHTML = opts(d.cut, "Excellent");
};

const bindEvents = () => {
  $("currency").addEventListener("change", (e) => { applyCurrency(e.target.value, { resetUnit: true }); renderAll(); });
  $("mode").addEventListener("change", (e) => { state.mode = e.target.value; prefs.set("mode", state.mode); renderAll(); });
  $("unit").addEventListener("change", (e) => { state.unit = e.target.value; prefs.set("unit", state.unit); renderAll(); });
  $("mc-metal").addEventListener("change", () => { fillPurityOptions(); renderMetalCalc(); });
  ["mc-purity", "mc-weight", "mc-unit", "mc-kind", "mc-making"].forEach((id) => $(id).addEventListener("input", renderMetalCalc));
  ["dc-carat", "dc-color", "dc-clarity", "dc-cut", "dc-origin"].forEach((id) => $(id).addEventListener("input", renderDiamondCalc));

  document.querySelectorAll("[data-metal]").forEach((b) => b.addEventListener("click", () => {
    state.chartMetal = b.dataset.metal;
    document.querySelectorAll("[data-metal]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    renderChart();
  }));
  document.querySelectorAll("[data-range]").forEach((b) => b.addEventListener("click", () => {
    state.chartRange = Number(b.dataset.range);
    document.querySelectorAll("[data-range]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    renderChart();
  }));

  let resizeTimer;
  window.addEventListener("resize", () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderChart, 150); });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { clearInterval(liveTimer); }
    else { refreshLive(); startLive(); }
  });
};

const init = async () => {
  fillPurityOptions();
  bindEvents();

  const [prices, history, diamonds, markets] = await Promise.allSettled([
    getJson("data/prices.json", { fresh: true }),
    getJson("data/history.json", { fresh: true }),
    getJson("data/diamonds.json", { fresh: true }),
    getJson("data/markets.json", { fresh: true }),
  ]);
  if (markets.status === "fulfilled") state.markets = markets.value;

  state.mode = prefs.get("mode") === "spot" ? "spot" : "local";
  $("mode").value = state.mode;
  const savedUnit = prefs.get("unit");
  applyCurrency(prefs.get("currency") || detectCurrency(), { resetUnit: !savedUnit });
  if (savedUnit && GRAMS[savedUnit]) { state.unit = savedUnit; $("unit").value = savedUnit; }

  if (prices.status === "fulfilled") {
    const p = prices.value;
    if (isPrice(p.gold_usd_oz)) state.usdOz.gold = p.gold_usd_oz;
    if (isPrice(p.silver_usd_oz)) state.usdOz.silver = p.silver_usd_oz;
    state.fx = p.fx || null;
    state.savedAt = p.updated_at || null;
    if (p.updated_at) $("saved-stamp").textContent = `Daily snapshot saved ${new Date(p.updated_at).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}.`;
  }
  if (history.status === "fulfilled") state.history = history.value.points || [];
  if (diamonds.status === "fulfilled") state.diamonds = diamonds.value;

  const tasks = [];
  if (!state.fx) tasks.push(fetchLiveFx().then((r) => { state.fx = r; }).catch(() => {}));
  if (state.history.filter((p) => isPrice(p.gold)).length < 2) {
    tasks.push(fetchGoldHistoryLive().then((pts) => {
      const map = new Map(state.history.map((p) => [p.d, p]));
      pts.forEach((p) => map.set(p.d, { ...map.get(p.d), ...p }));
      state.history = [...map.values()].sort((a, b) => a.d.localeCompare(b.d));
    }).catch(() => {}));
  }
  tasks.push(refreshLive());
  await Promise.all(tasks);

  fillCurrencies();
  fillDiamondOptions();
  renderAll();
  if (state.liveAt) setStatus("live", `Live prices, updated at ${timeFmt(state.liveAt)}`);
  startLive();
};

init();
