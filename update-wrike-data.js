/**
 * update-wrike-data.js
 * Repulls completed-task stats from the Wrike API and regenerates data.js
 * for the Digital Analytics dashboard (index.html).
 *
 * Usage:  node update-wrike-data.js
 * Auth:   WRIKE_TOKEN env var, or WRIKE_TOKEN=... line in ./.env
 *
 * Methodology (recovered from the original May 2026 pull):
 *  - Pull ALL completed tasks per responsible (5 Wrike contact IDs, 3 teams),
 *    paginated via nextPageToken, deduped across members.
 *  - Bucket by sprint using custom field "MAP-BI-Sprint Number" (IEAFI2DXJUAF27WJ),
 *    label extracted with /(\d{2}\.\d{2})/. Tasks with no sprint label are skipped.
 *  - Request type from "MAP-Digital Analytics Request Type" (IEAFI2DXJUAGHLIX).
 *  - Category from "MAP-Project Category" (IEAFI2DXJUAEZ3SD).
 *  - "Uncategorized" is displayed as "Agency Transition" on the dashboard.
 */

const fs = require('fs');
const path = require('path');

// ---------- config ----------

const CF_SPRINT = 'IEAFI2DXJUAF27WJ';   // MAP-BI-Sprint Number
const CF_TYPE = 'IEAFI2DXJUAGHLIX';     // MAP-Digital Analytics Request Type
const CF_CATEGORY = 'IEAFI2DXJUAEZ3SD'; // MAP-Project Category

// Team → responsible contact IDs. Order matters: dedup assigns a task to the
// first team that pulls it (DA first, matching the original pull).
const TEAMS = [
  { key: 'DA', ids: ['KUAMXJKD', 'KUAQLA5C', 'KUAQLPXZ'] }, // Trevor, Destiney, Christian
  { key: 'India', ids: ['KUAS2UBE'] },                      // ExoEdge shared login
  { key: 'Myna', ids: ['KUATNT6X'] },                       // Digital Analytics1 shared login
];

const TYPE_LABELS = {
  'Gain access to GA/GSC/GTM': 'GA/GSC/GTM Access',
  'Setup Event tracking in GA/GTM': 'Event Tracking Setup',
  'Publish tags in GTM': 'Publish Tags',
  'Web Cookie Compliance': 'Cookie Compliance',
  'Property Offboarding': 'Offboarding',
  'Dynamic Attribution': 'Dynamic Attribution',
  'Ai': 'AI',
  'Other': 'Other',
};
const TYPE_KEYS = ['GA/GSC/GTM Access', 'Event Tracking Setup', 'Publish Tags',
  'Data Troubleshoot', 'Cookie Compliance', 'Offboarding', 'Dynamic Attribution',
  'AI', 'Other', 'Agency Transition'];

const CATEGORY_KEYS = ['GTM/Custom Event Tracking', 'Web Cookie Compliance',
  'Dynamic Attribution', 'AI', 'BigQuery', 'Other', 'Agency Transition'];

// ---------- auth ----------

function getToken() {
  if (process.env.WRIKE_TOKEN) return process.env.WRIKE_TOKEN.trim();
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    const m = fs.readFileSync(envPath, 'utf8').match(/^WRIKE_TOKEN=(.+)$/m);
    if (m) return m[1].trim();
  }
  console.error('ERROR: WRIKE_TOKEN not found (env var or .env file).');
  process.exit(1);
}
const TOKEN = getToken();

// ---------- Wrike API ----------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function wrikeGet(url, attempt = 0) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (res.status === 429) {
    if (attempt >= 6) throw new Error(`429 rate limit persisted for ${url}`);
    const wait = 15000 * (attempt + 1);
    console.log(`  429 rate-limited, waiting ${wait / 1000}s...`);
    await sleep(wait);
    return wrikeGet(url, attempt + 1);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} for ${url}\n${body.slice(0, 500)}`);
  }
  return res.json();
}

let includeCompletedDate = true;

async function fetchCompletedTasks(responsibleId) {
  const tasks = [];
  let nextPageToken = null;
  while (true) {
    const fields = includeCompletedDate ? '["customFields","completedDate"]' : '["customFields"]';
    let url = `https://www.wrike.com/api/v4/tasks?responsibles=${encodeURIComponent(`["${responsibleId}"]`)}` +
      `&status=Completed&fields=${encodeURIComponent(fields)}&pageSize=100` +
      (nextPageToken ? `&nextPageToken=${nextPageToken}` : '');
    let json;
    try {
      json = await wrikeGet(url);
    } catch (e) {
      // completedDate may not be a valid optional field on this endpoint — retry same page without it
      if (includeCompletedDate && /completedDate/i.test(e.message)) {
        console.log('  "completedDate" not accepted as a field — falling back to customFields only.');
        includeCompletedDate = false;
        continue; // retry the SAME page (nextPageToken unchanged)
      }
      throw e;
    }
    tasks.push(...json.data);
    nextPageToken = json.nextPageToken || null;
    process.stdout.write(`\r  ${responsibleId}: ${tasks.length} tasks...`);
    if (!nextPageToken) break;
    await sleep(200);
  }
  console.log(`\r  ${responsibleId}: ${tasks.length} tasks     `);
  return tasks;
}

// ---------- bucketing helpers ----------

function cfValue(task, cfId) {
  const cf = (task.customFields || []).find((f) => f.id === cfId);
  return cf && cf.value != null ? String(cf.value) : '';
}

// values can arrive as plain strings or JSON-encoded arrays like ["26.09 – 4/22/26 → 5/5/26"]
function firstValue(raw) {
  if (!raw) return '';
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr) && arr.length) return String(arr[0]).trim();
    } catch {
      // fall through — strip brackets/quotes manually
      return s.replace(/^\[|\]$/g, '').replace(/^"|"$/g, '').split('","')[0].trim();
    }
    return '';
  }
  return s;
}

function sprintLabel(task) {
  const m = cfValue(task, CF_SPRINT).match(/(\d{2}\.\d{2})/);
  return m ? m[1] : null;
}

// sprint raw value embeds the date range: "26.09 – 4/22/26 → 5/5/26"; use the
// END date as fallback month source when completedDate is unavailable
function sprintEndDate(task) {
  const dates = cfValue(task, CF_SPRINT).match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/g);
  if (!dates || !dates.length) return null;
  const [mo, , yr] = dates[dates.length - 1].split('/').map(Number);
  return { year: 2000 + yr, month: mo };
}

function sprintStartDate(task) {
  const dates = cfValue(task, CF_SPRINT).match(/(\d{1,2})\/(\d{1,2})\/(\d{2})/g);
  if (!dates || !dates.length) return null;
  const [mo, dy, yr] = dates[0].split('/').map(Number);
  return new Date(Date.UTC(2000 + yr, mo - 1, dy));
}

function taskMonth(task, sprintYear) {
  if (task.completedDate) {
    const d = new Date(task.completedDate);
    if (d.getUTCFullYear() === sprintYear) return d.getUTCMonth() + 1;
  }
  const se = sprintEndDate(task);
  if (se && se.year === sprintYear) return se.month;
  return null;
}

function typeLabel(task) {
  const v = firstValue(cfValue(task, CF_TYPE));
  if (!v) return 'Agency Transition';
  if (v.startsWith('Data Troubleshoot')) return 'Data Troubleshoot';
  return TYPE_LABELS[v] || 'Other';
}

function categoryLabel(task) {
  const v = firstValue(cfValue(task, CF_CATEGORY)).replace(/\\\//g, '/');
  if (!v || v === 'Uncategorized') return 'Agency Transition';
  if (v.startsWith('GTM/Custom Event Tracking') || v.startsWith('GTM\\/')) return 'GTM/Custom Event Tracking';
  if (v === 'Web Cookie Compliance') return 'Web Cookie Compliance';
  if (v === 'Dynamic Attribution') return 'Dynamic Attribution';
  if (v === 'AI' || v === 'Ai') return 'AI';
  if (v.startsWith('BigQuery')) return 'BigQuery';
  return 'Other';
}

// ---------- main ----------

(async () => {
  console.log('Pulling completed tasks from Wrike (per responsible, all time)...');
  const seen = new Set();
  // taskRecords: {sprint, team, type, category, month, year}
  const records = [];

  for (const team of TEAMS) {
    for (const id of team.ids) {
      const tasks = await fetchCompletedTasks(id);
      for (const t of tasks) {
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        const sprint = sprintLabel(t);
        if (!sprint) continue; // dashboard tracks sprint-labeled work only
        const year = 2000 + Number(sprint.split('.')[0]);
        records.push({
          sprint, year, team: team.key,
          type: typeLabel(t), category: categoryLabel(t),
          month: taskMonth(t, year),
          sprintStart: sprintStartDate(t),
        });
      }
    }
  }
  console.log(`Unique completed tasks: ${seen.size}; sprint-labeled: ${records.length}`);

  // sprint label axis: fixed 25.01–25.26, then 26.01 → current sprint.
  // Tasks can be pre-labeled against future sprints; only include sprints
  // that have actually STARTED (per the date range in the sprint field).
  const today = new Date();
  const started26 = records
    .filter((r) => r.year === 2026 && r.sprintStart && r.sprintStart <= today)
    .map((r) => Number(r.sprint.split('.')[1]));
  const seen26 = records.filter((r) => r.year === 2026).map((r) => Number(r.sprint.split('.')[1]));
  const max26 = started26.length ? Math.max(10, ...started26) : Math.max(10, ...seen26, 10);
  const labels = [];
  for (let i = 1; i <= 26; i++) labels.push(`25.${String(i).padStart(2, '0')}`);
  for (let i = 1; i <= max26; i++) labels.push(`26.${String(i).padStart(2, '0')}`);
  const idx = new Map(labels.map((l, i) => [l, i]));

  const zeros = () => labels.map(() => 0);
  const SD = {
    labels,
    totals: zeros(),
    byType: Object.fromEntries(TYPE_KEYS.map((k) => [k, zeros()])),
    byCategory: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, zeros()])),
    typeTotals: Object.fromEntries(TYPE_KEYS.map((k) => [k, 0])),
    catTotals: Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0])),
  };
  const TEAM = { labels, DA: zeros(), India: zeros(), Myna: zeros() };
  const monthly = {
    2025: { DA: Array(12).fill(0), India: Array(12).fill(0), Myna: Array(12).fill(0) },
    2026: { DA: Array(12).fill(0), India: Array(12).fill(0), Myna: Array(12).fill(0) },
  };
  const counters = {
    2025: { DA: 0, India: 0, Myna: 0 },
    2026: { DA: 0, India: 0, Myna: 0 },
  };

  let droppedNoAxis = 0;
  for (const r of records) {
    const i = idx.get(r.sprint);
    if (i === undefined) { droppedNoAxis++; continue; } // e.g. pre-2025 sprints
    SD.totals[i]++;
    SD.byType[r.type][i]++;
    SD.byCategory[r.category][i]++;
    SD.typeTotals[r.type]++;
    SD.catTotals[r.category]++;
    TEAM[r.team][i]++;
    counters[r.year][r.team]++;
    if (r.month && monthly[r.year]) monthly[r.year][r.team][r.month - 1]++;
  }
  if (droppedNoAxis) console.log(`Note: ${droppedNoAxis} tasks had sprint labels outside 25.01–26.${max26} and were dropped.`);

  // ---------- yearData ----------
  const now = new Date();
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const fmtDate = `${MONTHS[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
  const monthsElapsed2026 = now.getFullYear() > 2026 ? 12 : now.getMonth() + 1;

  function yearBlock(yr) {
    const c = counters[yr];
    const total = c.DA + c.India + c.Myna;
    const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
    const nMonths = yr === 2026 ? monthsElapsed2026 : 12;
    return {
      info: yr === 2026
        ? `Jan 1 – ${fmtDate} · Live from Wrike API · Sprints 26.01–26.${String(max26).padStart(2, '0')} · All three teams active.`
        : 'Full Year 2025 · Live from Wrike API · Per-person pull across all Wrike spaces · All three teams active.',
      counters: { total, india: c.India, da: c.DA },
      lblTotal: yr === 2026 ? 'Total Tasks Completed YTD' : 'Total Tasks — Full Year 2025',
      lblIndia: 'India Team Tasks',
      donutData: [c.India, c.DA, c.Myna],
      legend: [
        { color: '#0F6E56', label: 'India', val: `${c.India.toLocaleString()} · ${pct(c.India)}%` },
        { color: '#1a56db', label: 'Digital Analytics', val: `${c.DA.toLocaleString()} · ${pct(c.DA)}%` },
        { color: '#f59e0b', label: 'Myna', val: `${c.Myna.toLocaleString()} · ${pct(c.Myna)}%` },
      ],
      barTitle: yr === 2026 ? 'Monthly Task Completion — 2026' : 'Monthly Task Completion — Full Year 2025',
      barLabels: MONTHS.slice(0, nMonths),
      barDA: monthly[yr].DA.slice(0, nMonths),
      barIndia: monthly[yr].India.slice(0, nMonths),
      barMyna: monthly[yr].Myna.slice(0, nMonths),
    };
  }

  const yearData = { 2025: yearBlock(2025), 2026: yearBlock(2026) };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const META = {
    generated: fmtDate,
    sprintCount: labels.length,
    teamTotals: { DA: sum(TEAM.DA), India: sum(TEAM.India), Myna: sum(TEAM.Myna) },
    ytdTotal: yearData[2026].counters.total,
  };

  // ---------- write data.js ----------
  const out = [
    `/* Generated by update-wrike-data.js on ${fmtDate} — do not edit by hand. */`,
    `const SD = ${JSON.stringify(SD)};`,
    `const TEAM = ${JSON.stringify(TEAM)};`,
    `const yearData = ${JSON.stringify(yearData)};`,
    `const DASH_META = ${JSON.stringify(META)};`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'data.js'), out);

  console.log('\nWrote data.js');
  console.log(`  Sprints on axis: ${labels.length} (through 26.${String(max26).padStart(2, '0')})`);
  console.log(`  2026 YTD: total=${META.ytdTotal} (DA=${counters[2026].DA}, India=${counters[2026].India}, Myna=${counters[2026].Myna})`);
  console.log(`  2025 FY:  total=${yearData[2025].counters.total} (DA=${counters[2025].DA}, India=${counters[2025].India}, Myna=${counters[2025].Myna})`);
  console.log(`  All-time team totals: DA=${META.teamTotals.DA}, India=${META.teamTotals.India}, Myna=${META.teamTotals.Myna}`);
})().catch((e) => { console.error('\nFAILED:', e.message); process.exit(1); });
