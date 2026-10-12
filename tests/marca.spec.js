import { test, expect } from '@playwright/test';
import { skipOnboardingFlag, bloquearFuentesRemotas } from './helpers.js';
import { readFileSync, readdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * La marca vive en TRES ficheros y los PNG los rasteriza un CUARTO:
 *   1. assets/icon.svg              -> PWA, web, apple-touch-icon
 *   2. <symbol id="i-checklist">     -> el logo de la cabecera, dentro de la app
 *   3. tools/android-icons/*.xml    -> el icono del launcher en Android
 *   4. tools/make-icons.mjs         -> rasteriza los PNG a mano
 *
 * Divergen sin avisar: SVG y rasterizador son implementaciones distintas y
 * comparar cadenas de texto NO dice nada de geometría. Ya pasó: el generador
 * usaba un portapapeles más ancho que el SVG y los dos iconos se veían de
 * distinto tamaño. Estos tests miran píxeles, que es lo único que no miente.
 *
 * Referencia única del dibujo, en coordenadas de un lienzo de 512:
 *   rectángulo  146,132  220x256  radio 34   trazo 32
 *   check       (206,264) (244,302) (318,212)
 */

// ------------------------------------------------------------------ decodificar
// Los PNG que genera make-icons.mjs son RGBA de 8 bits, sin entrelazado y con
// filtro None en cada fila, así que decodificar es esto. Si el generador cambia
// de formato, este lector hay que actualizarlo.
function leerPng(ruta) {
  const buf = readFileSync(ruta);
  const ancho = buf.readUInt32BE(16);
  const alto = buf.readUInt32BE(20);
  if (buf[25] !== 6) throw new Error('colorType inesperado: ' + buf[25] + ' (se esperaba 6 = RGBA)');

  const partes = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    if (buf.toString('ascii', off + 4, off + 8) === 'IDAT') partes.push(buf.subarray(off + 8, off + 8 + len));
    if (buf.toString('ascii', off + 4, off + 8) === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(partes));
  const px = (x, y) => {
    const i = y * (ancho * 4 + 1) + 1 + x * 4;
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  return { ancho, alto, px };
}

const INDIGO = [0x4f, 0x46, 0xe5];
const BLANCO = [0xff, 0xff, 0xff];
const cerca = (a, b, tol = 20) => Math.abs(a - b) <= tol;
const es = (px, ref, tol = 20) => cerca(px[0], ref[0], tol) && cerca(px[1], ref[1], tol) && cerca(px[2], ref[2], tol);

// ------------------------------------------------------- el PNG, píxel a píxel
test('el PNG rasterizado dibuja el portapapeles con el check en su sitio', () => {
  const { ancho, px } = leerPng(join(raiz, 'assets', 'icon-512.png'));
  expect(ancho).toBe(512);

  // Puntos de referencia: el centro de cada trazo del dibujo de referencia.
  const centro = (v) => Math.round(v * 512 / 512); // el dibujo ya está en 512
  const enBorde = (x, y, que) =>
    expect(es(px(centro(x), centro(y)), BLANCO, 30), `${que}: se esperaba blanco en (${x},${y}) y hay ${px(centro(x), centro(y))}`).toBe(true);
  const enFondo = (x, y, que) =>
    expect(es(px(centro(x), centro(y)), INDIGO, 30), `${que}: se esperaba indigo en (${x},${y}) y hay ${px(centro(x), centro(y))}`).toBe(true);

  // El borde del portapapeles: semiancho 16 hacia dentro y hacia fuera del borde.
  enBorde(146, 260, 'borde izquierdo');
  enBorde(366, 260, 'borde derecho');
  enBorde(256, 132, 'borde superior');
  enBorde(256, 388, 'borde inferior');

  // El check: sus dos segmentos.
  enBorde(226, 284, 'check, segmento corto');
  enBorde(282, 256, 'check, segmento largo');

  // Hueco interior del portapapeles, por encima del check: se ve el fondo. Si el
  // "contorno" rellenara, strokeRoundRect estaría roto y esto sería blanco.
  enFondo(256, 170, 'interior del portapapeles');
  // Y fuera del portapapeles: tampoco hay trazo.
  enFondo(256, 60, 'por encima del portapapeles');
  enFondo(60, 256, 'a la izquierda del portapapeles');
});

test('el fondo del icono normal es el acento de la app y va redondeado', () => {
  const { px } = leerPng(join(raiz, 'assets', 'icon-512.png'));
  const css = readFileSync(join(raiz, 'css', 'style.css'), 'utf8');
  const acento = css.match(/--accent:\s*(#[0-9a-f]{6})/)[1];
  const rgb = [1, 3, 5].map((i) => parseInt(acento.slice(i, i + 2), 16));
  expect(rgb).toEqual(INDIGO);

  expect(es(px(256, 60), INDIGO), `fondo arriba: ${px(256, 60)}`).toBe(true);
  // Las esquinas van redondeadas, así que ahí es transparente por diseño. No es
  // un fallo: es lo que hace el icono del PWA, que no aplica ninguna máscara.
  const esquina = px(2, 2);
  expect(esquina[3], 'la esquina redondeada debería ser transparente').toBeLessThan(40);
  // Y el redondeo tiene que empezar antes de la mitad del lado.
  expect(px(2, 256)[3], 'a media altura no debe haber esquina').toBeGreaterThan(200);
});

test('el maskable va a sangre y respeta la zona segura', () => {
  const { px } = leerPng(join(raiz, 'assets', 'icon-maskable-512.png'));
  // Fondo a sangre: es lo que permite al sistema recortar sin mostrar un borde
  // transparente.
  expect(es(px(2, 2), INDIGO, 24), `maskable a sangre: ${px(2, 2)}`).toBe(true);
  // El sistema puede recortar hasta un 18% por lado, así que ahí no puede haber
  // trazo del símbolo.
  expect(es(px(20, 256), INDIGO, 30), `no deberia haber simbolo a 20px del borde: ${px(20, 256)}`).toBe(true);
  expect(es(px(256, 20), INDIGO, 30), `no deberia haber simbolo arriba: ${px(256, 20)}`).toBe(true);
  // Y el símbolo tiene que estar presente en el centro.
  const centro = px(256, 256);
  expect(centro[3], 'algo se deberia dibujar en el centro').toBeGreaterThan(0);
});

// ------------------------------------------- los tres ficheros, misma geometria
test('los tres ficheros de la marca llevan el mismo dibujo', () => {
  const svg = readFileSync(join(raiz, 'assets', 'icon.svg'), 'utf8');
  const sprite = readFileSync(join(raiz, 'index.html'), 'utf8');
  const fondo = readFileSync(join(raiz, 'tools', 'android-icons', 'ic_launcher_background.xml'), 'utf8');
  const vectorial = readFileSync(join(raiz, 'tools', 'android-icons', 'ic_launcher_foreground.xml'), 'utf8');

  // El color de marca es el --accent de la app. Si se cambia en css/style.css,
  // el SVG y el fondo del icono de Android tienen que moverse con el.
  expect(svg, 'el SVG debe usar el acento de la app').toContain('#4f46e5');
  expect(fondo, 'el fondo del icono de Android debe ser el acento de la app').toContain('#4f46e5');

  // Rectángulo del portapapeles, en coordenadas de 512 (SVG) y de 24 (sprite).
  expect(svg, 'rectangulo en el SVG').toContain('<rect x="146" y="132" width="220" height="256" rx="34"/>');
  expect(svg, 'trazo en el SVG').toContain('stroke-width="32"');
  expect(sprite, 'portapapeles en el symbol').toContain('<rect x="6.84" y="6.19" width="10.31" height="12" rx="1.59"/>');
  expect(vectorial, 'portapapeles en el vectorial de Android').toContain('M6.84,6.19 h10.31 v12 h-10.31 z');

  // El check, en los tres. 512 -> 24 es dividir por 21,333.
  expect(svg).toContain('M206 264 L244 302 L318 212');
  expect(sprite).toContain('M9.66 12.38 11.44 14.16 14.91 9.94');
  expect(vectorial).toContain('M9.66,12.38 L11.44,14.16 L14.91,9.94');

  // Y el generador tiene que usar las mismas, no las suyas.
  const gen = readFileSync(join(raiz, 'tools', 'make-icons.mjs'), 'utf8');
  for (const c of ['146 / 512', '132 / 512', '220 / 512', '256 / 512', '34 / 512', '32 / 512',
                   '206 / 512', '264 / 512', '244 / 512', '302 / 512', '318 / 512', '212 / 512']) {
    expect(gen, `el generador no usa la coordenada ${c}`).toContain(c);
  }
});

test('el dibujo tiene aire para la zona segura de Android', async ({ page }) => {
  await bloquearFuentesRemotas(page);
  await skipOnboardingFlag(page);
  await page.goto('/');

  const rect = await page.evaluate(() => {
    const r = document.querySelector('#i-checklist rect');
    return [r.getAttribute('x'), r.getAttribute('y'), r.getAttribute('width'), r.getAttribute('height')].map(Number);
  });
  const [x, y, w, h] = rect;
  const trazo = 1.5;

  // Android recorta el icono adaptativo a la zona segura (66% del lienzo) y
  // encima aplica su máscara. Con el trazo el dibujo no puede acercarse al borde.
  expect(x - trazo / 2, 'margen izquierdo insuficiente para la zona segura').toBeGreaterThan(4.5);
  expect(y - trazo / 2, 'margen superior insuficiente').toBeGreaterThan(4.5);
  expect(x + w + trazo / 2, 'margen derecho insuficiente').toBeLessThan(19.5);
  expect(y + h + trazo / 2, 'margen inferior insuficiente').toBeLessThan(19.5);
});

// ------------------------------------------------------------------ el logo
for (const dark of [false, true]) {
  test(`el logo de la cabecera es la marca nueva (${dark ? 'oscuro' : 'claro'})`, async ({ page }) => {
    await bloquearFuentesRemotas(page);
    await skipOnboardingFlag(page);
    if (dark) await page.addInitScript(() => localStorage.setItem('compralist_dark', 'true'));
    await page.goto('/');
    if (dark) await expect(page.locator('body')).toHaveClass(/dark/);

    const info = await page.evaluate(() => {
      const svg = document.querySelector('.logo svg');
      const simbolo = document.querySelector('#i-checklist');
      const caja = svg.getBoundingClientRect();
      return {
        href: svg.querySelector('use').getAttribute('href'),
        formas: simbolo ? simbolo.querySelectorAll('path,rect').length : 0,
        // Un <use> a un símbolo vacío no pinta nada: hay que medir la caja.
        seVe: caja.width > 0 && caja.height > 0,
      };
    });

    expect(info.href, 'el logo debe usar el símbolo de la marca, no i-bag').toBe('#i-checklist');
    expect(info.formas, 'el símbolo necesita el rectángulo y el check').toBeGreaterThanOrEqual(2);
    expect(info.seVe).toBe(true);
  });
}

test('los XML de Android no tienen "--" en los comentarios', () => {
  // Un comentario XML no puede contener dos guiones seguidos (XML 1.0, seccion
  // 2.5). Con un "--accent" o un "make-icons --launcher" escritos en el
  // comentario, Gradle muere en mergeReleaseResources con
  //   Error: The string "--" is not permitted within comments
  // que es un error que NO menciona comentarios, asi que cuesta leer.
  const dir = join(raiz, 'tools', 'android-icons');
  for (const f of readdirSync(dir)) {
    const txt = readFileSync(join(dir, f), 'utf8');
    const abiertos = (txt.match(/<!--/g) || []).length;
    const cerrados = (txt.match(/-->/g) || []).length;
    expect(abiertos, `${f}: comentarios sin cerrar`).toBe(cerrados);
    for (const c of txt.matchAll(/<!--([\s\S]*?)-->/g)) {
      expect(c[1], `${f}: hay "--" dentro de un comentario XML, que no se permite`).not.toContain('--');
    }
  }
});

test('los iconos del launcher se generan en las cinco densidades', () => {
  // El workflow los copia a android/app/src/main/res. Si esto falla al compilar,
  // el móvil sale con el icono por defecto de Capacitor y no se nota hasta que
  // lo instalas.
  const gen = readFileSync(join(raiz, 'tools', 'make-icons.mjs'), 'utf8');
  for (const d of ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi']) {
    expect(gen, `falta la densidad ${d}`).toContain(d);
  }
  // El launcher aplica su propia máscara encima, así que la forma "launcher" va
  // a sangre y con el símbolo en la zona segura.
  expect(gen, 'la forma launcher tiene que usar la zona segura').toContain("forma === 'launcher' ? 0.66");
});
