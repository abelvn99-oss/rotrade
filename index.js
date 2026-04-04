const { Client, GatewayIntentBits, EmbedBuilder, SlashCommandBuilder, REST, Routes, ActivityType } = require("discord.js");
const axios = require("axios");

// ─── Config ────────────────────────────────────────────────────────────────
const config = {
  token:             process.env.BOT_TOKEN,
  alertChannelId:    process.env.ALERT_CHANNEL_ID,
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS) || 300000,
  salesIntervalMs:   Number(process.env.SALES_INTERVAL_MS)   || 30000,
  onlyUnder50k:      process.env.ONLY_UNDER_50K !== "false",
};
if (!config.token)          { console.error("ERROR: Missing BOT_TOKEN env var"); process.exit(1); }
if (!config.alertChannelId) { console.error("ERROR: Missing ALERT_CHANNEL_ID env var"); process.exit(1); }

// ─── State ─────────────────────────────────────────────────────────────────
let itemDB         = {};
let lastSnapshot   = {};
let lastMarketSales = [];
let dbLoadedAt     = null;

// ─── Rolimons mappings ─────────────────────────────────────────────────────
// demand: -1=none 0=Terrible 1=Low 2=Normal 3=High 4=Amazing
// trend:  -1=none 0=Fluctuating 1=Dropping 2=Unstable 3=Stable 4=Rising
function parseDemand(v) {
  const n = parseInt(v, 10);
  const map = { 0:"Terrible", 1:"Low", 2:"Normal", 3:"High", 4:"Amazing" };
  return map[n] ?? null; // null = truly unassigned by Rolimons
}
function parseTrend(v) {
  const n = parseInt(v, 10);
  const map = { 0:"Fluctuating", 1:"Dropping", 2:"Unstable", 3:"Stable", 4:"Rising" };
  return map[n] ?? null;
}

const DEMAND_COLOR = { Terrible:0xe0415a, Low:0xe8a020, Normal:0x1fcc74, High:0x3b9eff, Amazing:0x9b6dff };
const TREND_COLOR  = { Fluctuating:0xe8a020, Dropping:0xe0415a, Unstable:0xe8a020, Stable:0x1fcc74, Rising:0x3b9eff };
const TREND_EMOJI  = { Fluctuating:"〰️", Dropping:"📉", Unstable:"⚠️", Stable:"➡️", Rising:"📈" };

const fmt = (n) => Number(n).toLocaleString("en-US");

// ─── Item thumbnail ────────────────────────────────────────────────────────
async function fetchThumb(assetId) {
  // Try Roblox thumbnails API first
  try {
    const { data } = await axios.get(
      `https://thumbnails.roblox.com/v1/assets?assetIds=${assetId}&size=420x420&format=Png&isCircular=false`,
      { timeout: 8000, headers: { "User-Agent": "RoTradeBot/1.0" } }
    );
    const url = data?.data?.[0]?.imageUrl;
    if (url && url.startsWith("http")) return url;
  } catch {}
  // Fallback: Roblox item-thumbnails endpoint
  try {
    const { data } = await axios.get(
      `https://www.roblox.com/item-thumbnails?params=[{assetId:${assetId}}]`,
      { timeout: 8000, headers: { "User-Agent": "RoTradeBot/1.0" } }
    );
    const url = data?.[0]?.thumbnailUrl;
    if (url && url.startsWith("http")) return url;
  } catch {}
  return null;
}

// ─── Rolimons fetch ────────────────────────────────────────────────────────
async function fetchAllItems() {
  console.log("[Rolimons] Fetching item database...");
  // Try allitems first (has proper RAP in f[10])
  // Fall back to itemdetails if needed
  let raw = {};
  const ENDPOINTS = [
    "https://api.rolimons.com/items/v1/allitems",
    "https://www.rolimons.com/itemapi/itemdetails",
  ];
  for (const url of ENDPOINTS) {
    try {
      const { data } = await axios.get(url, {
        headers: { "User-Agent": "RoTradeBot/1.0", "Accept": "application/json" },
        timeout: 20000,
      });
      if (data.items && Object.keys(data.items).length > 0) {
        raw = data.items;
        console.log(`[Rolimons] Fetched from ${url}`);
        break;
      }
    } catch(e) { console.log(`[Rolimons] ${url} failed: ${e.message}`); }
  }
  const parsed = {};

  for (const [id, f] of Object.entries(raw)) {
    if (!Array.isArray(f) || !f[2]) continue;
    const value = Number(f[2]);  // community value
    const rap   = Number(f[10]);  // RAP (only valid on allitems endpoint)
    // If RAP is missing or 0, use value as fallback (better than wrong data)
    const rapFinal = (rap && rap > 0) ? rap : value;
    if (!value || value <= 0) continue;

    parsed[id] = {
      id,
      name:      f[0] || "Unknown",
      acronym:   f[1] || "",
      value,
      rap:       rapFinal,
      demand:    parseDemand(f[4]),
      trend:     parseTrend(f[5]),
      projected: Number(f[6]) === 1,
      hyped:     Number(f[7]) === 1,
      rare:      Number(f[8]) === 1,
      bestPrice: Math.round(rapFinal * 0.92),
      thumbUrl:  null,
    };
  }

  itemDB     = parsed;
  dbLoadedAt = new Date();
  console.log(`[Rolimons] Loaded ${Object.keys(parsed).length} valued items.`);
  return parsed;
}

async function fetchMarketActivity() {
  try {
    const { data } = await axios.get("https://www.rolimons.com/api/activity/v1/recentmajoritems", {
      headers: { "User-Agent": "RoTradeBot/1.0" },
      timeout: 10000,
    });
    return data.activities || [];
  } catch { return []; }
}

// ─── Change detection ──────────────────────────────────────────────────────
function detectChanges(newDB) {
  const changes = [];
  for (const [id, item] of Object.entries(newDB)) {
    const old = lastSnapshot[id];
    if (!old) continue;
    if (old.value    !== item.value)    changes.push({ type:"value_change",  item, oldValue:old.value, newValue:item.value });
    if (old.demand   !== item.demand)   changes.push({ type:"demand_change", item, oldDemand:old.demand, newDemand:item.demand });
    if (old.trend    !== item.trend)    changes.push({ type:"trend_change",  item, oldTrend:old.trend, newTrend:item.trend });
    if (!old.projected && item.projected) changes.push({ type:"projected", item });
  }
  return changes;
}

function snapshotDB(db) {
  const snap = {};
  for (const [id, item] of Object.entries(db)) {
    snap[id] = { value:item.value, demand:item.demand, trend:item.trend, projected:item.projected };
  }
  return snap;
}

// ─── Item search ───────────────────────────────────────────────────────────
function findItem(query) {
  const q   = query.toLowerCase().trim();
  const all = Object.values(itemDB);
  const exact = all.find(i => i.acronym.toLowerCase() === q);
  if (exact) return exact;
  const nameExact = all.find(i => i.name.toLowerCase() === q);
  if (nameExact) return nameExact;
  const partial = all.filter(i => i.name.toLowerCase().includes(q) || i.acronym.toLowerCase().includes(q));
  if (partial.length === 0) return null;
  return partial.sort((a, b) => a.name.length - b.name.length)[0];
}

// ─── Embed builders ────────────────────────────────────────────────────────
function buildItemEmbed(item) {
  const vsRap  = ((item.value / item.rap - 1) * 100).toFixed(2);
  const color  = item.projected ? 0xe0415a : (item.demand ? DEMAND_COLOR[item.demand] : 0x5a6480);
  const flags  = [
    item.projected ? "🚨 **Projected** — RAP artificially inflated" : null,
    item.rare      ? "💎 Rare"  : null,
    item.hyped     ? "🔥 Hyped" : null,
  ].filter(Boolean);

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(item.name)
    .setURL(`https://www.rolimons.com/item/${item.id}`)
    .setDescription(item.acronym ? `**${item.acronym}** · Asset ID: \`${item.id}\`` : `Asset ID: \`${item.id}\``)
    .addFields(
      { name:"RAP",        value:`\`${fmt(item.rap)} R$\``,       inline:true },
      { name:"Value",      value:`\`${fmt(item.value)} R$\``,     inline:true },
      { name:"Best Price", value:`\`${fmt(item.bestPrice)} R$\``, inline:true },
      { name:"vs RAP",     value:`\`${parseFloat(vsRap)>=0?"+":""}${vsRap}%\``, inline:true },
      { name:"Demand",     value: item.demand ? `\`${item.demand}\`` : "`Not set by Rolimons`", inline:true },
      { name:"Trend",      value: item.trend  ? `${TREND_EMOJI[item.trend]} \`${item.trend}\`` : "`Not set by Rolimons`", inline:true },
    )
    .addFields({ name:"Flags", value: flags.length ? flags.join("\n") : "None" })
    .setFooter({ text:`Rolimons · ${new Date().toUTCString()}` });

  if (item.thumbUrl) embed.setThumbnail(item.thumbUrl);
  return embed;
}

function buildValueChangeEmbed(change) {
  const { item, oldValue, newValue } = change;
  const diff    = newValue - oldValue;
  const diffPct = ((diff / oldValue) * 100).toFixed(2);
  const up      = diff > 0;
  const embed   = new EmbedBuilder()
    .setColor(up ? 0x1fcc74 : 0xe0415a)
    .setTitle(`${up ? "Value Up" : "Value Down"} — ${item.name}`)
    .setURL(`https://www.rolimons.com/item/${item.id}`)
    .addFields(
      { name:"Old Value", value:`\`${fmt(oldValue)} R$\``, inline:true },
      { name:"New Value", value:`\`${fmt(newValue)} R$\``, inline:true },
      { name:"Change",    value:`\`${up?"+":""}${fmt(diff)} R$ (${up?"+":""}${diffPct}%)\``, inline:true },
      { name:"RAP",       value:`\`${fmt(item.rap)} R$\``, inline:true },
      { name:"Demand",    value: item.demand ? `\`${item.demand}\`` : "`Not set`", inline:true },
      { name:"Trend",     value: item.trend  ? `\`${item.trend}\`` : "`Not set`",  inline:true },
    )
    .setFooter({ text:`Rolimons Value Change · ${new Date().toUTCString()}` });
  if (item.thumbUrl) embed.setThumbnail(item.thumbUrl);
  return embed;
}

function buildProjectedEmbed(item) {
  return new EmbedBuilder()
    .setColor(0xe0415a)
    .setTitle(`Projected Flag — ${item.name}`)
    .setURL(`https://www.rolimons.com/item/${item.id}`)
    .setDescription(
      `**${item.name}** has been flagged as **Projected** by Rolimons.\n\n` +
      `RAP has been artificially inflated. The true market value is likely significantly lower.\n\n` +
      `**Do not trade for this item at face value.**`
    )
    .addFields(
      { name:"RAP",   value:`\`${fmt(item.rap)} R$\``,   inline:true },
      { name:"Value", value:`\`${fmt(item.value)} R$\``, inline:true },
    )
    .setFooter({ text:`Rolimons Projection Alert · ${new Date().toUTCString()}` });
}

function buildOPEmbed(giveItem, getItem) {
  const diff  = giveItem.value - getItem.value;
  const ratio = ((diff / getItem.value) * 100).toFixed(2);
  let verdict, color;
  if (parseFloat(ratio) > 8)       { verdict = "Heavy overpay — you are losing significant value."; color = 0xe0415a; }
  else if (parseFloat(ratio) > 2)  { verdict = "Slight overpay — marginally unfavorable.";          color = 0xe8a020; }
  else if (parseFloat(ratio) < -8) { verdict = "Favorable — you gain value on this trade.";         color = 0x1fcc74; }
  else                              { verdict = "Fair trade — values are approximately balanced.";   color = 0x3b9eff; }
  const warnings = [
    giveItem.projected ? `🚨 **${giveItem.name}** is Projected — RAP inflated` : null,
    getItem.projected  ? `🚨 **${getItem.name}** is Projected — RAP inflated`  : null,
  ].filter(Boolean);
  return new EmbedBuilder()
    .setColor(color)
    .setTitle("Trade Analysis")
    .addFields(
      { name:"You Give", value:`**${giveItem.name}**\nValue: \`${fmt(giveItem.value)} R$\` · RAP: \`${fmt(giveItem.rap)} R$\``, inline:true },
      { name:"You Get",  value:`**${getItem.name}**\nValue: \`${fmt(getItem.value)} R$\` · RAP: \`${fmt(getItem.rap)} R$\``,   inline:true },
      { name:"Difference", value:`\`${diff>=0?"+":""}${fmt(diff)} R$ (${diff>=0?"+":""}${ratio}%)\`` },
      { name:"Verdict", value:verdict },
      ...(warnings.length ? [{ name:"Warnings", value:warnings.join("\n") }] : []),
    )
    .setFooter({ text:`Rolimons values · ${new Date().toUTCString()}` });
}

// ─── Slash commands ────────────────────────────────────────────────────────
const commands = [
  new SlashCommandBuilder().setName("item").setDescription("Look up a Roblox limited item from Rolimons")
    .addStringOption(o => o.setName("name").setDescription("Item name or acronym").setRequired(true)),
  new SlashCommandBuilder().setName("rap").setDescription("Quick RAP and value lookup")
    .addStringOption(o => o.setName("name").setDescription("Item name or acronym").setRequired(true)),
  new SlashCommandBuilder().setName("compare").setDescription("Analyze a trade between two items")
    .addStringOption(o => o.setName("give").setDescription("Item you are giving").setRequired(true))
    .addStringOption(o => o.setName("get").setDescription("Item you are getting").setRequired(true)),
  new SlashCommandBuilder().setName("catalog").setDescription("Browse valued limiteds under 50K RAP")
    .addStringOption(o => o.setName("demand").setDescription("Filter by demand").addChoices(
      {name:"All",value:"all"},{name:"Terrible",value:"Terrible"},{name:"Low",value:"Low"},
      {name:"Normal",value:"Normal"},{name:"High",value:"High"},{name:"Amazing",value:"Amazing"}))
    .addStringOption(o => o.setName("trend").setDescription("Filter by trend").addChoices(
      {name:"All",value:"all"},{name:"Dropping",value:"Dropping"},{name:"Unstable",value:"Unstable"},
      {name:"Stable",value:"Stable"},{name:"Rising",value:"Rising"},{name:"Fluctuating",value:"Fluctuating"}))
    .addBooleanOption(o => o.setName("projected_only").setDescription("Show only projected items")),
  new SlashCommandBuilder().setName("projected").setDescription("List all currently projected items"),
  new SlashCommandBuilder().setName("refresh").setDescription("Force-refresh the Rolimons database"),
  new SlashCommandBuilder().setName("status").setDescription("Bot status and database stats"),
].map(c => c.toJSON());

// ─── Client ────────────────────────────────────────────────────────────────
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

client.once("ready", async () => {
  console.log(`[Bot] Logged in as ${client.user.tag}`);
  client.user.setActivity("Rolimons · /item", { type: ActivityType.Watching });
  const rest = new REST({ version:"10" }).setToken(config.token);
  await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
  console.log("[Bot] Slash commands registered.");
  const db = await fetchAllItems();
  lastSnapshot = snapshotDB(db);
  startMonitor();
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  await interaction.deferReply();
  const { commandName } = interaction;

  // /item
  if (commandName === "item") {
    const item = findItem(interaction.options.getString("name"));
    if (!item) return interaction.editReply({ content: `No item found. Try the full name or acronym.` });
    // fetch thumb if not cached — store on item object for reuse
    if (item.thumbUrl === null) {
      item.thumbUrl = await fetchThumb(item.id);
      console.log(`[Thumb] ${item.name}: ${item.thumbUrl ?? "not found"}`);
    }
    return interaction.editReply({ embeds: [buildItemEmbed(item)] });
  }

  // /rap
  if (commandName === "rap") {
    const item = findItem(interaction.options.getString("name"));
    if (!item) return interaction.editReply({ content: `No item found.` });
    if (!item.thumbUrl) item.thumbUrl = await fetchThumb(item.id);
    const vsRap = ((item.value / item.rap - 1) * 100).toFixed(2);
    const embed = new EmbedBuilder()
      .setColor(item.demand ? DEMAND_COLOR[item.demand] : 0x5a6480)
      .setTitle(item.name)
      .setURL(`https://www.rolimons.com/item/${item.id}`)
      .setDescription([
        `**RAP:** \`${fmt(item.rap)} R$\``,
        `**Value:** \`${fmt(item.value)} R$\``,
        `**Best Price:** \`${fmt(item.bestPrice)} R$\``,
        `**vs RAP:** \`${parseFloat(vsRap)>=0?"+":""}${vsRap}%\``,
        `**Demand:** \`${item.demand ?? "Not set by Rolimons"}\``,
        `**Trend:** ${item.trend ? TREND_EMOJI[item.trend]+" \`"+item.trend+"\`" : "`Not set by Rolimons`"}`,
        item.projected ? "\n🚨 **Projected** — Do not trade at face value" : "",
      ].filter(Boolean).join("\n"))
      .setFooter({ text:`Rolimons · ${new Date().toUTCString()}` });
    if (item.thumbUrl) embed.setThumbnail(item.thumbUrl);
    return interaction.editReply({ embeds: [embed] });
  }

  // /compare
  if (commandName === "compare") {
    const give = findItem(interaction.options.getString("give"));
    const get  = findItem(interaction.options.getString("get"));
    if (!give) return interaction.editReply({ content: `Could not find: **"${interaction.options.getString("give")}"**` });
    if (!get)  return interaction.editReply({ content: `Could not find: **"${interaction.options.getString("get")}"**` });
    return interaction.editReply({ embeds: [buildOPEmbed(give, get)] });
  }

  // /catalog
  if (commandName === "catalog") {
    const demandF = interaction.options.getString("demand")         ?? "all";
    const trendF  = interaction.options.getString("trend")          ?? "all";
    const projOnly= interaction.options.getBoolean("projected_only") ?? false;
    let results   = Object.values(itemDB).filter(i => i.rap < 50000);
    if (demandF !== "all") results = results.filter(i => i.demand === demandF);
    if (trendF  !== "all") results = results.filter(i => i.trend  === trendF);
    if (projOnly)          results = results.filter(i => i.projected);
    results.sort((a, b) => b.rap - a.rap);
    if (results.length === 0) return interaction.editReply({ content: "No items match those filters." });
    const lines = results.slice(0, 20).map((i, n) =>
      `\`${String(n+1).padStart(2)}\` **${i.name}**${i.acronym ? ` (${i.acronym})` : ""}\n` +
      `     RAP \`${fmt(i.rap)}\` · Val \`${fmt(i.value)}\`` +
      (i.demand ? ` · ${i.demand}` : "") +
      (i.trend  ? ` · ${TREND_EMOJI[i.trend]} ${i.trend}` : "") +
      (i.projected ? " · 🚨 Proj" : "") + (i.rare ? " · 💎 Rare" : "")
    );
    return interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0x3b9eff)
        .setTitle("Valued Limiteds Under 50K RAP")
        .setDescription(lines.join("\n\n"))
        .setFooter({ text:`${results.length} results · Showing top 20 · Sorted by RAP` })
    ]});
  }

  // /projected
  if (commandName === "projected") {
    const proj = Object.values(itemDB).filter(i => i.projected).sort((a,b) => b.rap - a.rap);
    if (proj.length === 0) return interaction.editReply({ content: "No projected items currently." });
    const lines = proj.slice(0,25).map((i,n) =>
      `\`${String(n+1).padStart(2)}\` **${i.name}** · RAP \`${fmt(i.rap)}\` · Val \`${fmt(i.value)}\``
    );
    return interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0xe0415a)
        .setTitle("Currently Projected Items")
        .setDescription("These items have artificially inflated RAP. **Do not trade at face value.**\n\n" + lines.join("\n"))
        .setFooter({ text:`${proj.length} projected items · ${new Date().toUTCString()}` })
    ]});
  }

  // /refresh
  if (commandName === "refresh") {
    try {
      await interaction.editReply({ content: "Fetching latest data from Rolimons..." });
      const newDB   = await fetchAllItems();
      const changes = detectChanges(newDB);
      lastSnapshot  = snapshotDB(newDB);
      return interaction.editReply({ content:"", embeds: [
        new EmbedBuilder().setColor(0x1fcc74).setTitle("Database Refreshed")
          .addFields(
            { name:"Items Loaded",    value:`\`${fmt(Object.keys(newDB).length)}\``, inline:true },
            { name:"Value Changes",   value:`\`${changes.filter(c=>c.type==="value_change").length}\``, inline:true },
            { name:"New Projections", value:`\`${changes.filter(c=>c.type==="projected").length}\``, inline:true },
          )
          .setFooter({ text:`Refreshed at ${new Date().toUTCString()}` })
      ]});
    } catch(e) {
      return interaction.editReply({ content:`Failed to refresh: ${e.message}` });
    }
  }

  // /status
  if (commandName === "status") {
    const all = Object.values(itemDB);
    return interaction.editReply({ embeds: [
      new EmbedBuilder().setColor(0x1fcc74).setTitle("RoTrade Bot — Status")
        .addFields(
          { name:"Total Items",    value:`\`${fmt(all.length)}\``,                                    inline:true },
          { name:"Under 50K RAP", value:`\`${fmt(all.filter(i=>i.rap<50000).length)}\``,              inline:true },
          { name:"Projected",     value:`\`${fmt(all.filter(i=>i.projected).length)}\``,              inline:true },
          { name:"Rising",        value:`\`${fmt(all.filter(i=>i.trend==="Rising").length)}\``,       inline:true },
          { name:"Dropping",      value:`\`${fmt(all.filter(i=>i.trend==="Dropping").length)}\``,     inline:true },
          { name:"DB Updated",    value: dbLoadedAt ? `<t:${Math.floor(dbLoadedAt.getTime()/1000)}:R>` : "Never" },
        )
        .setFooter({ text:`Ping: ${client.ws.ping}ms` })
    ]});
  }
});

// ─── Monitor loop ──────────────────────────────────────────────────────────
function startMonitor() {
  const channel = client.channels.cache.get(config.alertChannelId);

  setInterval(async () => {
    try {
      const newDB   = await fetchAllItems();
      const changes = detectChanges(newDB);
      lastSnapshot  = snapshotDB(newDB);
      if (!channel) return;
      for (const change of changes) {
        if (config.onlyUnder50k && change.item.rap >= 50000) continue;
        if (change.type === "value_change")  await channel.send({ embeds: [buildValueChangeEmbed(change)] });
        if (change.type === "projected")     await channel.send({ embeds: [buildProjectedEmbed(change.item)] });
        if (change.type === "demand_change") {
          await channel.send({ embeds: [new EmbedBuilder()
            .setColor(change.newDemand ? DEMAND_COLOR[change.newDemand] : 0x5a6480)
            .setTitle(`Demand Change — ${change.item.name}`)
            .setURL(`https://www.rolimons.com/item/${change.item.id}`)
            .setDescription(`Demand: \`${change.oldDemand ?? "Not set"}\` → \`${change.newDemand ?? "Not set"}\``)
            .addFields(
              { name:"RAP",   value:`\`${fmt(change.item.rap)} R$\``,   inline:true },
              { name:"Value", value:`\`${fmt(change.item.value)} R$\``, inline:true },
            )
            .setFooter({ text:`Rolimons · ${new Date().toUTCString()}` })]});
        }
        if (change.type === "trend_change") {
          await channel.send({ embeds: [new EmbedBuilder()
            .setColor(change.newTrend ? TREND_COLOR[change.newTrend] : 0x5a6480)
            .setTitle(`Trend Change — ${change.item.name}`)
            .setURL(`https://www.rolimons.com/item/${change.item.id}`)
            .setDescription(`Trend: \`${change.oldTrend ?? "Not set"}\` → \`${change.newTrend ? TREND_EMOJI[change.newTrend]+" "+change.newTrend : "Not set"}\``)
            .setFooter({ text:`Rolimons · ${new Date().toUTCString()}` })]});
        }
      }
    } catch(e) { console.error("[Monitor] Error:", e.message); }
  }, config.refreshIntervalMs);

  setInterval(async () => {
    try {
      const activities = await fetchMarketActivity();
      if (!channel || !activities.length) return;
      const newSales = activities.filter(a => !lastMarketSales.find(o => o.id === a.id));
      lastMarketSales = activities.slice(0, 50);
      for (const sale of newSales.slice(0, 5)) {
        const item = itemDB[String(sale.asset_id)];
        if (!item) continue;
        if (config.onlyUnder50k && item.rap >= 50000) continue;
        const salePrice = sale.price ?? 0;
        const vsRap     = salePrice && item.rap ? ((salePrice/item.rap-1)*100).toFixed(2) : null;
        const up        = vsRap !== null && parseFloat(vsRap) >= 0;
        const embed     = new EmbedBuilder()
          .setColor(up ? 0x1fcc74 : 0xe0415a)
          .setTitle(`Sale — ${item.name}`)
          .setURL(`https://www.rolimons.com/item/${item.id}`)
          .addFields(
            { name:"Sale Price", value:`\`${fmt(salePrice)} R$\``, inline:true },
            { name:"RAP",        value:`\`${fmt(item.rap)} R$\``,  inline:true },
            { name:"vs RAP",     value: vsRap !== null ? `\`${up?"+":""}${vsRap}%\`` : "N/A", inline:true },
          )
          .setFooter({ text:`Rolimons Market Activity · ${new Date().toUTCString()}` });
        if (item.thumbUrl) embed.setThumbnail(item.thumbUrl);
        await channel.send({ embeds: [embed] });
      }
    } catch { /* silent */ }
  }, config.salesIntervalMs);

  console.log("[Monitor] Started. Refresh every", config.refreshIntervalMs/1000, "seconds.");
}

client.login(config.token);
