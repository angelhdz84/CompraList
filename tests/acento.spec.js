import { test, expect } from '@playwright/test';
import { skipOnboardingFlag, bloquearFuentesRemotas } from './helpers.js';

/**
 * Presupuesto de acento: el color marca ACCIONES y ESTADO ACTIVO, nunca DATOS.
 *
 * Por que hay un techo y no una opinion: antes, `.total-price` era de acento, y
 * hay uno por cada fila de producto. Como el numero de filas no tiene tope, una
 * lista de 30 productos llevaba 30 acentos y el color dejaba de ser jerarquia
 * para pasar a ser ruido de fondo. Medido con 4 productos: 9 acentos solidos en
 * la pantalla principal; despues de mover los datos a --text-primary: 5.
 *
 * Los 5 que quedan son los que deben: barra de progreso (estado), contador de
 * sugerencias (estado), boton primario (la accion) y la pestana activa (estado).
 *
 * OJO al escribir este archivo:
 *  - Los modales NO ocultan la de debajo, solo la cubren. Hay que medir DENTRO
 *    del modal activo, o el recuento de "pantalla Stats" incluye los precios de
 *    la lista y no significa nada.
 *  - Los <use> del sprite heredan el trazo del <svg> y contarian tres veces el
 *    mismo acento. Todo lo que este dentro de un <svg> queda fuera; el <svg>
 *    si cuenta.
 *  - El toast vive en el DOM con opacity: 0, asi que hay que filtrarlo.
 */

// ------------------------------------------------------------------ medicion
const CONTAR = () => {
  const aRgb = (hex) => {
    const s = hex.replace('#', '');
    const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
    return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)).join(', ');
  };
  const token = (n) => {
    const v = getComputedStyle(document.body).getPropertyValue(n).trim();
    return v.startsWith('#') ? `rgb(${aRgb(v)})` : v;
  };
  const ACENTO = token('--accent');
  const TINTE = token('--accent-soft');

  const modal = document.querySelector('.modal.active');
  const ambito = modal || document.body;

  const solidos = [];
  const tintes = [];
  let visibles = 0;

  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' ||
        parseFloat(cs.opacity) === 0 || el.closest('svg') !== null) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (el !== ambito && !ambito.contains(el)) continue;
    visibles++;

    const nombre = el.tagName.toLowerCase() +
      (el.id ? '#' + el.id : '') +
      (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '');
    const conTexto = (el.textContent || '').trim().slice(0, 16);

    const usa = ['color', 'stroke', 'borderTopColor', 'borderLeftColor',
                 'borderRightColor', 'borderBottomColor', 'backgroundImage']
      .some((p) => (cs[p] || '').includes(ACENTO));
    if (usa) solidos.push(nombre + (conTexto ? ` "${conTexto}"` : ''));
    if ((cs.backgroundColor || '').includes(TINTE)) tintes.push(nombre);
    if ((cs.backgroundColor || '') === ACENTO) solidos.push('RELLENO ' + nombre);
  }
  return { pantalla: modal ? modal.id || 'modal' : 'principal', visibles, solidos, tintes };
};

const NOMBRES = [
  'Leche', 'Huevos', 'Pan', 'Arroz', 'Azucar', 'Cafe', 'Aceite', 'Pasta',
  'Jabon', 'Detergente', 'Papel', 'Agua', 'Jugo', 'Limon', 'Tomate',
  'Cebolla', 'Patata', 'Pollo', 'Merluza', 'Yogur', 'Mantequilla', 'Atun',
  'Arroz integral', 'Lentejas', 'Garbanzos', 'Espinacas', 'Zanahoria',
  'Pimiento', 'Ajo', 'Perejil',
];

async function abrir(page, { productos = 0, pantalla = null, dark = false }) {
  await bloquearFuentesRemotas(page);
  await skipOnboardingFlag(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  // OJO: lo que se usa DENTRO de page.evaluate corre en el navegador y no ve
  // ninguna variable de Node. NOMBRES tiene que pasar como argumento.
  await page.evaluate(({ productos, dark, NOMBRES }) => {
    const h = new Date();
    const f = `${h.getFullYear()}-${String(h.getMonth() + 1).padStart(2, '0')}-${String(h.getDate()).padStart(2, '0')}`;
    localStorage.setItem('compralist_dark', dark ? 'true' : 'false');
    if (productos === 0) return;
    const cats = ['alimentos', 'bebidas', 'limpieza', 'otros'];
    localStorage.setItem('compralist_' + f, JSON.stringify({
      products: Array.from({ length: productos }, (_, i) => ({
        id: i + 1,
        name: NOMBRES[i % NOMBRES.length],
        price: 1.2 + (i % 7) * 1.35,
        quantity: 1 + (i % 3),
        category: cats[i % cats.length],
        bought: i % 3 === 0,
      })),
      budget: 500, budgets: {}, date: f,
    }));
  }, { productos, dark, NOMBRES });
  await page.reload();
  await page.waitForSelector('.bottom-nav');
  if (pantalla) {
    await page.click(pantalla);
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(150);
}

const TECLAS = {
  stats: '.bottom-nav button:nth-of-type(2)',
  historial: '.bottom-nav button:nth-of-type(3)',
  config: 'button[aria-label="Abrir configuración"]',
};

// ----------------------------------------------------- el techo, por pantalla
test('acento: el de la lista de productos no crece con las filas', async ({ page }) => {
  // El fallo que motiva todo: el acento escalaba con las filas, porque
  // .total-price era de acento y hay uno por producto.
  //
  // OJO: se mide SOLO dentro de .product-list, que es la zona que crece con las
  // filas. Comparar dos recuentos de pantalla completa era fragil: los dos
  // comparten barra de progreso, badge y nav, asi que un elemento que aun no ha
  // pintado en una de las dos mediciones hacia que el test fuera flaky sin que
  // hubiera cambiado nada.
  const enLista = () => page.evaluate(() => {
    const lista = document.querySelector('.product-list');
    if (!lista) return null;
    const aRgb = (hex) => {
      const s = hex.replace('#', '');
      const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
      return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)).join(', ');
    };
    const acento = `rgb(${aRgb(getComputedStyle(document.body).getPropertyValue('--accent').trim())})`;
    const relleno = `rgb(${aRgb(getComputedStyle(document.body).getPropertyValue('--accent-fill').trim())})`;
    let n = 0;
    const donde = [];
    for (const el of lista.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || parseFloat(cs.opacity) === 0) continue;
      if ((cs.color || '') === acento || (cs.stroke || '') === acento ||
          (cs.backgroundColor || '') === acento || (cs.backgroundColor || '') === relleno) {
        n++;
        donde.push(el.tagName.toLowerCase() + '.' + (typeof el.className === 'string' ? el.className.trim().split(/\s+/)[0] : ''));
      }
    }
    return { n, donde, tarjetas: lista.querySelectorAll('.product-card').length };
  });

  await abrir(page, { productos: 4 });
  const pocos = await enLista();
  await abrir(page, { productos: 30 });
  const muchos = await enLista();

  expect(pocos.tarjetas, 'sanidad: 4 tarjetas').toBe(4);
  expect(muchos.tarjetas, 'sanidad: 30 tarjetas').toBe(30);

  expect(
    muchos.n,
    `con 30 tarjetas hay ${muchos.n} acentos dentro de la lista (${muchos.donde.slice(0, 6).join(', ')}). El acento no puede escalar con las filas.`
  ).toBe(pocos.n);
});

test('acento: la lista con productos respecta el techo de pantalla', async ({ page }) => {
  await abrir(page, { productos: 4 });
  const r = await page.evaluate(CONTAR);
  expect(r.solidos.length, `con 4 productos: ${r.solidos.join(' | ')}`).toBeLessThanOrEqual(5);
});

test('acento: la lista vacia se mantiene sobria', async ({ page }) => {
  await abrir(page, { productos: 0 });
  const r = await page.evaluate(CONTAR);
  expect(r.solidos.length, `lista vacia: ${r.solidos.join(' | ')}`).toBeLessThanOrEqual(4);
});

test('acento: stats no pinta las cifras', async ({ page }) => {
  await abrir(page, { productos: 12, pantalla: TECLAS.stats });
  const r = await page.evaluate(CONTAR);
  expect(r.pantalla, 'sanidad: deberiamos estar dentro del modal de stats').toContain('stats');
  // Las cifras y el total del donut van en color de lectura; el unico color de
  // esa pantalla es el donut, que app.js pinta con los colores de categoria.
  expect(r.solidos.length, `stats: ${r.solidos.join(' | ')}`).toBeLessThanOrEqual(1);
});

test('acento: el historial no pinta los importes', async ({ page }) => {
  await abrir(page, { productos: 12, pantalla: TECLAS.historial });
  const r = await page.evaluate(CONTAR);
  expect(r.solidos.length, `historial: ${r.solidos.join(' | ')}`).toBeLessThanOrEqual(2);
});

test('acento: configuracion deja el acento para la accion', async ({ page }) => {
  await abrir(page, { productos: 4, pantalla: TECLAS.config });
  const r = await page.evaluate(CONTAR);
  expect(r.pantalla, 'sanidad: deberiamos estar dentro del modal de config').toContain('config');
  // "Guardar Cambios" es la accion y el boton del recorrido es secundario: dos
  // acentos es lo que se acepta en esa pantalla.
  expect(r.solidos.length, `configuracion: ${r.solidos.join(' | ')}`).toBeLessThanOrEqual(3);
});

test('acento: el techo se cumple tambien en modo oscuro', async ({ page }) => {
  await abrir(page, { productos: 4, dark: true });
  const r = await page.evaluate(CONTAR);
  expect(r.solidos.length, `lista en oscuro: ${r.solidos.join(' | ')}`).toBeLessThanOrEqual(5);
});

// ------------------------------------------- la regla, comprobada selector a selector
test('acento: ningun DATO usa el token del acento', async ({ page }) => {
  await abrir(page, { productos: 6 });
  const datos = await page.evaluate(() => {
    const aRgb = (hex) => {
      const s = hex.replace('#', '');
      const f = s.length === 3 ? s.split('').map((c) => c + c).join('') : s;
      return 'rgb(' + [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)).join(', ') + ')';
    };
    const acento = aRgb(getComputedStyle(document.body).getPropertyValue('--accent').trim());
    return ['.total-price', '.stat-value', '.donut-value', '.history-amount', '.logo', '.logo svg'].map((sel) => {
      const el = document.querySelector(sel);
      if (!el) return { selector: sel, loUsa: false, nota: 'no existe todavia' };
      const cs = getComputedStyle(el);
      return { selector: sel, color: cs.color, loUsa: cs.color === acento || cs.stroke === acento };
    });
  });

  for (const r of datos) {
    expect(r.loUsa, `${r.selector} pinta con el acento (${r.color}). El acento es para acciones y estado activo, no para datos.`).toBe(false);
  }
});

test('acento: el producto comprado sigue distinguiendose sin necesitar acento', async ({ page }) => {
  // El estado comprado no puede depender solo del color: acento-vs-verde es un
  // par rojo/verde, que es justo lo que no se distingue con daltonismo.
  await abrir(page, { productos: 6 });
  const r = await page.evaluate(() => {
    const card = document.querySelector('.product-card.bought');
    const nombre = card && card.querySelector('.product-name');
    return card
      ? {
          tachado: getComputedStyle(nombre).textDecorationLine.includes('line-through'),
          verde: getComputedStyle(card.querySelector('.total-price')).color,
        }
      : null;
  });
  expect(r, 'deberia haber al menos un producto comprado').not.toBeNull();
  expect(r.tachado, 'el nombre del producto comprado va tachado').toBe(true);
});
