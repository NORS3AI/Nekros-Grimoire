# Nekro's Grimoire

An idle / clicker / instant-gratification game about deciphering the text of the
Necromancer's Grimoire.

## Play

Just open `index.html` in any modern browser — there is no build step.
Progress is saved automatically to your browser's `localStorage`, and the tome
keeps writing runes while you're away (idle income, capped at 4 hours offline).

To run a tiny local server instead (recommended on iPad/mobile):

```bash
python3 -m http.server 8000
# then visit http://localhost:8000
```

## How it works

- **Tap the glowing turquoise rune.** Three taps decipher **1 rune**.
- **Runes** (top-left, purple) are your main currency.
- **Comprehension** (top-center) is earned at lifetime-rune milestones and gives
  a growing bonus to *all* rune gain. Earning your first Comprehension unlocks
  the **Research** menu.

### Upgrades (side menu)

- **Proficiency** — unlocks at 10 runes. `+0.1` rune per tap (additive).
- **Flow** — unlocks at 100 runes. `+1` rune per second (additive).

### Research

40 permanent arcane upgrades, from `Inking` (300 runes) up through crit chance,
crit damage, cost reductions, and escalating multipliers into the billions.

### How bonuses stack

- **Additive bonuses** (Proficiency, Flow) are summed **first**, then every
  multiplier is applied — so a flat `+1` becomes enormous once multipliers pile up.
- **Multiplicative** research compounds: `x5` then `x5` again = **x25**, not x10.
- **Additive-percentage** research (`+20%`, `+50%`, …) sums its percentages,
  then that group multiplies with the other multiplier groups
  (ten `+20%` = `+200%` = `x3`).
- The order you buy upgrades in never changes the final result.

Designed to be mobile/iPad-friendly: text can't be selected while tapping, and
pinch / double-tap zoom is disabled so rapid tapping won't zoom the page.
