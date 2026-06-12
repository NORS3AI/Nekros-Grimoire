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
const BASE_TAP = 1;                // one tap grants one rune
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

/* Comprehension thresholds (cumulative lifetime runes).
   Levels 1-4 are hand-set. From level 5 each threshold grows geometrically,
   and the growth ratio itself accelerates 8% per level — so reaching
   double-digit Comprehension is a genuine long-term goal. */
const COMP_SEQ = [300, 500, 800, 1200];   // levels 1-4
const COMP_START_RATIO = 1.7;             // size of the first jump after level 4
const COMP_RATIO_ACCEL = 1.08;            // ratio grows 8% each level after level 4
const compCache = COMP_SEQ.slice();
function roundNice(n) {
  if (n < 1000) return Math.round(n / 10) * 10;
  const mag = Math.pow(10, Math.floor(Math.log10(n)) - 2); // keep ~3 significant figures
  return Math.round(n / mag) * mag;
}
function compThreshold(i) {
  while (compCache.length <= i) {
    const n = compCache.length;            // 0-indexed level being added (n>=4)
    const ratio = COMP_START_RATIO * Math.pow(COMP_RATIO_ACCEL, n - 4);
    compCache.push(roundNice(compCache[n - 1] * ratio));
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

/* ---------- talent tree (bought with Void Runes; persists across rebirth) ----------
   fx effects fold into recompute exactly like research percentages.
   unlock: reveals a profession page. */
const TALENTS = [
  { id:"strength",  name:"Strength of Hit", cost:1,  growth:1.55, max:50, fx:{tapPct:50},
    desc:"+50% runes per tap." },
  { id:"swiftness", name:"Swiftness",       cost:1,  growth:1.55, max:50, fx:{idlePct:50},
    desc:"+50% idle rune gain." },
  { id:"time_dilation", name:"Time Dilation", cost:2, growth:1.7, max:30, fx:{allPct:20},
    desc:"+20% ALL rune gain (your studies move faster)." },
  { id:"void_edge", name:"Void Edge",       cost:3,  growth:1.8,  max:25, special:"crit",
    desc:"Unlock critical hits (5% chance, x10). Each extra level: +2% crit chance, +5 crit damage." },
  { id:"void_power", name:"Void Attunement", cost:3, growth:1.75, max:40, special:"vrpower",
    desc:"+5% ALL rune gain for every Void Rune you have ever earned." },
  { id:"head_start", name:"Head Start",     cost:2,  growth:1.8,  max:20, special:"headstart",
    desc:"Begin each life with more runes (x10 per level)." },
  { id:"greater_sacrifice", name:"Greater Sacrifice", cost:5, growth:2, max:30, special:"vrgain",
    desc:"+1 Void Rune gained on every rebirth." },
  // profession unlocks
  { id:"herbalism", name:"Herbalism", cost:3,  max:1, unlock:"herbalism",
    desc:"Unlock the Herbalism page — tap herbs to gather them (10 taps each)." },
  { id:"mining",    name:"Mining",    cost:6,  max:1, unlock:"mining",
    desc:"Unlock the Mining page — tap ore to mine it (10 taps each)." },
  { id:"combat",    name:"Path of the Sword", cost:20, max:1, unlock:"combat",
    desc:"Unlock Combat — slay monsters for loot and Survival Runes." },
];
const TALENT_BY_ID = Object.fromEntries(TALENTS.map(t => [t.id, t]));

function talentLevel(id) { return state.talents[id] | 0; }
function talentMax(t) { return t.max || Infinity; }
function talentCost(t) {
  const L = talentLevel(t.id);
  return Math.ceil(t.cost * Math.pow(t.growth || 1, L));
}
function hasProfession(name) {
  const t = TALENTS.find(x => x.unlock === name);
  return t ? talentLevel(t.id) > 0 : false;
}

/* Void Runes from a life's gathered runes: one per power-of-ten from 1e6 up */
function vrFromRunes(r) { return r >= 1e6 ? Math.floor(Math.log10(r)) - 5 : 0; }

/* ---------- combat tuning ---------- */
/* ---------- combat: a full idle/clicker sub-game ----------
   Currencies: Gold (loot, spent on Forge upgrades & Tactics research) and
   Survival Runes (prestige, earned from bosses & Retreat, spent on talents). */
const TAPS_PER_RESOURCE = 10;   // herbalism / mining
/* Combat depth = combatRank*100 + monsterLevel. Each rank is a 100-level
   "ascension": clear 10 bosses (lvl 10,20,..,100) to gain a star, reset to
   level 1. 5 stars -> a green triangle tier (rank 6+). */
const RANK_MULT = 4;            // each rank's ceiling is this much higher ("harder")
const BOSS_TIME_MS = 10000;    // bosses must be defeated within 10 seconds
const CBT = {
  depth:     () => state.combatRank * 100 + state.monsterLevel,   // monotonic progress metric
  isBoss:    (lvl) => lvl % 10 === 0,                             // lvl = within-rank level (1-100)
  // each rank restarts the climb (level 1) but with a higher ceiling via RANK_MULT^rank
  monsterHp: (lvl, rank) => Math.ceil((lvl % 10 === 0 ? 45 : 12) * Math.pow(1.13, lvl - 1) * Math.pow(RANK_MULT, rank)),
  // ~30 gold over the first 10 levels (boss ~10); grows with HP so pacing holds
  goldDrop:  (lvl, rank) => Math.ceil(Math.pow(1.13, lvl - 1) * Math.pow(RANK_MULT, rank) * (lvl % 10 === 0 ? 3.5 : 1)),
  monsterAtk:(lvl, rank) => Math.ceil(2 * Math.pow(1.08, lvl - 1) * Math.pow(2, rank)),   // damage / sec to player
  baseTap: 1,
};

/* Castable temporary buff spells (▲ tier), unlocked as magic levels up */
const SPELLS = [
  { id:"shield", name:"Arcane Shield", emoji:"🛡", unlock:1, cooldown:30, duration:8,  desc:"Block all monster damage for 8s." },
  { id:"vital",  name:"Vital Surge",   emoji:"💚", unlock:2, cooldown:30, duration:10, desc:"Heal fully and triple HP regen for 10s." },
  { id:"haste",  name:"Haste",         emoji:"💨", unlock:3, cooldown:25, duration:8,  desc:"+30% dodge for 8s." },
  { id:"rage",   name:"Rage",          emoji:"😡", unlock:4, cooldown:25, duration:8,  desc:"Double all your damage for 8s." },
];
function buffActive(id) { return ((state.buffs && state.buffs[id]) || 0) > Date.now(); }
function rankSymbol(rank) {
  if (rank <= 0) return "";
  if (rank <= 5) return "★".repeat(rank);
  return "▲".repeat(rank - 5);
}
/* turn an absolute depth into a friendly "★★ Lv 5" label */
function depthLabel(d) {
  const rank = Math.floor((d - 1) / 100);
  const level = d - rank * 100;
  const sym = rankSymbol(rank);
  return (sym ? sym + " " : "") + "Lv " + level;
}
function magicReq(level) { return 25 * Math.pow(2, level); } // 25, 50, 100, 200, ...

/* Forge upgrades (bought with Gold). minRank gates the new tiers. */
const COMBAT_UP = [
  { id:"sharpen",  name:"Sharpen Blade",   base:10,  growth:1.16, desc:"+2 tap damage." },
  { id:"familiar", name:"Summon Familiar", base:60,  growth:1.18, desc:"+3.33 damage per second (auto-attack)." },
  { id:"whetstone",name:"Whetstone",       base:250, growth:1.26, special:"crit", desc:"+1% crit chance and +0.5 crit damage." },
  { id:"greed",    name:"Greed",           base:120, growth:1.22, special:"gold", desc:"+10% gold from kills." },
  // ★ tier (rank >= 1): the monster fights back
  { id:"agility",  name:"Agility",   base:200, growth:1.20, minRank:1, desc:"+0.1% dodge chance per level." },
  { id:"strength", name:"Strength",  base:200, growth:1.20, minRank:1, desc:"+0.3% to all your damage per level." },
  { id:"vitality", name:"Vitality",  base:200, growth:1.20, minRank:1, desc:"+max HP and regen." },
  // ▲ tier (rank >= 6): magic
  { id:"intellect",name:"Intellect", base:5000, growth:1.22, minRank:6, desc:"+1 magic (fireball) damage per level." },
];
/* Tactics research (bought with Gold). unlock = depth; minRank gates new ones. */
const COMBAT_RESEARCH = [
  { id:"steel",    name:"Steel Edge",  unlock:5,  cost:1500,  fx:{dmgMult:2}, desc:"x2 tap damage." },
  { id:"plunder",  name:"Plunder",     unlock:8,  cost:6000,  fx:{goldMult:2}, desc:"x2 gold." },
  { id:"swarm",    name:"Swarm",       unlock:12, cost:30000, fx:{dpsMult:2}, desc:"x2 auto damage." },
  { id:"warlord",  name:"Warlord",     unlock:20, cost:2e5,   fx:{allMult:2}, desc:"x2 ALL damage." },
  { id:"fortune",  name:"Fortune",     unlock:28, cost:1e6,   fx:{goldMult:3}, desc:"x3 gold." },
  { id:"berserk",  name:"Berserk",     unlock:38, cost:1e7,   fx:{dmgMult:3}, desc:"x3 tap damage." },
  { id:"legion",   name:"Legion",      unlock:48, cost:1e8,   fx:{dpsMult:3}, desc:"x3 auto damage." },
  { id:"godslayer",name:"Godslayer",   unlock:65, cost:5e9,   fx:{allMult:3}, desc:"x3 ALL damage." },
  // ★ tier
  { id:"evasion",  name:"Evasion Drill", minRank:1, unlock:101, cost:5e5,  fx:{dodgeMult:2}, desc:"Double your dodge chance." },
  { id:"ironhide", name:"Iron Hide",     minRank:1, unlock:101, cost:2e6,  fx:{atkReduce:40}, desc:"Monsters hit you 40% softer." },
  { id:"titan",    name:"Titan's Vigor", minRank:3, unlock:301, cost:5e8,  fx:{allMult:3}, desc:"x3 ALL damage." },
  // ▲ tier
  { id:"spellpower",name:"Spell Mastery", minRank:6, unlock:601, cost:1e10, fx:{magicMult:3}, desc:"x3 magic damage." },
  { id:"archmage",  name:"Archmage",      minRank:6, unlock:601, cost:1e11, fx:{magicMult:3, allMult:2}, desc:"x3 magic & x2 all damage." },
];
/* Retreat talents (bought with Survival Runes; persist through Retreat) */
const COMBAT_TALENTS = [
  { id:"might",     name:"Might",      cost:1, growth:1.5, max:50, fx:{dmgPct:25}, desc:"+25% tap damage." },
  { id:"frenzy",    name:"Frenzy",     cost:1, growth:1.5, max:50, fx:{dpsPct:40}, desc:"+40% auto damage." },
  { id:"avarice",   name:"Avarice",    cost:2, growth:1.6, max:50, fx:{goldPct:30}, desc:"+30% gold." },
  { id:"bloodlust", name:"Bloodlust",  cost:3, growth:1.7, max:25, special:"crit", desc:"+5% crit chance, +2 crit damage." },
  { id:"war_chest", name:"War Chest",  cost:2, growth:1.8, max:15, special:"startgold", desc:"Start each Retreat with more gold (x10 per level)." },
  { id:"survivor",  name:"Survivor",   cost:5, growth:2.0, max:30, special:"srgain", desc:"Each boss drops +1 Survival Rune." },
];
function combatUpCost(u) { return Math.ceil(u.base * Math.pow(u.growth, (state.combatUp[u.id] | 0))); }
function combatTalentCost(t) { return Math.ceil(t.cost * Math.pow(t.growth || 1, (state.combatTalents[t.id] | 0))); }
// Tactics are repeatable (infinite levels); each repurchase costs much more
const COMBAT_RESEARCH_GROWTH = 8;
function combatResearchCost(r) { return Math.ceil(r.cost * Math.pow(COMBAT_RESEARCH_GROWTH, (state.combatResearch[r.id] | 0))); }

/* ---------- professions: Herbalism & Mining (each a small idle game) ----------
   Resource (herbs / ore) is spent on the profession's own upgrades. The global
   bonus scales with LIFETIME gathered, so spending never lowers it. */
const PROFS = {
  herb: {
    name: "Herbalism", emoji: "🌿", res: "herbs", total: "herbsTotal", prog: "herbProgress", up: "herbUp",
    bonusKind: "all", bonusBase: 0.1, bonusPer: 0.05, bonusLabel: "all rune gain",
    upgrades: [
      { id: "yield",   name: "Forager's Yield", base: 8,  growth: 1.20,          desc: "+1 herb per gather." },
      { id: "auto",    name: "Wild Growth",     base: 25, growth: 1.22,          desc: "+0.2 herbs per second." },
      { id: "speed",   name: "Quick Hands",     base: 40, growth: 1.55, max: 9,  desc: "−1 tap needed per herb (min 1)." },
      { id: "potency", name: "Potency",         base: 30, growth: 1.28,          desc: "+0.05% all rune gain per herb gathered (lifetime)." },
    ],
  },
  ore: {
    name: "Mining", emoji: "🪨", res: "ores", total: "oresTotal", prog: "oreProgress", up: "oreUp",
    bonusKind: "tap", bonusBase: 0.2, bonusPer: 0.1, bonusLabel: "runes per tap",
    upgrades: [
      { id: "yield",   name: "Rich Veins",  base: 8,  growth: 1.20,          desc: "+1 ore per mine." },
      { id: "auto",    name: "Auto-Drill",  base: 25, growth: 1.22,          desc: "+0.2 ore per second." },
      { id: "speed",   name: "Heavy Pick",  base: 40, growth: 1.55, max: 9,  desc: "−1 tap needed per ore (min 1)." },
      { id: "potency", name: "Refinement",  base: 30, growth: 1.28,          desc: "+0.1% runes per tap per ore mined (lifetime)." },
    ],
  },
};
function profUpLevel(kind, id) { return state[PROFS[kind].up][id] | 0; }
function profUpCost(kind, u) { return Math.ceil(u.base * Math.pow(u.growth, profUpLevel(kind, u.id))); }
function profTapsNeeded(kind) { return Math.max(1, TAPS_PER_RESOURCE - profUpLevel(kind, "speed")); }
function profYield(kind) { return 1 + profUpLevel(kind, "yield"); }
function profAutoPerSec(kind) { return 0.2 * profUpLevel(kind, "auto"); }
function profBonusPer(kind) { const p = PROFS[kind]; return p.bonusBase + p.bonusPer * profUpLevel(kind, "potency"); }

/* ---------- game state ---------- */
let state = {
  runes: 0,
  lifetimeRunes: 0,      // gathered THIS life (gates research/comprehension/VR; reset on rebirth)
  lifetimeTaps: 0,       // taps THIS life (reset on rebirth)
  comprehension: 0,
  proficiency: 0,
  flow: 0,
  research: {},          // id -> level
  lastSave: Date.now(),

  // play-time & progression stats (kept across rebirth)
  playTimeMs: 0,
  totalRunes: 0,         // all-time gathered, never reset
  totalTaps: 0,          // all-time taps, never reset
  rebirths: 0,
  rebirthUnlocked: false,
  forcedRebirthDone: false,

  // prestige
  vr: 0,                 // Void Runes (current balance)
  vrEarned: 0,           // total Void Runes ever earned (for Void Attunement)
  talents: {},           // talentId -> level
  buyMode: 1,            // 1, 5, or Infinity (Buy All)

  // professions (unlocked via talents; kept across rebirth)
  herbs: 0, herbsTotal: 0, herbProgress: 0, herbUp: {},
  ores: 0, oresTotal: 0, oreProgress: 0, oreUp: {},

  // combat sub-game (unlocked via talent; kept across Grimoire rebirth)
  gold: 0,
  survivalRunes: 0,
  monsterLevel: 1,       // within the current rank (1-100)
  combatRank: 0,         // 0 base, 1-5 stars, 6+ green triangles
  highestLevel: 1,       // highest depth reached this climb (resets on Retreat; gates Tactics)
  combatBest: 1,         // highest depth ever reached (never resets)
  monsterHp: null,       // current HP of the active monster (filled on first view)
  playerHp: null,        // player HP (★ tier and beyond)
  magicLevel: 0,         // fireball / spell level (▲ tier)
  magicProgress: 0,
  buffs: {},             // spell id -> expiry timestamp (ms)
  cooldowns: {},         // spell id -> ready timestamp (ms)
  combatUp: {},          // forge upgrade id -> level
  combatResearch: {},    // tactics research id -> level
  combatTalents: {},     // retreat talent id -> level

  // player settings
  settings: {
    runeColor: "#2ee6d6",
    tapColor: "#2ee6d6",
    muteAll: false,
    muteMusic: false,
    muteSfx: false,
    hidePurchased: false,
    hideMaxedTalents: false,
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
let pendingForcedRebirth = false;

/* combat derived values */
let cd = { tapDmg: 1, dps: 0, critChance: 0, critMult: 0, goldMult: 1,
           dodge: 0, playerMaxHp: 0, regen: 0, magicDamage: 0, atkReduce: 0 };
let combatDirty = true;
function recomputeCombat() {
  const lv = (id) => (state.combatUp[id] | 0);
  let tapAdd = CBT.baseTap + 2 * lv("sharpen");
  let autoAdd = 3.33 * lv("familiar");
  let critChance = Math.min(0.75, 0.01 * lv("whetstone"));
  let critMult = lv("whetstone") > 0 ? 2 + 0.5 * lv("whetstone") : 0;
  let goldPct = 10 * lv("greed");

  let dmgMult = 1, dpsMult = 1, allMult = 1, goldMult = 1, magicMult = 1, dodgeMult = 1, atkReduce = 0;
  for (const r of COMBAT_RESEARCH) {
    const L = state.combatResearch[r.id] | 0; if (!L) continue;
    if (r.fx.dmgMult)   dmgMult   *= Math.pow(r.fx.dmgMult, L);
    if (r.fx.dpsMult)   dpsMult   *= Math.pow(r.fx.dpsMult, L);
    if (r.fx.allMult)   allMult   *= Math.pow(r.fx.allMult, L);
    if (r.fx.goldMult)  goldMult  *= Math.pow(r.fx.goldMult, L);
    if (r.fx.magicMult) magicMult *= Math.pow(r.fx.magicMult, L);
    if (r.fx.dodgeMult) dodgeMult *= Math.pow(r.fx.dodgeMult, L);
    if (r.fx.atkReduce) atkReduce = 1 - (1 - atkReduce) * Math.pow(1 - r.fx.atkReduce / 100, L);
  }
  let dmgPct = 0, dpsPct = 0, talGoldPct = 0;
  for (const t of COMBAT_TALENTS) {
    const L = state.combatTalents[t.id] | 0; if (!L) continue;
    if (t.fx) {
      if (t.fx.dmgPct)  dmgPct  += t.fx.dmgPct * L;
      if (t.fx.dpsPct)  dpsPct  += t.fx.dpsPct * L;
      if (t.fx.goldPct) talGoldPct += t.fx.goldPct * L;
    }
    if (t.special === "crit") { critChance += 0.05 * L; critMult += 2 * L; }
  }

  // ★ stats: agility (dodge), strength (damage), vitality (HP/regen); ▲ intellect (magic)
  const agi = lv("agility"), str = lv("strength"), vit = lv("vitality"), intel = lv("intellect");

  // Survival Runes held: +10% combat damage each
  const srDmgMult = 1 + 0.10 * (state.survivalRunes | 0);
  const strengthMult = (1 + 0.003 * str) * srDmgMult;
  cd.tapDmg = tapAdd * dmgMult * allMult * (1 + dmgPct / 100) * strengthMult;
  cd.dps = autoAdd * dpsMult * allMult * (1 + dpsPct / 100) * strengthMult;
  cd.critChance = Math.min(0.9, critChance);
  cd.critMult = critMult;
  cd.goldMult = (1 + goldPct / 100) * goldMult * (1 + talGoldPct / 100);

  cd.dodge = Math.min(0.9, (0.001 * agi) * dodgeMult);
  cd.playerMaxHp = (60 + 40 * vit) * (1 + 0.5 * state.combatRank);
  cd.regen = Math.max(1, (60 + 40 * vit) * 0.03 + 2 * vit);
  cd.magicDamage = (2 + intel + (state.magicLevel | 0)) * magicMult * srDmgMult;   // +1 per magic level
  cd.atkReduce = atkReduce;
  combatDirty = false;
}

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

  // ----- talents (Void Rune tree; persist across rebirth) -----
  for (const t of TALENTS) {
    const L = talentLevel(t.id);
    if (L <= 0) continue;
    if (t.fx) {
      if (t.fx.tapPct)  tapPct  += t.fx.tapPct * L;
      if (t.fx.idlePct) idlePct += t.fx.idlePct * L;
      if (t.fx.allPct)  allPct  += t.fx.allPct * L;
    }
    if (t.special === "crit") {
      critChance += 0.05 + 0.02 * (L - 1);
      critMult   += 10 + 5 * (L - 1);
    }
    if (t.special === "vrpower") allPct += 5 * L * (state.vrEarned | 0);
  }

  // ----- profession bonuses (scale with LIFETIME gathered × Potency) -----
  allPct += profBonusPer("herb") * (state.herbsTotal || 0);  // herbs boost all rune gain
  tapPct += profBonusPer("ore") * (state.oresTotal || 0);    // ore boosts tap power

  // ----- Void Runes held: +10% tap & idle rune gain each -----
  const vrBonusPct = 10 * (state.vr | 0);
  tapPct += vrBonusPct;
  idlePct += vrBonusPct;

  // ----- Survival Runes held: +1% all rune gain each -----
  allPct += 1 * (state.survivalRunes | 0);

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
  state.totalRunes += v;
  // award comprehension for crossing lifetime thresholds
  while (state.lifetimeRunes >= compThreshold(state.comprehension)) {
    state.comprehension++;
    dirty = true;
    // the first time you reach 4 Comprehension you are forced to Rebirth
    if (state.comprehension >= 4 && !state.forcedRebirthDone) pendingForcedRebirth = true;
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
  let crit = false, mega = 1;
  if (d.critMult > 0 && Math.random() < d.critChance) {
    val *= d.critMult; crit = true;
    critStreak++;
    // crit streaks build to a MEGA crit at every 10th consecutive crit
    mega = megaCritMult(critStreak);
    if (mega > 1) val *= mega;
  } else {
    critStreak = 0;
  }

  // one tap = one rune, and the glowing rune jumps to a new random cell
  addRunes(val);
  state.lifetimeTaps++;
  state.totalTaps++;
  spawnFloat(ev, val, crit, mega);
  Sound.tap(crit);
  if (mega > 1) Sound.research(); // celebratory flourish on a mega crit
  rerollActive();

  updateTop();
  maybeRefreshPanels();
}

/* crit-streak combo: the Nth consecutive crit becomes a mega crit */
let critStreak = 0;
function megaCritMult(streak) {
  if (streak <= 0 || streak % 10 !== 0) return 1;
  if (streak <= 10) return 10;
  if (streak <= 20) return 25;
  if (streak <= 30) return 50;
  const s = Math.min(streak, 500);                 // keeps climbing up to 500 taps
  return Math.round((50 + (s - 30) * 450 / 470) / 5) * 5;
}

function spawnFloat(ev, val, crit, mega) {
  const rect = floatLayer.getBoundingClientRect();
  const f = document.createElement("div");
  const isMega = mega > 1;
  f.className = "float-num" + (crit ? " crit" : "") + (isMega ? " mega" : "");
  f.textContent = (isMega ? `MEGA CRIT x${mega}! +` : crit ? "CRIT! +" : "+") + fmt(val);
  f.style.left = (ev.clientX - rect.left) + "px";
  f.style.top = (ev.clientY - rect.top) + "px";
  floatLayer.appendChild(f);
  setTimeout(() => f.remove(), isMega ? 1300 : 900);
}

/* ---------- purchases ----------
   buy modes: state.buyMode is 1, 5, or Infinity (Buy All). Each tap buys up
   to that many levels that the player can currently afford. */
function buyLevels(costFn, applyFn) {
  const want = state.buyMode;
  let bought = 0;
  while (bought < want) {
    const c = costFn();
    if (state.runes < c) break;
    state.runes -= c;
    applyFn();
    bought++;
    if (bought >= 100000) break; // safety for Buy All
  }
  if (bought > 0) { dirty = true; Sound.buy(); refreshAll(); }
}
function buyProficiency() { buyLevels(proficiencyCost, () => state.proficiency++); }
function buyFlow() { buyLevels(flowCost, () => state.flow++); }
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

/* ---------- persistent card system ----------
   Cards are created once and then updated in place (never rebuilt), so
   tapping the same upgrade repeatedly always lands on the same button
   instead of mis-tapping a freshly recreated element. */
const cardRegistry = new Map();

function ensureCard(key) {
  let entry = cardRegistry.get(key);
  if (entry) return entry;
  const btn = document.createElement("button");
  btn.className = "card";
  btn.dataset.cardKey = key;
  btn.innerHTML =
    '<div class="card-head"><span class="card-name"></span><span class="card-level"></span></div>' +
    '<div class="card-desc"></div><span class="card-cost"></span>';
  const refs = {
    name: btn.querySelector(".card-name"),
    level: btn.querySelector(".card-level"),
    desc: btn.querySelector(".card-desc"),
    cost: btn.querySelector(".card-cost"),
  };
  entry = { btn, refs, onBuy: null };
  btn.addEventListener("click", () => { if (!btn.disabled && entry.onBuy) entry.onBuy(); });
  cardRegistry.set(key, entry);
  return entry;
}

function updateCardEntry(entry, o) {
  const { btn, refs } = entry;
  entry.onBuy = o.onBuy || null;
  const have = o.have != null ? o.have : state.runes;
  const affordable = !o.locked && !o.maxed && have >= o.cost;
  btn.classList.toggle("affordable", affordable);
  btn.classList.toggle("locked", !!o.locked);
  btn.classList.toggle("maxed", !!o.maxed);
  btn.disabled = !!(o.locked || o.maxed || !affordable);

  const nameHtml = o.name + (o.tag || "");
  if (refs.name.innerHTML !== nameHtml) refs.name.innerHTML = nameHtml;
  const levelLabel = o.levelText !== undefined ? o.levelText
    : (typeof o.level === "number" && o.level > 0 ? `Lv ${o.level}` : "");
  if (refs.level.textContent !== levelLabel) refs.level.textContent = levelLabel;
  if (refs.desc.textContent !== o.desc) refs.desc.textContent = o.desc;

  let costClass, costText;
  if (o.maxed) { costClass = "card-cost lock"; costText = "MAX"; }
  else if (o.locked) { costClass = "card-cost lock"; costText = o.lockText || ""; }
  else { costClass = "card-cost " + (affordable ? "ok" : "no"); costText = o.costText || ("✦ " + fmt(o.cost) + " runes"); }
  if (refs.cost.className !== costClass) refs.cost.className = costClass;
  if (refs.cost.textContent !== costText) refs.cost.textContent = costText;
}

/* reconcile a list's children to match `items` (ordered) without recreating
   buttons that are still present */
function syncList(listEl, items) {
  const wanted = new Set(items.map(i => i.key));
  Array.from(listEl.children).forEach(ch => {
    if (!wanted.has(ch.dataset.cardKey)) listEl.removeChild(ch);
  });
  items.forEach((item, idx) => {
    const entry = ensureCard(item.key);
    updateCardEntry(entry, item.data);
    if (listEl.children[idx] !== entry.btn) listEl.insertBefore(entry.btn, listEl.children[idx] || null);
  });
}
/* same reconciler, but affordability is measured against a given balance */
function syncListWith(listEl, items, have) {
  items.forEach(i => { i.data.have = have; });
  syncList(listEl, items);
}
function syncListGold(listEl, items) { syncListWith(listEl, items, state.gold); }

function renderUpgrades() {
  if (dirty) recompute();
  const showProf = state.lifetimeRunes >= 10 || state.proficiency > 0;
  const showFlow = state.lifetimeRunes >= 100 || state.flow > 0;
  $("#upgrades-empty").classList.toggle("hidden", showProf);

  const items = [];
  if (showProf) items.push({ key: "up-prof", data: {
    name: "Proficiency", level: state.proficiency,
    desc: `+${fmt(PROF_ADD)} rune per tap (before multipliers). Each level adds flat tap power.`,
    cost: proficiencyCost(), onBuy: buyProficiency, tag: '<span class="tag add">additive</span>'
  } });
  if (showFlow) items.push({ key: "up-flow", data: {
    name: "Flow", level: state.flow,
    desc: `+${fmt(FLOW_ADD)} rune per second (before multipliers). Passive income, even while idle.`,
    cost: flowCost(), onBuy: buyFlow, tag: '<span class="tag add">additive</span>'
  } });
  syncList($("#upgrades-list"), items);
}

function renderResearch() {
  if (dirty) recompute();
  const hidePurchased = !!(state.settings && state.settings.hidePurchased);
  const items = [];
  for (const r of RESEARCH) {
    const L = state.research[r.id] | 0;
    const revealed = state.lifetimeRunes >= r.unlock * 0.5 || L > 0;
    if (!revealed) continue;

    const unlocked = state.lifetimeRunes >= r.unlock;
    const maxed = L >= researchMax(r);

    // "purchased" = a one-time research that's owned, or a repeatable that's maxed
    const purchased = r.repeat ? maxed : L > 0;
    if (hidePurchased && purchased) continue;

    const repeatTag = r.repeat ? '<span class="tag repeat">repeatable</span>' : "";
    items.push({ key: "rs-" + r.id, data: {
      name: r.name,
      levelText: r.repeat ? `Lv ${L}${isFinite(researchMax(r)) ? "/" + researchMax(r) : ""}` : (L > 0 ? "Researched" : ""),
      desc: r.desc,
      cost: researchCost(r),
      locked: !unlocked,
      lockText: !unlocked ? `🔒 Unlocks at ${fmt(r.unlock)} lifetime runes` : null,
      maxed,
      onBuy: () => buyResearch(r),
      tag: effectTag(r) + repeatTag,
    } });
  }
  syncList($("#research-list"), items);
  const ra = $("#research-all");
  if (ra) ra.disabled = state.totalRunes < RESEARCH_ALL_UNLOCK;
}

const RESEARCH_ALL_UNLOCK = 999e12;   // 999 trillion total runes
/* buy every research the player can currently afford (cheapest first) */
function researchAll() {
  if (state.totalRunes < RESEARCH_ALL_UNLOCK) return;
  let bought = 0, guard = 0;
  while (guard++ < 100000) {
    let best = null, bestCost = Infinity;
    for (const r of RESEARCH) {
      if ((state.research[r.id] | 0) >= researchMax(r)) continue;
      if (state.lifetimeRunes < r.unlock) continue;
      const c = researchCost(r);
      if (c <= state.runes && c < bestCost) { best = r; bestCost = c; }
    }
    if (!best) break;
    state.runes -= bestCost;
    state.research[best.id] = (state.research[best.id] | 0) + 1;
    bought++;
  }
  if (bought > 0) { dirty = true; Sound.research(); refreshAll(); }
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
function selectTab(which) {
  document.querySelectorAll(".tab").forEach(t => t.classList.toggle("active", t.dataset.tab === which));
  document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("hidden", c.id !== "tab-" + which));
  if (which === "research") renderResearch();
  if (which === "herbalism") renderProfession("herb");
  if (which === "mining") renderProfession("ore");
  if (which === "combat") renderCombat();
}
document.querySelectorAll(".tab").forEach(tab => {
  tab.addEventListener("click", () => { if (!tab.disabled) selectTab(tab.dataset.tab); });
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
    state.talents = s.talents || {};
    state.combatUp = s.combatUp || {};
    state.combatResearch = s.combatResearch || {};
    state.combatTalents = s.combatTalents || {};
    state.herbUp = s.herbUp || {};
    state.oreUp = s.oreUp || {};
    state.buffs = s.buffs || {};
    state.cooldowns = s.cooldowns || {};
    // merge nested objects so older saves still get new fields
    state.settings = { ...defaults.settings, ...(s.settings || {}) };
    state.dev = { ...defaults.dev, ...(s.dev || {}) };
    // numeric/back-compat defaults for fields added later
    const num = (k) => { if (typeof state[k] !== "number") state[k] = 0; };
    ["playTimeMs", "rebirths", "totalRunes", "totalTaps", "vr", "vrEarned",
     "herbs", "herbsTotal", "herbProgress", "ores", "oresTotal", "oreProgress",
     "survivalRunes", "gold", "combatRank", "magicLevel", "magicProgress"].forEach(num);
    // older saves: seed lifetime totals from current counts so the bonus persists
    if (!s.herbsTotal && state.herbs > 0) state.herbsTotal = state.herbs;
    if (!s.oresTotal && state.ores > 0) state.oresTotal = state.ores;
    if (typeof state.buyMode !== "number") state.buyMode = 1;
    if (typeof state.monsterLevel !== "number" || state.monsterLevel < 1) state.monsterLevel = 1;
    if (typeof state.highestLevel !== "number" || state.highestLevel < state.monsterLevel) state.highestLevel = state.monsterLevel;
    if (typeof state.combatBest !== "number" || state.combatBest < state.highestLevel) {
      state.combatBest = Math.max(state.highestLevel | 0, (state.combatRank | 0) * 100 + state.monsterLevel);
    }
    // migrate the old single sword upgrade into the new Forge
    if (typeof s.swordLevel === "number" && s.swordLevel > 0 && !state.combatUp.sharpen) state.combatUp.sharpen = s.swordLevel;
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

/* ---------- idle accrual ----------
   Idle (per-second) runes are granted from REAL elapsed wall-clock time, not
   animation frames, so they keep accruing while the tab is unfocused or in the
   background. A 1s interval ticks it even when requestAnimationFrame is paused,
   and the real-time delta means any frozen gap is caught up on return. */
let lastIdle = Date.now();
function accrueIdle() {
  if (dirty || lifetimeTapEnabled) recompute();
  const now = Date.now();
  let sec = (now - lastIdle) / 1000;
  lastIdle = now;
  if (sec <= 0) return;
  sec = Math.min(sec, OFFLINE_CAP_SEC);
  if (d.idlePerSec > 0) addRunes(d.idlePerSec * sec);
}

/* combat auto-attack & profession auto-gather accrue from real elapsed time
   too (incl. background) */
let lastCombat = Date.now();
function accrueCombatTick() {
  const now = Date.now();
  let sec = (now - lastCombat) / 1000;
  lastCombat = now;
  if (sec <= 0) return;
  sec = Math.min(sec, OFFLINE_CAP_SEC);
  accrueCombat(sec);
  accrueProfessions(sec);
}

/* ---------- main loop ---------- */
let lastFrame = performance.now();
let panelAccum = 0;
function loop(now) {
  const dt = Math.min(0.25, (now - lastFrame) / 1000); // clamp big gaps
  lastFrame = now;
  if (!document.hidden) state.playTimeMs += dt * 1000;
  if (dirty || lifetimeTapEnabled) recompute();
  if (combatDirty) recomputeCombat();
  accrueIdle();
  accrueCombatTick();
  updateTop();
  checkResearchUnlock();
  checkForcedRebirth();
  // keep card states (affordability/unlocks) live during idle income
  panelAccum += dt;
  if (panelAccum >= 0.5) {
    panelAccum = 0;
    renderUpgrades();
    renderBuyMode();
    updateTabsVisibility();
    if (!$("#research-tab").disabled) renderResearch();
    if (!$("#tab-combat").classList.contains("hidden")) renderCombat();
    if (!$("#tab-herbalism").classList.contains("hidden")) renderProfession("herb");
    if (!$("#tab-mining").classList.contains("hidden")) renderProfession("ore");
    if (!$("#modal-overlay").classList.contains("hidden") && !$("#modal-stats").classList.contains("hidden")) renderStats();
  }
  requestAnimationFrame(loop);
}

/* ---------- extra zoom guards (iOS Safari ignores user-scalable) ---------- */
["gesturestart", "gesturechange", "gestureend"].forEach(evt =>
  document.addEventListener(evt, (e) => e.preventDefault(), { passive: false }));
// block double-tap zoom fallback — but never swallow rapid taps on buttons /
// inputs, so repeatedly tapping an upgrade keeps buying instead of mis-tapping
let lastTouchEnd = 0;
document.addEventListener("touchend", (e) => {
  const now = Date.now();
  const interactive = e.target.closest && e.target.closest("button, input, label, select, textarea, a, .card");
  if (!interactive && now - lastTouchEnd <= 300) e.preventDefault();
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

  // sound effects (tap / buy / research) are silenced by "mute all" or "mute SFX"
  const muted = () => state.settings.muteAll || state.settings.muteSfx;

  function tap(crit) {
    if (muted()) return; ensure(); if (!ctx) return;
    // a single soft, low note — same every tap so rapid tapping isn't grating
    tone({ freq: crit ? 130.81 : 164.81, type: "sine", dur: crit ? 0.22 : 0.11, gain: crit ? 0.2 : 0.13 });
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
  const muteSfx = $("#set-mute-sfx");
  const muteMusic = $("#set-mute-music");

  runeC.value = state.settings.runeColor;
  tapC.value = state.settings.tapColor;
  muteAll.checked = state.settings.muteAll;
  muteSfx.checked = state.settings.muteSfx;
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
  muteSfx.addEventListener("change", () => {
    state.settings.muteSfx = muteSfx.checked;
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

  // Research: hide purchased upgrades
  const hidePurchased = $("#hide-purchased");
  hidePurchased.checked = !!state.settings.hidePurchased;
  hidePurchased.addEventListener("change", () => {
    state.settings.hidePurchased = hidePurchased.checked;
    renderResearch();
  });
  $("#research-all").addEventListener("click", researchAll);
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
function closeModal() {
  if (rebirthForced) return; // a forced rebirth can't be dismissed
  $("#modal-overlay").classList.add("hidden");
}

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
  row("Runes tapped (all time)", fmt(state.totalTaps));
  row("Runes gathered (all time)", fmt(state.totalRunes));
  row("Runes gathered (this life)", fmt(state.lifetimeRunes));
  row("Comprehension", fmt(state.comprehension));
  if (state.rebirthUnlocked || state.rebirths > 0) {
    row("Rebirths", fmt(state.rebirths));
    row("Void Runes", fmt(state.vr) + " (earned " + fmt(state.vrEarned) + ")");
  }
  if (hasProfession("herbalism")) row("Herbs", fmt(state.herbs));
  if (hasProfession("mining")) row("Ore", fmt(state.ores));
  if (hasProfession("combat")) {
    row("Survival Runes", fmt(state.survivalRunes));
    const sym = rankSymbol(state.combatRank);
    row("Combat", (sym ? sym + " " : "") + "Lv " + fmt(state.monsterLevel) + " (depth " + fmt(CBT.depth()) + ")");
    row("Highest combat reached", depthLabel(state.combatBest) + " (depth " + fmt(state.combatBest) + ")");
    if (state.magicLevel > 0) row("Magic level", fmt(state.magicLevel));
  }

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
    v: "2.7.0", when: "2026-06-12", notes: [
      "Combat Tactics are now repeatable with infinite levels — each repurchase stacks its multiplier again (cost x8 per level).",
      "Ascending to a new star/triangle now wipes your Forge and Tactics (rank, Survival Runes, talents and magic are kept), so each rank is a fresh climb.",
      "Summon Familiar now gives +3.33 auto-damage/level; Sharpen Blade reverted to +2 tap damage.",
      "Dev panel: added an Add Gold (+10/+100/+1000/custom) control.",
    ],
  },
  {
    v: "2.6.1", when: "2026-06-12", notes: [
      "Herbalism & Mining now show how much you earn per tap (alongside per second).",
      "Combat now tracks and shows your highest depth ever reached (persists through Retreat) using a ★/▲ Lv label.",
      "Held Survival Runes now grant +10% combat damage each and +1% to all normal rune gain each.",
    ],
  },
  {
    v: "2.6.0", when: "2026-06-12", notes: [
      "Bosses now have a 10-second kill timer — fail and the boss heals to full and the timer resets (a DPS check).",
      "Combat rebalance: Sharpen Blade +0.5 (was +2), Summon Familiar +0.25 (was +1), and gold drops are much lower (~30g over the first 10 levels, boss ~10g).",
      "Survival Runes are now earned only from defeating bosses (Retreat just restarts the climb).",
      "Magic spells are now castable temporary buffs: Arcane Shield, Vital Surge, Haste and Rage, unlocked as your magic levels up.",
      "Research: added a “Research All” button (unlocks at 999 trillion total runes) that buys everything you can afford.",
    ],
  },
  {
    v: "2.5.0", when: "2026-06-12", notes: [
      "Combat tiers: clear 10 bosses (100 levels) to earn a ★ and restart at level 1 — and now the monster fights back! You gain HP, plus Agility (dodge) and Strength (damage) stats with new Forge & Tactics.",
      "At 5 stars you ascend to a green ▲ tier: monsters are tougher and you gain Intellect and a fireball — tap it to cast magic and level it up (25, 50, 100, 200… taps), learning spells that boost damage, HP, dodge, strength and regen.",
      "Survival Runes now drop 1 per boss defeated.",
    ],
  },
  {
    v: "2.4.0", when: "2026-06-12", notes: [
      "Void Runes now give a passive bonus just for holding them: +10% tap and idle rune gain each (10 VR = +100%).",
      "The Void talent tree has a “Hide maxed” checkbox.",
    ],
  },
  {
    v: "2.3.1", when: "2026-06-12", notes: [
      "Mega crits now keep climbing past x50 — all the way to x500 at a 500-crit streak.",
      "Dev panel: tap multiplier and Comprehension now take a custom amount, plus new +1/+5/+10/custom adders for Void Runes, Herbs and Ore.",
    ],
  },
  {
    v: "2.3.0", when: "2026-06-12", notes: [
      "Crit streaks: land 10 crits in a row for a MEGA CRIT worth x10, 20 in a row for x25, and 30+ in a row for x50 (on top of your normal crit). One non-crit tap resets the streak.",
    ],
  },
  {
    v: "2.2.1", when: "2026-06-12", notes: [
      "Settings: added a separate “Mute sound effects” toggle (silences tapping/buying without muting the music).",
    ],
  },
  {
    v: "2.2.0", when: "2026-06-12", notes: [
      "Herbalism & Mining are now proper idle games: each has Yield, Auto-gather, Speed and Potency upgrades bought with the resource itself, and the global bonus now scales with everything you've ever gathered (so spending it never lowers the bonus). Resources keep gathering in the background.",
      "Softened the tap sound — it's now a single low, gentle note instead of a rising high-pitched chime.",
    ],
  },
  {
    v: "2.1.0", when: "2026-06-12", notes: [
      "Combat is now a full idle/clicker game with its own loop: tap to strike, auto-attack chips away on its own (even in the background), and monsters drop Gold. Every 10th foe is a boss.",
      "Combat has four sub-tabs: Battle, Forge (spend Gold on tap damage, auto-attack, crit and gold-find), Tactics (Gold research unlocked by depth) and Retreat (its own prestige: reset for Survival Runes and spend them on combat talents).",
    ],
  },
  {
    v: "2.0.0", when: "2026-06-12", notes: [
      "Rebirth: at 4 Comprehension you enter the Void for the first time. Rebirthing wipes your life but grants Void Runes (1 per power-of-ten of runes gathered, from 1M up).",
      "Talent tree: spend Void Runes on permanent talents — tap power, crit, idle speed, Void Attunement, Head Start, and more.",
      "New professions, unlocked by talents: Herbalism and Mining (tap to gather, 10 taps each), and Combat (slay monsters for Survival Runes).",
      "Upgrades: added Buy 5 (unlocks at 1M total runes) and Buy All (unlocks at 1B total runes).",
    ],
  },
  {
    v: "1.5.1", when: "2026-06-10", notes: [
      "Fixed the “/ tap” display showing a stale 0.33 — a beginning tap is worth 1 rune.",
    ],
  },
  {
    v: "1.5.0", when: "2026-06-10", notes: [
      "Tapping an upgrade or research repeatedly now keeps buying it instead of mis-tapping — the cards are updated in place rather than rebuilt, and rapid taps on buttons are no longer swallowed by the zoom guard.",
    ],
  },
  {
    v: "1.4.1", when: "2026-06-10", notes: [
      "The glowing rune now jumps to a new random spot with every tap again.",
    ],
  },
  {
    v: "1.4.0", when: "2026-06-10", notes: [
      "One tap now grants a full rune (no more three taps per rune).",
    ],
  },
  {
    v: "1.3.0", when: "2026-06-10", notes: [
      "Retuned Comprehension: levels 1–4 are unchanged, but from level 5 the cost ramps up much faster (the growth accelerates 8% per level), so high Comprehension is now a real long-term goal.",
      "Added a 'Hide purchased upgrades' checkbox to the Research tab.",
      "Idle runes now keep accruing while the tab is in the background or unfocused.",
    ],
  },
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
  $("#dev-tapmult-set").addEventListener("click", () => {
    const v = parseFloat($("#dev-tapmult-custom").value);
    if (isFinite(v) && v > 0) {
      state.dev.tapMult = v; dirty = true; refreshAll(); showTapCur();
      tapWrap.querySelectorAll("button").forEach(x => x.classList.remove("on"));
    }
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
  $("#dev-comp-add").addEventListener("click", () => {
    const v = Math.floor(parseFloat($("#dev-comp-custom").value));
    if (isFinite(v) && v > 0) { state.comprehension += v; dirty = true; refreshAll(); }
  });

  // generic preset + custom adder for a resource
  const devAdder = (btnsSel, customSel, addBtnSel, apply, presets) => {
    const wrap = $(btnsSel);
    (presets || [1, 5, 10]).forEach(v => {
      const b = document.createElement("button");
      b.textContent = "+" + fmt(v);
      b.addEventListener("click", () => { apply(v); dirty = true; combatDirty = true; refreshAll(); });
      wrap.appendChild(b);
    });
    $(addBtnSel).addEventListener("click", () => {
      const v = parseFloat($(customSel).value);
      if (isFinite(v) && v > 0) { apply(v); dirty = true; combatDirty = true; refreshAll(); }
    });
  };
  // Void Runes
  devAdder("#dev-vr", "#dev-vr-custom", "#dev-vr-add", (v) => {
    state.vr += v; state.vrEarned += v; state.rebirthUnlocked = true; updateTabsVisibility();
  });
  // Herbalism (herbs) and Mining (ore) — grant to both spendable & lifetime total
  devAdder("#dev-herb", "#dev-herb-custom", "#dev-herb-add", (v) => grantResource("herb", v));
  devAdder("#dev-ore", "#dev-ore-custom", "#dev-ore-add", (v) => grantResource("ore", v));
  // Gold (combat)
  devAdder("#dev-gold", "#dev-gold-custom", "#dev-gold-add", (v) => { state.gold += v; }, [10, 100, 1000]);
}

/* =====================================================================
   Buy modes (Buy 5 / Buy All) in the Upgrades tab
   ===================================================================== */
const BUY5_UNLOCK = 1e6;     // total runes to unlock "Buy 5"
const BUYALL_UNLOCK = 1e9;   // total runes to unlock "Buy All"
function initBuyMode() {
  document.querySelectorAll(".buymode-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      if (btn.disabled) return;
      const v = btn.dataset.buy;
      state.buyMode = v === "all" ? Infinity : parseInt(v, 10);
      renderBuyMode();
      refreshAll();
    });
  });
  renderBuyMode();
}
function renderBuyMode() {
  const b5 = $("#buy5"), ball = $("#buyall");
  const u5 = state.totalRunes >= BUY5_UNLOCK, uall = state.totalRunes >= BUYALL_UNLOCK;
  b5.disabled = !u5; ball.disabled = !uall;
  b5.title = u5 ? "" : `Unlocks at ${fmt(BUY5_UNLOCK)} total runes`;
  ball.title = uall ? "" : `Unlocks at ${fmt(BUYALL_UNLOCK)} total runes`;
  if (state.buyMode === 5 && !u5) state.buyMode = 1;
  if (state.buyMode === Infinity && !uall) state.buyMode = 1;
  document.querySelectorAll(".buymode-btn").forEach(btn => {
    const v = btn.dataset.buy === "all" ? Infinity : parseInt(btn.dataset.buy, 10);
    btn.classList.toggle("active", v === state.buyMode);
  });
}

/* =====================================================================
   Rebirth + Void Runes + Talent tree
   ===================================================================== */
let rebirthForced = false;

function pendingVrGain() {
  let g = vrFromRunes(state.lifetimeRunes) + talentLevel("greater_sacrifice");
  if (state.rebirths === 0) g = Math.max(g, 5); // bootstrap the first (forced) rebirth
  return g;
}

function performRebirth() {
  const gain = pendingVrGain();
  state.vr += gain;
  state.vrEarned += gain;
  state.rebirths++;
  state.rebirthUnlocked = true;
  state.forcedRebirthDone = true;

  // wipe the life clean (keep VR, talents, professions, stats, settings)
  state.lifetimeRunes = 0;
  state.lifetimeTaps = 0;
  state.comprehension = 0;
  state.proficiency = 0;
  state.flow = 0;
  state.research = {};
  state.dev = { tapMult: 1, rpsBonus: 0 };
  // Head Start talent grants starting runes (not counted toward this life's gather)
  const hs = talentLevel("head_start");
  state.runes = hs > 0 ? Math.pow(10, hs) : 0;

  dirty = true;
  rebirthForced = false;
  Sound.research();
  recompute();
  renderRebirth();
  refreshAll();
  updateTabsVisibility();
}

function openRebirth(forced) {
  rebirthForced = !!forced;
  renderRebirth();
  openModal("rebirth");
}

function renderRebirth() {
  $("#vr-balance").textContent = fmt(state.vr);
  const heldPct = 10 * (state.vr | 0);
  $("#vr-held-bonus").textContent = heldPct > 0
    ? `Holding them grants +${fmt(heldPct)}% tap & idle rune gain`
    : "Each Void Rune held grants +10% tap & idle rune gain";
  const gain = pendingVrGain();
  const doBtn = $("#do-rebirth");
  doBtn.textContent = `Rebirth — gain ${fmt(gain)} Void Rune${gain === 1 ? "" : "s"}`;
  $("#vr-gain-line").innerHTML =
    `This life gathered <b>${fmt(state.lifetimeRunes)}</b> runes → <b>${fmt(gain)}</b> VR`;
  $("#rebirth-warning").textContent = rebirthForced
    ? "You have glimpsed the Void. You must Rebirth to continue — all progress this life is consumed, but your Void Runes remain."
    : "Rebirthing wipes this life (runes, upgrades, research, Comprehension). You keep Void Runes, talents and professions.";
  $("#rebirth-close").classList.toggle("hidden", rebirthForced);
  $("#begin-anew").classList.toggle("hidden", rebirthForced);
  renderTalents();
}

function renderTalents() {
  const list = $("#talent-list");
  const hideMaxed = !!(state.settings && state.settings.hideMaxedTalents);
  list.innerHTML = "";
  for (const t of TALENTS) {
    const L = talentLevel(t.id);
    const maxed = L >= talentMax(t);
    if (hideMaxed && maxed) continue;
    const cost = talentCost(t);
    const affordable = !maxed && state.vr >= cost;
    const btn = document.createElement("button");
    btn.className = "card talent" + (affordable ? " affordable" : "") + (maxed ? " maxed" : "");
    btn.disabled = !affordable;
    const lvlText = t.max === 1 ? (L > 0 ? "Unlocked" : "") : `Lv ${L}${isFinite(talentMax(t)) ? "/" + talentMax(t) : ""}`;
    const costText = maxed ? "MAX" : `◆ ${fmt(cost)} VR`;
    btn.innerHTML =
      `<div class="card-head"><span class="card-name">${t.name}${t.unlock ? '<span class="tag mult">profession</span>' : ""}</span>` +
      `<span class="card-level">${lvlText}</span></div>` +
      `<div class="card-desc">${t.desc}</div>` +
      `<span class="card-cost ${maxed ? "lock" : affordable ? "ok" : "no"}">${costText}</span>`;
    if (affordable) btn.addEventListener("click", () => buyTalent(t));
    list.appendChild(btn);
  }
}

function buyTalent(t) {
  const L = talentLevel(t.id);
  if (L >= talentMax(t)) return;
  const cost = talentCost(t);
  if (state.vr < cost) return;
  state.vr -= cost;
  state.talents[t.id] = L + 1;
  dirty = true;
  Sound.buy();
  recompute();
  renderRebirth();
  updateTabsVisibility();
  refreshAll();
}

function initRebirthUI() {
  $("#do-rebirth").addEventListener("click", performRebirth);
  $("#begin-anew").addEventListener("click", () => { rebirthForced = false; closeModal(); });
  $("#rebirth-btn").addEventListener("click", () => openRebirth(false));
  const hideMaxed = $("#hide-maxed-talents");
  hideMaxed.checked = !!state.settings.hideMaxedTalents;
  hideMaxed.addEventListener("change", () => {
    state.settings.hideMaxedTalents = hideMaxed.checked;
    renderTalents();
  });
}

function checkForcedRebirth() {
  if (pendingForcedRebirth && !state.forcedRebirthDone) {
    pendingForcedRebirth = false;
    openRebirth(true);
  }
}

function updateTabsVisibility() {
  ["herbalism", "mining", "combat"].forEach(name => {
    const tab = document.querySelector('.tab[data-tab="' + name + '"]');
    if (tab) tab.classList.toggle("hidden", !hasProfession(name));
  });
  const rb = $("#rebirth-btn");
  if (rb) rb.classList.toggle("hidden", !state.rebirthUnlocked);
}

/* =====================================================================
   Professions: Herbalism & Mining (each a small idle game)
   ===================================================================== */
function grantResource(kind, amount) {
  const p = PROFS[kind];
  state[p.res] += amount;
  state[p.total] += amount;
  dirty = true; // lifetime total feeds the global bonus
}
function gatherProfession(kind) {
  const p = PROFS[kind];
  state[p.prog] = (state[p.prog] | 0) + 1;
  if (state[p.prog] >= profTapsNeeded(kind)) {
    state[p.prog] = 0;
    grantResource(kind, profYield(kind));
  }
  Sound.tap(false);
  renderProfession(kind);
}
/* idle auto-gather, from real elapsed time (incl. background) */
function accrueProfessions(sec) {
  let changed = false;
  ["herb", "ore"].forEach(kind => {
    const auto = profAutoPerSec(kind);
    if (auto > 0) { grantResource(kind, auto * sec); changed = true; }
  });
  return changed;
}
function buyProfUp(kind, u) {
  const p = PROFS[kind];
  const cost = profUpCost(kind, u);
  if (state[p.res] < cost) return;
  if (u.max && profUpLevel(kind, u.id) >= u.max) return;
  state[p.res] -= cost;
  state[p.up][u.id] = profUpLevel(kind, u.id) + 1;
  dirty = true;
  Sound.buy();
  renderProfession(kind);
}
function renderProfession(kind) {
  if (dirty) recompute();
  const p = PROFS[kind];
  const pre = kind === "herb" ? "#herb" : "#ore";
  $(pre + "-count").textContent = fmt(Math.floor(state[p.res]));
  $(pre + "-bar").style.width = (100 * (state[p.prog] | 0) / profTapsNeeded(kind)) + "%";
  // effective amount earned per individual tap = yield / taps-needed
  $(pre + "-pertap").textContent = fmt(Math.round((profYield(kind) / profTapsNeeded(kind)) * 100) / 100);
  $(pre + "-auto").textContent = fmt(profAutoPerSec(kind));
  const bonus = profBonusPer(kind) * (state[p.total] || 0);
  $(pre + "-bonus").textContent = "+" + (Math.round(bonus * 100) / 100) + "% " + p.bonusLabel;
  // upgrades (spent with the resource)
  const items = p.upgrades.map(u => {
    const L = profUpLevel(kind, u.id);
    const maxed = u.max && L >= u.max;
    const cost = profUpCost(kind, u);
    return { key: kind + "-up-" + u.id, data: {
      name: u.name, levelText: `Lv ${L}${u.max ? "/" + u.max : ""}`, desc: u.desc,
      cost, costText: `${p.emoji} ${fmt(cost)}`, maxed,
      onBuy: () => buyProfUp(kind, u),
    } };
  });
  syncListWith($(pre + "-up-list"), items, state[p.res]);
}

/* =====================================================================
   Combat — a self-contained idle/clicker game
   ===================================================================== */
let combatSub = "battle";

function ensureMonster() {
  if (state.monsterHp == null || state.monsterHp <= 0 || !isFinite(state.monsterHp)) {
    state.monsterHp = CBT.monsterHp(state.monsterLevel, state.combatRank);
  }
}
function ensurePlayer() {
  if (state.combatRank < 1) return;
  if (combatDirty) recomputeCombat();
  if (state.playerHp == null || !isFinite(state.playerHp) || state.playerHp > cd.playerMaxHp) {
    state.playerHp = cd.playerMaxHp;
  }
}
function rankUp() {
  state.combatRank++;
  state.monsterLevel = 1;
  state.playerHp = null;       // refilled by ensurePlayer at the new max
  bossDeadline = 0;
  // ascending wipes Forge & Tactics — you rebuild them each rank (Survival
  // Runes, talents, rank and magic persist)
  state.combatUp = {};
  state.combatResearch = {};
  combatDirty = true;          // HP/regen scale with rank
}
function killMonster() {
  state.gold += CBT.goldDrop(state.monsterLevel, state.combatRank) * cd.goldMult;
  if (state.monsterLevel % 10 === 0) {
    state.survivalRunes += 1 + (state.combatTalents.survivor | 0);  // Survival Runes only from bosses
    bossDeadline = 0;
    dirty = true; combatDirty = true;   // SR held boosts rune gain & combat damage
  }
  state.monsterLevel++;
  if (state.monsterLevel > 100) rankUp();                        // cleared a century -> +1 star
  const nd = CBT.depth();
  if (nd > state.highestLevel) state.highestLevel = nd;
  if (nd > (state.combatBest | 0)) state.combatBest = nd;
  state.monsterHp = CBT.monsterHp(state.monsterLevel, state.combatRank);
  if (state.monsterLevel % 10 === 0) bossDeadline = 0;           // a fresh boss -> new timer
  // small heal between fights at the ★/▲ tiers
  if (state.combatRank >= 1 && state.playerHp != null) {
    state.playerHp = Math.min(cd.playerMaxHp, state.playerHp + cd.playerMaxHp * 0.1);
  }
}
function playerDefeated() {
  // setback to the start of the current 10-level block, full heal
  state.monsterLevel = Math.floor((state.monsterLevel - 1) / 10) * 10 + 1;
  state.monsterHp = CBT.monsterHp(state.monsterLevel, state.combatRank);
  state.playerHp = cd.playerMaxHp;
  bossDeadline = 0;
}
/* boss 10-second kill timer. Returns remaining ms (or 0 when not a boss). */
let bossDeadline = 0;
function bossTimerCheck(now) {
  if (!CBT.isBoss(state.monsterLevel)) { bossDeadline = 0; return 0; }
  if (!bossDeadline) bossDeadline = now + BOSS_TIME_MS;
  if (now > bossDeadline) {                       // ran out of time -> boss fully heals, retry
    state.monsterHp = CBT.monsterHp(state.monsterLevel, state.combatRank);
    bossDeadline = now + BOSS_TIME_MS;
  }
  return Math.max(0, bossDeadline - now);
}
function rageMult() { return buffActive("rage") ? 2 : 1; }
function tapMonster(ev) {
  if (combatDirty) recomputeCombat();
  ensureMonster();
  bossTimerCheck(Date.now());
  let dmg = cd.tapDmg * rageMult(), crit = false;
  if (cd.critMult > 0 && Math.random() < cd.critChance) { dmg *= cd.critMult; crit = true; }
  state.monsterHp -= dmg;
  spawnCombatFloat(ev, dmg, crit);
  if (state.monsterHp <= 0) { killMonster(); Sound.buy(); }
  else Sound.tap(false);
  if (combatSub === "battle") renderCombatBattle();
}
function tapFireball(ev) {
  if (state.combatRank < 6) return;
  if (combatDirty) recomputeCombat();
  ensureMonster();
  bossTimerCheck(Date.now());
  const dmg = cd.magicDamage * rageMult();
  state.monsterHp -= dmg;
  spawnCombatFloat(ev, dmg, false, true);
  state.magicProgress = (state.magicProgress | 0) + 1;
  if (state.magicProgress >= magicReq(state.magicLevel)) {
    state.magicProgress = 0;
    state.magicLevel = (state.magicLevel | 0) + 1;
    combatDirty = true;        // a new spell may unlock
    Sound.research();
  }
  if (state.monsterHp <= 0) { killMonster(); Sound.buy(); }
  else Sound.tap(false);
  if (combatSub === "battle") renderCombatBattle();
}
function castSpell(s) {
  if (state.magicLevel < s.unlock) return;
  const now = Date.now();
  if ((state.cooldowns[s.id] || 0) > now) return;     // still on cooldown
  state.buffs[s.id] = now + s.duration * 1000;
  state.cooldowns[s.id] = now + s.cooldown * 1000;
  if (s.id === "vital") { ensurePlayer(); state.playerHp = cd.playerMaxHp; }
  Sound.research();
  renderCombatBattle();
}
/* idle auto-attack & the monster fighting back, from real elapsed time */
function accrueCombat(sec) {
  if (!hasProfession("combat")) return;
  if (combatDirty) recomputeCombat();
  ensureMonster();
  bossTimerCheck(Date.now());
  if (cd.dps > 0) {
    let dmg = cd.dps * rageMult() * sec, guard = 0;
    while (dmg > 0 && guard < 100000) {
      if (dmg >= state.monsterHp) { dmg -= state.monsterHp; state.monsterHp = 0; killMonster(); guard++; }
      else { state.monsterHp -= dmg; dmg = 0; }
    }
  }
  // the monster fights back at the ★/▲ tiers (live ticks only — be generous offline)
  if (state.combatRank >= 1 && sec < 60) {
    ensurePlayer();
    const dodge = Math.min(0.95, cd.dodge + (buffActive("haste") ? 0.30 : 0));
    const incoming = buffActive("shield") ? 0
      : CBT.monsterAtk(state.monsterLevel, state.combatRank) * (1 - cd.atkReduce) * (1 - dodge);
    const regen = cd.regen * (buffActive("vital") ? 3 : 1);
    state.playerHp = Math.min(cd.playerMaxHp, state.playerHp + (regen - incoming) * sec);
    if (state.playerHp <= 0) playerDefeated();
  }
}
function spawnCombatFloat(ev, dmg, crit, magic) {
  const layer = $("#combat-float");
  if (!layer || !ev) return;
  const rect = layer.getBoundingClientRect();
  const f = document.createElement("div");
  f.className = "float-num" + (crit ? " crit" : "") + (magic ? " magic-hit" : "");
  f.textContent = (magic ? "🔥 " : crit ? "CRIT " : "") + fmt(dmg);
  f.style.left = (ev.clientX - rect.left) + "px";
  f.style.top = (ev.clientY - rect.top) + "px";
  layer.appendChild(f);
  setTimeout(() => f.remove(), 900);
}

function buyCombatUp(u) {
  if ((u.minRank || 0) > state.combatRank) return;
  const cost = combatUpCost(u);
  if (state.gold < cost) return;
  state.gold -= cost;
  state.combatUp[u.id] = (state.combatUp[u.id] | 0) + 1;
  combatDirty = true;
  Sound.buy();
  renderCombatForge();
}
function buyCombatResearch(r) {
  if ((r.minRank || 0) > state.combatRank) return;
  if (state.highestLevel < r.unlock) return;
  const cost = combatResearchCost(r);
  if (state.gold < cost) return;
  state.gold -= cost;
  state.combatResearch[r.id] = (state.combatResearch[r.id] | 0) + 1;   // infinite levels
  combatDirty = true;
  Sound.research();
  renderCombatTactics();
}
function buyCombatTalent(t) {
  const L = state.combatTalents[t.id] | 0;
  if (L >= (t.max || Infinity)) return;
  const cost = combatTalentCost(t);
  if (state.survivalRunes < cost) return;
  state.survivalRunes -= cost;
  state.combatTalents[t.id] = L + 1;
  combatDirty = true;
  dirty = true;          // spending SR changes the held-SR rune bonus
  Sound.buy();
  renderCombatRetreat();
}
function doRetreat() {
  // restart the climb (Survival Runes are earned from bosses, not from retreating)
  state.gold = (state.combatTalents.war_chest | 0) > 0 ? Math.pow(10, state.combatTalents.war_chest | 0) : 0;
  state.monsterLevel = 1;
  state.combatRank = 0;
  state.highestLevel = 1;
  state.monsterHp = CBT.monsterHp(1, 0);
  state.playerHp = null;
  state.magicLevel = 0;
  state.magicProgress = 0;
  state.combatUp = {};
  state.combatResearch = {};
  bossDeadline = 0;
  combatDirty = true;
  Sound.research();
  renderCombatRetreat();
  renderCombatBattle();
}

/* ----- combat rendering (sub-tabs: Battle / Forge / Tactics / Retreat) ----- */
function selectCombatSub(which) {
  combatSub = which;
  document.querySelectorAll("#tab-combat .subtab").forEach(s => s.classList.toggle("active", s.dataset.sub === which));
  document.querySelectorAll("#tab-combat .subcontent").forEach(c => c.classList.toggle("hidden", c.id !== "sub-" + which));
  renderCombat();
}
function renderCombat() {
  if (combatDirty) recomputeCombat();
  if (combatSub === "battle") renderCombatBattle();
  else if (combatSub === "forge") renderCombatForge();
  else if (combatSub === "tactics") renderCombatTactics();
  else if (combatSub === "retreat") renderCombatRetreat();
}
function renderCombatBattle() {
  if (combatDirty) recomputeCombat();
  ensureMonster();
  const maxHp = CBT.monsterHp(state.monsterLevel, state.combatRank);
  const boss = CBT.isBoss(state.monsterLevel);
  const sym = rankSymbol(state.combatRank);
  $("#monster-emoji").textContent = boss ? "🐉" : "👹";
  $("#monster-name").textContent = (sym ? sym + " " : "") + (boss ? "BOSS — Lv " : "Lv ") + fmt(state.monsterLevel) + (boss ? "" : " Fiend");
  $("#monster-hp").textContent = fmt(Math.max(0, Math.ceil(state.monsterHp)));
  $("#monster-hp-max").textContent = fmt(maxHp);
  $("#monster-hp-bar").style.width = Math.max(0, 100 * state.monsterHp / maxHp) + "%";
  // boss 10s timer
  const timerEl = $("#boss-timer");
  if (boss) {
    const left = bossTimerCheck(Date.now());
    timerEl.classList.remove("hidden");
    timerEl.textContent = "⏱ " + (left / 1000).toFixed(1) + "s";
    timerEl.classList.toggle("urgent", left < 4000);
  } else timerEl.classList.add("hidden");
  $("#combat-gold").textContent = fmt(state.gold);
  $("#combat-sr").textContent = fmt(state.survivalRunes);
  $("#combat-tapdmg").textContent = fmt(cd.tapDmg);
  $("#combat-dps").textContent = fmt(cd.dps);
  const critEl = $("#combat-crit");
  if (cd.critMult > 0) { critEl.classList.remove("hidden"); critEl.textContent = `${Math.round(cd.critChance * 100)}% crit · x${fmt(cd.critMult)}`; }
  else critEl.classList.add("hidden");

  // ★ tier: player HP + dodge
  const hpWrap = $("#player-hp-wrap");
  if (state.combatRank >= 1) {
    ensurePlayer();
    hpWrap.classList.remove("hidden");
    $("#player-hp").textContent = fmt(Math.max(0, Math.ceil(state.playerHp)));
    $("#player-hp-max").textContent = fmt(Math.ceil(cd.playerMaxHp));
    $("#player-hp-bar").style.width = Math.max(0, 100 * state.playerHp / cd.playerMaxHp) + "%";
    $("#player-dodge").textContent = (Math.round(cd.dodge * 1000) / 10) + "% dodge";
  } else hpWrap.classList.add("hidden");

  // ▲ tier: fireball / magic + castable spells
  const magicWrap = $("#magic-wrap");
  if (state.combatRank >= 6) {
    magicWrap.classList.remove("hidden");
    $("#magic-level").textContent = fmt(state.magicLevel);
    $("#magic-dmg").textContent = fmt(cd.magicDamage);
    $("#magic-bar").style.width = (100 * (state.magicProgress | 0) / magicReq(state.magicLevel)) + "%";
    renderSpells();
  } else magicWrap.classList.add("hidden");
}
function renderSpells() {
  const wrap = $("#spell-list");
  const now = Date.now();
  wrap.innerHTML = "";
  for (const s of SPELLS) {
    if (state.magicLevel < s.unlock) continue;
    const cdReady = state.cooldowns[s.id] || 0;
    const active = buffActive(s.id);
    const onCd = cdReady > now && !active;
    const b = document.createElement("button");
    b.className = "spell-btn" + (active ? " active" : "");
    b.disabled = onCd;
    let status = active ? Math.ceil((state.buffs[s.id] - now) / 1000) + "s"
      : onCd ? Math.ceil((cdReady - now) / 1000) + "s" : "ready";
    b.innerHTML = `<span class="spell-emoji">${s.emoji}</span><span class="spell-name">${s.name}</span><span class="spell-status">${status}</span>`;
    b.title = s.desc;
    b.addEventListener("click", () => castSpell(s));
    wrap.appendChild(b);
  }
}
function renderCombatForge() {
  if (combatDirty) recomputeCombat();
  $("#forge-gold").textContent = fmt(state.gold);
  const items = COMBAT_UP.filter(u => (u.minRank || 0) <= state.combatRank).map(u => {
    const cost = combatUpCost(u);
    return { key: "cu-" + u.id, data: {
      name: u.name, levelText: `Lv ${state.combatUp[u.id] | 0}`, desc: u.desc,
      cost, costText: `⟡ ${fmt(cost)} gold`, onBuy: () => buyCombatUp(u),
    } };
  });
  syncListGold($("#forge-list"), items);
}
function renderCombatTactics() {
  $("#tactics-gold").textContent = fmt(state.gold);
  const items = [];
  for (const r of COMBAT_RESEARCH) {
    if ((r.minRank || 0) > state.combatRank) continue;   // hidden until the tier is reached
    const L = state.combatResearch[r.id] | 0;
    const unlocked = state.highestLevel >= r.unlock;
    if (!unlocked && L === 0 && state.highestLevel < r.unlock - 5) continue; // hide far-off ones
    const cost = combatResearchCost(r);
    items.push({ key: "ct-" + r.id, data: {
      name: r.name, levelText: `Lv ${L}`, desc: r.desc,   // repeatable (infinite levels)
      cost, costText: `⟡ ${fmt(cost)} gold`,
      locked: !unlocked, lockText: !unlocked ? `🔒 Reach depth ${r.unlock}` : null,
      onBuy: () => buyCombatResearch(r),
    } });
  }
  syncListGold($("#tactics-list"), items);
}
function renderCombatRetreat() {
  $("#combat-sr2").textContent = fmt(state.survivalRunes);
  const btn = $("#do-retreat");
  btn.textContent = "Retreat — restart the climb";
  btn.disabled = state.combatRank === 0 && state.monsterLevel <= 1;
  const sr = state.survivalRunes | 0;
  $("#retreat-info").innerHTML = `Now at <b>${depthLabel(CBT.depth())}</b> (depth ${fmt(CBT.depth())}). Highest ever: <b>${depthLabel(state.combatBest)}</b>.<br>` +
    `Holding Survival Runes grants <b class="good-text">+${fmt(10 * sr)}% combat damage</b> and <b class="good-text">+${fmt(sr)}% rune gain</b>.<br>` +
    `Survival Runes come from <b>bosses</b>. Retreat resets gold, rank, Forge & Tactics so you can re-farm bosses — you keep Survival Runes and talents.`;
  const list = $("#combat-talent-list");
  list.innerHTML = "";
  for (const t of COMBAT_TALENTS) {
    const L = state.combatTalents[t.id] | 0;
    const maxed = L >= (t.max || Infinity);
    const cost = combatTalentCost(t);
    const can = !maxed && state.survivalRunes >= cost;
    const b = document.createElement("button");
    b.className = "card talent" + (can ? " affordable" : "") + (maxed ? " maxed" : "");
    b.disabled = !can;
    b.innerHTML =
      `<div class="card-head"><span class="card-name">${t.name}</span><span class="card-level">Lv ${L}${isFinite(t.max) ? "/" + t.max : ""}</span></div>` +
      `<div class="card-desc">${t.desc}</div>` +
      `<span class="card-cost ${maxed ? "lock" : can ? "ok" : "no"}">${maxed ? "MAX" : "🜂 " + fmt(cost) + " SR"}</span>`;
    if (can) b.addEventListener("click", () => buyCombatTalent(t));
    list.appendChild(b);
  }
}

function initProfessionsUI() {
  $("#herb-target").addEventListener("pointerdown", (e) => { e.preventDefault(); gatherProfession("herb"); });
  $("#ore-target").addEventListener("pointerdown", (e) => { e.preventDefault(); gatherProfession("ore"); });
  $("#monster-target").addEventListener("pointerdown", (e) => { e.preventDefault(); tapMonster(e); });
  $("#fireball-target").addEventListener("pointerdown", (e) => { e.preventDefault(); tapFireball(e); });
  $("#do-retreat").addEventListener("click", doRetreat);
  document.querySelectorAll("#tab-combat .subtab").forEach(s =>
    s.addEventListener("click", () => selectCombatSub(s.dataset.sub)));
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
  initBuyMode();
  initRebirthUI();
  initProfessionsUI();
  updateTabsVisibility();
  renderPatchNotes();

  // if a save already passed 4 Comprehension before the forced rebirth, force it now
  if (state.comprehension >= 4 && !state.forcedRebirthDone) pendingForcedRebirth = true;

  setInterval(save, 10000);
  // keep gathering idle runes & combat in the background (rAF is paused when hidden)
  lastIdle = Date.now();
  lastCombat = state.lastSave || Date.now();   // catch up combat over offline time
  recomputeCombat();
  accrueCombatTick();
  const tickBackground = () => { accrueIdle(); accrueCombatTick(); };
  setInterval(tickBackground, 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { tickBackground(); save(); }
    else { tickBackground(); lastFrame = performance.now(); updateTop(); }
  });
  window.addEventListener("beforeunload", save);

  requestAnimationFrame(loop);
}
init();
