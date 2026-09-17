#!/usr/bin/env node
/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  JMS HOLDINGS — NAVPU SUMMARIZER v1.0                                  ║
 * ║  Deterministic natural-language summary (NO LLM).                       ║
 * ║  Reads audit-reports/latest.json (from navpu-audit-swarm.js) and emits ║
 * ║  clean Markdown: fund overview, member bullets, recent activity, flags. ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * WHY NO LLM: every number in the summary is quoted verbatim from the audit
 * report, which is recomputed from source data by the 6-cylinder engine.
 * Templates guarantee fidelity; LLMs don't. (Use an LLM only for open-ended
 * Q&A later — and even then, ground it on this JSON, never let it do math.)
 *
 * OPTIONAL one-time patch to navpu-audit-swarm.js (ReporterAgent.buildReport)
 * so recent contributions appear in the report without --data:
 *
 *   recentEntries: entries.slice(-5).reverse().map(e => ({
 *     date: e.date, member: e.member, amount: e.amount, pv: e.pv ?? null })),
 *   latestPvDate: pvSnapshots.length
 *     ? pvSnapshots[pvSnapshots.length - 1].date : null,
 *
 * USAGE:
 *   node navpu-summarizer.js                                  # default report path
 *   node navpu-summarizer.js --report audit-reports/latest.json
 *   node navpu-summarizer.js --report latest.json --data jms-export.json
 *   node navpu-summarizer.js --out summary.md                 # write to file
 */

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs() {
  const args = process.argv.slice(2);
  const flags = { report: 'audit-reports/latest.json' };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--report') flags.report = args[++i];
    else if (args[i] === '--data') flags.data = args[++i];
    else if (args[i] === '--out') flags.out = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') flags.help = true;
  }
  return flags;
}
const FLAGS = parseArgs();

if (FLAGS.help) {
  console.log('Usage: node navpu-summarizer.js [--report latest.json] [--data export.json] [--out summary.md]');
  process.exit(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatting helpers (all deterministic)
// ─────────────────────────────────────────────────────────────────────────────
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function fmtDate(iso) {
  if (!iso) return 'n/a';
  const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return String(iso);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

function peso(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return 'n/a';
  return '₱' + Number(x).toLocaleString('en-PH',
    { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function signedPeso(x) {
  if (x === null || x === undefined) return 'n/a';
  const v = Number(x);
  return (v >= 0 ? '+' : '-') + peso(Math.abs(v));
}

function signedPct(x, digits = 2) {
  if (x === null || x === undefined || Number.isNaN(Number(x))) return 'n/a';
  const v = Number(x);
  return (v >= 0 ? '+' : '-') + Math.abs(v).toFixed(digits) + '%';
}

function nav(x) {
  return (x === null || x === undefined) ? 'n/a' : Number(x).toFixed(4);
}

function units(x) {
  return (x === null || x === undefined) ? 'n/a' : Number(x).toLocaleString('en-PH',
    { maximumFractionDigits: 4 });
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary generator
// ─────────────────────────────────────────────────────────────────────────────
function summarize(report, rawData) {
  const { meta, fund, ownership, findings, history } = report;
  if (!fund) throw new Error('Report has no fund block — run the audit swarm first.');

  const L = [];
  const asOf = (history && history.length)
    ? history[history.length - 1].date
    : (report.latestPvDate || (meta.timestamp || '').slice(0, 10));
  const up = (fund.gainLoss ?? 0) >= 0;

  // ── Header ──
  L.push('# JMS Holdings — Fund Summary');
  L.push('');
  L.push(`**As of ${fmtDate(asOf)}** · ${meta.memberCount} member(s) · ` +
         `${meta.entryCount} contribution(s) · ${meta.pvSnapshotCount} PV snapshot(s)`);
  L.push('');
  L.push(`The fund's current NAVPU is **${nav(fund.currentNav)}**, with total assets of ` +
         `**${peso(fund.currentValue)}** against **${peso(fund.totalContributed)}** contributed ` +
         `— ${up ? 'up' : 'down'} ${peso(Math.abs(fund.gainLoss || 0))} ` +
         `(${signedPct(fund.gainLossPct)}) since inception.`);

  // ── Key metrics ──
  L.push('', '## Key metrics', '');
  L.push(`- **NAVPU:** ${nav(fund.currentNav)}`);
  L.push(`- **Units outstanding:** ${units(fund.totalUnits)}`);
  L.push(`- **Total contributed:** ${peso(fund.totalContributed)}`);
  L.push(`- **Current fund value:** ${peso(fund.currentValue)}`);
  L.push(`- **Inception-to-date return:** ${signedPeso(fund.gainLoss)} (${signedPct(fund.gainLossPct)})`);

  // ── Members ──
  if (ownership && ownership.length) {
    L.push('', '## Members', '');
    for (const o of ownership) {
      const perf = (o.gainPct === null || o.gainPct === undefined)
        ? ''
        : ` · now ${peso(o.currentValue)} (${signedPeso(o.gain)} / ${signedPct(o.gainPct)})`;
      L.push(`- **${o.name}** — ${Number(o.pct).toFixed(1)}% of fund · contributed ` +
             `${peso(o.contributed)}${perf}`);
    }
    // Deterministic callouts (ties resolve by sort order — ownership is sorted desc by units)
    const largest = ownership[0];
    const topContributor = [...ownership].sort((a, b) => (b.contributed || 0) - (a.contributed || 0))[0];
    const withPerf = ownership.filter(o => o.gainPct !== null && o.gainPct !== undefined);
    L.push('');
    if (ownership.length > 1) {
      L.push(`Largest stake: **${largest.name}** (${Number(largest.pct).toFixed(1)}%). ` +
             `Top contributor: **${topContributor.name}** (${peso(topContributor.contributed)}).` +
             (withPerf.length
               ? ` Best performer: **${withPerf[0].name}** (${signedPct(withPerf[0].gainPct)}).`
               : ''));
    }
  }

  // ── Recent activity ──
  const recent = report.recentEntries
    || (rawData && Array.isArray(rawData.entries) ? rawData.entries.slice(-5).reverse() : null);
  const latestPvDate = report.latestPvDate
    || (rawData && Array.isArray(rawData.pvSnapshots) && rawData.pvSnapshots.length
        ? rawData.pvSnapshots[rawData.pvSnapshots.length - 1].date : null);

  if (recent || latestPvDate) {
    L.push('', '## Recent activity', '');
    if (latestPvDate) {
      L.push(`- Latest portfolio-value snapshot: **${fmtDate(latestPvDate)}**`);
    }
    if (recent) {
      for (const e of recent) {
        const pvNote = (e.pv === null || e.pv === undefined)
          ? ' *(no PV recorded at entry)*'
          : ` *(PV at entry: ${peso(e.pv)})*`;
        L.push(`- ${fmtDate(e.date)} — **${e.member}** contributed ${peso(e.amount)}${pvNote}`);
      }
    }
  }

  // ── Automated checks / flags ──
  L.push('', '## Automated checks', '');
  const crit = (findings || []).filter(f => f.severity === 'CRITICAL');
  const warn = (findings || []).filter(f => f.severity === 'WARNING');
  if (crit.length === 0 && warn.length === 0) {
    L.push(`- ✅ All automated audit checks passed — no issues flagged.`);
  } else {
    if (crit.length) {
      L.push(`- ❌ **${crit.length} critical issue(s):**`);
      crit.slice(0, 10).forEach(f => L.push(`  - [${f.checklistRef}] ${f.message}`));
    }
    if (warn.length) {
      L.push(`- ⚠️ **${warn.length} warning(s):**`);
      warn.slice(0, 10).forEach(f => L.push(`  - [${f.checklistRef}] ${f.message}`));
    }
  }

  L.push('');
  L.push(`---`);
  L.push(`*Report ${meta.auditId} · generated ${meta.timestamp} · ` +
         `navpu-summarizer v1.0 (deterministic, no LLM)*`);
  return L.join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
function main() {
  const reportPath = path.resolve(FLAGS.report);
  if (!fs.existsSync(reportPath)) {
    console.error(`Report not found: ${reportPath}\nRun navpu-audit-swarm.js first.`);
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  if (report.status === 'ERROR') {
    console.error(`Report ${report.meta.auditId} is an ERROR report: ${report.error}`);
    process.exit(1);
  }

  let rawData = null;
  if (FLAGS.data) {
    const dataPath = path.resolve(FLAGS.data);
    if (!fs.existsSync(dataPath)) {
      console.error(`--data file not found: ${dataPath}`);
      process.exit(1);
    }
    rawData = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
  }

  const md = summarize(report, rawData);

  if (FLAGS.out) {
    const outPath = path.resolve(FLAGS.out);
    fs.writeFileSync(outPath, md, 'utf8');
    console.log(`✅ summary written -> ${outPath}`);
  } else {
    console.log('\n' + md + '\n');
  }
}

main();

// ═════════════════════════════════════════════════════════════════════════════
// GITHUB ACTIONS — add this step after "Run NAVPU Audit Swarm" in
// .github/workflows/navpu-audit.yml (the existing Upload step will pick it up
// if you write to audit-reports/):
//
//   - name: Generate Fund Summary
//     run: node navpu-summarizer.js --report audit-reports/latest.json \
//          --out audit-reports/summary.md
//
// The dashboards can fetch summary.md from the artifact, or you can paste the
// generator into the browser bundle — it has zero Node-only dependencies except fs.
// ═════════════════════════════════════════════════════════════════════════════
