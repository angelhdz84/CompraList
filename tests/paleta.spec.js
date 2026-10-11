import { test, expect } from '@playwright/test';
import { skipOnboardingFlag, bloquearFuentesRemotas } from './helpers.js';

/**
 * Paleta y jerarquía visual.
 *
 * Motivo de este archivo: los colores dejaron de ser "unos colores que verían
 * bien" y pasaron a estar MEDIDOS contra WCAG, y la barra de presupuesto pasó
 * de tres números idénticos a tener un dominante. Las dos cosas se pueden
 * romper sin que nada se queje: un color pasa a 3:1 y sigue viéndose "verde",
 * y un font-size cambia y nadie lo nota hasta que la pantalla pierde el punto
 * de mira. Aquí se fijan las dos.
 *
 * Contexto de los fallos que corrigió (medidos, no supuestos):
 *  - modo claro: aviso 2,15:1, éxito 2,54:1 y peligro 3,76:1 sobre blanco
 *  - modo oscuro: acento 3,27:1 sobre superficie
 *  - hover del botón primario: blanco sobre el acento claro, 2,98:1
 *
 * El motivo de que el acento no se pueda aclarar en oscuro está en
 * `verifyTokenRoles()` de más abajo: el mismo token se usaba como texto Y como
 * fondo con texto blanco encima, y son dos requisitos opuestos.
 */

const PREPARAR = async (page, ancho = 390, alto = 844) => {
  await bloquearFuentesRemotas(page);
  await skipOnboardingFlag(page);
  await page.setViewportSize({ width: ancho, height: alto });
  await page.goto('/');
};

// ---------------------------------------------------------------- contraste
// Se mide sobre el documento RENDERIZADO, no sobre el archivo: asi se comprueba
// la herencia real (body.dark gana sobre :root) y no lo que uno cree que wrote.
const MEDIR_CONTRASTE = () => {
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const parse = (valor) => {
    const s = valor.trim();
    if (s.startsWith('#')) {
      const h = s.slice(1);
      const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
    }
    const n = s.match(/[\d.]+/g).map(Number);
    return [n[0] / 255, n[1] / 255, n[2] / 255];
  };
  const lum = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const ratio = (a, b) => {
    const [x, y] = [lum(parse(a)), lum(parse(b))];
    return x > y ? (x + 0.05) / (y + 0.05) : (y + 0.05) / (x + 0.05);
  };
  // El valor de un token, resuelto en el elemento que lo hereda (body), para que
  // la redefinicion de body.dark se tenga en cuenta.
  const token = (nombre) => getComputedStyle(document.body).getPropertyValue(nombre).trim();

  return {
    superficie: token('--surface'),
    fondo: token('--bg'),
    ratios: {
      'texto principal sobre superficie': ratio(token('--text-primary'), token('--surface')),
      'texto secundario sobre superficie': ratio(token('--text-secondary'), token('--surface')),
      'texto principal sobre fondo': ratio(token('--text-primary'), token('--bg')),
      'acento como texto': ratio(token('--accent'), token('--surface')),
      'peligro como texto': ratio(token('--danger'), token('--surface')),
      'aviso como texto': ratio(token('--warning'), token('--surface')),
      'exito como texto': ratio(token('--success'), token('--surface')),
      'star como texto': ratio(token('--star'), token('--surface')),
      'blanco sobre relleno de acento': ratio('#ffffff', token('--accent-fill')),
      'blanco sobre hover de acento': ratio('#ffffff', token('--accent-fill-hover')),
      'blanco sobre relleno de peligro': ratio('#ffffff', token('--danger-fill')),
      'blanco sobre relleno de aviso': ratio('#ffffff', token('--warning-fill')),
      'blanco sobre relleno de exito': ratio('#ffffff', token('--success-fill')),
      'blanco sobre relleno de estrella': ratio('#ffffff', token('--star-fill')),
    },
    // Comparaciones que explican POR QUE hay dos tokens por color.
    acento: { texto: token('--accent'), relleno: token('--accent-fill') },
    semanticos: {
      peligro: token('--danger'),
      aviso: token('--warning'),
      exito: token('--success'),
    },
    star: { texto: token('--star'), relleno: token('--star-fill') },
  };
};

for (const modo of ['claro', 'oscuro']) {
  test(`paleta: los contrastes cumplen en modo ${modo}`, async ({ page }) => {
    await bloquearFuentesRemotas(page);
    await skipOnboardingFlag(page);
    if (modo === 'oscuro') {
      await page.addInitScript(() => localStorage.setItem('compralist_dark', 'true'));
    }
    await page.goto('/');
    if (modo === 'oscuro') await expect(page.locator('body')).toHaveClass(/dark/);

    const r = await page.evaluate(MEDIR_CONTRASTE);
    const Minimos = {
      'texto principal sobre superficie': 4.5,
      'texto secundario sobre superficie': 4.5,
      'texto principal sobre fondo': 4.5,
      'acento como texto': 4.5,
      'peligro como texto': 4.5,
      'aviso como texto': 4.5,
      'exito como texto': 4.5,
      'star como texto': 4.5,
      'blanco sobre relleno de acento': 4.5,
      'blanco sobre hover de acento': 4.5,
      'blanco sobre relleno de peligro': 4.5,
      'blanco sobre relleno de aviso': 4.5,
      'blanco sobre relleno de exito': 4.5,
      'blanco sobre relleno de estrella': 4.5,
    };

    const fallos = [];
    for (const [que, valor] of Object.entries(r.ratios)) {
      const min = Minimos[que];
      if (valor < min) fallos.push(`${modo}: "${que}" mide ${valor.toFixed(2)}:1 y necesita ${min}:1`);
    }
    expect(fallos, 'contrastes por debajo del minimo').toEqual([]);
  });
}

test('paleta: los roles de color estan separados', async ({ page }) => {
  await bloquearFuentesRemotas(page);
  await skipOnboardingFlag(page);
  await page.goto('/');
  const claro = await page.evaluate(MEDIR_CONTRASTE);

  await page.addInitScript(() => localStorage.setItem('compralist_dark', 'true'));
  await page.goto('/');
  await expect(page.locator('body')).toHaveClass(/dark/);
  const oscuro = await page.evaluate(MEDIR_CONTRASTE);

  // Un color tiene dos requisitos que NO pueden ser el mismo valor: legible
  // sobre superficie, y bastante oscuro para que el blanco se lea encima.
  // Aclarar el acento en oscuro arreglaba lo primero y rompia lo segundo.
  expect(
    oscuro.acento.texto,
    'en oscuro el acento de texto debe ser distinto del de relleno'
  ).not.toBe(oscuro.acento.relleno);

  // Y los semanticos se aclaran al pasar a oscuro: los valores de modo claro
  // darian ~3:1 sobre la superficie oscura.
  for (const k of ['peligro', 'aviso', 'exito']) {
    expect(
      oscuro.semanticos[k],
      `el ${k} de modo oscuro (#${oscuro.semanticos[k]}) debe ser distinto del de claro (#${claro.semanticos[k]})`
    ).not.toBe(claro.semanticos[k]);
  }

  // El caso de la estrella: valia #fbbf24, que daba 1,67:1 tanto como texto
  // sobre blanco como con el blanco encima. En oscuro se aclara y en claro se
  // oscurece, igual que el resto.
  expect(oscuro.star.texto, 'la estrella de texto se aclara en oscuro').not.toBe(claro.star.texto);
  expect(claro.star.relleno, 'el relleno de estrella NO se aclara en oscuro').toBe(oscuro.star.relleno);
});

// ------------------------------------------------------- jerarquía visual
const MEDIR_BARRA = () => {
  const leer = (id) => {
    const el = document.getElementById(id);
    const cs = getComputedStyle(el);
    const caja = el.parentElement.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return {
      px: parseFloat(cs.fontSize),
      peso: parseInt(cs.fontWeight, 10),
      anchoCaja: r.width,
      anchoTexto: el.scrollWidth,
      // El texto se sale de su modulo si sobresale de la caja que lo contiene.
      // OJO: con overflow: hidden el scrollWidth sigue dando el ancho completo
      // aunque se este recortando, asi quescrollWidth solo sirve para saber si
      // HAY recorte; para saber si se sale hay que comparar rects.
      saleDeLaCaja: r.right > caja.right + 1 || r.left < caja.left - 1,
      saleDelPantalla: r.right > window.innerWidth + 1 || r.left < -1,
      hayRecorte: el.scrollWidth > Math.ceil(r.width) + 1,
    };
  };
  const cajas = {};
  for (const b of document.querySelectorAll('.budget-item')) {
    const r = b.getBoundingClientRect();
    cajas[b.id || 'presupuesto'] = r.width;
  }
  return {
    presupuesto: leer('budgetDisplay'),
    gastado: leer('spentDisplay'),
    restante: leer('remainingDisplay'),
    anchos: cajas,
    // OJO: el scrollWidth de la pagina NO sirve aqui. A 320px la pagina ya
    // desborda de por si por .header-actions y por los .suggestion-chip que
    // desplazan, y es preexistente; comprobarlo haria fallar este test por
    // culpa de otros componentes. Lo que sí es responsabilidad de la barra es
    // no salirse de su propia caja ni del viewport.
    barraSeSale: (() => {
      const r = document.querySelector('.budget-bar').getBoundingClientRect();
      return r.right > window.innerWidth + 1 || r.left < -1;
    })(),
  };
};

const ponerImportes = (page, valores) =>
  page.evaluate((v) => {
    document.getElementById('remainingDisplay').textContent = v.restante;
    document.getElementById('budgetDisplay').textContent = v.presupuesto;
    document.getElementById('spentDisplay').textContent = v.gastado;
  }, valores);

test('barra de presupuesto: hay un numero dominante y los otros no compiten', async ({ page }) => {
  await PREPARAR(page);
  const b = await page.evaluate(MEDIR_BARRA);

  // Lo que se rompió antes: los tres con el mismo font-size y el mismo peso.
  expect(b.restante.px).not.toBe(b.presupuesto.px);
  expect(b.restante.px).not.toBe(b.gastado.px);
  expect(b.presupuesto.px).toBe(b.gastado.px);

  // El dominante tiene que destacar de verdad, no 1,05x.
  expect(
    b.restante.px / b.gastado.px,
    `RESTANTE deberia destacar sobre GASTADO (${(b.restante.px / b.gastado.px).toFixed(2)}x)`
  ).toBeGreaterThan(1.8);
  expect(b.restante.peso).toBeGreaterThan(b.gastado.peso);

  // Y tiene que ser el único con el ancho extra.
  expect(b.anchos.remainingBox).toBeGreaterThan(b.anchos.spentBox);
});

// Anchos y cifras que se usan: 320 es el minimo que mira tests/empty-state.spec.js
// y los importes largos son los que rompen el layout, no "$0.00".
const ANCHOS = [320, 360, 390, 430];
const IMPORTE_REALISTA = { restante: '$859.50', presupuesto: '$1200.00', gastado: '$340.50' };
const IMPORTE_LARGO = { restante: '$1.234,56', presupuesto: '$1.234,56', gastado: '$1.234,56' };

for (const ancho of ANCHOS) {
  test(`barra de presupuesto: importes normales caben a ${ancho}px`, async ({ page }) => {
    await PREPARAR(page, ancho);
    await ponerImportes(page, IMPORTE_REALISTA);
    const b = await page.evaluate(MEDIR_BARRA);

    for (const [nombre, v] of Object.entries({
      PRESUPUESTO: b.presupuesto,
      GASTADO: b.gastado,
      RESTANTE: b.restante,
    })) {
      expect(v.saleDeLaCaja, `${nombre} sobresale de su caja a ${ancho}px`).toBe(false);
      expect(v.saleDelPantalla, `${nombre} se sale de la pantalla a ${ancho}px`).toBe(false);
      // Con cifras normales NO hay motivo para recortar.
      expect(
        v.hayRecorte,
        `${nombre} se esta recortando a ${ancho}px ("${v.anchoTexto}px" en "${v.anchoCaja.toFixed(1)}px") y con cifras normales deberia caber entero`
      ).toBe(false);
    }
    expect(b.barraSeSale, `la barra se sale del viewport a ${ancho}px`).toBe(false);
  });

  test(`barra de presupuesto: importes largos no rompen a ${ancho}px`, async ({ page }) => {
    await PREPARAR(page, ancho);
    await ponerImportes(page, IMPORTE_LARGO);
    const b = await page.evaluate(MEDIR_BARRA);

    for (const [nombre, v] of Object.entries({
      PRESUPUESTO: b.presupuesto,
      GASTADO: b.gastado,
      RESTANTE: b.restante,
    })) {
      // Aqui si se admite el recorte, pero NUNCA salirse de la caja ni de la
      // pantalla: un importe que se va por la derecha es un bug, no un recorte.
      expect(v.saleDeLaCaja, `${nombre} sobresale de su caja a ${ancho}px (importe largo)`).toBe(false);
      expect(v.saleDelPantalla, `${nombre} se sale de la pantalla a ${ancho}px (importe largo)`).toBe(false);
    }
    expect(b.barraSeSale, `la barra se sale del viewport a ${ancho}px con importes largos`).toBe(false);
  });
}

test('barra de presupuesto: un importe absurdo se recorta pero no rompe la pantalla', async ({ page }) => {
  await PREPARAR(page, 320);
  // Este es el caso que se salia por la derecha y que motivations el clamp() y
  // el min-width: 0. Antes el texto se salia de la pantalla; ahora se recorta.
  await ponerImportes(page, { restante: '$1234557.89', presupuesto: '$1234567.89', gastado: '$10.00' });
  const b = await page.evaluate(MEDIR_BARRA);

  expect(b.restante.hayRecorte, 'con 11 cifras a 320px lo esperable es que se recorte').toBe(true);
  expect(b.restante.saleDeLaCaja, 'pero el recorte no puede salirse de su caja').toBe(false);
  expect(b.restante.saleDelPantalla, 'ni de la pantalla').toBe(false);
  expect(b.barraSeSale, 'y la barra no puede salirse del viewport').toBe(false);
});

test('barra de presupuesto: el estado de alerta sigue mandando en el color', async ({ page }) => {
  await PREPARAR(page);
  // El dominante no declara color a proposito, para que el color lo siga
  // poniendo .danger / .warning del box. Si alguien lo declara, el selector por
  // id gana y la alerta desaparece sin error visible en consola.
  const colores = await page.evaluate(() => {
    const num = document.getElementById('remainingDisplay');
    const cs = getComputedStyle(num);
    const token = (n) => getComputedStyle(document.body).getPropertyValue(n).trim();
    const aRgb = (hex) => {
      const h = hex.replace('#', '');
      const f = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
      return [0, 2, 4].map((i) => parseInt(f.slice(i, i + 2), 16)).join(', ');
    };
    return {
      display: cs.display,
      color: cs.color,
      // Los tokens, para no dejar cifras a fuego que rompen con cualquier retoque.
      colorPrimario: `rgb(${aRgb(token('--text-primary'))})`,
      colorPeligro: `rgb(${aRgb(token('--danger'))})`,
    };
  });
  expect(colores.display, 'sanidad: el bloque tiene que existir').not.toBe('none');
  expect(
    colores.color,
    'el numero dominante no debe declarar color: debe heredarlo del box para que la alerta llegue'
  ).toBe(colores.colorPrimario);

  const enAlerta = await page.evaluate(() => {
    const box = document.getElementById('remainingBox');
    // OJO: .budget-item tiene `transition: all 0.2s`, y getComputedStyle devuelve
    // el valor DE PARTIDA de una transición si se lee en el mismo tick. Sin
    // esto el test leería el color viejo y fallaría por culpa de la animación.
    box.style.transition = 'none';
    box.classList.add('danger');
    return getComputedStyle(document.getElementById('remainingDisplay')).color;
  });
  expect(
    enAlerta,
    'con .danger en el box, el numero tiene que heredar el rojo de peligro'
  ).toBe(colores.colorPeligro);
});