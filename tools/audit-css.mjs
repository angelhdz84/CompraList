/**
 * Auditoría de clases huérfanas.
 *
 * Una clase usada en el markup sin ninguna regla se renderiza sin estilo, que es
 * como apareció .empty: el contenedor del estado vacío no tenía NINGUNA regla y
 * solo se notaba porque el icono se pegaba a la izquierda.
 *
 * Por qué no basta con buscar el texto ".empty" en la hoja: eso es una búsqueda de
 * SUBCADENA, así que .empty da "true" porque existen .empty-title y .empty-text.
 * Ese chequeo dio un falso negativo y dejó pasar el bug. Aquí se comparan
 * nombres exactos.
 *
 * Uso: node tools/audit-css.mjs   (sale con código 1 si hay huérfanas)
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const leer = (p) => readFileSync(join(raiz, p), 'utf8');

const css = leer('css/style.css');
const html = leer('index.html');
const app = leer('js/app.js');

// --- clases usadas ---------------------------------------------------------
// Del HTML estático y también de las cadenas que app.js inyecta con innerHTML,
// que es donde viven la mitad de las clases (tarjetas de producto, modales...).
//
// El valor de class= suele ser una expresión de JS con comillas y
// interpolaciones: class="product-card ${bought ? 'bought' : ''}". Hay que quitar
// las interpolaciones y trocear por comillas y signs de unión, o aparecen tokens
// como "${bought" o "'bought'" que no son clases.
const sinInterpolaciones = (s) => {
  let out = '';
  let nivel = 0;
  for (const ch of s) {
    if (ch === '{') nivel++;
    else if (ch === '}') nivel = Math.max(0, nivel - 1);
    else if (nivel === 0) out += ch;
  }
  return out;
};
const esClase = (t) => /^[A-Za-z][A-Za-z0-9_-]*$/.test(t);

// --- clases definidas ------------------------------------------------------
// Solo los selectores de clase de verdad: se descartan los .5 de medidas
// decimales y los nombres dentro de url()/valores.
const definidas = new Set();
for (const m of css.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) definidas.add(m[1]);

const usadas = new Set();
const anota = (valor) => {
  for (const c of sinInterpolaciones(valor).split(/[\s'"+,]+/)) {
    if (esClase(c)) usadas.add(c);
  }
};
for (const texto of [html, app]) {
  // class="..." en el HTML y en las cadenas de innerHTML.
  for (const m of texto.matchAll(/class=(["'])([\s\S]*?)\1/g)) anota(m[2]);
  // element.className = '... product-card ...'  (una parte grande de la app).
  for (const m of texto.matchAll(/className\s*=\s*(["'`])[\s\S]*?\1/g)) {
    const v = m[0].replace(/^className\s*=\s*/, '').slice(1, -1);
    anota(v);
  }
  // classList.add/toggle/remove('...'): dark, show, bought, added, pressing...
  for (const m of texto.matchAll(/classList\.(?:add|toggle|remove)\(\s*'([^']*)'/g)) {
    anota(m[1]);
  }
  // showToast(msg, 'success') acaba en `toast ${type} show`: el tipo se convierte
  // en clase (.toast.success, .toast.star...). Al quitar las interpolaciones de
  // arriba esos nombres seescapaban, así que una cadena entrecomillada que
  // coincides con una clase definida se cuenta como uso: si la clase existe en la
  // hoja y aparece como cadena en JS, se está usando como clase.
  for (const m of texto.matchAll(/'([a-z][a-z0-9-]*)'/gi)) {
    if (definidas.has(m[1])) usadas.add(m[1]);
  }
}

const huerfanas = [...usadas].filter((c) => !definidas.has(c)).sort();
const sinUsar = [...definidas].filter((c) => !usadas.has(c)).sort();

console.log(`clases usadas en el markup: ${usadas.size}`);
console.log(`clases con regla en la hoja: ${definidas.size}`);
console.log(`\nSIN REGLA (${huerfanas.length}):`);
huerfanas.forEach((c) => console.log('  .' + c));

// Informativo, no falla: muchas clases las alterna JS (dark, show, bought,
// added, pressing, supermarket-mode...) y este barrido estático no las ve.
console.log(`\nInformativo: definidas pero no detectadas en uso (${sinUsar.length}):`);
console.log('  ' + sinUsar.map((c) => '.' + c).join(' '));

if (huerfanas.length) {
  console.error('\nFallo: hay clases en el markup sin ninguna regla.');
  process.exit(1);
}
console.log('\nOK: toda clase del markup tiene regla.');
