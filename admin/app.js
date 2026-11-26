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
let transfers = [];   // unit transfers between members
let chart = null;
let useLocalFallback = false;

// Cloud safety: the page may only write after it has read the cloud copy
let cloudReady = false;       // true once the cloud data has loaded in this session
let cloudFingerprint = null;  // the cloud data as this page last saw it
let isSaving = false;         // blocks double taps while a save is running

let BIN_ID = "";
let API_KEY = "";

const LOCAL_KEY = "jms_holdings_entries_v3";
const CONFIG_KEY = "jms_jsonbin_config_v2";
const PV_SNAPSHOTS_KEY = "jms_pv_snapshots_v1";

// Chart instances for analytics
let fundChart = null;
let contribChart = null;
let memberChart = null;

// ============================================================
// UNIT TRANSFERS: SHARED BLOCK
// The admin page and the member page carry the same copy of this block.
// If you change it in one file, change it in the other too.
// ============================================================
const UNIT_DUST = 0.000001;  // unit differences smaller than this are rounding noise
const PAYMENT_DAYS = 7;

// ---------- Reading the cloud data ----------

// Turns what the bin returned into {entries, pvSnapshots, transfers}.
// Anything else is refused, so an unrelated bin is never overwritten.
function parseFundData(data){
  if(Array.isArray(data)) return { entries: data, pvSnapshots: [], transfers: [] };
  // Once transfers exist, contributions are saved under "contributions".
  // Older copies of the app don't recognise that, so they cannot overwrite the transfers.
  const list = data?.version === 2 ? data.contributions : data?.version === undefined ? data?.entries : null;
  if(Array.isArray(list)){
    return { entries: list, pvSnapshots: data.pvSnapshots || [], transfers: data.transfers || [] };
  }
  throw new Error("This bin does not contain fund data this page can read.");
}

// ---------- Dates ----------

// Today's date in the Philippines (YYYY-MM-DD), wherever this device is
function todayLocal(){
  const parts = new Intl.DateTimeFormat("en-US", {timeZone:"Asia/Manila", year:"numeric", month:"2-digit", day:"2-digit"}).formatToParts(new Date());
  const part = type => parts.find(p => p.type === type).value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

// "2026-11-26" becomes "November 26, 2026"
function formatDate(isoDate){
  if(!isoDate) return "";
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(year, month - 1, day).toLocaleDateString("en-US", {year:"numeric", month:"long", day:"numeric"});
}

// A saved moment, shown in Philippine time
function formatDateTime(timestamp){
  return new Date(timestamp).toLocaleString("en-US", {timeZone:"Asia/Manila", year:"numeric", month:"long", day:"numeric", hour:"numeric", minute:"2-digit"});
}

// Transfer prices need more decimals, so that units × price matches the amount paid
function fmtPrice(n){
  return "₱" + Number(n).toFixed(6);
}

// A difference smaller than half a centavo is zero, so it never shows as "-0.00"
function noTinyAmount(n){
  return Math.abs(n) < 0.005 ? 0 : n;
}

function fmtSignedPeso(n){
  const amount = noTinyAmount(n);
  return (amount >= 0 ? "+" : "") + fmtPeso(amount);
}

// ---------- Transfer facts ----------

const sumOf = (list, key) => list.reduce((total, item) => total + item[key], 0);
const transferUnits = t => sumOf(t.buyers, "units");
const transferAmount = t => sumOf(t.buyers, "amount");
const isOverdue = t => t.status === "pending" && todayLocal() > t.dueDate;
const buyerNames = t => t.buyers.map(b => b.name).join(", ");

function transferStatusLabel(t){
  if(isOverdue(t)) return "Overdue";
  return {pending:"Pending payment", completed:"Completed", cancelled:"Cancelled", voided:"Voided"}[t.status] ?? t.status;
}

// Units a member has promised in pending transfers. They still own them until completion.
function reservedUnits(name){
  return transfers
    .filter(t => t.status === "pending" && t.seller === name)
    .reduce((total, t) => total + transferUnits(t), 0);
}

// ---------- Who owns what ----------

// Contributions first, then every completed transfer.
// cost = what the units a member holds now cost them
// realized = gain or loss already taken by selling units
function memberHoldings(rows){
  const holdings = Object.create(null);
  const holdingFor = name => holdings[name] ??= {units:0, cost:0, contributed:0, bought:0, realized:0, traded:false};

  for(const r of rows){
    if(r.unitsIssued === null) continue;
    const h = holdingFor(r.member);
    h.units += r.unitsIssued;
    h.cost += r.amount;
    h.contributed += r.amount;
  }

  for(const t of transfers){
    if(t.status !== "completed") continue;
    const seller = holdingFor(t.seller);
    seller.units -= transferUnits(t);
    seller.cost -= t.costMoved;
    seller.realized += transferAmount(t) - t.costMoved;
    seller.traded = true;
    for(const b of t.buyers){
      const buyer = holdingFor(b.name);
      buyer.units += b.units;
      buyer.cost += b.amount;
      buyer.bought += b.amount;
      buyer.traded = true;
    }
  }

  for(const h of Object.values(holdings)){
    if(Math.abs(h.units) < UNIT_DUST) h.units = 0;
    if(Math.abs(h.cost) < 0.005) h.cost = 0;
  }
  return holdings;
}

function computeOwnership(rows, totalUnits){
  const list = Object.entries(memberHoldings(rows)).map(([name, h]) => ({
    name,
    units: h.units,
    pct: totalUnits > 0 ? (h.units / totalUnits) * 100 : 0,
    totalContributed: h.cost,   // cost of the units held now
    contributed: h.contributed, // money this member put into the fund
    bought: h.bought,
    realized: h.realized,
    traded: h.traded
  }));
  list.sort((a,b) => b.units - a.units);
  return list;
}

// Everyone who has contributed, or taken part in a completed transfer
function memberNames(){
  const traded = transfers.filter(t => t.status === "completed").flatMap(t => [t.seller, ...t.buyers.map(b => b.name)]);
  return [...new Set([...entries.map(e => e.member), ...traded].filter(Boolean))];
}

// One member's figures today (null until the fund has a value)
function memberPosition(name){
  const { rows, totalUnits } = computeLedger();
  const perf = computePerformance(computeOwnership(rows, totalUnits), totalUnits);
  return perf?.memberPerf.find(m => m.name === name) ?? null;
}

// The headline figures for one member, used by the analytics cards and the statement
function memberFigures(name, history){
  const holding = memberHoldings(computeLedger().rows)[name];
  const cost = holding?.cost ?? 0;
  const value = memberPosition(name)?.currentValue ?? history.at(-1).shareValue;
  return {
    cost, value,
    units: holding?.units ?? 0,
    contributed: holding?.contributed ?? 0,
    bought: holding?.bought ?? 0,
    realized: holding?.realized ?? 0,
    traded: holding?.traded ?? false,
    gain: noTinyAmount(value - cost),
    returnPct: cost > 0 ? (noTinyAmount(value - cost) / cost) * 100 : 0
  };
}

// Extra lines about a member's transfers (empty when there is nothing to say)
function memberNotes(name){
  const realized = memberHoldings(computeLedger().rows)[name]?.realized ?? 0;
  const reserved = reservedUnits(name);
  const notes = [];
  if(Math.abs(realized) >= 0.005) notes.push(`Realized from units sold: ${fmtSignedPeso(realized)}`);
  if(reserved > 0) notes.push(`${fmtUnits(reserved)} units set aside for a pending transfer`);
  return notes;
}

// A member's story over time: contributions, transfers, and the value at each point
function buildMemberHistory(memberName){
  const key = memberName + "|" + _fullKey();
  if(_CACHE.memberHist[key]) return _CACHE.memberHist[key];

  const { rows, totalUnits } = computeLedger();
  const moves = transfers
    .filter(t => t.status === "completed" && (t.seller === memberName || t.buyers.some(b => b.name === memberName)))
    .sort((a,b) => a.certificateNo.localeCompare(b.certificateNo));

  const history = [];
  let cost = 0;
  let units = 0;

  const addPoint = (date, nav, extra = {}) => history.push({
    date, type:"value", amount:0, fundNav:nav, unitsIssued:0, ...extra,
    memberTotalContrib: cost,
    memberTotalUnits: units,
    avgCost: units > 0 ? cost / units : 0,
    shareValue: units * nav
  });

  const addTransfer = t => {
    const purchase = t.buyers.find(b => b.name === memberName);
    const unitChange = purchase ? purchase.units : -transferUnits(t);
    const amount = purchase ? purchase.amount : transferAmount(t);
    units += unitChange;
    cost += purchase ? amount : -t.costMoved;
    if(Math.abs(units) < UNIT_DUST) units = 0;
    if(Math.abs(cost) < 0.005) cost = 0;
    addPoint(t.completedDate, t.price, {type: purchase ? "bought" : "sold", amount, unitsIssued: unitChange, transfer: t});
  };

  let next = 0;
  for(const r of rows){
    if(r.nav === null) continue;
    while(next < moves.length && moves[next].completedDate < r.date) addTransfer(moves[next++]);
    if(r.member === memberName){
      cost += r.amount;
      units += r.unitsIssued;
      addPoint(r.date, r.nav, {type:"contribution", amount:r.amount, unitsIssued:r.unitsIssued});
    } else if(units > 0){
      // The value of this member's units also moves when others contribute
      addPoint(r.date, r.nav);
    }
  }
  while(next < moves.length) addTransfer(moves[next++]);

  // Points from portfolio value updates
  if(units > 0 && totalUnits > 0){
    const lastDate = history.at(-1).date;
    for(const snap of pvSnapshots){
      if(snap.date >= lastDate) addPoint(snap.date, snap.value / totalUnits);
    }
    // A transfer is priced on its agreement day, so finish the line at today's value
    const last = history.at(-1);
    if(last.type === "bought" || last.type === "sold") addPoint(last.date, getLatestPV() / totalUnits);
  }

  _CACHE.memberHist[key] = history;
  return history;
}

// The Amount column in a member's history table
function historyAmount(h){
  const label = {bought:"Bought ", sold:"Sold "}[h.type] ?? "";
  return label + fmtPeso(h.amount);
}

// ---------- Showing transfers ----------

function transferCardHtml(t, actionsHtml = ""){
  const fact = (label, value) => `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  const facts = [
    fact("Units", fmtUnits(transferUnits(t))),
    fact(t.status === "completed" ? "Amount paid" : "Amount", fmtPeso(transferAmount(t))),
    fact("Value per unit", fmtPrice(t.price)),
    fact("Agreed", formatDate(t.agreedDate)),
  ];
  if(t.status === "pending") facts.push(fact("Pay by", formatDate(t.dueDate)));
  if(t.completedDate) facts.push(fact("Completed", formatDate(t.completedDate)));
  if(t.cancelledDate) facts.push(fact("Cancelled", formatDate(t.cancelledDate)));
  if(t.voidedDate) facts.push(fact("Voided", formatDate(t.voidedDate)));

  const buyers = t.buyers.map(b => `
    <li><strong>${escapeHtml(b.name)}</strong><span class="mono">${fmtUnits(b.units)} units for ${fmtPeso(b.amount)}</span></li>`).join("");
  const reason = t.voidReason || t.cancelReason;
  const style = isOverdue(t) ? "overdue" : t.status;

  return `
    <article class="transfer-card is-${style}">
      <div class="transfer-head">
        <span class="transfer-chip">${transferStatusLabel(t)}</span>
        <span class="transfer-no mono">${t.certificateNo ?? ""}</span>
      </div>
      <h3 class="transfer-title">${escapeHtml(t.seller)} → ${escapeHtml(buyerNames(t))}</h3>
      <dl class="transfer-facts">${facts.join("")}</dl>
      <ul class="transfer-buyers">${buyers}</ul>
      ${reason ? `<p class="transfer-reason">Reason: ${escapeHtml(reason)}</p>` : ""}
      ${actionsHtml ? `<div class="transfer-actions">${actionsHtml}</div>` : ""}
    </article>`;
}

// Open transfers first (nearest deadline first), then history (newest first)
function sortedTransfers(){
  const open = transfers.filter(t => t.status === "pending").sort((a,b) => a.dueDate.localeCompare(b.dueDate));
  const closed = transfers.filter(t => t.status !== "pending").sort((a,b) => b.agreedAt.localeCompare(a.agreedAt));
  return [...open, ...closed];
}

function updateTransferCount(){
  const open = transfers.filter(t => t.status === "pending").length;
  document.getElementById("transfer-tab-btn").textContent = open ? `Transfers (${open})` : "Transfers";
}

// ---------- Certificate ----------

function certificateHtml(t, isMemberCopy){
  const buyerRows = t.buyers.map(b => `
    <tr><td>${escapeHtml(b.name)}</td><td>${fmtUnits(b.units)}</td><td>${fmtPeso(b.amount)}</td><td>${escapeHtml(b.paymentRef) || "—"}</td></tr>`).join("");
  const parties = [
    {name: t.seller, role: "Seller", before: t.sellerUnitsBefore, after: t.sellerUnitsAfter},
    ...t.buyers.map(b => ({name: b.name, role: "Buyer", before: b.unitsBefore, after: b.unitsAfter}))
  ];
  const holdingRows = parties.map(p => `
    <tr><td>${escapeHtml(p.name)} (${p.role})</td><td>${fmtUnits(p.before)}</td><td>${fmtUnits(p.after)}</td></tr>`).join("");
  const signatures = [...parties, {name:"", role:"Treasurer"}].map(p => `
    <div class="cert-sign"><span>${escapeHtml(p.name) || "&nbsp;"}</span>${p.role}</div>`).join("");

  return `
    <div class="cert-page">
      ${t.status === "voided" ? `<div class="cert-void"><strong>VOID</strong>Voided on ${formatDate(t.voidedDate)}. Reason: ${escapeHtml(t.voidReason)}</div>` : ""}
      ${isMemberCopy ? `<div class="cert-copy">Member copy. The signed original is kept by the treasurer.</div>` : ""}
      <div class="cert-header">
        <div class="cert-fund">JMS HOLDINGS FUND</div>
        <div class="cert-title">UNIT TRANSFER CERTIFICATE</div>
        <div class="cert-no">No. ${t.certificateNo}</div>
      </div>
      <dl class="cert-facts">
        <div><dt>Date agreed (price set)</dt><dd>${formatDate(t.agreedDate)}</dd></div>
        <div><dt>Date completed (units moved)</dt><dd>${formatDateTime(t.completedAt)}, Philippine time</dd></div>
        <div><dt>From</dt><dd>${escapeHtml(t.seller)}</dd></div>
        <div><dt>To</dt><dd>${escapeHtml(buyerNames(t))}</dd></div>
        <div><dt>Units transferred</dt><dd>${fmtUnits(transferUnits(t))}</dd></div>
        <div><dt>Value per unit</dt><dd>${fmtPrice(t.price)}</dd></div>
        <div><dt>Total amount paid</dt><dd>${fmtPeso(transferAmount(t))}</dd></div>
      </dl>
      <table class="cert-table">
        <thead><tr><th>Buyer</th><th>Units</th><th>Amount paid</th><th>Payment reference</th></tr></thead>
        <tbody>${buyerRows}</tbody>
      </table>
      <table class="cert-table">
        <thead><tr><th>Holdings</th><th>Units before</th><th>Units after</th></tr></thead>
        <tbody>${holdingRows}</tbody>
      </table>
      <div class="cert-signs">${signatures}</div>
      <div class="cert-footer">Internal family record of JMS Holdings.</div>
    </div>`;
}

function printCertificate(id, isMemberCopy){
  const t = transfers.find(x => x.id === id);
  if(!t?.certificateNo) return;
  const view = document.getElementById("print-cert-view");
  view.innerHTML = certificateHtml(t, isMemberCopy);
  // This tells the print layout to print the certificate and nothing else
  document.body.classList.add("print-cert");
  view.style.display = "block";
  window.print();
  setTimeout(() => { view.style.display = "none"; }, 500);
}

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
          transfers = data.transfers || [];
        } else if(Array.isArray(data)){
          entries = data;
          pvSnapshots = [];
          transfers = [];
        }
      } else if(Array.isArray(data)){
        entries = data;
        pvSnapshots = [];
        transfers = [];
      }
      logDebug(`Loaded ${entries.length} entries from localStorage`, "ok");
      return true;
    }
  }catch(e){
    logDebug("Local load error: " + e.message, "err");
  }
  entries = [];
  pvSnapshots = [];
  transfers = [];
  logDebug("No local entries found", "warn");
  return false;
}

function saveLocalEntries(){
  try{
    const payload = {
      entries: entries,
      pvSnapshots: pvSnapshots,
      transfers: transfers
    };
    localStorage.setItem(LOCAL_KEY, JSON.stringify(payload));
    logDebug(`Saved ${entries.length} entries to localStorage`, "ok");
  }catch(e){
    logDebug("Local save error: " + e.message, "err");
  }
}

// Puts the latest saved value into the "Current Total Portfolio Value" box
function syncPVInput(){
  document.getElementById("f-current-pv").value = getLatestPV() ?? "";
}

function getLatestPV(){
  if(!pvSnapshots || pvSnapshots.length === 0) return null;
  return pvSnapshots[pvSnapshots.length - 1].value;
}

// The date of the latest value written out in full, e.g. "November 26, 2026"
function formatValueDate(){
  return formatDate(pvSnapshots.at(-1)?.date);
}

// Fills every "Values as of" line, and leaves them empty when there is nothing to value
function showValueDate(){
  const hasValues = entries.length > 0 && getLatestPV() > 0;
  const text = hasValues ? `Values as of ${formatValueDate()}` : "";
  document.querySelectorAll(".as-of").forEach(el => el.textContent = text);
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

// Records the fund value for a date. It is stored when saveEntries() succeeds.
function savePVSnapshot(value, date = todayLocal()){
  const existing = pvSnapshots.find(s => s.date === date);
  if(existing){
    existing.value = value;
  } else {
    pvSnapshots.push({date, value});
    pvSnapshots.sort((a,b) => a.date.localeCompare(b.date));
  }
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

// The same data always gives the same text, whatever order its fields arrive in
function fingerprint(data){
  return JSON.stringify([data.entries, data.pvSnapshots, data.transfers], (key, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  );
}

// The shape saved in the cloud. See parseFundData for why it changes once transfers exist.
function toCloud({entries, pvSnapshots, transfers}){
  if(transfers.length === 0) return { entries, pvSnapshots };
  return { version: 2, contributions: entries, pvSnapshots, transfers };
}

// Replaces what is on screen with a fresh copy from the cloud
function useCloudData(data){
  entries = data.entries;
  pvSnapshots = data.pvSnapshots;
  transfers = data.transfers;
  cloudFingerprint = fingerprint(data);
  cloudReady = true;
  useLocalFallback = false;
  saveLocalEntries();
  invalidateCache("all");
  syncPVInput();
}

function resetCloudState(){
  cloudReady = false;
  cloudFingerprint = null;
}

async function loadEntries(){
  const banner = document.getElementById("status-banner");
  banner.textContent = "";

  loadLocalEntries();
  resetCloudState();

  if(!BIN_ID || !API_KEY){
    logDebug("No cloud config, using local only", "warn");
    invalidateCache("all");
    syncPVInput();
    render();
    return;
  }

  try{
    useCloudData(parseFundData(await jsonbinRead()));
    logDebug("Cloud load successful, synced to local", "ok");
  }catch(e){
    logDebug("Cloud load FAILED: " + e.message, "err");
    banner.textContent = "⚠ Cloud load failed. Showing the copy saved in this browser.\nChanges are paused so the cloud data stays safe.\nCheck your connection, then reload the page.";
    useLocalFallback = true;
    invalidateCache("all");
    syncPVInput();
  }
  render();
}

// Saves the current data. Returns {ok, message}.
// Before writing, it checks that nobody changed the cloud since this page loaded it.
async function saveEntries(){
  const banner = document.getElementById("status-banner");

  if(!BIN_ID || !API_KEY){
    saveLocalEntries();
    banner.textContent = "⚠ Not connected to cloud. Data saved locally in this browser only.";
    logDebug("No cloud config, saved local only", "warn");
    return { ok: true };
  }

  if(!cloudReady){
    return { ok: false, message: "Nothing was saved.\nThe cloud data has not loaded yet.\nCheck your connection, then reload the page." };
  }

  const payload = { entries, pvSnapshots, transfers };
  const mine = fingerprint(payload);

  const maxAttempts = 3;
  for(let attempt = 1; attempt <= maxAttempts; attempt++){
    try{
      const inCloud = fingerprint(parseFundData(await jsonbinRead()));
      // If the cloud already matches, an earlier attempt got through
      if(inCloud !== mine){
        if(inCloud !== cloudFingerprint){
          cloudReady = false;
          logDebug("Save refused: cloud data changed elsewhere", "err");
          return { ok: false, message: "Nothing was saved.\nThe cloud data was changed somewhere else after this page loaded.\nReload the page, check the latest entries, then try again." };
        }
        await jsonbinUpdate(toCloud(payload));
      }
      cloudFingerprint = mine;
      useLocalFallback = false;
      saveLocalEntries();
      banner.textContent = "";
      logDebug(`Cloud save successful (attempt ${attempt})`, "ok");
      return { ok: true };
    }catch(e){
      logDebug(`Cloud save attempt ${attempt} FAILED: ${e.message}`, "err");
      if(attempt < maxAttempts){
        const delay = 800 * attempt;
        logDebug(`Retrying in ${delay}ms...`, "warn");
        await new Promise(res => setTimeout(res, delay));
      }
    }
  }
  logDebug("All cloud save attempts exhausted", "err");
  return { ok: false, message: "The change could not be saved to the cloud, so it was not applied.\nCheck your connection and try again.\nIf it keeps failing, reload the page." };
}

// Applies a change, and keeps it only if it could be saved
async function commitChange(change, messageEl){
  if(isSaving){
    messageEl.textContent = "Still saving the last change.\nWait a moment, then try again.";
    return false;
  }
  if(BIN_ID && API_KEY && !cloudReady){
    messageEl.textContent = "Nothing was saved.\nThe cloud data has not loaded, so saving now could overwrite it.\nCheck your connection, then reload the page.";
    return false;
  }

  isSaving = true;
  messageEl.textContent = "Saving...";
  const backup = structuredClone({ entries, pvSnapshots, transfers });

  change();
  invalidateCache("all");
  const result = await saveEntries();

  if(!result.ok){
    entries = backup.entries;
    pvSnapshots = backup.pvSnapshots;
    transfers = backup.transfers;
    invalidateCache("all");
  }
  isSaving = false;
  messageEl.textContent = result.ok ? "" : result.message;
  syncPVInput();
  render();
  return result.ok;
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

function _fullKey(){ return _entriesKey() + "||" + _pvKey() + "||" + JSON.stringify(transfers); }

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

  const result = computeLedgerFor(entries);
  _cacheSet("ledger", key, result);
  logDebug("CACHE MISS: computeLedger computed", "warn");
  return result;
}

function computeLedgerFor(list){
  let unitsOutstanding = 0;
  const rows = [];
  for(const e of list){
    const before = unitsOutstanding;
    let nav, unitsIssued, warning = null;
    if(before === 0){
      nav = 1;
    } else if(!(e.pv > 0)){
      // A missing or zero value would create endless units, so the row is flagged instead
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
  return { rows, totalUnits: unitsOutstanding };
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
  // Only money put into the fund counts. Transfers move money between members.
  const totalContributed = sumOf(ownership, "contributed");
  const totalCurrentValue = latestPV;
  const gainLoss = totalCurrentValue - totalContributed;
  const gainLossPct = totalContributed > 0 ? (gainLoss / totalContributed) * 100 : 0;

  const memberPerf = ownership.map(m => {
    const currentValue = m.units * currentNav;
    const gain = noTinyAmount(currentValue - m.totalContributed);
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
  showValueDate();

  const dl = document.getElementById("member-list");
  dl.innerHTML = "";
  memberNames().forEach(name => {
    const opt = document.createElement("option");
    opt.value = name;
    dl.appendChild(opt);
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
    btn.addEventListener("click", () => confirmRemove(entries[Number(btn.dataset.idx)]));
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
        if(mp && mp.traded && mp.units === 0){
          gainHtml = `<span class="ledger-gain">All units sold</span>`;
        } else if(mp){
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
        ${memberNotes(m.name).map(note => `<span class="ledger-note">${note}</span>`).join("")}
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

  renderTransfers();
}

function confirmRemove(entry){
  const problem = removalProblem(entry);
  if(problem){
    const messageEl = document.getElementById("pv-warn");
    messageEl.textContent = problem;
    messageEl.scrollIntoView({ block: "center" });
    return;
  }
  showConfirmModal(
    "Remove this entry?",
    `${entry.date} · ${entry.member} · ${fmtPeso(entry.amount)}\n\nUnits for later entries will be recalculated.\nThis cannot be undone.`,
    async () => {
      const messageEl = document.getElementById("pv-warn");
      const removed = await commitChange(() => {
        const i = entries.indexOf(entry);
        if(i !== -1) entries.splice(i, 1);
      }, messageEl);
      if(removed){
        messageEl.textContent = "Entry removed.\nThe current portfolio value was not changed.\nCheck it, then press Update Portfolio Value.";
      }
    }
  );
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
      // Value right after this contribution: what it was before, plus the new money
      fundValue: (r.pv || 0) + r.amount,
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
function populateMemberSelector(){
  const select = document.getElementById("member-select");
  const currentVal = select.value;
  const members = memberNames().sort();

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

  const figures = memberFigures(memberName, history);
  const totalReturn = figures.returnPct;

  const snapContrib = document.getElementById("snap-contributed");
  const snapCurrent = document.getElementById("snap-current");
  const snapReturn = document.getElementById("snap-return");

  snapContrib.textContent = fmtPeso(figures.cost);
  snapContrib.nextElementSibling.textContent = figures.traded ? "Cost of Current Units" : "Total Contributed";
  document.getElementById("snap-note").textContent = memberNotes(memberName).join("\n");
  snapCurrent.textContent = fmtPeso(figures.value);
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

  history.filter(h => h.type !== "value").forEach(h => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="mono">${h.date}</td>
      <td class="mono">${historyAmount(h)}</td>
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
  status.className = "config-status";

  if(!apiKey){
    status.className = "config-status err";
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
    await jsonbinUpdate({entries: [], pvSnapshots: []});
    useCloudData({entries: [], pvSnapshots: [], transfers: []});

    status.className = "config-status ok";
    status.textContent = "New bin created successfully!";
    updateConfigUI();
    render();
  }catch(e){
    console.error("Create bin error:", e);
    logDebug("Create bin FAILED: " + e.message, "err");
    BIN_ID = "";
    API_KEY = "";
    status.className = "config-status err";
    status.textContent = "Failed: " + e.message;

    document.getElementById("fallback-notice").style.display = "block";
    document.getElementById("fallback-notice").innerHTML = `
      <b>Cloud connection failed.</b> ${escapeHtml(e.message)}<br>
      Nothing is connected yet, so entries added now stay in this browser only and will not move to the cloud later.<br>
      Check your Master Key and internet, then try again.
    `;
  }
}

async function connectToExistingBin(){
  const apiKey = document.getElementById("cfg-api-key").value.trim();
  const binId = document.getElementById("cfg-bin-id").value.trim();
  const status = document.getElementById("cfg-status");
  status.className = "config-status";

  if(!apiKey){
    status.className = "config-status err";
    status.textContent = "Please paste your X-Master-Key.";
    return;
  }
  if(!binId){
    status.className = "config-status err";
    status.textContent = "Please enter a Bin ID, or use 'Create New Bin' instead.";
    return;
  }

  BIN_ID = binId;
  API_KEY = apiKey;
  status.textContent = "Testing connection...";
  logDebug("Connecting to existing bin: " + binId);

  try{
    const data = parseFundData(await jsonbinRead());
    saveConfig(BIN_ID, API_KEY);
    useCloudData(data);
    status.className = "config-status ok";
    status.textContent = "Connected successfully! Data loaded.";
    logDebug("Connected! Loaded " + entries.length + " entries", "ok");
    updateConfigUI();
    render();
  }catch(e){
    console.error("Connect error:", e);
    logDebug("Connect FAILED: " + e.message, "err");
    BIN_ID = "";
    API_KEY = "";
    status.className = "config-status err";
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
  const payload = {entries, pvSnapshots, transfers};
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
  if(!cloudReady){
    showSyncStatus("Reloading from the cloud first...", "warn");
    await loadEntries();
    if(cloudReady) showSyncStatus("✅ Reloaded the latest cloud data.", "ok");
    else showSyncStatus("❌ Could not reach the cloud. Nothing was changed.", "err");
    return;
  }
  showSyncStatus("Checking the cloud copy...", "warn");
  const result = await saveEntries();
  if(result.ok) showSyncStatus("✅ Cloud is up to date.", "ok");
  else showSyncStatus("❌ " + result.message, "err");
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

  if(date > todayLocal()){
    warnEl.textContent = "The date is in the future.\nChoose today or an earlier date.";
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
    if(!(pv > 0)){
      warnEl.textContent = "Portfolio Value Before must be more than zero.\nThe fund already holds units, so it cannot be worth nothing.";
      return;
    }
  } else {
    pv = pvRaw === "" ? 0 : parseFloat(pvRaw);
  }

  // A back-dated entry must not replace a newer portfolio value
  const lastValueDate = pvSnapshots.length > 0 ? pvSnapshots[pvSnapshots.length - 1].date : "";
  const isNewest = date >= lastValueDate;

  logDebug(`Adding entry: ${member} ₱${amount} (PV: ${pv})`, "ok");
  const saved = await commitChange(() => {
    entries.push({ date, member, amount, pv });
    // The fund is now worth what it was before, plus the new money
    if(isNewest) savePVSnapshot(pv + amount, date);
  }, warnEl);
  if(!saved) return;  // the form stays filled in, so you can try again

  document.getElementById("f-amount").value = "";
  document.getElementById("f-pv").value = "";
  document.getElementById("f-member").value = "";
  if(!isNewest){
    warnEl.textContent = `Entry saved.\nIt is dated before your last value update (${lastValueDate}), so the current value was not changed.\nCheck it, then press Update Portfolio Value.`;
  }
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
  if(!(pv > 0)){
    warnEl.textContent = "Portfolio value must be more than zero.";
    return;
  }

  const { totalUnits } = computeLedger();
  if(totalUnits <= 0){
    warnEl.textContent = "No units outstanding yet. Add contributions first.";
    return;
  }

  const saved = await commitChange(() => savePVSnapshot(pv), warnEl);
  if(!saved) return;
  logDebug(`Updated portfolio value snapshot: ₱${pv}`, "ok");

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
// TRANSFERS (treasurer only)
// ============================================
const FULL_AMOUNT_GAP = 0.01; // pesos: how close counts as "the full amount"

const findTransfer = id => transfers.find(t => t.id === id);

function addDays(isoDate, days){
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// What a seller can still offer: units held, minus units already promised
function availableUnits(name){
  const held = memberHoldings(computeLedger().rows)[name]?.units ?? 0;
  const free = held - reservedUnits(name);
  return free > UNIT_DUST ? free : 0;
}

// Today's value per unit, or the reason a transfer cannot be priced yet
function todaysPrice(){
  const { totalUnits } = computeLedger();
  const latestPV = getLatestPV();
  if(!(latestPV > 0) || !(totalUnits > 0)){
    return { message: "There is nothing to transfer yet.\nLog contributions and update the portfolio value first." };
  }
  const valueDate = pvSnapshots.at(-1).date;
  if(valueDate !== todayLocal()){
    return { message: `The portfolio value was last updated on ${formatDate(valueDate)}.\nA transfer uses today's value, so first go to the Overview tab and press "Update Portfolio Value" (even if the number is the same).` };
  }
  return { price: latestPV / totalUnits, fundValue: latestPV, totalUnits };
}

// Checks the form and works out each buyer's units. Returns {ok, message} or the full plan.
function planTransfer(seller, buyerInputs){
  const fail = message => ({ ok: false, message });

  const today = todaysPrice();
  if(today.message) return fail(today.message);
  if(!seller) return fail("Choose who is transferring units.");

  const available = availableUnits(seller);
  if(available === 0) return fail(`${seller} has no units available.\nUnits in a pending transfer cannot be offered twice.`);

  const filled = buyerInputs.filter(b => b.name || b.amount !== "");
  if(filled.length === 0) return fail("Add at least one buyer and the amount they will pay.");

  // Reuse the spelling of existing members, so "maria" does not become a second Maria
  const pendingBuyers = transfers.filter(t => t.status === "pending").flatMap(t => t.buyers.map(b => b.name));
  const known = new Map([...memberNames(), ...pendingBuyers].map(n => [n.toLowerCase(), n]));

  const buyers = [];
  for(const input of filled){
    if(!input.name) return fail("Every buyer needs a name.");
    const name = known.get(input.name.toLowerCase()) ?? input.name;
    const amount = Math.round(Number(input.amount) * 100) / 100;
    if(!(amount > 0)) return fail(`Enter how much ${name} will pay.`);
    if(name.toLowerCase() === seller.toLowerCase()) return fail("The seller cannot also be a buyer.");
    if(buyers.some(b => b.name.toLowerCase() === name.toLowerCase())){
      return fail(`${name} is listed twice.\nPut their full amount on one line.`);
    }
    buyers.push({ name, amount, isNew: !known.has(name.toLowerCase()) });
  }

  const total = sumOf(buyers, "amount");
  const availableValue = available * today.price;
  const tooMuch = () => fail(`That is more than ${seller} can transfer.\nAvailable: ${fmtPeso(availableValue)} (${fmtUnits(available)} units).\nEntered: ${fmtPeso(total)}.`);
  if(total > availableValue + FULL_AMOUNT_GAP) return tooMuch();

  // Paying the full available value moves every unit, with nothing tiny left behind
  const sellsEverything = total >= availableValue - FULL_AMOUNT_GAP;
  let left = available;
  buyers.forEach((b, i) => {
    b.units = sellsEverything && i === buyers.length - 1 ? left : b.amount / today.price;
    left -= b.units;
  });
  // The one-centavo allowance must never leave the last buyer paying for no units
  if(buyers.some(b => b.units <= UNIT_DUST)) return tooMuch();

  return { ok: true, ...today, seller, buyers, available, availableValue, total, sellsEverything };
}

// ---------- New transfer form ----------

function buyerRows(){
  return [...document.querySelectorAll("#t-buyers .buyer-row")];
}

function readBuyerInputs(){
  return buyerRows().map(row => ({
    name: row.querySelector(".t-buyer-name").value.trim(),
    amount: row.querySelector(".t-buyer-amount").value
  }));
}

function addBuyerRow(){
  const row = document.createElement("div");
  row.className = "buyer-row";
  row.innerHTML = `
    <div><label>Buyer</label><input type="text" class="t-buyer-name" list="member-list" placeholder="Name"></div>
    <div><label>Pays (₱)</label><input type="number" class="t-buyer-amount" min="0" step="0.01" placeholder="0.00"></div>
    <button type="button" class="buyer-remove" aria-label="Remove this buyer">×</button>
    <div class="buyer-units mono"></div>`;
  row.querySelector(".buyer-remove").addEventListener("click", () => {
    row.remove();
    if(buyerRows().length === 0) addBuyerRow();
    refreshTransferPreview();
  });
  document.getElementById("t-buyers").appendChild(row);
}

function refreshTransferForm(){
  const select = document.getElementById("t-seller");
  const chosen = select.value;
  const today = todaysPrice();

  select.innerHTML = '<option value="">Choose a member...</option>';
  for(const name of memberNames().sort()){
    const units = availableUnits(name);
    if(units === 0) continue;
    const option = document.createElement("option");
    option.value = name;
    option.textContent = today.price ? `${name} (${fmtPeso(units * today.price)} available)` : name;
    select.appendChild(option);
  }
  select.value = [...select.options].some(o => o.value === chosen) ? chosen : "";

  const priceLine = document.getElementById("t-price");
  priceLine.classList.toggle("blocked", !today.price);
  priceLine.textContent = today.price
    ? `Value per unit today: ${fmtPrice(today.price)}\nFrom the portfolio value dated ${formatDate(todayLocal())}.`
    : today.message;
  refreshTransferPreview();
}

// Shows units and totals while you type
function refreshTransferPreview(){
  const { price } = todaysPrice();
  const seller = document.getElementById("t-seller").value;
  const inputs = readBuyerInputs();
  buyerRows().forEach((row, i) => {
    const amount = Number(inputs[i].amount);
    row.querySelector(".buyer-units").textContent = price && amount > 0 ? `≈ ${fmtUnits(amount / price)} units` : "";
  });

  const summary = document.getElementById("t-summary");
  if(!price || !seller){
    summary.textContent = "";
    return;
  }
  const available = availableUnits(seller) * price;
  const total = inputs.reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  const left = available - total;
  const ending = left < -FULL_AMOUNT_GAP ? `Over by ${fmtPeso(-left)}.`
    : left <= FULL_AMOUNT_GAP ? `This transfers everything ${seller} has available.`
    : `${fmtPeso(left)} stays with ${seller}.`;
  summary.textContent = `Total: ${fmtPeso(total)} of ${fmtPeso(available)} available.\n${ending}`;
}

// Puts whatever is still available on the last buyer line
function fillRemainingAmount(){
  const { price } = todaysPrice();
  const seller = document.getElementById("t-seller").value;
  if(!price || !seller) return;
  const rows = buyerRows();
  const others = readBuyerInputs().slice(0, -1).reduce((sum, b) => sum + (Number(b.amount) || 0), 0);
  const rest = Math.max(availableUnits(seller) * price - others, 0);
  rows.at(-1).querySelector(".t-buyer-amount").value = rest.toFixed(2);
  refreshTransferPreview();
}

function resetTransferForm(){
  document.getElementById("t-seller").value = "";
  document.getElementById("t-buyers").innerHTML = "";
  addBuyerRow();
  refreshTransferPreview();
}

function recordTransfer(){
  const warnEl = document.getElementById("t-warn");
  warnEl.textContent = "";
  const seller = document.getElementById("t-seller").value;
  const inputs = readBuyerInputs();
  const plan = planTransfer(seller, inputs);
  if(!plan.ok){
    warnEl.textContent = plan.message;
    return;
  }

  const lines = plan.buyers.map(b => `${b.name}${b.isNew ? " (new member)" : ""}: ${fmtPeso(b.amount)} for ${fmtUnits(b.units)} units`);
  showConfirmModal(
    "Record this agreement?",
    `From ${seller} to:\n${lines.join("\n")}\n\nValue per unit: ${fmtPrice(plan.price)}\nPayment due: ${formatDate(addDays(todayLocal(), PAYMENT_DAYS))}\n\nUnits move only after you confirm payment.`,
    async () => {
      // Checked again, in case anything changed while this box was open
      const fresh = planTransfer(seller, inputs);
      if(!fresh.ok){
        warnEl.textContent = fresh.message;
        return;
      }
      const record = {
        id: `T${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        status: "pending",
        seller,
        price: fresh.price,
        fundValue: fresh.fundValue,
        totalUnits: fresh.totalUnits,
        buyers: fresh.buyers.map(({name, units, amount}) => ({name, units, amount})),
        agreedDate: todayLocal(),
        agreedAt: new Date().toISOString(),
        dueDate: addDays(todayLocal(), PAYMENT_DAYS)
      };
      if(await commitChange(() => transfers.push(record), warnEl)){
        resetTransferForm();
        warnEl.textContent = "Agreement recorded.\nThe units are set aside until you confirm payment.";
      }
    },
    { hint: "This check prevents recording a transfer by accident." }
  );
}

// ---------- Actions on a transfer ----------

// Saves a change to one transfer. makeChange returns an error message, or nothing on success.
async function changeTransfer(id, expectedStatus, makeChange, successMessage){
  const messageEl = document.getElementById("t-list-warn");
  messageEl.textContent = "";
  const current = findTransfer(id);
  if(!current || current.status !== expectedStatus){
    messageEl.textContent = "This transfer has changed.\nReload the page and check it again.";
    return;
  }
  const problem = makeChange(structuredClone(current), true);
  if(problem){
    messageEl.textContent = problem;
    messageEl.scrollIntoView({ block: "center" });
    return;
  }
  if(await commitChange(() => makeChange(findTransfer(id), false), messageEl)){
    messageEl.textContent = successMessage;
  }
  messageEl.scrollIntoView({ block: "center" });
}

function nextCertificateNo(year){
  const prefix = `JMS-T-${year}-`;
  const used = transfers
    .filter(t => t.certificateNo?.startsWith(prefix))
    .map(t => Number(t.certificateNo.slice(prefix.length)));
  return prefix + String(Math.max(0, ...used) + 1).padStart(4, "0");
}

function askCompleteTransfer(t){
  showConfirmModal(
    "Confirm payment and complete",
    `Complete ONLY if every buyer has paid.\n\n${t.seller} → ${buyerNames(t)}\nTotal: ${fmtPeso(transferAmount(t))} for ${fmtUnits(transferUnits(t))} units.\n\nThe units move now and a certificate is created.`,
    values => changeTransfer(t.id, "pending", (target, checkOnly) => {
      if(isOverdue(target)) return "This transfer is overdue.\nExtend it by 7 days or cancel it first.";
      const holdings = memberHoldings(computeLedger().rows);
      const seller = holdings[target.seller];
      const units = transferUnits(target);
      if(!seller || seller.units < units - UNIT_DUST){
        return `${target.seller} no longer holds enough units for this transfer.\nCancel it and record a new one.`;
      }
      if(checkOnly) return;

      // The figures are saved on the record, so reprints always match
      const sellerAfter = seller.units - units < UNIT_DUST ? 0 : seller.units - units;
      target.sellerUnitsBefore = seller.units;
      target.sellerUnitsAfter = sellerAfter;
      // The seller's cost leaves with the units, at their average cost per unit
      target.costMoved = sellerAfter === 0 ? seller.cost : seller.cost * units / seller.units;
      target.buyers.forEach((b, i) => {
        b.unitsBefore = holdings[b.name]?.units ?? 0;
        b.unitsAfter = b.unitsBefore + b.units;
        b.paymentRef = values[`ref${i}`];
      });
      target.completedDate = todayLocal();
      target.completedAt = new Date().toISOString();
      target.certificateNo = nextCertificateNo(target.completedDate.slice(0, 4));
      target.status = "completed";
    }, "Transfer completed.\nYou can now print the certificate."),
    {
      hint: "This check prevents moving units by accident.",
      fields: t.buyers.map((b, i) => ({ id: `ref${i}`, label: `Payment reference from ${b.name} (optional)` }))
    }
  );
}

function askExtendTransfer(t){
  const newDate = addDays(todayLocal(), PAYMENT_DAYS);
  showConfirmModal(
    "Extend the payment deadline?",
    `New deadline: ${formatDate(newDate)}.\nThe value per unit stays the same.`,
    () => changeTransfer(t.id, "pending", (target, checkOnly) => {
      if(!checkOnly) target.dueDate = newDate;
    }, "Deadline extended."),
    { hint: "This check prevents changes by accident." }
  );
}

function askCancelTransfer(t){
  showConfirmModal(
    "Cancel this transfer?",
    `${t.seller} keeps all the units.\nIf any buyer already paid, return their money.`,
    values => changeTransfer(t.id, "pending", (target, checkOnly) => {
      if(checkOnly) return;
      target.status = "cancelled";
      target.cancelledDate = todayLocal();
      target.cancelReason = values.reason;
    }, "Transfer cancelled.\nThe units are available again."),
    { hint: "This check prevents cancelling by accident.", fields: [{ id: "reason", label: "Reason (optional)" }] }
  );
}

// Why a completed transfer cannot be voided right now, if anything
function voidProblem(t){
  const holdings = memberHoldings(computeLedger().rows);
  const laterSale = transfers.find(other =>
    other.status === "completed" && other.certificateNo > t.certificateNo && t.buyers.some(b => b.name === other.seller));
  if(laterSale){
    return `Void ${laterSale.certificateNo} first.\n${laterSale.seller} sold units after receiving them in this transfer.`;
  }
  const short = t.buyers.find(b => (holdings[b.name]?.units ?? 0) - reservedUnits(b.name) < b.units - UNIT_DUST);
  if(short){
    return `${short.name} no longer has all of these units free.\nCancel their pending transfer first.`;
  }
}

function askVoidTransfer(t){
  const problem = voidProblem(t);
  if(problem){
    const messageEl = document.getElementById("t-list-warn");
    messageEl.textContent = problem;
    messageEl.scrollIntoView({ block: "center" });
    return;
  }
  showConfirmModal(
    `Void ${t.certificateNo}?`,
    `Use this only if the completed record is wrong.\nThe units go back to ${t.seller}.\nAny money already paid must be returned outside the app.`,
    values => changeTransfer(t.id, "completed", (target, checkOnly) => {
      const stillProblem = voidProblem(target);
      if(stillProblem) return stillProblem;
      if(checkOnly) return;
      target.status = "voided";
      target.voidedDate = todayLocal();
      target.voidReason = values.reason;
    }, "Transfer voided.\nThe units are back with the seller."),
    { fields: [{ id: "reason", label: "Why is it being voided?", required: true }], hint: "This cannot be undone." }
  );
}

// A ready-made message for telling the other members
function transferNotice(t){
  const lines = [
    "JMS Holdings: unit transfer",
    `Status: ${transferStatusLabel(t)}${t.certificateNo ? ` (${t.certificateNo})` : ""}`,
    `From: ${t.seller}`,
    ...t.buyers.map(b => `To: ${b.name}, ${fmtUnits(b.units)} units for ${fmtPeso(b.amount)}`),
    `Value per unit: ${fmtPrice(t.price)}`,
    `Agreed: ${formatDate(t.agreedDate)}`
  ];
  if(t.status === "pending") lines.push(`Payment due: ${formatDate(t.dueDate)}`, "Units move once payment is confirmed.");
  if(t.status === "completed") lines.push(`Completed: ${formatDate(t.completedDate)}`);
  if(t.status === "cancelled") lines.push(`Cancelled: ${formatDate(t.cancelledDate)}. No units moved.`);
  if(t.status === "voided") lines.push(`Voided: ${formatDate(t.voidedDate)}. The units went back to ${t.seller}.`);
  return lines.join("\n");
}

async function copyNotice(t){
  const messageEl = document.getElementById("t-list-warn");
  const text = transferNotice(t);
  try{
    await navigator.clipboard.writeText(text);
    messageEl.textContent = "Notice copied.\nPaste it into your family chat.";
  }catch(e){
    // Some browsers block copying, so show the text to copy by hand
    messageEl.textContent = `Could not copy automatically.\nSelect and copy this:\n\n${text}`;
  }
  messageEl.scrollIntoView({ block: "center" });
}

const TRANSFER_ACTIONS = {
  complete: { label: "Confirm Payment & Complete", run: askCompleteTransfer },
  extend:   { label: "Extend 7 Days", run: askExtendTransfer },
  cancel:   { label: "Cancel Transfer", run: askCancelTransfer, danger: true },
  print:    { label: "Print Certificate", run: t => printCertificate(t.id, false) },
  void:     { label: "Void", run: askVoidTransfer, danger: true },
  notice:   { label: "Copy Notice", run: copyNotice }
};

function actionsFor(t){
  if(t.status === "pending") return isOverdue(t) ? ["extend", "cancel", "notice"] : ["complete", "cancel", "notice"];
  if(t.status === "completed") return ["print", "notice", "void"];
  if(t.status === "voided") return ["print", "notice"];
  return ["notice"];
}

function renderTransfers(){
  updateTransferCount();
  refreshTransferForm();
  const list = document.getElementById("t-list");
  list.innerHTML = sortedTransfers().map(t => transferCardHtml(t, actionsFor(t).map(key => `
      <button type="button" class="btn-tool${TRANSFER_ACTIONS[key].danger ? " danger" : ""}" data-action="${key}" data-id="${escapeHtml(t.id)}">${TRANSFER_ACTIONS[key].label}</button>`).join(""))
  ).join("") || '<div class="empty-note">No transfers yet.</div>';
}

// Why a contribution cannot be removed, if transfers depend on it
function removalProblem(entry){
  const sale = transfers.find(t => t.status === "completed" && t.seller === entry.member && t.completedDate >= entry.date);
  if(sale){
    return `This contribution cannot be removed.\nIt is part of the figures on transfer ${sale.certificateNo}.\nVoid that transfer first.`;
  }
  const holdings = memberHoldings(computeLedgerFor(entries.filter(e => e !== entry)).rows);
  const names = new Set([...Object.keys(holdings), ...transfers.map(t => t.seller)]);
  for(const name of names){
    if((holdings[name]?.units ?? 0) - reservedUnits(name) < -UNIT_DUST){
      return `This contribution cannot be removed.\nIt would leave ${name} with fewer units than they have transferred or set aside.\nCancel or void that transfer first.`;
    }
  }
}

document.getElementById("t-seller").addEventListener("change", refreshTransferPreview);
document.getElementById("t-buyers").addEventListener("input", refreshTransferPreview);
document.getElementById("t-add-buyer").addEventListener("click", () => { addBuyerRow(); refreshTransferPreview(); });
document.getElementById("t-fill").addEventListener("click", fillRemainingAmount);
document.getElementById("t-record").addEventListener("click", recordTransfer);
document.getElementById("t-list").addEventListener("click", e => {
  const button = e.target.closest("[data-action]");
  const t = button && findTransfer(button.dataset.id);
  if(t) TRANSFER_ACTIONS[button.dataset.action].run(t);
});
// Re-checks the date and price whenever the tab is opened
document.getElementById("transfer-tab-btn").addEventListener("click", renderTransfers);
addBuyerRow();

// ============================================
// INIT
// ============================================
const hasConfig = loadConfig();
updateConfigUI();
if(hasConfig){
  loadEntries();
} else {
  loadLocalEntries();
  invalidateCache("all");
  syncPVInput();
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

const DEFAULT_HINT = "This safety check prevents accidental deletion.";

// fields: extra boxes to fill in, as [{id, label, required}]. onConfirm receives their values.
function showConfirmModal(title, message, onConfirm, {fields = [], hint = DEFAULT_HINT} = {}){
  document.getElementById("modal-title").textContent = title;
  document.getElementById("modal-msg").textContent = message;
  document.getElementById("modal-hint").textContent = hint;
  const box = document.getElementById("modal-fields");
  box.innerHTML = "";
  for(const field of fields){
    const label = document.createElement("label");
    label.textContent = field.label;
    const input = document.createElement("input");
    input.type = "text";
    input.dataset.field = field.id;
    input.required = Boolean(field.required);
    input.maxLength = 120;
    input.autocomplete = "off";
    label.appendChild(input);
    box.appendChild(label);
  }
  document.getElementById("confirm-code").value = "";
  confirmCallback = onConfirm;
  updateConfirmButton();
  document.getElementById("confirm-modal").classList.add("visible");
  document.getElementById("confirm-code").focus();
}

// Confirm stays locked until 0000 is typed and every required box is filled
function updateConfirmButton(){
  const code = document.getElementById("confirm-code");
  const codeOk = code.value.trim() === "0000";
  const filled = [...document.querySelectorAll("#modal-fields input[required]")].every(input => input.value.trim());
  code.classList.toggle("valid", codeOk);
  const button = document.getElementById("modal-confirm");
  button.classList.toggle("active", codeOk && filled);
  button.disabled = !(codeOk && filled);
}

function hideConfirmModal(){
  document.getElementById("confirm-modal").classList.remove("visible");
  confirmCallback = null;
}

document.getElementById("confirm-modal").addEventListener("input", updateConfirmButton);

document.getElementById("modal-cancel").addEventListener("click", hideConfirmModal);
document.getElementById("modal-confirm").addEventListener("click", () => {
  const values = Object.fromEntries(
    [...document.querySelectorAll("#modal-fields input")].map(input => [input.dataset.field, input.value.trim()]));
  if(confirmCallback) confirmCallback(values);
  hideConfirmModal();
});

// Danger buttons: nothing happens until 0000 is typed and Confirm is pressed
document.getElementById("btn-clear-local").addEventListener("click", () => {
  showConfirmModal(
    "🗑 Clear Local Data",
    "This deletes ONLY the copy saved in this browser.\nThe cloud data is not touched, and is loaded again right after.",
    async () => {
      try{
        localStorage.removeItem(LOCAL_KEY);
        clearPVSnapshots();
        entries = [];
        transfers = [];
        resetCloudState();
        invalidateCache("all");
        logDebug("Local entries cleared", "warn");
        await loadEntries();
        if(cloudReady) showSyncStatus("🗑 Local copy cleared and reloaded from the cloud.", "ok");
        else showSyncStatus("🗑 Local copy cleared. The cloud could not be loaded.", "warn");
      }catch(e){
        logDebug("Clear local failed: " + e.message, "err");
      }
    }
  );
});

document.getElementById("btn-disconnect").addEventListener("click", () => {
  showConfirmModal(
    "🔌 Disconnect & Clear ALL",
    "This disconnects from the cloud AND clears all data in this browser.\nYou will need to connect again. This cannot be undone.",
    () => {
      try{
        localStorage.removeItem(LOCAL_KEY);
        localStorage.removeItem(CONFIG_KEY);
        clearPVSnapshots();
        entries = [];
        transfers = [];
        resetCloudState();
        invalidateCache("all");
        BIN_ID = "";
        API_KEY = "";
        syncPVInput();
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
  const members = memberNames();

  document.getElementById("fl-date").textContent = today;
  document.getElementById("fl-asof").textContent = formatValueDate() || "—";
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

  // Once there are transfers, cost and realized gain are shown as well
  const hasTrades = ownership.some(m => m.traded);
  document.getElementById("fl-cost-head").textContent = hasTrades ? "Cost of Units" : "Contributed";
  document.getElementById("fl-realized-head").hidden = !hasTrades;
  document.getElementById("fl-transfer-section").hidden = transfers.length === 0;
  document.getElementById("fl-transfer-body").innerHTML = sortedTransfers().map(t => `
    <tr><td class="mono">${t.agreedDate}</td><td>${transferStatusLabel(t)}</td><td class="mono">${t.certificateNo ?? "—"}</td>
    <td>${escapeHtml(t.seller)}</td><td>${escapeHtml(buyerNames(t))}</td>
    <td class="mono">${fmtUnits(transferUnits(t))}</td><td class="mono">${fmtPeso(transferAmount(t))}</td></tr>`).join("");

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
        ${hasTrades ? `<td class="mono">${fmtSignedPeso(m.realized)}</td>` : ""}
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

  document.body.classList.remove("print-cert");
  const view = document.getElementById("print-fund-view");
  view.style.display = "block";
  window.print();
  setTimeout(() => { view.style.display = "none"; }, 500);
}

document.getElementById("btn-print-fund-log").addEventListener("click", generateFundLog);
