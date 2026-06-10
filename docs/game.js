/* =====================================================================
   Nekro's Grimoire — an idle / clicker game about deciphering runes.

   STACKING RULES (per design):
   - Additive bonuses (Proficiency +0.1/tap, Flow +1/sec) are summed FIRST,
     then all multipliers are applied. So a flat +1 becomes huge once
     multipliers stack on top of it.
   - "Multiplicative" research (x2, x5, ...) multiplies together:
       x5 then x5 again = x25, not x10.
   - "Additive-percentage" research (+20%, +25%, ...) sums its percentages
     within its own group, converts to a multiplier (1 + sum), and that
     group multiplies with the other multiplier groups.
   - Order of acquisition never changes the final result.
   ===================================================================== */

"use strict";

/* ---------- constants ---------- */
const BASE_TAP = 1 / 3;            // three taps grant one rune
const PROF_ADD = 0.1;              // Proficiency: +0.1 rune / tap per level
const FLOW_ADD = 1;                // Flow: +1 rune / second per level
const COMP_BASE_PCT = 0.05;        // each Comprehension = +5% all rune gain (base)
const OFFLINE_CAP_SEC = 4 * 3600;  // cap offline idle earnings at 4 hours
const SAVE_KEY = "nekros-grimoire-save-v1";

const RUNE_GLYPHS = [
  "ᚠ","ᚢ","ᚦ","ᚨ","ᚱ","ᚲ","ᚷ","ᚹ","ᚺ","ᚾ","ᛁ","ᛃ","ᛇ","ᛈ",
  "ᛉ","ᛊ","ᛏ","ᛒ","ᛖ","ᛗ","ᛚ","ᛜ","ᛞ","ᛟ","ᚪ","ᚫ","ᛡ","ᛠ"
];
const GRID_SIZE = 36; // 6 x 6

/* Proficiency cost: explicit early values, then grows ~x1.4 */
const PROF_SEQ = [10, 15, 18, 25, 35, 50];
function profBaseCost(level) {
  if (level < PROF_SEQ.length) return PROF_SEQ[level];
  let c = PROF_SEQ[PROF_SEQ.length - 1];
  for (let i = PROF_SEQ.length; i <= level; i++) c = Math.round(c * 1.4);
  return c;
}

/* Flow cost: 100, 200, 400, 800 ... doubles each level */
function flowBaseCost(level) { return 100 * Math.pow(2, level); }

/* Comprehension thresholds (cumulative lifetime runes). Explicit start,
   then the increment keeps growing ~12% so it continues forever. */
const COMP_SEQ = [300, 500, 800, 1200, 1600, 2000, 2500, 3000, 3500, 4300];
const compCache = COMP_SEQ.slice();
function compThreshold(i) {
  while (compCache.length <= i) {
    const n = compCache.length;
    const inc = Math.max(100, Math.round((compCache[n - 1] - compCache[n - 2]) * 1.12 / 100) * 100);
    compCache.push(compCache[n - 1] + inc);
  }
  return compCache[i];
}

/* ---------- research definitions ----------
   effect types:
     tapMult / idleMult / allMult        -> multiply that group's product (compounding)
     tapPct  / idlePct  / allPct          -> add to that group's % sum (additive %, then x)
     profCostDiv / flowCostDiv            -> divide Proficiency / Flow cost
     profAddMult / flowAddMult            -> scale the +0.1 / +1 additive effectiveness
     critChance (0-1) / critMult          -> additive crit chance / crit multiplier
     lifetimeTap                          -> tap multiplier grows with lifetime taps
     compPct                              -> increase the per-Comprehension % bonus
   repeat: true => repeatable; costGrowth & maxLevel control scaling
*/
const RESEARCH = [
  // --- the ten starting researches from the design ---
  { id:"inking",      name:"Inking",            unlock:300,    cost:300,    effects:[{t:"tapMult", v:2}],  desc:"x2 runes per tap." },
  { id:"dual_ink",    name:"Dual Ink",          unlock:500,    cost:500,    effects:[{t:"allMult", v:2}],  desc:"x2 ALL rune gain." },
  { id:"cheap_prof1", name:"Efficient Study",   unlock:2000,   cost:2000,   effects:[{t:"profCostDiv", v:10}], desc:"Proficiency is 10x cheaper." },
  { id:"cheap_flow1", name:"Steady Hand",       unlock:2000,   cost:2000,   effects:[{t:"flowCostDiv", v:10}], desc:"Flow is 10x cheaper." },
  { id:"tap_mastery", name:"Tap Mastery",       unlock:10000,  cost:10000,  effects:[{t:"tapMult", v:2}],  desc:"x2 runes per tap." },
  { id:"idle_mastery",name:"Idle Mastery",      unlock:25000,  cost:25000,  effects:[{t:"idleMult", v:2}], desc:"x2 idle (per second) rune gain." },
  { id:"muscle_mem",  name:"Muscle Memory",     unlock:50000,  cost:50000,  effects:[{t:"lifetimeTap"}],   desc:"Your lifetime taps boost the tap multiplier (x1.10 and growing)." },
  { id:"cheap_flow2", name:"Flowing Quill",     unlock:50000,  cost:50000,  effects:[{t:"flowCostDiv", v:10}], desc:"Flow is another 10x cheaper." },
  { id:"all_gain2",   name:"Living Ink",        unlock:100000, cost:100000, effects:[{t:"allMult", v:2}],  desc:"x2 ALL rune gain." },
  { id:"idle_gain3",  name:"Whispering Pages",  unlock:250000, cost:250000, effects:[{t:"idleMult", v:2}], desc:"x2 idle rune gain." },

  // --- 30 more, starting at 400k ---
  { id:"crit_unlock", name:"Critical Inscriptions", unlock:400000,  cost:400000, effects:[{t:"critChance",v:0.05},{t:"critMult",v:10}], desc:"Taps gain a 5% chance to CRIT for x10 runes." },
  { id:"tap_surge",   name:"Tap Surge",         unlock:500000,  cost:500000,    effects:[{t:"tapMult",v:2}],  desc:"x2 runes per tap." },
  { id:"idle_surge",  name:"Idle Surge",        unlock:600000,  cost:600000,    effects:[{t:"idleMult",v:2}], desc:"x2 idle rune gain." },
  { id:"lucky1",      name:"Fortunate Glyphs",  unlock:750000,  cost:750000,    effects:[{t:"critChance",v:0.02}], desc:"+2% crit chance.", repeat:true, costGrowth:2.2, maxLevel:20 },
  { id:"all_gain3",   name:"Eldritch Bloom",    unlock:1e6,     cost:1e6,       effects:[{t:"allMult",v:2}],  desc:"x2 ALL rune gain." },
  { id:"scribe_haste",name:"Scribe's Haste",    unlock:1.5e6,   cost:1.5e6,     effects:[{t:"idlePct",v:25}], desc:"+25% idle rune gain.", repeat:true, costGrowth:2.0, maxLevel:40 },
  { id:"swift_quill", name:"Swift Quill",       unlock:2e6,     cost:2e6,       effects:[{t:"tapPct",v:25}],  desc:"+25% runes per tap.", repeat:true, costGrowth:2.0, maxLevel:40 },
  { id:"crit_power1", name:"Cutting Words",     unlock:2.5e6,   cost:2.5e6,     effects:[{t:"critMult",v:5}], desc:"+5 to crit multiplier.", repeat:true, costGrowth:2.4, maxLevel:30 },
  { id:"cheap_prof2", name:"Scholar's Mind",    unlock:3e6,     cost:3e6,       effects:[{t:"profCostDiv",v:5}], desc:"Proficiency is 5x cheaper." },
  { id:"cheap_flow3", name:"Endless Pages",     unlock:4e6,     cost:4e6,       effects:[{t:"flowCostDiv",v:5}], desc:"Flow is 5x cheaper." },
  { id:"deep_focus",  name:"Deep Focus",        unlock:5e6,     cost:5e6,       effects:[{t:"idleMult",v:3}], desc:"x3 idle rune gain." },
  { id:"arcane_speed",name:"Arcane Speed",      unlock:7e6,     cost:7e6,       effects:[{t:"tapMult",v:3}],  desc:"x3 runes per tap." },
  { id:"grand_ink",   name:"Grand Ink",         unlock:1e7,     cost:1e7,       effects:[{t:"allMult",v:3}],  desc:"x3 ALL rune gain." },
  { id:"comp_boost1", name:"Enlightenment",     unlock:1.5e7,   cost:1.5e7,     effects:[{t:"compPct",v:0.02}], desc:"Each Comprehension grants +2% more (on top of base)." },
  { id:"overflow",    name:"Rune Overflow",     unlock:2e7,     cost:2e7,       effects:[{t:"allPct",v:50}],  desc:"+50% ALL rune gain.", repeat:true, costGrowth:2.2, maxLevel:40 },
  { id:"lucky2",      name:"Blessed Sigils",    unlock:3e7,     cost:3e7,       effects:[{t:"critChance",v:0.03}], desc:"+3% crit chance.", repeat:true, costGrowth:2.4, maxLevel:20 },
  { id:"crit_power2", name:"Executioner's Mark",unlock:4e7,     cost:4e7,       effects:[{t:"critMult",v:10}], desc:"+10 to crit multiplier.", repeat:true, costGrowth:2.6, maxLevel:30 },
  { id:"idle_x5",     name:"Self-Writing Tome", unlock:5e7,     cost:5e7,       effects:[{t:"idleMult",v:5}], desc:"x5 idle rune gain." },
  { id:"tap_x5",      name:"Master's Touch",     unlock:7.5e7,  cost:7.5e7,     effects:[{t:"tapMult",v:5}],  desc:"x5 runes per tap." },
  { id:"eternal_ink", name:"Eternal Ink",        unlock:1e8,    cost:1e8,       effects:[{t:"allMult",v:5}],  desc:"x5 ALL rune gain." },
  { id:"prof_amp",    name:"Proficient Genius",  unlock:1.5e8,  cost:1.5e8,     effects:[{t:"profAddMult",v:2}], desc:"Doubles the bonus each Proficiency level gives." },
  { id:"flow_amp",    name:"Tidal Knowledge",    unlock:2e8,    cost:2e8,       effects:[{t:"flowAddMult",v:2}], desc:"Doubles the bonus each Flow level gives." },
  { id:"lucky3",      name:"Hand of Fate",       unlock:3e8,    cost:3e8,       effects:[{t:"critChance",v:0.05}], desc:"+5% crit chance.", repeat:true, costGrowth:2.6, maxLevel:15 },
  { id:"devastation", name:"Devastation",        unlock:4e8,    cost:4e8,       effects:[{t:"critMult",v:25}], desc:"+25 to crit multiplier.", repeat:true, costGrowth:2.8, maxLevel:30 },
  { id:"transcend",   name:"Transcendence",      unlock:5e8,    cost:5e8,       effects:[{t:"allPct",v:100}], desc:"+100% ALL rune gain.", repeat:true, costGrowth:2.5, maxLevel:30 },
  { id:"tap_x10",     name:"Infinite Quill",     unlock:7.5e8,  cost:7.5e8,     effects:[{t:"tapMult",v:10}], desc:"x10 runes per tap." },
  { id:"idle_x10",    name:"Infinite Flow",      unlock:1e9,    cost:1e9,       effects:[{t:"idleMult",v:10}],desc:"x10 idle rune gain." },
  { id:"omniscience", name:"Omniscience",        unlock:2e9,    cost:2e9,       effects:[{t:"allMult",v:10}], desc:"x10 ALL rune gain." },
  { id:"soul_link",   name:"Soul Link",          unlock:3e9,    cost:3e9,       effects:[{t:"compPct",v:0.03}], desc:"Each Comprehension grants +3% more." },
  { id:"finale",      name:"Grand Finale",       unlock:5e9,    cost:5e9,       effects:[{t:"allPct",v:200}], desc:"+200% ALL rune gain.", repeat:true, costGrowth:3.0, maxLevel:50 },
];
const RESEARCH_BY_ID = Object.fromEntries(RESEARCH.map(r => [r.id, r]));

/* tag helper for the UI */
function effectTag(r) {
  const t = r.effects[0].t;
  if (t.endsWith("Mult") && (t === "tapMult" || t === "idleMult" || t === "allMult")) return '<span class="tag mult">multiplicative</span>';
  if (t.endsWith("Pct")) return '<span class="tag add">additive %</span>';
  if (t === "critChance" || t === "critMult") return '<span class="tag crit">crit</span>';
  return "";
}

/* ---------- game state ---------- */
let state = {
  runes: 0,
  lifetimeRunes: 0,
  lifetimeTaps: 0,
  comprehension: 0,
  proficiency: 0,
  flow: 0,
  research: {},          // id -> level
  lastSave: Date.now(),

  // play-time & progression stats
  playTimeMs: 0,
  rebirths: 0,
  rebirthUnlocked: false,

  // player settings
  settings: {
    runeColor: "#2ee6d6",
    tapColor: "#2ee6d6",
    muteAll: false,
    muteMusic: false,
  },

  // dev control panel overrides
  dev: {
    tapMult: 1,
    rpsBonus: 0,
  },
};

/* derived values, recomputed when something changes */
let d = {
  tapValue: BASE_TAP,
  idlePerSec: 0,
  critChance: 0,
  critMult: 0,
  profCostDiv: 1,
  flowCostDiv: 1,
  compMult: 1,
};
let dirty = true;
let lifetimeTapEnabled = false;

/* ---------- core math ---------- */
function recompute() {
  let profAddMult = 1, flowAddMult = 1;
  let profCostDiv = 1, flowCostDiv = 1;
  let critChance = 0, critMult = 0;
  let compPct = COMP_BASE_PCT;
  let tapMult = 1, idleMult = 1, allMult = 1;
  let tapPct = 0, idlePct = 0, allPct = 0;
  lifetimeTapEnabled = false;

  for (const r of RESEARCH) {
    const L = state.research[r.id] | 0;
    if (L <= 0) continue;
    for (const e of r.effects) {
      switch (e.t) {
        case "tapMult":   tapMult  *= Math.pow(e.v, L); break;
        case "idleMult":  idleMult *= Math.pow(e.v, L); break;
        case "allMult":   allMult  *= Math.pow(e.v, L); break;
        case "tapPct":    tapPct   += e.v * L; break;
        case "idlePct":   idlePct  += e.v * L; break;
        case "allPct":    allPct   += e.v * L; break;
        case "profCostDiv": profCostDiv *= Math.pow(e.v, L); break;
        case "flowCostDiv": flowCostDiv *= Math.pow(e.v, L); break;
        case "profAddMult": profAddMult *= Math.pow(e.v, L); break;
        case "flowAddMult": flowAddMult *= Math.pow(e.v, L); break;
        case "critChance":  critChance += e.v * L; break;
        case "critMult":    critMult   += e.v * L; break;
        case "compPct":     compPct    += e.v * L; break;
        case "lifetimeTap": lifetimeTapEnabled = true; break;
      }
    }
  }

  // additive bonuses first
  const tapAdd  = PROF_ADD * state.proficiency * profAddMult;
  const idleAdd = FLOW_ADD * state.flow * flowAddMult;

  // lifetime-tap multiplier (grows slowly, logarithmically)
  const lifeMult = lifetimeTapEnabled
    ? 1.10 * (1 + Math.log10(1 + state.lifetimeTaps) / 10)
    : 1;

  const compMult = 1 + compPct * state.comprehension;

  const allGroup = allMult * (1 + allPct / 100) * compMult;
  const devTapMult = (state.dev && state.dev.tapMult) || 1;
  const tapGroup = tapMult * (1 + tapPct / 100) * lifeMult * devTapMult;
  const idleGroup = idleMult * (1 + idlePct / 100);

  d.tapValue  = (BASE_TAP + tapAdd) * tapGroup * allGroup;
  d.idlePerSec = idleAdd * idleGroup * allGroup + ((state.dev && state.dev.rpsBonus) || 0);

  d.critChance = Math.min(0.95, critChance);
  d.critMult = critMult;
  d.profCostDiv = profCostDiv;
  d.flowCostDiv = flowCostDiv;
  d.compMult = compMult;
  d.compPct = compPct;
  // breakdown for the Stats page
  d.tapMultTotal = tapGroup * allGroup;
  d.idleMultTotal = idleGroup * allGroup;
  d.allMultTotal = allGroup;
  dirty = false;
}

function proficiencyCost() { return Math.max(1, Math.ceil(profBaseCost(state.proficiency) / d.profCostDiv)); }
function flowCost()        { return Math.max(1, Math.ceil(flowBaseCost(state.flow) / d.flowCostDiv)); }
function researchCost(r) {
  const L = state.research[r.id] | 0;
  return Math.ceil(r.cost * Math.pow(r.costGrowth || 1, L));
}
function researchMax(r) { return r.repeat ? (r.maxLevel || Infinity) : 1; }

/* ---------- currency ---------- */
function addRunes(v) {
  if (v <= 0) return;
  state.runes += v;
  state.lifetimeRunes += v;
  // award comprehension for crossing lifetime thresholds
  while (state.lifetimeRunes >= compThreshold(state.comprehension)) {
    state.comprehension++;
    dirty = true;
  }
}

/* ---------- number formatting ---------- */
const SUFFIX = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
function fmt(n) {
  if (!isFinite(n)) return "∞";
  if (n < 1000) {
    if (n < 10 && n % 1 !== 0) return (Math.floor(n * 100) / 100).toString();
    return Math.floor(n).toString();
  }
  let tier = Math.floor(Math.log10(n) / 3);
  if (tier < SUFFIX.length) {
    const scaled = n / Math.pow(10, tier * 3);
    return scaled.toFixed(scaled < 10 ? 2 : scaled < 100 ? 1 : 0) + SUFFIX[tier];
  }
  return n.toExponential(2).replace("e+", "e");
}

/* ---------- DOM refs ---------- */
const $ = (s) => document.querySelector(s);
const grid = $("#rune-grid");
const floatLayer = $("#float-layer");
let cells = [];
let activeCell = 0;
let tapsOnRune = 0;          // the glowing rune stays put until it's deciphered
const TAPS_PER_RUNE = 3;     // "three taps grants 1 rune", then it moves on

/* ---------- grid / tapping ---------- */
function randGlyph() { return RUNE_GLYPHS[(Math.random() * RUNE_GLYPHS.length) | 0]; }

function buildGrid() {
  grid.innerHTML = "";
  cells = [];
  for (let i = 0; i < GRID_SIZE; i++) {
    const el = document.createElement("div");
    el.className = "rune-cell";
    el.textContent = randGlyph();
    el.addEventListener("pointerdown", (ev) => onCellTap(i, ev), { passive: false });
    grid.appendChild(el);
    cells.push(el);
  }
  rerollActive();
}

/* size the rune grid to the actual free space so nothing is ever cut off
   at the bottom and the whole game fits on one screen (no page scroll) */
function sizeGrid() {
  const stage = document.querySelector(".stage");
  if (!stage) return;
  const title = document.querySelector(".grimoire-title");
  const hint = document.querySelector(".grimoire-hint");
  const cs = getComputedStyle(stage);
  const padV = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
  const padH = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const usedV = (title ? title.offsetHeight : 0) + (hint ? hint.offsetHeight : 0) + 16;
  const availH = stage.clientHeight - padV - usedV;
  const availW = stage.clientWidth - padH;
  const size = Math.max(140, Math.min(availW, availH, 560));
  grid.style.width = size + "px";
  grid.style.height = size + "px";
}

function rerollActive() {
  tapsOnRune = 0;
  if (cells[activeCell]) cells[activeCell].classList.remove("active");
  let next = activeCell;
  while (next === activeCell && cells.length > 1) next = (Math.random() * cells.length) | 0;
  activeCell = next;
  const el = cells[activeCell];
  el.textContent = randGlyph();
  el.classList.add("active");
}

function onCellTap(i, ev) {
  ev.preventDefault();                  // stop double-tap zoom / text select
  if (i !== activeCell) return;         // only the turquoise rune counts
  if (dirty || lifetimeTapEnabled) recompute();

  let val = d.tapValue;
  let crit = false;
  if (d.critMult > 0 && Math.random() < d.critChance) { val *= d.critMult; crit = true; }

  addRunes(val);
  state.lifetimeTaps++;
  spawnFloat(ev, val, crit);
  Sound.tap(crit);

  // the glowing rune stays in place; it only moves once deciphered (3 taps)
  tapsOnRune++;
  if (tapsOnRune >= TAPS_PER_RUNE) {
    tapsOnRune = 0;
    rerollActive();
  }

  updateTop();
  maybeRefreshPanels();
}

function spawnFloat(ev, val, crit) {
  const rect = floatLayer.getBoundingClientRect();
  const f = document.createElement("div");
  f.className = "float-num" + (crit ? " crit" : "");
  f.textContent = (crit ? "CRIT! +" : "+") + fmt(val);
  f.style.left = (ev.clientX - rect.left) + "px";
  f.style.top = (ev.clientY - rect.top) + "px";
  floatLayer.appendChild(f);
  setTimeout(() => f.remove(), 900);
}

/* ---------- purchases ---------- */
function buyProficiency() {
  const c = proficiencyCost();
  if (state.runes < c) return;
  state.runes -= c; state.proficiency++; dirty = true;
  Sound.buy();
  refreshAll();
}
function buyFlow() {
  const c = flowCost();
  if (state.runes < c) return;
  state.runes -= c; state.flow++; dirty = true;
  Sound.buy();
  refreshAll();
}
function buyResearch(r) {
  const L = state.research[r.id] | 0;
  if (L >= researchMax(r)) return;
  const c = researchCost(r);
  if (state.runes < c) return;
  state.runes -= c; state.research[r.id] = L + 1; dirty = true;
  Sound.research();
  refreshAll();
}

/* ---------- rendering ---------- */
function updateTop() {
  if (dirty) recompute();
  $("#rune-count").textContent = fmt(state.runes);
  $("#comprehension-count").textContent = fmt(state.comprehension);
  $("#per-tap").textContent = fmt(d.tapValue);
  $("#per-sec").textContent = fmt(d.idlePerSec);

  const bonus = $("#comprehension-bonus");
  bonus.textContent = state.comprehension > 0
    ? "+" + Math.round((d.compMult - 1) * 100) + "% all runes"
    : "";

  // progress to next comprehension
  const prev = state.comprehension === 0 ? 0 : compThreshold(state.comprehension - 1);
  const next = compThreshold(state.comprehension);
  const pct = Math.max(0, Math.min(100, ((state.lifetimeRunes - prev) / (next - prev)) * 100));
  $("#comp-progress-bar").style.width = pct + "%";

  const critStat = $("#crit-stat");
  if (d.critMult > 0) {
    critStat.classList.remove("hidden");
    critStat.textContent = `${Math.round(d.critChance * 100)}% crit · x${fmt(d.critMult)}`;
  }
}

let upgradesBuilt = false;
function renderUpgrades() {
  if (dirty) recompute();
  const list = $("#upgrades-list");
  const showProf = state.lifetimeRunes >= 10 || state.proficiency > 0;
  const showFlow = state.lifetimeRunes >= 100 || state.flow > 0;
  $("#upgrades-empty").classList.toggle("hidden", showProf);

  list.innerHTML = "";
  if (showProf) list.appendChild(makeCard({
    name: "Proficiency", level: state.proficiency,
    desc: `+${fmt(PROF_ADD)} rune per tap (before multipliers). Each level adds flat tap power.`,
    cost: proficiencyCost(), onBuy: buyProficiency, tag: '<span class="tag add">additive</span>'
  }));
  if (showFlow) list.appendChild(makeCard({
    name: "Flow", level: state.flow,
    desc: `+${fmt(FLOW_ADD)} rune per second (before multipliers). Passive income, even while idle.`,
    cost: flowCost(), onBuy: buyFlow, tag: '<span class="tag add">additive</span>'
  }));
}

function renderResearch() {
  if (dirty) recompute();
  const list = $("#research-list");
  list.innerHTML = "";
  for (const r of RESEARCH) {
    const L = state.research[r.id] | 0;
    const revealed = state.lifetimeRunes >= r.unlock * 0.5 || L > 0;
    if (!revealed) continue;

    const unlocked = state.lifetimeRunes >= r.unlock;
    const maxed = L >= researchMax(r);
    const cost = researchCost(r);
    const repeatTag = r.repeat ? '<span class="tag repeat">repeatable</span>' : "";
    list.appendChild(makeCard({
      name: r.name,
      level: r.repeat ? L : (L > 0 ? "✓" : 0),
      levelText: r.repeat ? `Lv ${L}${isFinite(researchMax(r)) ? "/" + researchMax(r) : ""}` : (L > 0 ? "Researched" : ""),
      desc: r.desc,
      cost,
      locked: !unlocked,
      lockText: !unlocked ? `🔒 Unlocks at ${fmt(r.unlock)} lifetime runes` : null,
      maxed,
      onBuy: () => buyResearch(r),
      tag: effectTag(r) + repeatTag,
    }));
  }
}

function makeCard(o) {
  const btn = document.createElement("button");
  btn.className = "card";
  const affordable = !o.locked && !o.maxed && state.runes >= o.cost;
  if (affordable) btn.classList.add("affordable");
  if (o.locked) btn.classList.add("locked");
  if (o.maxed) btn.classList.add("maxed");
  btn.disabled = o.locked || o.maxed || !affordable;

  let costHtml;
  if (o.maxed) costHtml = `<span class="card-cost lock">MAX</span>`;
  else if (o.locked) costHtml = `<span class="card-cost lock">${o.lockText}</span>`;
  else costHtml = `<span class="card-cost ${affordable ? "ok" : "no"}">✦ ${fmt(o.cost)} runes</span>`;

  const levelLabel = o.levelText !== undefined ? o.levelText
    : (typeof o.level === "number" && o.level > 0 ? `Lv ${o.level}` : "");

  btn.innerHTML =
    `<div class="card-head"><span class="card-name">${o.name}${o.tag || ""}</span>` +
    `<span class="card-level">${levelLabel}</span></div>` +
    `<div class="card-desc">${o.desc}</div>` + costHtml;

  if (!btn.disabled && o.onBuy) btn.addEventListener("click", o.onBuy);
  return btn;
}

/* unlock the research tab once first comprehension is earned */
function checkResearchUnlock() {
  const tab = $("#research-tab");
  if (state.comprehension > 0 && tab.disabled) {
    tab.disabled = false;
    tab.textContent = "Research";
  }
}

/* throttled panel refresh on taps (so affordability/states stay live) */
let lastPanelRefresh = 0;
function maybeRefreshPanels() {
  const now = performance.now();
  if (now - lastPanelRefresh > 250) { refreshAll(); lastPanelRefresh = now; }
  else checkResearchUnlock();
}
function refreshAll() {
  if (dirty) recompute();
  updateTop();
  checkResearchUnlock();
  renderUpgrades();
  if (!$("#research-tab").disabled) renderResearch();
}

/* ---------- tabs ---------- */
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => {
    if (tab.disabled) return;
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    tab.classList.add("active");
    const which = tab.dataset.tab;
    $("#tab-upgrades").classList.toggle("hidden", which !== "upgrades");
    $("#tab-research").classList.toggle("hidden", which !== "research");
    if (which === "research") renderResearch();
  });
});

/* ---------- save / load ---------- */
function save() {
  state.lastSave = Date.now();
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(state));
    const ind = $("#save-indicator");
    ind.textContent = "saved ✓";
    setTimeout(() => { ind.textContent = ""; }, 1500);
  } catch (e) { /* storage may be unavailable */ }
}

function load() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    const defaults = { settings: { ...state.settings }, dev: { ...state.dev } };
    Object.assign(state, s);
    state.research = s.research || {};
    // merge nested objects so older saves still get new fields
    state.settings = { ...defaults.settings, ...(s.settings || {}) };
    state.dev = { ...defaults.dev, ...(s.dev || {}) };
    if (typeof state.playTimeMs !== "number") state.playTimeMs = 0;
    if (typeof state.rebirths !== "number") state.rebirths = 0;
    return true;
  } catch (e) { return false; }
}

function applyOffline() {
  recompute();
  if (d.idlePerSec <= 0) return;
  const elapsed = Math.min(OFFLINE_CAP_SEC, (Date.now() - (state.lastSave || Date.now())) / 1000);
  if (elapsed < 5) return;
  const gained = d.idlePerSec * elapsed;
  addRunes(gained);
  const w = $("#welcome-back");
  const mins = Math.floor(elapsed / 60);
  w.textContent = `Welcome back! Your tome wrote ${fmt(gained)} runes while away (${mins}m).`;
  w.classList.remove("hidden");
  setTimeout(() => w.classList.add("hidden"), 6000);
}

$("#reset-btn").addEventListener("click", () => {
  if (!confirm("Erase all progress and restart the Grimoire?")) return;
  localStorage.removeItem(SAVE_KEY);
  location.reload();
});

/* ---------- main loop ---------- */
let lastFrame = performance.now();
let panelAccum = 0;
function loop(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000); // clamp big gaps
  lastFrame = now;
  if (!document.hidden) state.playTimeMs += dt * 1000;
  if (dirty || lifetimeTapEnabled) recompute();
  if (d.idlePerSec > 0) addRunes(d.idlePerSec * dt);
  updateTop();
  checkResearchUnlock();
  // keep card states (affordability/unlocks) live during idle income
  panelAccum += dt;
  if (panelAccum >= 0.5) {
    panelAccum = 0;
    renderUpgrades();
    if (!$("#research-tab").disabled) renderResearch();
    if (!$("#modal-overlay").classList.contains("hidden") && !$("#modal-stats").classList.contains("hidden")) renderStats();
  }
  requestAnimationFrame(loop);
}

/* ---------- extra zoom guards (iOS Safari ignores user-scalable) ---------- */
["gesturestart", "gesturechange", "gestureend"].forEach(evt =>
  document.addEventListener(evt, (e) => e.preventDefault(), { passive: false }));
// block double-tap zoom fallback
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  if (now - lastTouchEnd <= 300) e.preventDefault();
  lastTouchEnd = now;
}, { passive: false });
// block ctrl/cmd + wheel zoom on desktop
document.addEventListener("wheel", (e) => { if (e.ctrlKey) e.preventDefault(); }, { passive: false });

/* =====================================================================
   Sound — original synthesised audio via the Web Audio API.
   Gentle pentatonic tones (never harsh), plus a slow ambient music bed.
   Respects the "mute all" and "mute music" settings.
   ===================================================================== */
const Sound = (() => {
  let ctx = null, master = null, musicGain = null, started = false;
  let musicTimer = null;
  const PENTA = [0, 2, 4, 7, 9];           // major pentatonic semitone steps
  const noteHz = (semi) => 220 * Math.pow(2, semi / 12);

  function ensure() {
    if (ctx) { if (ctx.state === "suspended") ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.9;
    master.connect(ctx.destination);
    musicGain = ctx.createGain();
    musicGain.gain.value = 0.0;
    musicGain.connect(master);
  }

  // a single soft tone with an ADSR-ish envelope
  function tone({ freq, t = ctx.currentTime, dur = 0.18, type = "sine", gain = 0.18, dest = master }) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(dest);
    o.start(t); o.stop(t + dur + 0.05);
  }

  const muted = () => state.settings.muteAll;

  let tapStep = 0;
  function tap(crit) {
    if (muted()) return; ensure(); if (!ctx) return;
    // wandering pentatonic pluck so rapid tapping stays musical
    const semi = PENTA[tapStep % PENTA.length] + 12 * ((tapStep / PENTA.length | 0) % 2);
    tapStep = (tapStep + 1) % 10;
    tone({ freq: noteHz(semi), type: "triangle", dur: 0.16, gain: 0.16 });
    if (crit) {
      tone({ freq: noteHz(semi + 12), type: "sine", dur: 0.3, gain: 0.14, t: ctx.currentTime + 0.04 });
      tone({ freq: noteHz(semi + 19), type: "sine", dur: 0.35, gain: 0.1, t: ctx.currentTime + 0.09 });
    }
  }

  function buy() {
    if (muted()) return; ensure(); if (!ctx) return;
    [0, 4, 7].forEach((s, i) =>
      tone({ freq: noteHz(s), type: "sine", dur: 0.4, gain: 0.13, t: ctx.currentTime + i * 0.05 }));
  }

  function research() {
    if (muted()) return; ensure(); if (!ctx) return;
    // ascending shimmer
    [0, 4, 7, 12, 16].forEach((s, i) =>
      tone({ freq: noteHz(s + 12), type: "triangle", dur: 0.5, gain: 0.1, t: ctx.currentTime + i * 0.07 }));
  }

  // ---- ambient music: a slow, low-volume evolving arpeggio + drone ----
  let musicIdx = 0;
  const MUSIC_NOTES = [0, 4, 7, 11, 7, 4, 9, 7];
  function musicStep() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const semi = MUSIC_NOTES[musicIdx % MUSIC_NOTES.length] - 12;
    musicIdx++;
    // soft pad note
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = "sine"; o.frequency.value = noteHz(semi);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.06, t + 0.6);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 1.8);
    o.connect(g); g.connect(musicGain);
    o.start(t); o.stop(t + 2.0);
  }

  function musicActive() { return !state.settings.muteAll && !state.settings.muteMusic; }

  function updateMusic() {
    ensure(); if (!ctx) return;
    if (musicActive()) {
      musicGain.gain.setTargetAtTime(0.5, ctx.currentTime, 0.5);
      if (!musicTimer) { musicStep(); musicTimer = setInterval(musicStep, 1400); }
    } else {
      musicGain.gain.setTargetAtTime(0.0, ctx.currentTime, 0.3);
      if (musicTimer) { clearInterval(musicTimer); musicTimer = null; }
    }
  }

  // kick everything off on the first user gesture (browser autoplay policy)
  function unlock() {
    ensure();
    if (!started && ctx) { started = true; updateMusic(); }
  }

  return { tap, buy, research, updateMusic, unlock };
})();

// resume audio + start music on first interaction anywhere
["pointerdown", "keydown"].forEach(evt =>
  window.addEventListener(evt, () => Sound.unlock(), { once: false }));

/* =====================================================================
   Settings
   ===================================================================== */
function applySettings() {
  const s = state.settings;
  document.documentElement.style.setProperty("--rune-color", s.runeColor);
  document.documentElement.style.setProperty("--tap-color", s.tapColor);
  Sound.updateMusic();
}

function initSettingsUI() {
  const runeC = $("#set-rune-color");
  const tapC = $("#set-tap-color");
  const muteAll = $("#set-mute-all");
  const muteMusic = $("#set-mute-music");

  runeC.value = state.settings.runeColor;
  tapC.value = state.settings.tapColor;
  muteAll.checked = state.settings.muteAll;
  muteMusic.checked = state.settings.muteMusic;

  runeC.addEventListener("input", () => {
    state.settings.runeColor = runeC.value;
    document.documentElement.style.setProperty("--rune-color", runeC.value);
  });
  tapC.addEventListener("input", () => {
    state.settings.tapColor = tapC.value;
    document.documentElement.style.setProperty("--tap-color", tapC.value);
  });
  muteAll.addEventListener("change", () => {
    state.settings.muteAll = muteAll.checked;
    Sound.updateMusic();
  });
  muteMusic.addEventListener("change", () => {
    state.settings.muteMusic = muteMusic.checked;
    Sound.updateMusic();
  });
  $("#reset-colors-btn").addEventListener("click", () => {
    state.settings.runeColor = "#2ee6d6";
    state.settings.tapColor = "#2ee6d6";
    runeC.value = "#2ee6d6"; tapC.value = "#2ee6d6";
    applySettings();
  });
}

/* =====================================================================
   Modals
   ===================================================================== */
function openModal(name) {
  $("#modal-overlay").classList.remove("hidden");
  document.querySelectorAll(".modal").forEach(m => m.classList.add("hidden"));
  const m = $("#modal-" + name);
  if (m) m.classList.remove("hidden");
  if (name === "stats") renderStats();
}
function closeModal() { $("#modal-overlay").classList.add("hidden"); }

function initModals() {
  document.querySelectorAll(".footer-btn[data-modal]").forEach(btn =>
    btn.addEventListener("click", () => openModal(btn.dataset.modal)));
  document.querySelectorAll("[data-close]").forEach(btn =>
    btn.addEventListener("click", closeModal));
  // click outside the modal closes it
  $("#modal-overlay").addEventListener("pointerdown", (e) => {
    if (e.target.id === "modal-overlay") closeModal();
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModal(); });
}

/* =====================================================================
   Stats
   ===================================================================== */
function fmtDuration(ms) {
  let s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400); s -= d * 86400;
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  const parts = [];
  if (d) parts.push(d + "d");
  if (h || d) parts.push(h + "h");
  parts.push(m + "m");
  parts.push(s + "s");
  return parts.join(" ");
}

function renderStats() {
  if (dirty) recompute();
  const rows = [];
  const row = (k, v) => rows.push(`<div class="stat-line"><span class="k">${k}</span><span class="v">${v}</span></div>`);

  row("Time played", fmtDuration(state.playTimeMs));
  row("Runes tapped", fmt(state.lifetimeTaps));
  row("Runes gathered (all time)", fmt(state.lifetimeRunes));
  row("Comprehension", fmt(state.comprehension));
  if (state.rebirthUnlocked || state.rebirths > 0) row("Rebirths", fmt(state.rebirths));

  // multiplier (only meaningful once a multiplier has been researched / earned)
  if (d.allMultTotal > 1.0001 || d.tapMultTotal > 1.0001) {
    row("Tap multiplier", "x" + fmt(d.tapMultTotal));
    row("Idle multiplier", "x" + fmt(d.idleMultTotal));
    row("Global multiplier", "x" + fmt(d.allMultTotal));
  }
  if (d.critMult > 0) {
    row("Crit chance", Math.round(d.critChance * 100) + "%");
    row("Crit multiplier", "x" + fmt(d.critMult));
  }
  row("Runes / tap", fmt(d.tapValue));
  row("Runes / second", fmt(d.idlePerSec));

  $("#stats-body").innerHTML = rows.join("");
}

/* =====================================================================
   Patch Notes  — keep newest at the top; add an entry with every patch.
   ===================================================================== */
const PATCH_NOTES = [
  {
    v: "1.2.0", when: "2026-06-10", notes: [
      "Added Settings: customise the rune colour and the tap-number colour.",
      "Added mute toggles for all sound and for music.",
      "Added original synthesised sound effects for tapping, buying upgrades and researching, plus a gentle ambient music bed.",
      "Added a Stats page (time played, runes tapped, all-time runes, multipliers, crit, and more).",
      "Added a keypad-locked Dev Control Panel.",
      "Added this Patch Notes page.",
      "Moved the game title up into the header.",
    ],
  },
  {
    v: "1.1.0", when: "2026-06-10", notes: [
      "The glowing rune now stays put for three taps before moving on, so it no longer feels like it vanishes.",
      "Locked the app to the viewport — the page no longer scrolls.",
    ],
  },
  {
    v: "1.0.0", when: "2026-06-09", notes: [
      "Initial release: tap runes, buy Proficiency & Flow, earn Comprehension, and unlock the 40-entry Research tree.",
    ],
  },
];

function renderPatchNotes() {
  $("#patch-body").innerHTML = PATCH_NOTES.map(p =>
    `<div class="patch-entry"><h3>v${p.v}<span class="when">${p.when}</span></h3>` +
    `<ul>${p.notes.map(n => `<li>${n}</li>`).join("")}</ul></div>`
  ).join("");
}

/* =====================================================================
   Dev Control Panel (keypad locked to 1337)
   ===================================================================== */
const DEV_CODE = "1337";
function initDevPanel() {
  // build keypad
  const keypad = $("#keypad");
  const layout = ["1","2","3","4","5","6","7","8","9","Clear","0","Enter"];
  let entry = "";
  const display = $("#keypad-display");
  const msg = $("#keypad-msg");
  const render = () => { display.textContent = "•".repeat(entry.length); };

  function unlock() {
    $("#dev-lock").classList.add("hidden");
    $("#dev-controls").classList.remove("hidden");
  }

  layout.forEach(key => {
    const b = document.createElement("button");
    b.textContent = key;
    b.addEventListener("click", () => {
      msg.textContent = ""; msg.className = "keypad-msg";
      if (key === "Clear") { entry = ""; }
      else if (key === "Enter") {
        if (entry === DEV_CODE) { msg.textContent = "Access granted"; msg.className = "keypad-msg good"; unlock(); }
        else { msg.textContent = "Incorrect code"; msg.className = "keypad-msg bad"; entry = ""; }
      } else if (entry.length < 6) { entry += key; }
      render();
    });
    keypad.appendChild(b);
  });

  // tap multiplier
  const tapWrap = $("#dev-tapmult");
  const tapCur = $("#dev-tapmult-cur");
  const showTapCur = () => { tapCur.textContent = "Current: x" + (state.dev.tapMult || 1); };
  [1, 2, 4, 8, 16, 32, 64].forEach(mult => {
    const b = document.createElement("button");
    b.textContent = mult === 1 ? "x1 (off)" : "x" + mult;
    b.addEventListener("click", () => {
      state.dev.tapMult = mult; dirty = true; refreshAll(); showTapCur();
      tapWrap.querySelectorAll("button").forEach(x => x.classList.remove("on"));
      b.classList.add("on");
    });
    tapWrap.appendChild(b);
  });
  showTapCur();

  // bonus runes / second (presets add; custom sets exact)
  const rpsWrap = $("#dev-rps");
  const rpsCur = $("#dev-rps-cur");
  const showRpsCur = () => { rpsCur.textContent = "Current dev bonus: " + fmt(state.dev.rpsBonus || 0) + " /sec"; };
  [1, 5, 10, 100, 500].forEach(v => {
    const b = document.createElement("button");
    b.textContent = "+" + v;
    b.addEventListener("click", () => { state.dev.rpsBonus = (state.dev.rpsBonus || 0) + v; dirty = true; refreshAll(); showRpsCur(); });
    rpsWrap.appendChild(b);
  });
  $("#dev-rps-set").addEventListener("click", () => {
    const v = parseFloat($("#dev-rps-custom").value);
    if (isFinite(v)) { state.dev.rpsBonus = v; dirty = true; refreshAll(); showRpsCur(); }
  });
  showRpsCur();

  // add runes
  const runesWrap = $("#dev-runes");
  [1, 100, 1000].forEach(v => {
    const b = document.createElement("button");
    b.textContent = "+" + fmt(v);
    b.addEventListener("click", () => { addRunes(v); refreshAll(); });
    runesWrap.appendChild(b);
  });
  $("#dev-runes-add").addEventListener("click", () => {
    const v = parseFloat($("#dev-runes-custom").value);
    if (isFinite(v) && v > 0) { addRunes(v); refreshAll(); }
  });

  // add comprehension
  const compWrap = $("#dev-comp");
  [1, 5, 10, 100, 1000].forEach(v => {
    const b = document.createElement("button");
    b.textContent = "+" + fmt(v);
    b.addEventListener("click", () => { state.comprehension += v; dirty = true; refreshAll(); });
    compWrap.appendChild(b);
  });
}

/* ---------- boot ---------- */
function init() {
  load();
  buildGrid();
  recompute();
  applyOffline();
  refreshAll();
  sizeGrid();

  // keep the board fitted to the viewport on resize / rotate / toolbar changes
  let raf;
  const refit = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(sizeGrid); };
  window.addEventListener("resize", refit);
  window.addEventListener("orientationchange", refit);
  if (window.visualViewport) window.visualViewport.addEventListener("resize", refit);
  // re-fit after fonts/layout settle
  setTimeout(sizeGrid, 50);
  setTimeout(sizeGrid, 300);

  applySettings();
  initSettingsUI();
  initModals();
  initDevPanel();
  renderPatchNotes();

  setInterval(save, 10000);
  document.addEventListener("visibilitychange", () => { if (document.hidden) save(); });
  window.addEventListener("beforeunload", save);

  requestAnimationFrame(loop);
}
init();
