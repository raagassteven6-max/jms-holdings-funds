// ============================================================
// JMS Holdings — Ownership Dashboard  (app.js)
// Part 1 of 2: core application (config, data layer, cache,
// render logic, analytics, setup handlers, tools, tabs, add/update)
// ============================================================

// ============================================
// CONFIGURATION
// ============================================
const HARDCODED_BIN_ID = "";
const HARDCODED_API_KEY = "";

const PALETTE = ["#0f766e", "#f59e0b", "#6366f1", "#dc2626", "#0891b2", "#7c3aed", "#65a30d", "#db2777"];
let entries = [];
let pvSnapshots = []; // Array of {date, value} for permanent PV history
let chart = null;
let useLocalFallback = false;

let BIN_ID = "";
let API_KEY = "";

const LOCAL_KEY = "jms_holdings_entries_v3";
const CONFIG_KEY = "jms_jsonbin_config_v2";
const PV_SNAPSHOTS_KEY = "jms_pv_snapshots_v1";

// Chart instances for analytics
let fundChart = null;
let contribChart = null;
let memberChart = null;

const debugLines = [];
function logDebug(msg, type="info"){
  const ts = new Date().toLocaleTimeString();
  const line = `<span class="ts">[${ts}]</span> <span class="${type}">${escapeHtml(msg)}</span>`;
  debugLines.push(line);
  if(debugLines.length > 50) debugLines.shift();
  const el = document.getElementById("debug-log");
  if(el) el.innerHTML = debugLines.join("\n");
  console.log(`[${ts}] ${msg}`);
}

function loadConfig(){
  if(HARDCODED_BIN_ID && HARDCODED_API_KEY){
    BIN_ID = HARDCODED_BIN_ID;
    API_KEY = HARDCODED_API_KEY;
    logDebug("Using hardcoded config", "ok");
    return true;
  }
  try{
    const saved = localStorage.getItem(CONFIG_KEY);
    if(saved){
      const cfg = JSON.parse(saved);
      if(cfg.binId && cfg.apiKey){
        BIN_ID = cfg.binId;
        API_KEY = cfg.apiKey;
        logDebug(`Loaded config: binId=${cfg.binId}`, "ok");
        return true;
      }
    }
  }catch(e){
    logDebug("Config load error: " + e.message, "err");
  }
  logDebug("No config found", "warn");
  return false;
}

function saveConfig(binId, apiKey){
  BIN_ID = binId;
  API_KEY = apiKey;
  try{
    localStorage.setItem(CONFIG_KEY, JSON.stringify({binId, apiKey}));
    logDebug("Config saved to localStorage", "ok");
  }catch(e){
    logDebug("Config save error: " + e.message, "err");
  }
}

function clearConfig(){
  BIN_ID = "";
  API_KEY = "";
  try{
    localStorage.removeItem(CONFIG_KEY);
    logDebug("Config cleared from localStorage", "warn");
  }catch(e){}
}

function loadLocalEntries(){
  try{
    const saved = localStorage.getItem(LOCAL_KEY);
    if(saved){
      const data = JSON.parse(saved);
      if(data && typeof data === "object"){
        if(Array.isArray(data.entries)){
          entries = data.entries;
          pvSnapshots = data.pvSnapshots || [];
        } else if(Array.isArray(data)){
          entries = data;
          pvSnapshots = [];
        }
      } else if(Array.isArray(data)){
        entries = data;
        pvSnapshots = [];
      }
      logDebug(`Loaded ${entries.length} entries from localStorage`, "ok");
      return true;
    }
  }catch(e){
    logDebug("Local load error: " + e.message, "err");
  }
  entries = [];
  pvSnapshots = [];
  logDebug("No local entries found", "warn");
  return false;
}

function saveLocalEntries(){
  try{
    const payload = {
      entries: entries,
      pvSnapshots: pvSnapshots
    };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(payload));
    logDebug(`Saved ${entries.length} entries to localStorage`, "ok");
  }catch(e){
    logDebug("Local save error: " + e.message, "err");
  }
}

function loadPVSnapshots(){
  try{
    const saved = localStorage.getItem(PV_SNAPSHOTS_KEY);
    if(saved){
      pvSnapshots = JSON.parse(saved);
      if(!Array.isArray(pvSnapshots)) pvSnapshots = [];
    }
    // Show latest value in input
    const latest = getLatestPV();
    if(latest !== null){
      document.getElementById("f-current-pv").value = latest;
    }
  }catch(e){
    pvSnapshots = [];
  }
}

function getLatestPV(){
  if(!pvSnapshots || pvSnapshots.length === 0) return null;
  return pvSnapshots[pvSnapshots.length - 1].value;
}

function getPVForDate(dateStr){
  // Find the most recent snapshot on or before the given date
  if(!pvSnapshots || pvSnapshots.length === 0) return null;
  let best = null;
  for(const snap of pvSnapshots){
    if(snap.date <= dateStr) best = snap.value;
  }
  return best;
}

function savePVSnapshot(value){
  // Use LOCAL date, not UTC — fixes early-morning snapshots appearing on wrong day
  const d = new Date();
  const today = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
  // Check if we already have a snapshot for today - update it
  const existing = pvSnapshots.find(s => s.date === today);
  if(existing){
    existing.value = value;
  } else {
    pvSnapshots.push({date: today, value: value});
    pvSnapshots.sort((a,b) => a.date.localeCompare(b.date));
  }
  try{
    localStorage.setItem(PV_SNAPSHOTS_KEY, JSON.stringify(pvSnapshots));
  }catch(e){}
}

function clearPVSnapshots(){
  pvSnapshots = [];
  try{
    localStorage.removeItem(PV_SNAPSHOTS_KEY);
  }catch(e){}
}

// ============================================
// JSONBIN.IO API
// ============================================
const JSONBIN_ROOT = "https://api.jsonbin.io/v3";

async function jsonbinRead(){
  logDebug(`READ  -> ${JSONBIN_ROOT}/b/${BIN_ID}/latest`);
  const res = await fetch(`${JSONBIN_ROOT}/b/${BIN_ID}/latest`, {
    method: "GET",
    headers: { "X-Master-Key": API_KEY }
  });
  logDebug(`READ  <- HTTP ${res.status} ${res.statusText}`);
  if(!res.ok){
    let errMsg = `HTTP ${res.status}`;
    try{
      const err = await res.json();
      errMsg = err.message || JSON.stringify(err);
    }catch(e){}
    throw new Error(errMsg);
  }
  const data = await res.json();
  logDebug(`READ  <- payload type: ${typeof data.record}`, "ok");
  return data.record || data;
}

async function jsonbinUpdate(payload){
  const entryCount = payload.entries ? payload.entries.length : (Array.isArray(payload) ? payload.length : "?");
  logDebug(`WRITE -> ${JSONBIN_ROOT}/b/${BIN_ID} (${entryCount} entries)`);
  const res = await fetch(`${JSONBIN_ROOT}/b/${BIN_ID}`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": API_KEY
    },
    body: JSON.stringify(payload)
  });
  logDebug(`WRITE <- HTTP ${res.status} ${res.statusText}`);
  if(!res.ok){
    let errMsg = `HTTP ${res.status}`;
    try{
      const err = await res.json();
      errMsg = err.message || JSON.stringify(err);
    }catch(e){}
    throw new Error(errMsg);
  }
  return await res.json();
}

async function jsonbinCreate(payload){
  logDebug(`CREATE -> new bin`);
  const res = await fetch(`${JSONBIN_ROOT}/b`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Master-Key": API_KEY
    },
    body: JSON.stringify(payload)
  });
  logDebug(`CREATE <- HTTP ${res.status} ${res.statusText}`);
  if(!res.ok){
    let errMsg = `HTTP ${res.status}`;
    try{
      const err = await res.json();
      errMsg = err.message || JSON.stringify(err);
    }catch(e){}
    throw new Error(errMsg);
  }
  const data = await res.json();
  logDebug(`CREATE <- binId=${data.metadata ? data.metadata.id : "???"}`, "ok");
  return data.metadata ? data.metadata.id : null;
}

// ============================================
// DATA LAYER
// ============================================
async function loadEntries(){
  const banner = document.getElementById("status-banner");
  banner.textContent = "";

  loadLocalEntries();

  if(!BIN_ID || !API_KEY){
    logDebug("No cloud config, using local only", "warn");
    render();
    return;
  }

  try{
    const data = await jsonbinRead();
    if(data && typeof data === "object"){
      if(Array.isArray(data.entries)){
        entries = data.entries;
        pvSnapshots = data.pvSnapshots || [];
      } else if(Array.isArray(data)){
        entries = data;
        pvSnapshots = [];
      } else {
        entries = [];
        pvSnapshots = [];
      }
    } else {
      entries = [];
      pvSnapshots = [];
    }
    saveLocalEntries();
    invalidateCache("all");
    const latestPV = getLatestPV();
    if(latestPV !== null){
      document.getElementById("f-current-pv").value = latestPV;
    }
    banner.textContent = "";
    useLocalFallback = false;
    logDebug("Cloud load successful, synced to local", "ok");
  }catch(e){
    logDebug("Cloud load FAILED: " + e.message, "err");
    banner.textContent = "⚠ Cloud load failed — showing locally saved data. Check your connection.";
    useLocalFallback = true;
  }
  render();
}

async function saveEntries(){
  const banner = document.getElementById("status-banner");

  saveLocalEntries();

  if(!BIN_ID || !API_KEY){
    banner.textContent = "⚠ Not connected to cloud. Data saved locally in this browser only.";
    logDebug("No cloud config, saved local only", "warn");
    return false;
  }

  const payload = {
    entries: entries,
    pvSnapshots: pvSnapshots
  };

  const maxAttempts = 3;
  for(let attempt = 1; attempt <= maxAttempts; attempt++){
    try{
      await jsonbinUpdate(payload);
      banner.textContent = "";
      useLocalFallback = false;
      logDebug(`Cloud save successful (attempt ${attempt})`, "ok");
      return true;
    }catch(e){
      logDebug(`Cloud save attempt ${attempt} FAILED: ${e.message}`, "err");
      if(attempt < maxAttempts){
        const delay = 800 * attempt;
        logDebug(`Retrying in ${delay}ms...`, "warn");
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }
  banner.textContent = "⚠ Cloud save failed — data saved locally. Check your Bin ID / API Key.";
  useLocalFallback = true;
  logDebug("All cloud save attempts exhausted", "err");
  return false;
}

// ============================================
// MULTI-LEVEL CACHE
// ============================================
const _CACHE = {
  ledger:    { key: null, data: null, hits: 0, misses: 0 },
  fundHist:  { key: null, data: null, hits: 0, misses: 0 },
  memberHist:{},  // keyed by "memberName|entriesKey|pvKey"
  perf:      { key: null, data: null, hits: 0, misses: 0 },
};

function _entriesKey(){
  if(entries.length === 0) return "empty";
  const last = entries[entries.length - 1];
  return `${entries.length}|${last.date || ""}|${last.amount || 0}|${last.member || ""}`;
}

function _pvKey(){
  if(!pvSnapshots || pvSnapshots.length === 0) return "no-pv";
  const last = pvSnapshots[pvSnapshots.length - 1];
  return `${pvSnapshots.length}|${last.date || ""}|${last.value || 0}`;
}

function _fullKey(){ return _entriesKey() + "||" + _pvKey(); }

function _cacheHit(level, key){
  if(_CACHE[level].key === key){
    _CACHE[level].hits++;
    return _CACHE[level].data;
  }
  return null;
}
function _cacheSet(level, key, data){
  _CACHE[level].key = key;
  _CACHE[level].data = data;
  _CACHE[level].misses++;
}

function invalidateCache(level){
  if(level === "all" || level === "ledger"){
    _CACHE.ledger.key = null; _CACHE.ledger.data = null;
  }
  if(level === "all" || level === "fundHist"){
    _CACHE.fundHist.key = null; _CACHE.fundHist.data = null;
  }
  if(level === "all" || level === "memberHist"){
    _CACHE.memberHist = {};
  }
  if(level === "all" || level === "perf"){
    _CACHE.perf.key = null; _CACHE.perf.data = null;
  }
  logDebug(`Cache invalidated: ${level}`, "warn");
}

// ============================================
// CORE LOGIC (Fund)
// ============================================
function computeLedger(){
  const key = _entriesKey();
  const cached = _cacheHit("ledger", key);
  if(cached){
    logDebug("CACHE HIT: computeLedger", "ok");
    return cached;
  }

  let unitsOutstanding = 0;
  const rows = [];
  for(const e of entries){
    const before = unitsOutstanding;
    let nav, unitsIssued, warning = null;
    if(before === 0){
      nav = 1;
    } else if(e.pv === null || e.pv === undefined || isNaN(e.pv)){
      warning = "Missing portfolio value";
      nav = null;
    } else {
      nav = e.pv / before;
    }
    if(nav !== null){
      unitsIssued = e.amount / nav;
      unitsOutstanding = before + unitsIssued;
    } else {
      unitsIssued = null;
    }
    rows.push({...e, before, nav, unitsIssued, warning});
  }
  const result = { rows, totalUnits: unitsOutstanding };
  _cacheSet("ledger", key, result);
  logDebug("CACHE MISS: computeLedger computed", "warn");
  return result;
}

function computeOwnership(rows, totalUnits){
  const byMember = {};
  const memberContributions = {};
  for(const r of rows){
    if(r.unitsIssued === null) continue;
    byMember[r.member] = (byMember[r.member] || 0) + r.unitsIssued;
    memberContributions[r.member] = (memberContributions[r.member] || 0) + r.amount;
  }
  const list = Object.entries(byMember).map(([name, units]) => ({
    name, units, pct: totalUnits > 0 ? (units / totalUnits) * 100 : 0,
    totalContributed: memberContributions[name] || 0
  }));
  list.sort((a,b) => b.units - a.units);
  return list;
}

function computePerformance(ownership, totalUnits){
  const key = _fullKey();
  const cached = _cacheHit("perf", key);
  if(cached){
    logDebug("CACHE HIT: computePerformance", "ok");
    return cached;
  }

  const latestPV = getLatestPV();
  if(!latestPV || latestPV <= 0 || totalUnits <= 0){
    return null;
  }
  const currentNav = latestPV / totalUnits;
  const totalContributed = ownership.reduce((sum, m) => sum + m.totalContributed, 0);
  const totalCurrentValue = latestPV;
  const gainLoss = totalCurrentValue - totalContributed;
  const gainLossPct = totalContributed > 0 ? (gainLoss / totalContributed) * 100 : 0;

  const memberPerf = ownership.map(m => {
    const currentValue = m.units * currentNav;
    const gain = currentValue - m.totalContributed;
    const gainPct = m.totalContributed > 0 ? (gain / m.totalContributed) * 100 : 0;
    return {...m, currentValue, gain, gainPct, currentNav};
  });

  const result = {totalContributed, totalCurrentValue, gainLoss, gainLossPct, currentNav, memberPerf};
  _cacheSet("perf", key, result);
  logDebug("CACHE SET: computePerformance", "ok");
  return result;
}

function fmtPeso(n){
  return "₱" + Number(n).toLocaleString("en-PH", {minimumFractionDigits:2, maximumFractionDigits:2});
}
function fmtUnits(n){
  return Number(n).toLocaleString("en-PH", {minimumFractionDigits:4, maximumFractionDigits:4});
}

function render(){
  const { rows, totalUnits } = computeLedger();
  const ownership = computeOwnership(rows, totalUnits);
  const perf = computePerformance(ownership, totalUnits);

  const dl = document.getElementById("member-list");
  dl.innerHTML = "";
  const seen = new Set();
  entries.forEach(e => {
    if(e.member && !seen.has(e.member)){
      seen.add(e.member);
      const opt = document.createElement("option");
      opt.value = e.member;
      dl.appendChild(opt);
    }
  });

  const tbody = document.getElementById("log-body");
  const emptyNote = document.getElementById("empty-note");
  tbody.innerHTML = "";
  if(rows.length === 0){
    emptyNote.style.display = "block";
  } else {
    emptyNote.style.display = "none";
    rows.forEach((r, idx) => {
      const tr = document.createElement("tr");
      if(idx === rows.length - 1) tr.className = "latest";
      const navText = r.warning ? `<span style="color:var(--danger)">⚠ value</span>` : (r.nav !== null ? r.nav.toFixed(4) : "—");
      const unitsText = r.unitsIssued !== null ? fmtUnits(r.unitsIssued) : "—";
      tr.innerHTML = `
        <td class="mono">${r.date || "—"}</td>
        <td>${escapeHtml(r.member)}</td>
        <td class="mono">${fmtPeso(r.amount)}</td>
        <td class="mono">${r.pv !== null && r.pv !== undefined ? fmtPeso(r.pv) : "—"}</td>
        <td class="mono">${navText}</td>
        <td class="mono">${unitsText}</td>
        <td><button class="del-btn" data-idx="${idx}">remove</button></td>
      `;
      tbody.appendChild(tr);
    });
  }
  tbody.querySelectorAll(".del-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const i = parseInt(btn.getAttribute("data-idx"));
      entries.splice(i, 1);
      invalidateCache("all");
      saveEntries();
      render();
    });
  });

  document.getElementById("total-units-label").textContent = totalUnits > 0 ? Number(totalUnits.toFixed(2)).toLocaleString("en-PH") : "0";

  const pvDisplay = document.getElementById("current-pv-display");
  const perfGrid = document.getElementById("perf-grid");
  if(perf){
    pvDisplay.style.display = "block";
    perfGrid.style.display = "grid";
    document.getElementById("display-current-pv").textContent = fmtPeso(getLatestPV());
    document.getElementById("display-current-nav").textContent = `Current NAV: ${perf.currentNav.toFixed(4)}`;

    document.getElementById("perf-total-contrib").textContent = fmtPeso(perf.totalContributed);
    document.getElementById("perf-gain-loss").textContent = (perf.gainLoss >= 0 ? "+" : "") + fmtPeso(perf.gainLoss).replace("₱", "₱");
    document.getElementById("perf-gain-pct").textContent = (perf.gainLossPct >= 0 ? "+" : "") + perf.gainLossPct.toFixed(2) + "%";
    document.getElementById("perf-total-units").textContent = Number(totalUnits.toFixed(2)).toLocaleString("en-PH");

    const gainCard = document.getElementById("card-gain-loss");
    const gainPctCard = document.getElementById("card-gain-pct");
    if(perf.gainLoss >= 0){
      gainCard.className = "perf-card gain";
      gainPctCard.className = "perf-card gain";
      document.getElementById("perf-gain-loss").className = "perf-value mono gain";
      document.getElementById("perf-gain-pct").className = "perf-value mono gain";
    } else {
      gainCard.className = "perf-card loss";
      gainPctCard.className = "perf-card loss";
      document.getElementById("perf-gain-loss").className = "perf-value mono loss";
      document.getElementById("perf-gain-pct").className = "perf-value mono loss";
    }
  } else {
    pvDisplay.style.display = "none";
    perfGrid.style.display = "none";
  }

  const ledgerList = document.getElementById("ledger-list");
  ledgerList.innerHTML = "";
  if(ownership.length === 0){
    ledgerList.innerHTML = `<div class="empty-note">Ownership shares will appear here once contributions are logged.</div>`;
  } else {
    ownership.forEach((m, i) => {
      const color = PALETTE[i % PALETTE.length];
      const row = document.createElement("div");
      row.className = "ledger-row";
      let gainHtml = "";
      if(perf){
        const mp = perf.memberPerf.find(x => x.name === m.name);
        if(mp){
          const isGain = mp.gain >= 0;
          gainHtml = `<span class="ledger-gain ${isGain ? 'up' : 'down'}">${isGain ? '+' : ''}${fmtPeso(mp.gain).replace('₱','')} (${isGain ? '+' : ''}${mp.gainPct.toFixed(2)}%)</span>`;
        }
      }
      row.innerHTML = `
        <span class="swatch" style="background:${color}"></span>
        <span class="ledger-name">${escapeHtml(m.name)}</span>
        <span class="ledger-pct">${m.pct.toFixed(2)}%</span>
        <span class="ledger-units mono">${fmtUnits(m.units)} u</span>
        ${gainHtml}
      `;
      ledgerList.appendChild(row);
    });
  }

  const warnRows = rows.filter(r => r.warning);
  const banner = document.getElementById("status-banner");
  if(!banner.textContent.startsWith("⚠")){
    banner.textContent = warnRows.length > 0
      ? `⚠ ${warnRows.length} entr${warnRows.length>1?"ies":"y"} missing a Portfolio Value — units for those rows are not counted above.`
      : "";
  }

  const ctx = document.getElementById("pie-chart").getContext("2d");
  const data = {
    labels: ownership.map(m => m.name),
    datasets: [{
      data: ownership.map(m => m.units),
      backgroundColor: ownership.map((_, i) => PALETTE[i % PALETTE.length]),
      borderColor: "#ffffff",
      borderWidth: 3,
    }]
  };
  if(chart){
    chart.data = data;
    chart.update();
  } else {
    chart = new Chart(ctx, {
      type: "doughnut",
      data,
      options: {
        cutout: "68%",
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
                const pct = total > 0 ? (ctx.parsed/total*100).toFixed(2) : "0.00";
                return ` ${ctx.label}: ${pct}%`;
              }
            }
          }
        }
      }
    });
  }
}

function escapeHtml(s){
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

// ============================================
// ANALYTICS - FUND METRICS
// ============================================
function buildFundHistory(){
  const key = _fullKey();
  const cached = _cacheHit("fundHist", key);
  if(cached){
    logDebug("CACHE HIT: buildFundHistory", "ok");
    return cached;
  }

  const { rows } = computeLedger();
  if(rows.length === 0) return [];

  const history = [];
  let cumulativeContrib = 0;

  for(const r of rows){
    if(r.nav === null) continue;
    cumulativeContrib += r.amount;
    history.push({
      date: r.date,
      nav: r.nav,
      fundValue: r.pv || cumulativeContrib,
      cumulativeContrib: cumulativeContrib,
      totalUnits: r.before + (r.unitsIssued || 0)
    });
  }

  // Add PV snapshot points - each snapshot is a real data point on its date
  if(pvSnapshots.length > 0 && history.length > 0){
    const lastEntry = history[history.length - 1];
    for(const snap of pvSnapshots){
      // Only add snapshots on or after the last contribution date
      if(snap.date >= lastEntry.date){
        const currentNav = lastEntry.totalUnits > 0 ? snap.value / lastEntry.totalUnits : 1;
        history.push({
          date: snap.date,
          nav: currentNav,
          fundValue: snap.value,
          cumulativeContrib: lastEntry.cumulativeContrib,
          totalUnits: lastEntry.totalUnits
        });
      }
    }
  }

  _cacheSet("fundHist", key, history);
  logDebug("CACHE SET: buildFundHistory", "ok");
  return history;
}

function renderFundAnalytics(){
  const history = buildFundHistory();

  if(history.length === 0){
    document.getElementById("fund-chart-wrap").innerHTML = '<div class="no-data" style="min-width:600px;">No contribution data yet. Log entries to see charts.</div>';
    document.getElementById("contrib-chart-wrap").innerHTML = '<div class="no-data" style="min-width:600px;">No contribution data yet.</div>';
    document.getElementById("ms-first-date").textContent = "—";
    document.getElementById("ms-highest-nav").textContent = "—";
    document.getElementById("ms-lowest-nav").textContent = "—";
    document.getElementById("ms-total-contrib").textContent = "—";
    return;
  }

  // Milestones
  const navs = history.map(h => h.nav).filter(n => n > 0);
  const totalContrib = history[history.length - 1].cumulativeContrib;
  document.getElementById("ms-first-date").textContent = history[0].date;
  document.getElementById("ms-highest-nav").textContent = navs.length > 0 ? Math.max(...navs).toFixed(4) : "—";
  document.getElementById("ms-lowest-nav").textContent = navs.length > 0 ? Math.min(...navs).toFixed(4) : "—";
  document.getElementById("ms-total-contrib").textContent = "₱" + totalContrib.toLocaleString("en-PH", {minimumFractionDigits:0, maximumFractionDigits:0});

  // Fund Chart: NAV + Fund Value (dual axis)
  const labels = history.map(h => h.date);
  const navData = history.map(h => h.nav);
  const valueData = history.map(h => h.fundValue);

  const ctx1 = document.getElementById("fund-chart").getContext("2d");
  if(fundChart) fundChart.destroy();

  fundChart = new Chart(ctx1, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "NAV per Unit",
          data: navData,
          borderColor: "#0f766e",
          backgroundColor: "rgba(15, 118, 110, 0.08)",
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          yAxisID: "y",
          pointRadius: 4,
          pointBackgroundColor: "#0f766e",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        },
        {
          label: "Fund Value (₱)",
          data: valueData,
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245, 158, 11, 0.06)",
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          yAxisID: "y1",
          pointRadius: 4,
          pointBackgroundColor: "#f59e0b",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1e293b",
          titleColor: "#f1f5f9",
          bodyColor: "#e2e8f0",
          borderColor: "#334155",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => {
              if(ctx.dataset.label === "NAV per Unit"){
                return ` NAV: ${ctx.parsed.y.toFixed(4)}`;
              }
              return ` Fund Value: ₱${ctx.parsed.y.toLocaleString("en-PH", {minimumFractionDigits:2})}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false, drawBorder: false },
          ticks: { color: "#64748b", font: { size: 11 } }
        },
        y: {
          type: "linear",
          display: true,
          position: "left",
          grid: { color: "#e2e8f0", drawBorder: false },
          ticks: { color: "#0f766e", font: { size: 11 }, callback: (v) => v.toFixed(2) },
          title: { display: true, text: "NAV", color: "#0f766e", font: { size: 10, weight: "bold" } }
        },
        y1: {
          type: "linear",
          display: true,
          position: "right",
          grid: { display: false },
          ticks: { color: "#f59e0b", font: { size: 11 }, callback: (v) => "₱" + (v >= 1000 ? (v/1000).toFixed(1) + "k" : v.toFixed(0)) },
          title: { display: true, text: "Value", color: "#f59e0b", font: { size: 10, weight: "bold" } }
        }
      }
    }
  });

  // Contributions Chart: Cumulative contributions vs fund value
  const contribData = history.map(h => h.cumulativeContrib);

  const ctx2 = document.getElementById("contrib-chart").getContext("2d");
  if(contribChart) contribChart.destroy();

  contribChart = new Chart(ctx2, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Cumulative Contributions",
          data: contribData,
          borderColor: "#0ea5e9",
          backgroundColor: "rgba(14, 165, 233, 0.08)",
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          pointRadius: 4,
          pointBackgroundColor: "#0ea5e9",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        },
        {
          label: "Fund Value",
          data: valueData,
          borderColor: "#8b5cf6",
          backgroundColor: "rgba(139, 92, 246, 0.06)",
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          pointRadius: 4,
          pointBackgroundColor: "#8b5cf6",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1e293b",
          titleColor: "#f1f5f9",
          bodyColor: "#e2e8f0",
          borderColor: "#334155",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => ` ${ctx.dataset.label}: ₱${ctx.parsed.y.toLocaleString("en-PH", {minimumFractionDigits:2})}`
          }
        }
      },
      scales: {
        x: {
          grid: { display: false, drawBorder: false },
          ticks: { color: "#64748b", font: { size: 11 } }
        },
        y: {
          grid: { color: "#e2e8f0", drawBorder: false },
          ticks: { color: "#64748b", font: { size: 11 }, callback: (v) => "₱" + (v >= 1000 ? (v/1000).toFixed(1) + "k" : v.toFixed(0)) }
        }
      }
    }
  });
}

// ============================================
// ANALYTICS - MEMBER METRICS
// ============================================
function buildMemberHistory(memberName){
  const key = memberName + "|" + _fullKey();
  if(_CACHE.memberHist[key]){
    logDebug("CACHE HIT: buildMemberHistory(" + memberName + ")", "ok");
    return _CACHE.memberHist[key];
  }

  const { rows } = computeLedger();
  if(rows.length === 0) return [];

  const memberRows = [];
  let memberTotalContrib = 0;
  let memberTotalUnits = 0;

  for(const r of rows){
    if(r.nav === null) continue;

    if(r.member === memberName){
      memberTotalContrib += r.amount;
      memberTotalUnits += r.unitsIssued || 0;
      const avgCost = memberTotalUnits > 0 ? memberTotalContrib / memberTotalUnits : 0;

      memberRows.push({
        date: r.date,
        amount: r.amount,
        fundNav: r.nav,
        unitsIssued: r.unitsIssued,
        memberTotalContrib: memberTotalContrib,
        memberTotalUnits: memberTotalUnits,
        avgCost: avgCost,
        shareValue: memberTotalUnits * r.nav
      });
    } else {
      // Still track fund NAV evolution for non-member rows so we can show share value at each point
      if(memberTotalUnits > 0){
        memberRows.push({
          date: r.date,
          amount: 0,
          fundNav: r.nav,
          unitsIssued: 0,
          memberTotalContrib: memberTotalContrib,
          memberTotalUnits: memberTotalUnits,
          avgCost: memberTotalUnits > 0 ? memberTotalContrib / memberTotalUnits : 0,
          shareValue: memberTotalUnits * r.nav
        });
      }
    }
  }

  // Add PV snapshot points
  if(pvSnapshots.length > 0 && memberTotalUnits > 0){
    const { totalUnits } = computeLedger();
    const lastEntryDate = memberRows.length > 0 ? memberRows[memberRows.length - 1].date : null;
    for(const snap of pvSnapshots){
      if(lastEntryDate && snap.date < lastEntryDate) continue;
      const currentNav = totalUnits > 0 ? snap.value / totalUnits : 1;
      memberRows.push({
        date: snap.date,
        amount: 0,
        fundNav: currentNav,
        unitsIssued: 0,
        memberTotalContrib: memberTotalContrib,
        memberTotalUnits: memberTotalUnits,
        avgCost: memberTotalUnits > 0 ? memberTotalContrib / memberTotalUnits : 0,
        shareValue: memberTotalUnits * currentNav
      });
    }
  }

  _CACHE.memberHist[key] = memberRows;
  logDebug("CACHE SET: buildMemberHistory(" + memberName + ")", "ok");
  return memberRows;
}

function populateMemberSelector(){
  const select = document.getElementById("member-select");
  const currentVal = select.value;

  // Get unique members
  const members = [...new Set(entries.map(e => e.member).filter(m => m))];
  members.sort();

  select.innerHTML = '<option value="">Choose a member...</option>';
  members.forEach(m => {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = m;
    select.appendChild(opt);
  });

  if(currentVal && members.includes(currentVal)){
    select.value = currentVal;
  }
}

function renderMemberAnalytics(){
  const select = document.getElementById("member-select");
  const memberName = select.value;

  if(!memberName){
    document.getElementById("member-content").style.display = "none";
    document.getElementById("member-no-data").style.display = "block";
    return;
  }

  document.getElementById("member-content").style.display = "block";
  document.getElementById("member-no-data").style.display = "none";

  const history = buildMemberHistory(memberName);

  if(history.length === 0){
    document.getElementById("member-chart-wrap").innerHTML = '<div class="no-data" style="min-width:600px;">No data for this member.</div>';
    return;
  }

  const latest = history[history.length - 1];
  const totalReturn = latest.memberTotalContrib > 0 ? ((latest.shareValue - latest.memberTotalContrib) / latest.memberTotalContrib) * 100 : 0;

  // Snapshot cards
  const snapContrib = document.getElementById("snap-contributed");
  const snapCurrent = document.getElementById("snap-current");
  const snapReturn = document.getElementById("snap-return");

  snapContrib.textContent = fmtPeso(latest.memberTotalContrib);
  snapCurrent.textContent = fmtPeso(latest.shareValue);
  snapReturn.textContent = (totalReturn >= 0 ? "+" : "") + totalReturn.toFixed(2) + "%";
  snapReturn.className = "value mono " + (totalReturn >= 0 ? "gain" : "loss");

  // Member chart: Avg Cost vs Share Value
  const labels = history.map(h => h.date);
  const avgCostData = history.map(h => h.avgCost);
  const shareValueData = history.map(h => h.shareValue);

  // Restore canvas if it was replaced
  const wrap = document.getElementById("member-chart-wrap");
  if(!document.getElementById("member-chart")){
    wrap.innerHTML = '<canvas id="member-chart" style="min-width:600px;"></canvas>';
  }

  const ctx = document.getElementById("member-chart").getContext("2d");
  if(memberChart) memberChart.destroy();

  memberChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Avg Cost (NAV)",
          data: avgCostData,
          borderColor: "#0f766e",
          backgroundColor: "rgba(15, 118, 110, 0.08)",
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          yAxisID: "y",
          pointRadius: 3,
          pointBackgroundColor: "#0f766e",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        },
        {
          label: "Share Value",
          data: shareValueData,
          borderColor: "#f59e0b",
          backgroundColor: "rgba(245, 158, 11, 0.06)",
          borderWidth: 2.5,
          tension: 0.4,
          fill: true,
          yAxisID: "y1",
          pointRadius: 3,
          pointBackgroundColor: "#f59e0b",
          pointBorderColor: "#fff",
          pointBorderWidth: 2,
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1e293b",
          titleColor: "#f1f5f9",
          bodyColor: "#e2e8f0",
          borderColor: "#334155",
          borderWidth: 1,
          padding: 12,
          callbacks: {
            label: (ctx) => {
              if(ctx.dataset.label === "Avg Cost (NAV)"){
                return ` Avg Cost: ${ctx.parsed.y.toFixed(4)}`;
              }
              return ` Share Value: ₱${ctx.parsed.y.toLocaleString("en-PH", {minimumFractionDigits:2})}`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false, drawBorder: false },
          ticks: { color: "#64748b", font: { size: 11 } }
        },
        y: {
          type: "linear",
          display: true,
          position: "left",
          grid: { color: "#e2e8f0", drawBorder: false },
          ticks: { color: "#0f766e", font: { size: 11 }, callback: (v) => v.toFixed(2) },
          title: { display: true, text: "Avg Cost", color: "#0f766e", font: { size: 10, weight: "bold" } }
        },
        y1: {
          type: "linear",
          display: true,
          position: "right",
          grid: { display: false },
          ticks: { color: "#f59e0b", font: { size: 11 }, callback: (v) => "₱" + (v >= 1000 ? (v/1000).toFixed(1) + "k" : v.toFixed(0)) },
          title: { display: true, text: "Share Value", color: "#f59e0b", font: { size: 10, weight: "bold" } }
        }
      }
    }
  });

  // Member history table
  const tbody = document.getElementById("member-history-body");
  tbody.innerHTML = "";

  history.filter(h => h.amount > 0).forEach(h => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${h.date}</td>
      <td class="mono">${fmtPeso(h.amount)}</td>
      <td class="mono">${h.fundNav.toFixed(4)}</td>
      <td class="mono">${fmtUnits(h.unitsIssued)}</td>
      <td class="mono">${h.avgCost.toFixed(4)}</td>
      <td class="mono">${fmtPeso(h.shareValue)}</td>
    `;
    tbody.appendChild(tr);
  });
}

// ============================================
// SETUP PANEL HANDLERS
// ============================================
function updateConfigUI(){
  const panel = document.getElementById("config-panel");
  const ok = document.getElementById("config-ok");
  const binDisplay = document.getElementById("bin-id-display");
  const fallback = document.getElementById("fallback-notice");
  const debugPanel = document.getElementById("debug-panel");

  if(BIN_ID && API_KEY){
    panel.style.display = "none";
    ok.classList.add("visible");
    binDisplay.style.display = "block";
    binDisplay.innerHTML = `<strong>Your Bin ID:</strong> ${BIN_ID}<br><span style="font-size:11px;color:#6b7280;">Share this Bin ID with family members so they can connect too.</span>`;
    fallback.style.display = useLocalFallback ? "block" : "none";
    if(debugPanel) debugPanel.style.display = "block";
  } else {
    panel.style.display = "block";
    ok.classList.remove("visible");
    binDisplay.style.display = "none";
    fallback.style.display = "none";
    if(debugPanel) debugPanel.style.display = "none";
  }
}

async function createNewBin(){
  const apiKey = document.getElementById("cfg-api-key").value.trim();
  const status = document.getElementById("cfg-status");
  status.className = "";

  if(!apiKey){
    status.className = "err";
    status.textContent = "Please paste your X-Master-Key first.";
    return;
  }

  API_KEY = apiKey;
  status.textContent = "Creating new bin on JSONBin.io...";
  logDebug("Creating new bin...");

  try{
    const newBinId = await jsonbinCreate({entries: [], pvSnapshots: [], created: new Date().toISOString()});
    if(!newBinId){
      throw new Error("Bin created but no ID returned.");
    }
    BIN_ID = newBinId;
    saveConfig(BIN_ID, API_KEY);
    entries = [];
    pvSnapshots = [];
    saveLocalEntries();

    await jsonbinUpdate({entries: [], pvSnapshots: []});

    status.className = "ok";
    status.textContent = "New bin created successfully!";
    updateConfigUI();
    render();
  }catch(e){
    console.error("Create bin error:", e);
    logDebug("Create bin FAILED: " + e.message, "err");
    BIN_ID = "";
    API_KEY = "";
    status.className = "err";
    status.textContent = "Failed: " + e.message;

    document.getElementById("fallback-notice").style.display = "block";
    document.getElementById("fallback-notice").innerHTML = `
      <b>Cloud connection failed.</b> ${e.message}<br>
      Your data will be saved locally in this browser. You can still use the dashboard, but data won't sync across devices.
    `;
  }
}

async function connectToExistingBin(){
  const apiKey = document.getElementById("cfg-api-key").value.trim();
  const binId = document.getElementById("cfg-bin-id").value.trim();
  const status = document.getElementById("cfg-status");
  status.className = "";

  if(!apiKey){
    status.className = "err";
    status.textContent = "Please paste your X-Master-Key.";
    return;
  }
  if(!binId){
    status.className = "err";
    status.textContent = "Please enter a Bin ID, or use 'Create New Bin' instead.";
    return;
  }

  BIN_ID = binId;
  API_KEY = apiKey;
  status.textContent = "Testing connection...";
  logDebug("Connecting to existing bin: " + binId);

  try{
    const data = await jsonbinRead();
    if(data && typeof data === "object"){
      if(Array.isArray(data.entries)){
        entries = data.entries;
        pvSnapshots = data.pvSnapshots || [];
      } else if(Array.isArray(data)){
        entries = data;
        pvSnapshots = [];
      } else {
        entries = [];
        pvSnapshots = [];
      }
    } else {
      entries = [];
      pvSnapshots = [];
    }
    saveConfig(BIN_ID, API_KEY);
    saveLocalEntries();
    const latestPV = getLatestPV();
    if(latestPV !== null){
      document.getElementById("f-current-pv").value = latestPV;
    }
    status.className = "ok";
    status.textContent = "Connected successfully! Data loaded.";
    logDebug("Connected! Loaded " + entries.length + " entries", "ok");
    updateConfigUI();
    render();
  }catch(e){
    console.error("Connect error:", e);
    logDebug("Connect FAILED: " + e.message, "err");
    BIN_ID = "";
    API_KEY = "";
    status.className = "err";
    status.textContent = "Connection failed: " + e.message;
  }
}

document.getElementById("cfg-create-btn").addEventListener("click", createNewBin);
document.getElementById("cfg-connect-btn").addEventListener("click", connectToExistingBin);

// ============================================
// TOOLS & DEBUG
// ============================================
function showSyncStatus(msg, type){
  const el = document.getElementById("sync-status");
  el.textContent = msg;
  el.className = "sync-status " + type;
  el.style.display = "block";
  setTimeout(() => { el.style.display = "none"; }, 5000);
}

document.getElementById("btn-export").addEventListener("click", () => {
  const payload = {entries, pvSnapshots};
  const data = JSON.stringify(payload, null, 2);
  const textarea = document.createElement("textarea");
  textarea.value = data;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  try{
    document.execCommand("copy");
    showSyncStatus("✅ Data copied to clipboard! Paste it somewhere safe.", "ok");
    logDebug("Exported data to clipboard", "ok");
  }catch(e){
    showSyncStatus("Could not auto-copy.", "warn");
    logDebug("Export failed: " + e.message, "err");
  }
  document.body.removeChild(textarea);
});

document.getElementById("btn-force-sync").addEventListener("click", async () => {
  if(!BIN_ID || !API_KEY){
    showSyncStatus("❌ Not connected to cloud. Connect first.", "err");
    return;
  }
  logDebug("Force sync started...", "warn");
  showSyncStatus("Syncing local data to cloud...", "warn");
  const ok = await saveEntries();
  if(ok){
    showSyncStatus("✅ Force sync successful! Cloud is up to date.", "ok");
  } else {
    showSyncStatus("❌ Force sync failed. Check debug log for details.", "err");
  }
});

document.getElementById("btn-clear-local").addEventListener("click", () => {
  if(!confirm("This will delete ONLY the local browser copy. Cloud data is untouched. Continue?")) return;
  try{
    localStorage.removeItem(LOCAL_KEY);
    clearPVSnapshots();
    entries = [];
    pvSnapshots = [];
    render();
    showSyncStatus("🗑 Local data cleared. Reload to fetch from cloud.", "warn");
    logDebug("Local entries cleared", "warn");
  }catch(e){
    logDebug("Clear local failed: " + e.message, "err");
  }
});

document.getElementById("btn-disconnect").addEventListener("click", () => {
  if(!confirm("This will disconnect from cloud AND clear all local data. You will need to reconnect. Continue?")) return;
  try{
    localStorage.removeItem(LOCAL_KEY);
    localStorage.removeItem(CONFIG_KEY);
    clearPVSnapshots();
    entries = [];
    pvSnapshots = [];
    BIN_ID = "";
    API_KEY = "";
    render();
    updateConfigUI();
    showSyncStatus("🔌 Disconnected. All local data cleared.", "warn");
    logDebug("Disconnected and cleared all local data", "warn");
  }catch(e){
    logDebug("Disconnect failed: " + e.message, "err");
  }
});

document.getElementById("btn-toggle-debug").addEventListener("click", () => {
  const el = document.getElementById("debug-log");
  el.style.display = el.style.display === "none" ? "block" : "none";
});

document.getElementById("btn-cache-stats").addEventListener("click", () => {
  const stats = {
    ledger: _CACHE.ledger.key ? `HIT(h${_CACHE.ledger.hits}/m${_CACHE.ledger.misses})` : "EMPTY",
    fundHist: _CACHE.fundHist.key ? `HIT(h${_CACHE.fundHist.hits}/m${_CACHE.fundHist.misses})` : "EMPTY",
    memberHistKeys: Object.keys(_CACHE.memberHist).length,
    perf: _CACHE.perf.key ? `HIT(h${_CACHE.perf.hits}/m${_CACHE.perf.misses})` : "EMPTY",
  };
  logDebug(`CACHE STATS — ledger:${stats.ledger} | fundHist:${stats.fundHist} | memberHist:${stats.memberHistKeys} entries | perf:${stats.perf}`, "ok");
});

// ============================================
// TAB NAVIGATION
// ============================================
document.querySelectorAll(".tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.getAttribute("data-tab")).classList.add("active");

    if(btn.getAttribute("data-tab") === "analytics"){
      renderFundAnalytics();
      populateMemberSelector();
      const memberSelect = document.getElementById("member-select");
      if(memberSelect.value){
        renderMemberAnalytics();
      }
    }
  });
});

document.querySelectorAll(".sub-tab-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".sub-tab-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".sub-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("subtab-" + btn.getAttribute("data-subtab")).classList.add("active");

    if(btn.getAttribute("data-subtab") === "fund"){
      renderFundAnalytics();
    } else {
      populateMemberSelector();
      if(document.getElementById("member-select").value){
        renderMemberAnalytics();
      }
    }
  });
});

document.getElementById("member-select").addEventListener("change", renderMemberAnalytics);

// ============================================
// ADD CONTRIBUTION
// ============================================
document.getElementById("add-btn").addEventListener("click", async () => {
  const warnEl = document.getElementById("form-warn");
  warnEl.textContent = "";
  const date = document.getElementById("f-date").value;
  const member = document.getElementById("f-member").value.trim();
  const amountRaw = document.getElementById("f-amount").value;
  const pvRaw = document.getElementById("f-pv").value;

  if(!date || !member || amountRaw === ""){
    warnEl.textContent = "Please fill in date, member, and contribution amount.";
    return;
  }
  const amount = parseFloat(amountRaw);
  if(isNaN(amount) || amount <= 0){
    warnEl.textContent = "Contribution amount must be a positive number.";
    return;
  }

  const { totalUnits } = computeLedger();
  let pv = null;
  if(totalUnits > 0){
    if(pvRaw === ""){
      warnEl.textContent = "Portfolio Value Before is required once the fund already holds units — check COL and enter the current total value.";
      return;
    }
    pv = parseFloat(pvRaw);
    if(isNaN(pv) || pv < 0){
      warnEl.textContent = "Portfolio Value Before must be a valid non-negative number.";
      return;
    }
  } else {
    pv = pvRaw === "" ? 0 : parseFloat(pvRaw);
  }

  entries.push({ date, member, amount, pv });
  invalidateCache("all");
  logDebug(`Adding entry: ${member} ₱${amount} (PV: ${pv})`, "ok");

  const saved = await saveEntries();
  if(!saved){
    warnEl.textContent = "⚠ Entry saved locally but NOT to cloud. Tap 'Force Sync to Cloud' to retry.";
  }

  document.getElementById("f-amount").value = "";
  document.getElementById("f-pv").value = "";
  document.getElementById("f-member").value = "";
  render();
});

// ============================================
// UPDATE CURRENT PORTFOLIO VALUE
// ============================================
document.getElementById("update-pv-btn").addEventListener("click", async () => {
  const warnEl = document.getElementById("pv-warn");
  warnEl.textContent = "";
  const pvRaw = document.getElementById("f-current-pv").value;

  if(pvRaw === ""){
    warnEl.textContent = "Please enter the current total portfolio value.";
    return;
  }
  const pv = parseFloat(pvRaw);
  if(isNaN(pv) || pv < 0){
    warnEl.textContent = "Portfolio value must be a valid non-negative number.";
    return;
  }

  const { totalUnits } = computeLedger();
  if(totalUnits <= 0){
    warnEl.textContent = "No units outstanding yet. Add contributions first.";
    return;
  }

  savePVSnapshot(pv);
  invalidateCache("fundHist");
  invalidateCache("memberHist");
  invalidateCache("perf");
  logDebug(`Updated portfolio value snapshot: ₱${pv}`, "ok");

  const saved = await saveEntries();
  if(!saved){
    warnEl.textContent = "⚠ Portfolio value saved locally but NOT to cloud. Tap 'Force Sync to Cloud' to retry.";
  }

  render();

  // === SURGICAL FIX: Refresh analytics charts if user is on Analytics tab ===
  const analyticsPanel = document.getElementById("tab-analytics");
  if(analyticsPanel && analyticsPanel.classList.contains("active")){
    const fundSubtab = document.getElementById("subtab-fund");
    if(fundSubtab && fundSubtab.classList.contains("active")){
      renderFundAnalytics();
    }
    const memberSubtab = document.getElementById("subtab-member");
    if(memberSubtab && memberSubtab.classList.contains("active")){
      populateMemberSelector();
      renderMemberAnalytics();
    }
  }
});

// ============================================
// INIT
// ============================================
const hasConfig = loadConfig();
loadPVSnapshots();
updateConfigUI();
if(hasConfig){
  loadEntries();
} else {
  loadLocalEntries();
  invalidateCache("all");
  render();
}


// ============================================================
// Part 2 of 2: confirmation modal overrides + fund log print
// (originally a separate <script> block at the end of the body)
// Order preserved — part 2 depends on functions/consts from part 1.
// ============================================================

// ============================================
// CONFIRMATION MODAL
// ============================================
let confirmCallback = null;

function showConfirmModal(title, message, onConfirm){
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-msg").textContent = message;
  document.getElementById("confirm-code").value = "";
  document.getElementById("confirm-code").classList.remove("valid");
  document.getElementById("modal-confirm").classList.remove("active");
  document.getElementById("modal-confirm").disabled = true;
  confirmCallback = onConfirm;
  document.getElementById("confirm-modal").classList.add("visible");
  document.getElementById("confirm-code").focus();
}

function hideConfirmModal(){
  document.getElementById("confirm-modal").classList.remove("visible");
  confirmCallback = null;
}

document.getElementById("confirm-code").addEventListener("input", (e) => {
  const val = e.target.value.trim();
  const btn = document.getElementById("modal-confirm");
  if(val === "0000"){
    e.target.classList.add("valid");
    btn.classList.add("active");
    btn.disabled = false;
  } else {
    e.target.classList.remove("valid");
    btn.classList.remove("active");
    btn.disabled = true;
  }
});

document.getElementById("modal-cancel").addEventListener("click", hideConfirmModal);
document.getElementById("modal-confirm").addEventListener("click", () => {
  if(confirmCallback) confirmCallback();
  hideConfirmModal();
});

// Override danger button handlers
const originalClearLocal = document.getElementById("btn-clear-local").onclick;
document.getElementById("btn-clear-local").addEventListener("click", (e) => {
  e.stopImmediatePropagation();
  showConfirmModal(
    "🗑 Clear Local Data",
    "This will delete ONLY the local browser copy. Cloud data is untouched. This cannot be undone.",
    () => {
      try{
        localStorage.removeItem(LOCAL_KEY);
        clearPVSnapshots();
        entries = [];
        pvSnapshots = [];
        invalidateCache("all");
        render();
        showSyncStatus("🗑 Local data cleared. Reload to fetch from cloud.", "warn");
        logDebug("Local entries cleared", "warn");
      }catch(e){
        logDebug("Clear local failed: " + e.message, "err");
      }
    }
  );
});

const originalDisconnect = document.getElementById("btn-disconnect").onclick;
document.getElementById("btn-disconnect").addEventListener("click", (e) => {
  e.stopImmediatePropagation();
  showConfirmModal(
    "🔌 Disconnect & Clear ALL",
    "This will disconnect from cloud AND clear all local data. You will need to reconnect. This cannot be undone.",
    () => {
      try{
        localStorage.removeItem(LOCAL_KEY);
        localStorage.removeItem(CONFIG_KEY);
        clearPVSnapshots();
        entries = [];
        pvSnapshots = [];
        invalidateCache("all");
        BIN_ID = "";
        API_KEY = "";
        render();
        updateConfigUI();
        showSyncStatus("🔌 Disconnected. All local data cleared.", "warn");
        logDebug("Disconnected and cleared all local data", "warn");
      }catch(e){
        logDebug("Disconnect failed: " + e.message, "err");
      }
    }
  );
});

// ============================================
// PRINT FUND LOG
// ============================================
function generateFundLog(){
  const { rows, totalUnits } = computeLedger();
  const ownership = computeOwnership(rows, totalUnits);
  const perf = computePerformance(ownership, totalUnits);

  const today = new Date().toLocaleDateString("en-PH", {year:"numeric", month:"long", day:"numeric"});
  const members = [...new Set(entries.map(e => e.member).filter(m => m))];

  document.getElementById("fl-date").textContent = today;
  document.getElementById("fl-entries").textContent = entries.length;
  document.getElementById("fl-members").textContent = members.length;

  if(perf){
    document.getElementById("fl-pv").textContent = fmtPeso(getLatestPV());
    document.getElementById("fl-nav").textContent = perf.currentNav.toFixed(4);
    document.getElementById("fl-units").textContent = fmtUnits(totalUnits);
    document.getElementById("fl-contrib").textContent = fmtPeso(perf.totalContributed);
    const gainEl = document.getElementById("fl-gain");
    gainEl.textContent = (perf.gainLoss >= 0 ? "+" : "") + fmtPeso(perf.gainLoss);
    gainEl.style.color = perf.gainLoss >= 0 ? "#16a34a" : "#dc2626";
    const retEl = document.getElementById("fl-return");
    retEl.textContent = (perf.gainLossPct >= 0 ? "+" : "") + perf.gainLossPct.toFixed(2) + "%";
    retEl.style.color = perf.gainLossPct >= 0 ? "#16a34a" : "#dc2626";
  } else {
    document.getElementById("fl-pv").textContent = "—";
    document.getElementById("fl-nav").textContent = "—";
    document.getElementById("fl-units").textContent = fmtUnits(totalUnits);
    document.getElementById("fl-contrib").textContent = "—";
    document.getElementById("fl-gain").textContent = "—";
    document.getElementById("fl-return").textContent = "—";
  }

  // Ownership table
  const ownBody = document.getElementById("fl-ownership-body");
  ownBody.innerHTML = "";
  if(ownership.length === 0){
    ownBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:12px;">No ownership data yet.</td></tr>';
  } else {
    ownership.forEach(m => {
      const mp = perf ? perf.memberPerf.find(x => x.name === m.name) : null;
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><strong>${escapeHtml(m.name)}</strong></td>
        <td class="mono">${fmtUnits(m.units)}</td>
        <td class="mono">${m.pct.toFixed(2)}%</td>
        <td class="mono">${fmtPeso(m.totalContributed)}</td>
        <td class="mono">${mp ? fmtPeso(mp.currentValue) : "—"}</td>
        <td class="mono" style="color:${mp && mp.gain >= 0 ? '#16a34a' : '#dc2626'}">${mp ? (mp.gain >= 0 ? '+' : '') + fmtPeso(mp.gain) : '—'}</td>
        <td class="mono" style="color:${mp && mp.gainPct >= 0 ? '#16a34a' : '#dc2626'}">${mp ? (mp.gainPct >= 0 ? '+' : '') + mp.gainPct.toFixed(2) + '%' : '—'}</td>
      `;
      ownBody.appendChild(tr);
    });
  }

  // Log table
  const logBody = document.getElementById("fl-log-body");
  logBody.innerHTML = "";
  if(rows.length === 0){
    logBody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#999;padding:12px;">No entries logged yet.</td></tr>';
  } else {
    rows.forEach((r, idx) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td class="mono">${idx + 1}</td>
        <td class="mono">${r.date || "—"}</td>
        <td>${escapeHtml(r.member)}</td>
        <td class="mono">${fmtPeso(r.amount)}</td>
        <td class="mono">${r.pv !== null && r.pv !== undefined ? fmtPeso(r.pv) : "—"}</td>
        <td class="mono">${r.nav !== null ? r.nav.toFixed(4) : "—"}</td>
        <td class="mono">${r.unitsIssued !== null ? fmtUnits(r.unitsIssued) : "—"}</td>
      `;
      logBody.appendChild(tr);
    });
  }

  const view = document.getElementById("print-fund-view");
  view.style.display = "block";
  window.print();
  setTimeout(() => { view.style.display = "none"; }, 500);
}

document.getElementById("btn-print-fund-log").addEventListener("click", generateFundLog);
