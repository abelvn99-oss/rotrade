const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder,
        REST, Routes, ActivityType, AttachmentBuilder } = require("discord.js");
const axios = require("axios");
const { createCanvas } = require("@napi-rs/canvas");

// ─── Config ────────────────────────────────────────────────────────────────
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) { console.error("Missing BOT_TOKEN"); process.exit(1); }

// ─── State ─────────────────────────────────────────────────────────────────
let DB         = {};
let dbLoadedAt = null;
const thumbCache = {};
const salesCache = {};

// ─── Rolimons mappings ─────────────────────────────────────────────────────
const DEMAND_MAP = { 0:"Terrible", 1:"Low", 2:"Normal", 3:"High", 4:"Amazing" };
const TREND_MAP  = { 0:"Fluctuating", 1:"Dropping", 2:"Unstable", 3:"Stable", 4:"Rising" };
const parseDemand = v => DEMAND_MAP[parseInt(v,10)] ?? null;
const parseTrend  = v => TREND_MAP[parseInt(v,10)]  ?? null;
const fmt  = n => Number(n).toLocaleString("en-US");
const fmtK = n => n>=1e6?(n/1e6).toFixed(2)+"M":n>=1e3?(n/1e3).toFixed(1)+"K":String(n);

const DEMAND_COLOR = {
  Terrible:0xe0415a, Low:0xe8a020, Normal:0x10b981, High:0x3b82f6, Amazing:0x8b5cf6
};

// ─── OP calculation ────────────────────────────────────────────────────────
// Returns { opGiveMin, opGiveMax, opGetMin, opGetMax }
// Under 50K value: give ~5%, get ~10%
// 50K-150K value: give ~4%, get ~8%
// Over 150K: give ~3%, get ~6%
// Demand adjusts these — High/Amazing = give less, get more
// Terrible demand = you give more to move it, get less from it
// Projected = never give OP, demand 15%+ back
function calcOP(item) {
  if (!item.value) return { opGiveMin:0, opGiveMax:0, opGetMin:0, opGetMax:0 };
  const v = item.value;

  if (item.projected) {
    return {
      opGiveMin: 0, opGiveMax: 0,
      opGetMin:  Math.round(v*0.15), opGetMax: Math.round(v*0.25),
    };
  }

  // Items valued over 150K — OP is proof-based, not formula-based
  if (v >= 150000) {
    return {
      opGiveMin: null, opGiveMax: null,
      opGetMin:  null, opGetMax:  null,
      proofBased: true,
    };
  }

  // Base give/get percentages by value tier
  let giveBase, getBase;
  if (v < 50000)  { giveBase=0.05; getBase=0.10; }
  else            { giveBase=0.04; getBase=0.08; }

  // Demand multiplier
  const demandMult = {
    Terrible: { give:1.8, get:0.3 },
    Low:      { give:1.4, get:0.6 },
    Normal:   { give:1.0, get:1.0 },
    High:     { give:0.6, get:1.5 },
    Amazing:  { give:0.3, get:2.0 },
  };
  const mult = demandMult[item.demand] ?? { give:1.0, get:1.0 };

  const giveMid = v * giveBase * mult.give;
  const getMid  = v * getBase  * mult.get;

  return {
    opGiveMin:  Math.round(giveMid * 0.7),
    opGiveMax:  Math.round(giveMid * 1.3),
    opGetMin:   Math.round(getMid  * 0.7),
    opGetMax:   Math.round(getMid  * 1.3),
    proofBased: false,
  };
}

// ─── Thumbnail ─────────────────────────────────────────────────────────────
async function fetchThumb(assetId) {
  if (thumbCache[assetId]) return thumbCache[assetId];
  try {
    const { data } = await axios.get(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=420x420&format=Png&isCircular=false`,
      { timeout:8000, headers:{"User-Agent":"RoTradeBot/1.0"} }
    );
    const url = data?.data?.[0]?.imageUrl;
    if (url?.startsWith("http")) { thumbCache[assetId]=url; return url; }
  } catch {}
  return null;
}

// ─── Best price cache ────────────────────────────────────────────────────────
const bestPriceCache = {};  // assetId -> { price, fetchedAt }

async function fetchBestPrice(assetId) {
  // Return cached price if fresh (< 30 min)
  const cached = bestPriceCache[assetId];
  if (cached && Date.now() - cached.fetchedAt < 1800000) return cached.price;

  let price = null;

  // Source 1: Roblox catalog API (no auth, works for most items)
  try {
    const { data } = await axios.get(
      `https://catalog.roblox.com/v1/catalog/items/details`,
      {
        method: 'POST',
        timeout: 8000,
        headers: { "User-Agent":"RoTradeBot/1.0", "Content-Type":"application/json" },
        data: JSON.stringify({ items:[{ itemType:"Asset", id:Number(assetId) }] }),
      }
    );
    const item = data?.data?.[0];
    if (item?.lowestPrice) price = item.lowestPrice;
  } catch {}

  // Source 2: Roblox economy resellers (may work for some items)
  if (!price) {
    try {
      const { data } = await axios.get(
        `https://economy.roblox.com/v1/assets/${assetId}/resellers?limit=3`,
        { timeout:8000, headers:{"User-Agent":"RoTradeBot/1.0"} }
      );
      const top = data?.data?.[0];
      if (top?.price) price = top.price;
    } catch {}
  }

  // Source 3: Roblox productinfo (public, no auth)
  if (!price) {
    try {
      const { data } = await axios.get(
        `https://economy.roblox.com/v2/assets/${assetId}/details`,
        { timeout:8000, headers:{"User-Agent":"RoTradeBot/1.0"} }
      );
      if (data?.PriceInRobux) price = data.PriceInRobux;
    } catch {}
  }

  bestPriceCache[assetId] = { price, fetchedAt: Date.now() };
  return price;
}

// Pre-fetch best prices for all items in DB in background
// Runs every 30 minutes to keep prices fresh
async function refreshBestPrices() {
  const items = Object.values(DB);
  console.log(`[BestPrice] Refreshing prices for ${items.length} items...`);
  // Process in batches of 10 to avoid overwhelming APIs
  for (let i = 0; i < items.length; i += 10) {
    const batch = items.slice(i, i + 10);
    await Promise.all(batch.map(item => fetchBestPrice(item.id)));
    await new Promise(r => setTimeout(r, 500)); // 500ms between batches
  }
  console.log(`[BestPrice] Price refresh complete.`);
}

// ─── Sales history ──────────────────────────────────────────────────────────
async function fetchSalesHistory(assetId) {
  const cached = salesCache[assetId];
  if (cached && Date.now()-cached.fetchedAt < 600000) return cached.sales;
  try {
    const { data } = await axios.get(
      `https://www.rolimons.com/itemapi/itemsales/${assetId}`,
      { timeout:12000, headers:{"User-Agent":"RoTradeBot/1.0"} }
    );
    const raw = data?.sales ?? data?.data ?? [];
    const sales = raw.map(s=>({
      timestamp: s[0]*1000,
      price:     s[1],
      rapBefore: s[2],
      rapAfter:  s[3],
    })).filter(s=>s.price>0).sort((a,b)=>a.timestamp-b.timestamp);
    salesCache[assetId] = { sales, fetchedAt:Date.now() };
    return sales;
  } catch { return []; }
}

// ─── RSI (14-period) ────────────────────────────────────────────────────────
function calcRSI(prices, period=14) {
  if (prices.length < period+1) return null;
  let gains=0, losses=0;
  for (let i=1; i<=period; i++) {
    const d = prices[i]-prices[i-1];
    if (d>=0) gains+=d; else losses-=d;
  }
  let avgG = gains/period, avgL = losses/period;
  for (let i=period+1; i<prices.length; i++) {
    const d = prices[i]-prices[i-1];
    avgG = (avgG*(period-1)+(d>=0?d:0))/period;
    avgL = (avgL*(period-1)+(d<0?-d:0))/period;
  }
  if (avgL===0) return 100;
  return Math.round(100-(100/(1+(avgG/avgL))));
}

// ─── RSI series for chart ───────────────────────────────────────────────────
function calcRSISeries(prices, period=14) {
  const series = [];
  for (let i=period; i<prices.length; i++) {
    const rsi = calcRSI(prices.slice(0,i+1), period);
    if (rsi!==null) series.push({ i, rsi });
  }
  return series;
}

// ─── Chart generation ───────────────────────────────────────────────────────
async function generateChart(item, sales) {
  const W=820, H=520;
  const PAD_L=72, PAD_R=18, PAD_T=54, CHART_H=290, RSI_GAP=36, RSI_H=110;
  const chartBottom = PAD_T+CHART_H;
  const chartLeft   = PAD_L;
  const chartRight  = W-PAD_R;
  const chartW      = chartRight-chartLeft;
  const rsiTop      = chartBottom+RSI_GAP;
  const rsiBottom   = rsiTop+RSI_H;

  const canvas = createCanvas(W,H);
  const ctx    = canvas.getContext("2d");

  // Background
  ctx.fillStyle="#0d1117"; ctx.fillRect(0,0,W,H);

  // Title
  ctx.fillStyle="#e6edf3"; ctx.font="bold 13px monospace";
  ctx.fillText(`${item.name}  ·  Recent Average Price`, PAD_L, 24);
  ctx.fillStyle="#8b949e"; ctx.font="11px monospace";
  ctx.fillText(
    `Value: ${fmt(item.value)} R$   RAP: ${item.rap?fmt(item.rap):"N/A"} R$   Demand: ${item.demand??"—"}   Trend: ${item.trend??"—"}`,
    PAD_L, 42
  );

  if (!sales || sales.length<3) {
    ctx.fillStyle="#8b949e"; ctx.font="13px monospace";
    ctx.textAlign="center";
    ctx.fillText("Insufficient sales history to generate chart",W/2,H/2);
    return canvas.toBuffer("image/png");
  }

  // Build candles from grouped sales
  const candleCount = Math.min(50, Math.max(10, Math.floor(sales.length/2)));
  const groupSize   = Math.max(1, Math.floor(sales.length/candleCount));
  const candles=[];
  for (let i=0; i<sales.length; i+=groupSize) {
    const g  = sales.slice(i,i+groupSize);
    const ps = g.map(s=>s.price);
    candles.push({ open:ps[0], close:ps[ps.length-1], high:Math.max(...ps), low:Math.min(...ps), time:g[0].timestamp });
  }

  // Price range with 4% padding
  const allP = candles.flatMap(c=>[c.high,c.low]);
  const minP = Math.min(...allP)*0.96, maxP = Math.max(...allP)*1.04, rangeP = maxP-minP;
  const priceToY = p => PAD_T+CHART_H-((p-minP)/rangeP)*CHART_H;
  const idxToX   = i => chartLeft+(i/(candles.length-1||1))*chartW;

  // Main chart grid
  ctx.strokeStyle="#161b22"; ctx.lineWidth=1;
  for (let r=0; r<=5; r++) {
    const y = PAD_T+(r/5)*CHART_H;
    const p = maxP-(r/5)*rangeP;
    ctx.beginPath(); ctx.moveTo(chartLeft,y); ctx.lineTo(chartRight,y); ctx.stroke();
    ctx.fillStyle="#8b949e"; ctx.font="9.5px monospace"; ctx.textAlign="right";
    ctx.fillText(fmtK(Math.round(p)), chartLeft-5, y+3);
  }

  // Gradient area under RAP line
  const grad = ctx.createLinearGradient(0,PAD_T,0,chartBottom);
  grad.addColorStop(0,"rgba(57,211,83,0.15)");
  grad.addColorStop(1,"rgba(57,211,83,0)");
  ctx.fillStyle=grad;
  ctx.beginPath();
  ctx.moveTo(idxToX(0),chartBottom);
  candles.forEach((c,i)=>ctx.lineTo(idxToX(i),priceToY(c.close)));
  ctx.lineTo(idxToX(candles.length-1),chartBottom);
  ctx.closePath(); ctx.fill();

  // Candlesticks
  const cw = Math.max(2, (chartW/candles.length)*0.65);
  candles.forEach((c,i)=>{
    const x    = idxToX(i);
    const isUp = c.close>=c.open;
    const col  = isUp?"#238636":"#da3633";
    const bT   = priceToY(Math.max(c.open,c.close));
    const bB   = priceToY(Math.min(c.open,c.close));
    const bH   = Math.max(1,bB-bT);
    ctx.strokeStyle=col; ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(x,priceToY(c.high)); ctx.lineTo(x,priceToY(c.low)); ctx.stroke();
    ctx.fillStyle=col; ctx.fillRect(x-cw/2,bT,cw,bH);
  });

  // RAP line
  ctx.strokeStyle="#39d353"; ctx.lineWidth=1.8; ctx.lineJoin="round";
  ctx.beginPath();
  candles.forEach((c,i)=>i===0?ctx.moveTo(idxToX(i),priceToY(c.close)):ctx.lineTo(idxToX(i),priceToY(c.close)));
  ctx.stroke();

  // Current price dot
  const lastC = candles[candles.length-1];
  ctx.fillStyle="#39d353";
  ctx.beginPath(); ctx.arc(idxToX(candles.length-1),priceToY(lastC.close),4,0,Math.PI*2); ctx.fill();

  // X-axis date labels
  ctx.fillStyle="#8b949e"; ctx.font="9px monospace"; ctx.textAlign="center";
  const step = Math.max(1,Math.floor(candles.length/7));
  candles.forEach((c,i)=>{
    if (i%step!==0 && i!==candles.length-1) return;
    const d=new Date(c.time);
    ctx.fillText(`${d.getMonth()+1}/${d.getDate()}`, idxToX(i), chartBottom+14);
  });

  // ── RSI Panel ─────────────────────────────────────────────────────────────
  const rsiHH = rsiBottom-rsiTop;
  const rsiY  = (rsi) => rsiTop+((100-rsi)/100)*rsiHH;

  // RSI panel bg
  ctx.fillStyle="#0d1117"; ctx.fillRect(chartLeft,rsiTop,chartW,rsiHH);

  // Overbought/oversold zones
  ctx.fillStyle="rgba(218,54,51,0.10)"; ctx.fillRect(chartLeft,rsiTop,chartW,rsiY(70)-rsiTop);
  ctx.fillStyle="rgba(35,134,54,0.10)"; ctx.fillRect(chartLeft,rsiY(30),chartW,rsiBottom-rsiY(30));

  // RSI reference lines
  [[70,"#da3633","70"],[50,"#484f58","50"],[30,"#238636","30"]].forEach(([v,col,lbl])=>{
    const y=rsiY(v);
    ctx.strokeStyle=col; ctx.lineWidth=0.8;
    ctx.setLineDash([4,4]);
    ctx.beginPath(); ctx.moveTo(chartLeft,y); ctx.lineTo(chartRight,y); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle=col; ctx.font="9px monospace"; ctx.textAlign="right";
    ctx.fillText(lbl,chartLeft-4,y+3);
  });

  // RSI line
  const closePrices = candles.map(c=>c.close);
  const rsiSeries   = calcRSISeries(closePrices);
  const currentRSI  = rsiSeries.length?rsiSeries[rsiSeries.length-1].rsi:null;

  if (rsiSeries.length>=2) {
    ctx.strokeStyle="#58a6ff"; ctx.lineWidth=1.5; ctx.lineJoin="round";
    ctx.beginPath();
    rsiSeries.forEach(({i,rsi},k)=>{
      const x=idxToX(i), y=rsiY(rsi);
      k===0?ctx.moveTo(x,y):ctx.lineTo(x,y);
    });
    ctx.stroke();

    // Current RSI dot
    const last=rsiSeries[rsiSeries.length-1];
    const dotCol = last.rsi<30?"#39d353":last.rsi>70?"#da3633":"#58a6ff";
    ctx.fillStyle=dotCol;
    ctx.beginPath(); ctx.arc(idxToX(last.i),rsiY(last.rsi),4,0,Math.PI*2); ctx.fill();
  }

  // RSI label + value
  ctx.fillStyle="#8b949e"; ctx.font="10px monospace"; ctx.textAlign="left";
  ctx.fillText("RSI (14)", chartLeft, rsiTop-7);
  if (currentRSI!==null) {
    const rc = currentRSI<30?"#39d353":currentRSI>70?"#da3633":"#58a6ff";
    ctx.fillStyle=rc; ctx.font="bold 10px monospace";
    ctx.fillText(`  ${currentRSI}`, chartLeft+58, rsiTop-7);

    // RSI interpretation
    const interp = currentRSI<30?"Oversold — strong buy":currentRSI<50?"Below midline":currentRSI>70?"Overbought — may drop":"Above midline";
    ctx.fillStyle="#8b949e"; ctx.font="9px monospace";
    ctx.fillText(`   ${interp}`, chartLeft+80, rsiTop-7);
  }

  // Watermark
  ctx.fillStyle="#21262d"; ctx.font="9px monospace"; ctx.textAlign="right";
  ctx.fillText("RoTrade Bot · Rolimons Data", W-PAD_R, H-5);

  return canvas.toBuffer("image/png");
}

// ─── Fetch DB ───────────────────────────────────────────────────────────────
async function fetchDB() {
  console.log("[Rolimons] Fetching item database...");
  const ENDPOINTS = [
    "https://api.rolimons.com/items/v1/allitems",
    "https://www.rolimons.com/itemapi/itemdetails",
  ];
  let raw={}, isAllItems=false;
  for (const url of ENDPOINTS) {
    try {
      const {data} = await axios.get(url,{
        headers:{"User-Agent":"RoTradeBot/1.0","Accept":"application/json"},
        timeout:25000,
      });
      // allitems uses item_details key, itemdetails uses items key
      const items = data.item_details || data.items;
      if (items && Object.keys(items).length>100) {
        raw=items;
        isAllItems = url.includes("api.rolimons.com");
        console.log(`[Rolimons] Loaded ${Object.keys(raw).length} raw items from ${url} (isAllItems=${isAllItems})`);
        break;
      }
    } catch(e){ console.log(`[Rolimons] ${url} failed: ${e.message}`); }
  }

  const parsed={};
  for (const [id,f] of Object.entries(raw)) {
    if (!Array.isArray(f)||f.length<4) continue;

    // Field layout differs by endpoint:
    // allitems (api.rolimons.com):   f[2]=value, f[3]=defaultVal, f[10]=RAP
    // itemdetails (www.rolimons.com): f[2]=RAP,   f[3]=value
    let value, rap;
    if (isAllItems) {
      value = Number(f[2]);
      rap   = Number(f[10]);
    } else {
      // itemdetails: f[2] is RAP, f[3] is community value
      rap   = Number(f[2]);
      value = Number(f[3]);
    }

    if (!value||value<=0) continue;

    parsed[id]={
      id, name:f[0]||"Unknown", acronym:f[1]||"",
      value,
      rap:(rap&&rap>0)?rap:null,
      demand:parseDemand(f[4]), trend:parseTrend(f[5]),
      projected:Number(f[6])===1, hyped:Number(f[7])===1, rare:Number(f[8])===1,
      thumbUrl:null, rsi:null,
    };
  }
  DB=parsed; dbLoadedAt=new Date();
  const u150=Object.values(parsed).filter(i=>i.value<=150000).length;
  console.log(`[Rolimons] ${Object.keys(parsed).length} items loaded. ${u150} valued ≤150K R$`);
  return parsed;
}

// ─── Item search ─────────────────────────────────────────────────────────────
function findItem(q) {
  q=q.toLowerCase().trim();
  const all=Object.values(DB);
  return all.find(i=>i.acronym.toLowerCase()===q)
    || all.find(i=>i.name.toLowerCase()===q)
    || all.filter(i=>i.name.toLowerCase().includes(q)||i.acronym.toLowerCase().includes(q))
         .sort((a,b)=>a.name.length-b.name.length)[0]
    || null;
}

// ─── /item embed ─────────────────────────────────────────────────────────────
function buildItemEmbed(item, bestPrice, op, rsi) {
  const color = item.projected ? 0xe0415a : (DEMAND_COLOR[item.demand] ?? 0x1c2333);
  const vsRap = item.rap ? (((item.value / item.rap) - 1) * 100).toFixed(2) : null;

  const rsiStr = rsi === null ? "Insufficient data"
    : rsi < 30 ? `${rsi} — Oversold (below green zone)`
    : rsi < 50 ? `${rsi} — Below midline (weak)`
    : rsi > 70 ? `${rsi} — Overbought (may drop soon)`
    : `${rsi} — Neutral`;

  const demandNote = {
    Terrible: "Very hard to trade. Expect to give significant OP and receive little back.",
    Low:      "Below average demand. You will likely need to sweeten your offer.",
    Normal:   "Average demand. Standard OP expectations apply on both sides.",
    High:     "Good demand. Easy to move, traders will give OP for this.",
    Amazing:  "Exceptional demand. Actively sought after — expect large OP.",
  };

  const flags = [
    item.projected ? "🚨 Projected — RAP artificially inflated. Do not trade at face value." : null,
    item.rare  ? "💎 Rare"  : null,
    item.hyped ? "🔥 Hyped" : null,
  ].filter(Boolean);

  // ── OP values ─────────────────────────────────────────────────────────────
  const opGiveStr = op.proofBased
    ? "Proof-Based — check Rolimons proofs for 150K+ items"
    : op.opGiveMax > 0
      ? `${fmt(op.opGiveMin)} – ${fmt(op.opGiveMax)} R$`
      : "0 R$ — Do not overpay";

  const opGetStr = op.proofBased
    ? "Proof-Based — check Rolimons proofs for 150K+ items"
    : op.opGetMax > 0
      ? `${fmt(op.opGetMin)} – ${fmt(op.opGetMax)} R$`
      : "0 R$ — No OP expected";

  // ── Demand + description block (right column) ─────────────────────────────
  const demandStr = item.demand ?? "Not set";
  const demandDesc = item.demand && demandNote[item.demand] ? demandNote[item.demand] : "No demand data.";
  const trendStr  = item.trend  ?? "Not set";

  // ── Flags line for description ────────────────────────────────────────────
  const flagLine = flags.length ? flags.join("\n") : null;

  const embed = new EmbedBuilder()
    .setColor(color)
    // Name at top — thumbnail appears top-right automatically in Discord
    .setTitle(item.name)
    .setURL(`https://www.rolimons.com/item/${item.id}`)
    .setDescription(
      [
        item.acronym ? `**${item.acronym}**  ·  [View on Rolimons](https://www.rolimons.com/item/${item.id})` : `[View on Rolimons](https://www.rolimons.com/item/${item.id})`,
        flagLine,
      ].filter(Boolean).join("\n")
    )
    // ── Middle row: LEFT = Val/RAP/BP stacked | RIGHT = Demand/Trend desc ──
    .addFields(
      {
        name:  "📊 Prices",
        value: [
          `**Value:**  \`${fmt(item.value)} R$\``,
          `**RAP:**    \`${item.rap ? fmt(item.rap) + " R$" : "Not tracked"}\``,
          `**Best Price:** \`${bestPrice ? fmt(bestPrice) + " R$" : "Not available"}\``,
          vsRap !== null ? `**vs RAP:** \`${parseFloat(vsRap) >= 0 ? "+" : ""}${vsRap}%\`` : null,
        ].filter(Boolean).join("\n"),
        inline: true,
      },
      {
        name:  "📈 Demand & Trend",
        value: [
          `**Demand:** \`${demandStr}\``,
          `**Trend:**  \`${trendStr}\``,
          `**RSI:**    \`${rsiStr}\``,
          demandDesc,
        ].join("\n"),
        inline: true,
      },
    )
    // ── Bottom row: Give | Get side by side ───────────────────────────────
    .addFields(
      {
        name:  "💸 OP to Give",
        value: `\`${opGiveStr}\``,
        inline: true,
      },
      {
        name:  "💰 OP to Get",
        value: `\`${opGetStr}\``,
        inline: true,
      },
    )
    .setFooter({ text: `Rolimons · ${new Date().toUTCString()}` });

  if (item.thumbUrl) embed.setThumbnail(item.thumbUrl);
  return embed;
}

// ─── /find ───────────────────────────────────────────────────────────────────
async function handleFind(interaction) {
  await interaction.deferReply();
  const minVal = interaction.options.getInteger("min");
  const maxVal = interaction.options.getInteger("max");
  const limit  = Math.min(5, Math.max(1, interaction.options.getInteger("results")??3));

  if (minVal>=maxVal) return interaction.editReply({content:"Min must be less than max."});
  if (maxVal>150000)  return interaction.editReply({content:"Max value supported is 150,000 R$."});

  const candidates = Object.values(DB).filter(i=>
    i.value>=minVal && i.value<=maxVal && !i.projected && i.demand!=="Terrible"
  );

  if (!candidates.length) return interaction.editReply({
    content:`No valued items found between **${fmt(minVal)}** and **${fmt(maxVal)} R$**. Try a wider range.`
  });

  // Sample top 20 by demand, fetch RSI for each
  const ds={Amazing:4,High:3,Normal:2,Low:1,Terrible:0};
  const sample=candidates.sort((a,b)=>(ds[b.demand]??0)-(ds[a.demand]??0)).slice(0,20);

  const scored=await Promise.all(sample.map(async item=>{
    const sales  = await fetchSalesHistory(item.id);
    const prices = sales.map(s=>s.price);
    const rsi    = prices.length>=15?calcRSI(prices):null;
    item.rsi=rsi;
    const rsiScore    = rsi!==null?(50-rsi):0;
    const demandBonus = {Amazing:30,High:20,Normal:10,Low:0,Terrible:-20};
    const trendBonus  = {Rising:15,Stable:5,Unstable:0,Fluctuating:0,Dropping:-10};
    const score = rsiScore+(demandBonus[item.demand]??0)+(trendBonus[item.trend]??0);
    return {item,rsi,score};
  }));

  const results=scored
    .filter(s=>s.rsi!==null&&s.rsi<=50)
    .sort((a,b)=>b.score-a.score)
    .slice(0,limit);

  if (!results.length) return interaction.editReply({
    content:`Found items in that range but none had RSI data or all were above the midline (RSI>50). Try:\n• A wider value range\n• Items with more sale history (higher demand items)`
  });

  const embed=new EmbedBuilder()
    .setColor(0x10b981)
    .setTitle(`Best Items to Trade For — ${fmt(minVal)}–${fmt(maxVal)} R$`)
    .setDescription(
      `**How to read this:** Lower RSI = oversold = the item is weak and likely to recover.\n`+
      `🟢 **RSI below 30** = Oversold zone — strongest buy signal.\n`+
      `🟡 **RSI 30–50** = Below the midline — showing weakness, may recover.\n\n`+
      `These are the best items to **trade for** right now in your range.`
    );

  for (const {item,rsi} of results) {
    const rsiLabel=rsi<30?`\`${rsi}\` 🟢 Oversold — strong buy signal`:
                   rsi<40?`\`${rsi}\` 🟡 Weak — below midline, likely to recover`:
                          `\`${rsi}\` ⚪ Below midline`;
    const vsRap=item.rap?(((item.value/item.rap)-1)*100).toFixed(1):null;
    embed.addFields({
      name:`${item.name}${item.acronym?` (${item.acronym})`:""}`,
      value:[
        `**Value:** \`${fmt(item.value)} R$\`  **RAP:** \`${item.rap?fmt(item.rap):"N/A"}\`${vsRap!==null?`  **vs RAP:** \`${parseFloat(vsRap)>=0?"+":""}${vsRap}%\``:""}`,
        `**Demand:** \`${item.demand??"—"}\`  **Trend:** \`${item.trend??"—"}\``,
        `**RSI:** ${rsiLabel}`,
        `[View on Rolimons](https://www.rolimons.com/item/${item.id})`,
      ].join("\n"),
    });
  }

  embed.setFooter({text:`RSI<30=oversold · RSI<50=below midline · Rolimons · ${new Date().toUTCString()}`});
  return interaction.editReply({embeds:[embed]});
}

// ─── Slash commands ───────────────────────────────────────────────────────────
const commands=[
  new SlashCommandBuilder()
    .setName("item")
    .setDescription("Look up a Roblox limited — value, RAP, best price, demand, OP ranges, RSI chart")
    .addStringOption(o=>o.setName("name").setDescription("Item name or acronym (e.g. Dinos, STF, DA)").setRequired(true)),

  new SlashCommandBuilder()
    .setName("compare")
    .setDescription("Compare two sides of a trade — up to 4 items each side")
    .addStringOption(o=>o.setName("give1").setDescription("Your item 1").setRequired(true))
    .addStringOption(o=>o.setName("get1").setDescription("Their item 1").setRequired(true))
    .addStringOption(o=>o.setName("give2").setDescription("Your item 2 (optional)"))
    .addStringOption(o=>o.setName("get2").setDescription("Their item 2 (optional)"))
    .addStringOption(o=>o.setName("give3").setDescription("Your item 3 (optional)"))
    .addStringOption(o=>o.setName("get3").setDescription("Their item 3 (optional)"))
    .addStringOption(o=>o.setName("give4").setDescription("Your item 4 (optional)"))
    .addStringOption(o=>o.setName("get4").setDescription("Their item 4 (optional)")),

  new SlashCommandBuilder()
    .setName("find")
    .setDescription("Find best items to trade for in a value range — ranked by RSI (oversold = best buy)")
    .addIntegerOption(o=>o.setName("min").setDescription("Minimum value in R$").setRequired(true))
    .addIntegerOption(o=>o.setName("max").setDescription("Maximum value in R$").setRequired(true))
    .addIntegerOption(o=>o.setName("results").setDescription("Number of results to show (1–5, default 3)")),

].map(c=>c.toJSON());

// ─── Client setup ─────────────────────────────────────────────────────────────
const client=new Client({intents:[GatewayIntentBits.Guilds]});

client.once("ready", async ()=>{
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  client.user.setActivity("Rolimons · /item /find", {type:ActivityType.Watching});
  const rest=new REST({version:"10"}).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(client.user.id),{body:commands});
  console.log("[Bot] Commands registered: /item /compare /find");
  await fetchDB();
  setInterval(fetchDB, 5*60*1000);
  // Refresh best prices every 30 minutes in background
  setTimeout(() => {
    refreshBestPrices();
    setInterval(refreshBestPrices, 30*60*1000);
  }, 60000); // start 1 min after bot loads
});

client.on("interactionCreate", async interaction=>{
  if (!interaction.isChatInputCommand()) return;
  const {commandName}=interaction;

  // ── /item ────────────────────────────────────────────────────────────────
  if (commandName==="item") {
    await interaction.deferReply();
    const item=findItem(interaction.options.getString("name"));
    if (!item) return interaction.editReply({content:`No item found. Try the full name or acronym.`});

    const [thumb, bestPrice, sales]=await Promise.all([
      item.thumbUrl?Promise.resolve(item.thumbUrl):fetchThumb(item.id),
      fetchBestPrice(item.id),
      fetchSalesHistory(item.id),
    ]);
    if (!item.thumbUrl&&thumb) item.thumbUrl=thumb;

    const prices=sales.map(s=>s.price);
    const rsi=prices.length>=15?calcRSI(prices):null;
    item.rsi=rsi;

    const op=calcOP(item);
    const embed=buildItemEmbed(item,bestPrice,op,rsi);

    try {
      const buf=await generateChart(item,sales);
      const file=new AttachmentBuilder(buf,{name:"chart.png"});
      embed.setImage("attachment://chart.png");
      return interaction.editReply({embeds:[embed],files:[file]});
    } catch(e) {
      console.error("[Chart]",e.message);
      return interaction.editReply({embeds:[embed]});
    }
  }

  // ── /find ─────────────────────────────────────────────────────────────────
  if (commandName==="find") return handleFind(interaction);

  // ── /compare ──────────────────────────────────────────────────────────────
  if (commandName==="compare") {
    await interaction.deferReply();
    const gNames=[1,2,3,4].map(n=>interaction.options.getString(`give${n}`)).filter(Boolean);
    const tNames=[1,2,3,4].map(n=>interaction.options.getString(`get${n}`)).filter(Boolean);

    const resolve=ns=>ns.map(n=>{
      const i=findItem(n);
      return i??{name:n,value:0,rap:null,demand:null,trend:null,projected:false,rare:false,notFound:true};
    });
    const gItems=resolve(gNames), tItems=resolve(tNames);
    const nf=[...gItems,...tItems].filter(i=>i.notFound).map(i=>i.name);
    if (nf.length) return interaction.editReply({content:`Could not find: **${nf.join(", ")}**`});

    await Promise.all([...gItems,...tItems].map(async i=>{if(!i.thumbUrl)i.thumbUrl=await fetchThumb(i.id);}));

    const gTotal=gItems.reduce((s,i)=>s+i.value,0);
    const tTotal=tItems.reduce((s,i)=>s+i.value,0);
    const diff=tTotal-gTotal, diffPct=gTotal>0?(diff/gTotal)*100:0;

    const ds={Amazing:4,High:3,Normal:2,Low:1,Terrible:0};
    const tScore=tItems.reduce((s,i)=>s+(ds[i.demand]??2),0);
    const gScore=gItems.reduce((s,i)=>s+(ds[i.demand]??2),0);
    const dDiff=tScore-gScore;

    let verdict,rating;
    if(diffPct>15){verdict="Heavy Win";rating="🟢🟢🟢";}
    else if(diffPct>5){verdict="Win";rating="🟢🟢";}
    else if(diffPct>=-5){verdict="Fair Trade";rating="🟡";}
    else if(diffPct>=-15){verdict="Loss";rating="🔴🔴";}
    else{verdict="Heavy Loss";rating="🔴🔴🔴";}

    const color=diffPct>5?0x10b981:diffPct<-5?0xef4444:0xf59e0b;
    const lines=[];

    const projG=gItems.filter(i=>i.projected), projT=tItems.filter(i=>i.projected);
    if(projG.length) lines.push(`⚠️ You are giving **${projG.map(i=>i.name).join(", ")}** which ${projG.length>1?"are":"is"} **Projected** by Rolimons. RAP is artificially inflated — most traders will not accept these at face value, and this significantly weakens your offer.`);
    if(projT.length) lines.push(`⚠️ You are receiving **${projT.map(i=>i.name).join(", ")}** which ${projT.length>1?"are":"is"} **Projected**. Be cautious — their true market value is likely lower than displayed.`);

    if(diffPct>15)    lines.push(`You are gaining significant value on this trade (+${diffPct.toFixed(1)}%). By Rolimons community standards this is a strong win. Most traders would accept this offer without hesitation.`);
    else if(diffPct>5)lines.push(`You are gaining value (+${diffPct.toFixed(1)}%). This is a favorable trade. The other party is giving a slight overpay, which is acceptable in the community.`);
    else if(diffPct>=-5)lines.push(`This trade is approximately even (${diffPct>=0?"+":""}${diffPct.toFixed(1)}%). By Rolimons standards this is a fair trade. Neither side is significantly overpaying.`);
    else if(diffPct>=-15)lines.push(`You are losing value on this trade (${diffPct.toFixed(1)}%). You are overpaying. Most experienced traders would decline or ask for an additional item to balance the trade.`);
    else lines.push(`You are losing significant value (${diffPct.toFixed(1)}%). This is a bad trade by Rolimons standards. You are heavily overpaying and most traders would not make this offer.`);

    if(dDiff>0) lines.push(`The items you are receiving have higher overall demand than what you are giving. This works in your favor — they will be easier to re-trade and hold their value better over time.`);
    else if(dDiff<0) lines.push(`The items you are giving have higher demand than what you are receiving. This works against you — lower demand items are harder to move and may lose value over time.`);

    const dG=gItems.filter(i=>i.trend==="Dropping").map(i=>i.name);
    const rG=gItems.filter(i=>i.trend==="Rising").map(i=>i.name);
    const dT=tItems.filter(i=>i.trend==="Dropping").map(i=>i.name);
    const rT=tItems.filter(i=>i.trend==="Rising").map(i=>i.name);
    if(dT.length) lines.push(`📉 **${dT.join(", ")}** (receiving) ${dT.length>1?"are":"is"} Dropping — value may continue to decrease.`);
    if(rT.length) lines.push(`📈 **${rT.join(", ")}** (receiving) ${rT.length>1?"are":"is"} Rising — a positive sign for holding value.`);
    if(dG.length) lines.push(`📉 **${dG.join(", ")}** (giving) ${dG.length>1?"are":"is"} Dropping — may be a good time to trade these away.`);
    if(rG.length) lines.push(`📈 **${rG.join(", ")}** (giving) ${rG.length>1?"are":"is"} Rising — consider whether you want to give away a rising item.`);

    const iLine=i=>{
      const fl=[i.projected?"🚨Proj":null,i.rare?"💎Rare":null].filter(Boolean).join(" ");
      return `**${i.name}**\nVal: \`${fmt(i.value)} R$\`  RAP: \`${i.rap?fmt(i.rap):"N/A"}\`\nDemand: \`${i.demand??"—"}\`  Trend: \`${i.trend??"—"}\`${fl?" · "+fl:""}`;
    };

    const embed=new EmbedBuilder()
      .setColor(color)
      .setTitle(`Trade Analysis — ${verdict} ${rating}`)
      .addFields(
        {name:"📤 You Are Giving",  value:gItems.map(iLine).join("\n\n"),inline:true},
        {name:"📥 You Are Getting", value:tItems.map(iLine).join("\n\n"),inline:true},
        {name:"\u200b",value:"\u200b"},
        {
          name:"💰 Value Summary",
          value:[
            `**Your offer:**  \`${fmt(gTotal)} R$\``,
            `**Their offer:** \`${fmt(tTotal)} R$\``,
            `**Difference:**  \`${diff>=0?"+":""}${fmt(diff)} R$ (${diffPct>=0?"+":""}${diffPct.toFixed(1)}%)\``,
            `**Verdict:** ${verdict} ${rating}`,
          ].join("\n"),
        },
        {name:"📋 Trade Analysis", value:lines.join("\n\n")||"No additional analysis."},
      )
      .setFooter({text:`Rolimons values · ${new Date().toUTCString()}`});

    const fg=tItems[0]; if(fg?.thumbUrl) embed.setThumbnail(fg.thumbUrl);
    return interaction.editReply({embeds:[embed]});
  }
});

client.login(TOKEN);
