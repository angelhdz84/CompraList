import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, copyFileSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ejecuta DE VERDAD los tres pasos del workflow sobre una estructura de recursos
 * que imita la de la plantilla de Capacitor, y comprueba el resultado.
 *
 * Existe porque el orden ya se rompio las dos veces y en las dos el build paso:
 *   - borrar despues de generar -> el APK sale con CERO iconos propios
 *   - borrar antes de generar   -> el simbolo es el logo de Capacitor
 * Ninguno de los dos se ve en la consola del workflow, y comprobarlo mirando el
 * APK publicado cuesta un ciclo entero de push y build de 2 minutos.
 *
 * El borrado esta en tools/purge-launcher-icons.mjs y no en un `find -delete`
 * del YAML precisamente para poder ejecutarlo aqui: `find` no existe en
 * Windows.
 */

// La estructura que deja la plantilla de Capacitor 7.4.3. Nombres de mentira,
// lo que importa es la forma: un ic_launcher* por densidad, los adaptive en
// anydpi-v26, y un ic_launcher_foreground con sufijo de version.
const PLANTILLA = [
  'mipmap-mdpi/ic_launcher.png',
  'mipmap-mdpi/ic_launcher_round.png',
  'mipmap-mdpi/ic_launcher_foreground.png',
  'mipmap-hdpi/ic_launcher.png',
  'mipmap-hdpi/ic_launcher_round.png',
  'mipmap-hdpi/ic_launcher_foreground.png',
  'mipmap-xhdpi/ic_launcher.png',
  'mipmap-xhdpi/ic_launcher_round.png',
  'mipmap-xhdpi/ic_launcher_foreground.png',
  'mipmap-xxhdpi/ic_launcher.png',
  'mipmap-xxhdpi/ic_launcher_round.png',
  'mipmap-xxhdpi/ic_launcher_foreground.png',
  'mipmap-xxxhdpi/ic_launcher.png',
  'mipmap-xxxhdpi/ic_launcher_round.png',
  'mipmap-xxxhdpi/ic_launcher_foreground.png',
  'mipmap-anydpi-v26/ic_launcher.xml',
  'mipmap-anydpi-v26/ic_launcher_round.xml',
  'values/ic_launcher_background.xml',
  'drawable/ic_launcher_background.xml',
  'drawable-v24/ic_launcher_foreground.xml',
];

const CON_PLANTA = '<vector android:viewportHeight="108"><path android:fillType="evenOdd"/></vector>';

function montarPlantilla() {
  const res = mkdtempSync(join(tmpdir(), 'res-'));
  for (const rel of PLANTILLA) {
    const ruta = join(res, rel.replace('/', process.platform === 'win32' ? '\\' : '/'));
    mkdirSync(dirname(ruta), { recursive: true });
    // Marcador reconocible: si sobrevive al purgado, es de la plantilla.
    writeFileSync(ruta, rel.includes('foreground') ? CON_PLANTA : '<!-- PLANTILLA -->');
  }
  // Algo que NO es un icono y no debe tocarse.
  mkdirSync(join(res, 'layout'), { recursive: true });
  writeFileSync(join(res, 'layout', 'activity_main.xml'), '<!-- NO TOCAR -->');
  return res;
}

function listar(res) {
  const out = [];
  const recorrer = (d, pre) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const r = pre ? pre + '/' + e.name : e.name;
      if (e.isDirectory()) recorrer(join(d, e.name), r);
      else out.push(r);
    }
  };
  recorrer(res, '');
  return out.sort();
}

const node = (script, ...args) => execFileSync(process.execPath, [join(raiz, script), ...args], { encoding: 'utf8' });

test('los tres pasos del workflow dejan solo los iconos propios', () => {
  const res = montarPlantilla();
  const sep = process.platform === 'win32' ? '\\' : '/';

  // 1) purgar lo de la plantilla
  node('tools/purge-launcher-icons.mjs', res);

  // 2) generar los PNG del launcher
  node('tools/make-icons.mjs', '--launcher', res);

  // 3) copiar los XML del icono adaptativo
  for (const f of ['ic_launcher_foreground.xml']) {
    copyFileSync(join(raiz, 'tools/android-icons', f), join(res, 'drawable', f));
  }
  copyFileSync(join(raiz, 'tools/android-icons', 'ic_launcher_background.xml'), join(res, 'values', 'ic_launcher_background.xml'));
  mkdirSync(join(res, 'mipmap-anydpi-v26'), { recursive: true });
  // El workflow copia el MISMO fichero como ic_launcher y como ic_launcher_round,
  // porque no hay diferencia entre ambos (la mascara la pone el launcher).
  for (const f of ['ic_launcher.xml', 'ic_launcher_round.xml']) {
    copyFileSync(join(raiz, 'tools/android-icons', 'ic_launcher.xml'), join(res, 'mipmap-anydpi-v26', f));
  }

  const finales = listar(res);

  // Los 10 PNG del launcher: cinco densidades por los dos nombres.
  for (const d of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) {
    for (const n of ['ic_launcher.png', 'ic_launcher_round.png']) {
      expect(finales, `falta mipmap-${d}/${n}`).toContain(`mipmap-${d}${sep === '/' ? '/' : '/'}${n}`.replace(/\\/g, '/'));
    }
  }

  // Y los XML del adaptive icon.
  expect(finales).toContain('mipmap-anydpi-v26/ic_launcher.xml');
  expect(finales).toContain('mipmap-anydpi-v26/ic_launcher_round.xml');
  expect(finales).toContain('drawable/ic_launcher_foreground.xml');
  expect(finales).toContain('values/ic_launcher_background.xml');

  // NADA de la plantilla sobrevive. El drawable-v24 es el que mas se cuela,
  // porque un sufijo de version gana a drawable/ en API 24+.
  const supervivientes = finales.filter((f) => f.startsWith('drawable-v24/'));
  expect(supervivientes, 'el foreground de la plantilla seguia ahi y habria ganado en API 24+').toEqual([]);
  for (const f of finales) {
    expect(f, `${f} es de la plantilla y no deberia estar`).not.toContain('ic_launcher_foreground.png');
  }

  // Y el purgado no toca lo que no es un icono.
  expect(finales).toContain('layout/activity_main.xml');
});

test('si se purga DESPUES de generar, el APK se queda sin iconos', () => {
  // El otro orden. Se documenta porque es el que dio un APK con cero iconos
  // propios y el build en verde: el purgado se lleva por delante los PNG.
  const res = montarPlantilla();
  node('tools/make-icons.mjs', '--launcher', res);
  // 15, no 10: los 10 del generador mas los 5 ic_launcher_foreground.png que deja
  // la plantilla, uno por densidad.
  const antes = listar(res).filter((f) => f.endsWith('.png')).length;
  expect(antes, 'sanidad: 10 del generador + 5 foreground de la plantilla').toBe(15);

  node('tools/purge-launcher-icons.mjs', res);
  const despues = listar(res).filter((f) => f.endsWith('.png')).length;
  expect(despues, 'por eso el purgado tiene que ir ANTES de generar').toBe(0);
});

test('el workflow purga antes de generar y antes de copiar', () => {
  const yml = readFileSync(join(raiz, '.github', 'workflows', 'apk.yml'), 'utf8');
  const purgar = yml.search(/purge-launcher-icons\.mjs/);
  const generar = yml.search(/make-icons\.mjs --launcher/);
  const copiar = yml.search(/cp tools\/android-icons\/ic_launcher_foreground\.xml/);
  expect(purgar, 'no se encuentra el purgado').toBeGreaterThan(-1);
  expect(generar, 'no se encuentra la generacion').toBeGreaterThan(-1);
  expect(copiar, 'no se encuentra el cp').toBeGreaterThan(-1);
  expect(purgar, 'el purgado tiene que ir ANTES de generar').toBeLessThan(generar);
  expect(purgar, 'el purgado tiene que ir ANTES del cp').toBeLessThan(copiar);
});
