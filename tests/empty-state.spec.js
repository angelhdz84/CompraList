import { test, expect } from '@playwright/test';
import { skipOnboardingFlag, bloquearFuentesRemotas } from './helpers.js';

/**
 * Estado vacío de la lista.
 *
 * La caja `.empty` NO TENÍA NINGUNA REGLA en css/style.css (solo existían
 * `.empty-title` y `.empty-text`), así que era un div normal: el <svg
 * class="icon icon-xl"> quedaba inline pegado a la izquierda mientras el <p> sí
 * estaba centrado, y el párrafo caía justo bajo la barra inferior fija, que se lo
 * tachaba a medias.
 *
 * Aquí se fijan las dos propiedades que lo hacen legible:
 *  1. centrado real (icono, título y párrafo en el mismo eje, en el centro)
 *  2. que nada de su texto quede bajo la barra inferior
 *
 * OJO al escribir estos tests: el desbordamiento horizontal a 320px que existe en
 * la página (`.header-actions`, los `.suggestion-chip` que desplazan) es
 * PREEEXISTENTE y no tiene nada que ver con `.empty`, así que no se comprueba
 * scrollWidth: se comprueba que el propio bloque no se sale.
 */

const VIEWPORTS = [
  { name: 'movil pequeno', width: 320, height: 568 },
  { name: 'movil normal', width: 390, height: 844 },
  { name: 'movil alto', width: 430, height: 932 },
  { name: 'pantalla muy corta', width: 360, height: 480 },
  { name: 'tablet', width: 768, height: 1024 },
];

const MEDIR = () => {
  const el = document.getElementById('emptyState');
  const centre = (r) => r.left + r.width / 2;
  const leer = () => {
    const icon = el.querySelector('svg').getBoundingClientRect();
    const title = el.querySelector('.empty-title').getBoundingClientRect();
    const text = el.querySelector('.empty-text').getBoundingClientRect();
    const nav = document.querySelector('.bottom-nav').getBoundingClientRect();
    return {
      icon, title, text, nav,
      holguraNav: nav.top - text.bottom,   // > 0 = el texto queda por encima de la barra
      visibleEnCarga: text.top < window.innerHeight && text.bottom > 0,
      dentroDelViewport: text.left >= -1 && text.right <= window.innerWidth + 1,
      scrollY: window.scrollY,
    };
  };
  const cs = getComputedStyle(el);
  const carga = leer();
  // Y una segunda medición con el bloque centrado en pantalla, que es la otra
  // mitad del contrato: si la pila de arriba es alta, el bloque puede quedar bajo
  // el pliegue, pero nunca inaccesible.
  el.scrollIntoView({ block: 'center' });
  const centrado = leer();
  return {
    visible: !el.classList.contains('hidden'),
    display: cs.display,
    align: cs.alignItems,
    textAlign: cs.textAlign,
    vw: window.innerWidth,
    centroViewport: window.innerWidth / 2,
    centroIcon: centre(carga.icon),
    centroTitle: centre(carga.title),
    centroText: centre(carga.text),
    holguraCarga: carga.holguraNav,
    visibleEnCarga: carga.visibleEnCarga,
    dentroDelViewport: carga.dentroDelViewport,
    holguraCentrado: centrado.holguraNav,
  };
};

for (const vp of VIEWPORTS) {
  test(`el estado vacío se centra y no queda bajo la barra: ${vp.name}`, async ({ page }) => {
    await bloquearFuentesRemotas(page);
    await skipOnboardingFlag(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');

    const info = await page.evaluate(MEDIR);

    expect(info.visible, 'el estado vacío debería mostrarse sin productos').toBe(true);
    expect(info.display).toBe('flex');
    expect(info.align).toBe('center');
    expect(info.textAlign).toBe('center');

    // Icono, título y párrafo en el MISMO eje y centrados en el viewport.
    expect(Math.abs(info.centroIcon - info.centroViewport)).toBeLessThanOrEqual(1);
    expect(Math.abs(info.centroTitle - info.centroIcon)).toBeLessThanOrEqual(1);
    expect(Math.abs(info.centroText - info.centroIcon)).toBeLessThanOrEqual(1);

    // El bloque no se sale de lado (el scrollWidth de la página, no: ese
    // desbordamiento a 320px es preexistente y de otros componentes).
    expect(info.dentroDelViewport).toBe(true);

    // Si se ve al cargar, nada de su texto bajo la barra inferior fija.
    if (info.visibleEnCarga) {
      expect(info.holguraCarga).toBeGreaterThanOrEqual(0);
    }
    // Y al desplazarse tiene que verse entero, siempre.
    expect(info.holguraCentrado).toBeGreaterThanOrEqual(0);
  });
}
