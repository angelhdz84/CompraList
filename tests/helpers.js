/**
 * Utilidades compartidas por los specs.
 *
 * Viven aquí y no en un spec porque hay que aplicarlas ANTES de cada navegacion:
 * si un spec se olvida, la suite se vuelve intermitente (page.goto esperando al
 * CSS de Google Fonts hasta agotar el timeout de 20s).
 */

/** Salta el modal de onboarding sembrando el flag, para que no tape los tests. */
export async function skipOnboardingFlag(page) {
  await page.addInitScript(() => {
    localStorage.setItem('compralist_onboarding', 'true');
    localStorage.setItem('compralist_tour', 'true');
  });
}

/**
 * Corta la fuente de Google, la única petición externa de la app.
 *
 * index.html ya la carga sin bloquear el pintado (media="print" + onload), pero
 * `page.goto()` espera al evento load, que sí incluye la hoja de estilo. Sin esto
 * cada test se come la latencia de la red —o expira del todo sin conexión— y la
 * app va perfectamente bien.
 */
export async function bloquearFuentesRemotas(page) {
  await page.route(/fonts\.(googleapis|gstatic)\.com/, (route) => route.abort());
}
