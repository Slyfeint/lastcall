/* The periodic table as a deck.

   Symbols are pure memorisation, they never change, and they come up in every
   quiz — which is exactly what a drill is for. The table is embedded rather
   than fetched: 118 entries verified in one place beats a live dependency that
   can go stale or go away.

   node scripts/build-elements.mjs
*/
import { writeFileSync, mkdirSync } from 'node:fs';
import { check } from './lint-decks.mjs';

// atomic number, symbol, name
const ELEMENTS = `1 H Hydrogen|2 He Helium|3 Li Lithium|4 Be Beryllium|5 B Boron|6 C Carbon|7 N Nitrogen|8 O Oxygen|9 F Fluorine|10 Ne Neon|
11 Na Sodium|12 Mg Magnesium|13 Al Aluminium|14 Si Silicon|15 P Phosphorus|16 S Sulfur|17 Cl Chlorine|18 Ar Argon|19 K Potassium|20 Ca Calcium|
21 Sc Scandium|22 Ti Titanium|23 V Vanadium|24 Cr Chromium|25 Mn Manganese|26 Fe Iron|27 Co Cobalt|28 Ni Nickel|29 Cu Copper|30 Zn Zinc|
31 Ga Gallium|32 Ge Germanium|33 As Arsenic|34 Se Selenium|35 Br Bromine|36 Kr Krypton|37 Rb Rubidium|38 Sr Strontium|39 Y Yttrium|40 Zr Zirconium|
41 Nb Niobium|42 Mo Molybdenum|43 Tc Technetium|44 Ru Ruthenium|45 Rh Rhodium|46 Pd Palladium|47 Ag Silver|48 Cd Cadmium|49 In Indium|50 Sn Tin|
51 Sb Antimony|52 Te Tellurium|53 I Iodine|54 Xe Xenon|55 Cs Caesium|56 Ba Barium|57 La Lanthanum|58 Ce Cerium|59 Pr Praseodymium|60 Nd Neodymium|
61 Pm Promethium|62 Sm Samarium|63 Eu Europium|64 Gd Gadolinium|65 Tb Terbium|66 Dy Dysprosium|67 Ho Holmium|68 Er Erbium|69 Tm Thulium|70 Yb Ytterbium|
71 Lu Lutetium|72 Hf Hafnium|73 Ta Tantalum|74 W Tungsten|75 Re Rhenium|76 Os Osmium|77 Ir Iridium|78 Pt Platinum|79 Au Gold|80 Hg Mercury|
81 Tl Thallium|82 Pb Lead|83 Bi Bismuth|84 Po Polonium|85 At Astatine|86 Rn Radon|87 Fr Francium|88 Ra Radium|89 Ac Actinium|90 Th Thorium|
91 Pa Protactinium|92 U Uranium|93 Np Neptunium|94 Pu Plutonium|95 Am Americium|96 Cm Curium|97 Bk Berkelium|98 Cf Californium|99 Es Einsteinium|100 Fm Fermium|
101 Md Mendelevium|102 No Nobelium|103 Lr Lawrencium|104 Rf Rutherfordium|105 Db Dubnium|106 Sg Seaborgium|107 Bh Bohrium|108 Hs Hassium|109 Mt Meitnerium|110 Ds Darmstadtium|
111 Rg Roentgenium|112 Cn Copernicium|113 Nh Nihonium|114 Fl Flerovium|115 Mc Moscovium|116 Lv Livermorium|117 Ts Tennessine|118 Og Oganesson`
  .split('|').map(s => s.trim()).filter(Boolean)
  .map(s => { const [n, sym, ...name] = s.split(' '); return { n: +n, sym, name: name.join(' ') }; });

/* The odd ones out are where the points are, so they get the note. */
const NOTES = {
  K: 'From the Latin kalium.', Na: 'From the Latin natrium.', Fe: 'From the Latin ferrum.',
  Ag: 'From the Latin argentum.', Au: 'From the Latin aurum.', Sn: 'From the Latin stannum.',
  Pb: 'From the Latin plumbum.', Cu: 'From the Latin cuprum.', Hg: 'From hydrargyrum, "water-silver".',
  Sb: 'From the Latin stibium.', W: 'From wolfram; tungsten is the Swedish name.',
};

const bad = [];
if (ELEMENTS.length !== 118) bad.push(`expected 118 elements, built ${ELEMENTS.length}`);
ELEMENTS.forEach((e, i) => { if (e.n !== i + 1) bad.push(`atomic numbers break at ${e.n} (${e.name})`); });
for (const key of ['sym', 'name']) {
  const seen = new Set();
  for (const e of ELEMENTS) { if (seen.has(e[key])) bad.push(`duplicate ${key}: ${e[key]}`); seen.add(e[key]); }
}
for (const [n, sym, name] of [[1, 'H', 'Hydrogen'], [26, 'Fe', 'Iron'], [79, 'Au', 'Gold'], [118, 'Og', 'Oganesson']]) {
  const e = ELEMENTS[n - 1];
  if (e.sym !== sym || e.name !== name) bad.push(`element ${n} should be ${sym}/${name}, got ${e.sym}/${e.name}`);
}
if (bad.length) { bad.forEach(b => console.error('BAD  ' + b)); process.exit(1); }

const cards = ELEMENTS.map(e => ({
  q: `The element with the chemical symbol ${e.sym}`,
  a: e.name,
  ...(NOTES[e.sym] ? { n: NOTES[e.sym] } : {}),
  d: e.n <= 20 || NOTES[e.sym] ? 1 : e.n <= 60 ? 2 : 3,
  s: 'table',
}));

const rejected = cards.map(check).filter(Boolean);
if (rejected.length) { console.error('the lint rejects generated cards: ' + rejected.join(', ')); process.exit(1); }

mkdirSync('public/decks', { recursive: true });
writeFileSync('public/decks/elem.json', JSON.stringify({
  id: 'elem', name: 'The Periodic Table', style: 'All 118 symbols, and the Latin ones that catch people out',
  area: 'Science', source: 'table', cards,
}));
console.log(`elem.json: ${cards.length} cards, ${Object.keys(NOTES).length} with the Latin trap noted`);
