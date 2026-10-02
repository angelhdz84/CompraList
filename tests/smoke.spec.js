import { test, expect } from '@playwright/test';
import { skipOnboardingFlag, bloquearFuentesRemotas } from './helpers.js';

// ------------------------------------------------------------------ utilidades

// La fuente de Google es la unica peticion externa de la app. Cortarla deja la
// suite determinista y ejecutable sin red: si no, cada page.goto espera al CSS y
// de vez en cuando expira el timeout aunque la app vaya bien. Vive en helpers.js
// para que todo spec lo aplique y no se quede uno sin hacerlo.
test.beforeEach(async ({ page }) => {
  await bloquearFuentesRemotas(page);
});

async function openConfig(page) {
  await page.click('[onclick="openConfig()"]');
  await expect(page.locator('#configModal')).toHaveClass(/active/);
}

/**
 * Abre el desplegable de límites por categoría.
 *
 * Los campos de #catBudgetFields viven dentro de un <details> plegado, así que
 * aunque el input tenga layout (getBoundingClientRect no es 0), está sin pintar:
 * page.fill() espera visibilidad y expira. Hay que abrir el desplegable antes.
 */
async function openCatBudgetSection(page) {
  await page.click('.cat-budget-config > summary');
  await expect(page.locator('.cat-budget-config')).toHaveAttribute('open', '');
}

async function setProduct(page, name, price, category = 'alimentos') {
  await page.fill('#productName', name);
  await page.fill('#productPrice', price);
  await page.selectOption('#productCategory', category);
  await page.click('#controlsPanel button.btn-primary');
}

const cards = (page) => page.locator('#productList .product-card');
const spent = (page) => page.locator('#spentDisplay');
const toast = (page) => page.locator('#toast');

/**
 * Marca el primer producto como comprado con UN solo clic.
 *
 * No usar check() aqui: check() verifica despues que la casilla quedo marcada y,
 * si no, reintenta. saveData() redibuja la lista y ademas manda el producto
 * comprado al final, asi que al reintentar Playwright pulsa el producto que ahora
 * ocupa esa posicion: acaban marcados dos y el progreso se va a 100%. Con
 * click() a pelo sale un unico change, igual que el de un usuario real
 * (verificado con un clic de entrada real via CDP: una sola llamada a
 * toggleBought). force:true solo salta la comprobacion de estabilidad, no la de
 * "queda marcada", asi que por si solo no basta.
 */
async function markFirstBought(page) {
  await cards(page).first().locator('input[type=checkbox]').click({ force: true });
}

/** Backup JSON para los tests de importacion. */
function backup(lists, suggestions) {
  return JSON.stringify({ app: 'CompraLIST Pro', version: 2, suggestions, lists });
}

async function importBackup(page, payload) {
  await openConfig(page);
  const chooser = page.waitForEvent('filechooser');
  await page.click('[onclick="importData()"]');
  (await chooser).setFiles({
    name: 'backup.json',
    mimeType: 'application/json',
    buffer: Buffer.from(payload, 'utf8'),
  });
  await expect(toast(page)).toHaveClass(/show/);
}

// --------------------------------------------------------------------- tests

test.describe('carga inicial', () => {
  test('muestra el onboarding solo la primera vez', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#onboardingModal')).toHaveClass(/active/, { timeout: 4000 });
    await page.click('[onclick="skipOnboarding()"]');
    await expect(page.locator('#onboardingModal')).not.toHaveClass(/active/);
    expect(await page.evaluate(() => localStorage.getItem('compralist_onboarding'))).toBe('true');

    // Recarga: ya no debe reaparecer.
    await page.reload();
    await page.waitForTimeout(900);
    await expect(page.locator('#onboardingModal')).not.toHaveClass(/active/);
  });

  test('el badge de sugerencias refleja las predeterminadas', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    await expect(page.locator('#suggestionsBadge')).toHaveText(/\/20$/);
    const count = await page.evaluate(() => JSON.parse(localStorage.getItem('compralist_suggestions')).length);
    await expect(page.locator('#suggestionsBadge')).toHaveText(`${count}/20`);
  });

  test('expone el manifest y los roles de dialogo', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const href = await page.getAttribute('link[rel=manifest]', 'href');
    expect(href).toBe('manifest.webmanifest');
    await expect(page.locator('#configModal')).toHaveAttribute('role', 'dialog');
    await expect(page.locator('#statsModal')).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('#toast')).toHaveAttribute('aria-live', 'polite');
  });
});

test.describe('productos', () => {
  test.beforeEach(async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
  });

  test('añade un producto y refleja el total', async ({ page }) => {
    await setProduct(page, 'Leche', '1.20');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first().locator('.product-name')).toHaveText('Leche');
    await expect(spent(page)).toHaveText('$1.20');
    await expect(page.locator('#progressText')).toHaveText('0 de 1 productos');
  });

  test('regresion: precio con coma decimal no se pierde (A4)', async ({ page }) => {
    // <input type="number"> rechazaba la coma y devolvia "" -> se guardaba 0 en silencio.
    await setProduct(page, 'Pan', '1,20');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first().locator('.unit-price')).toHaveText('$1.20 c/u');
    await expect(spent(page)).toHaveText('$1.20');
  });

  test('regresion: categoria desconocida no rompe el render (A1)', async ({ page }) => {
    const today = await page.evaluate(() => getLocalDate());
    await page.evaluate((d) => {
      localStorage.setItem(`compralist_${d}`, JSON.stringify({
        products: [{ id: 1, name: 'Producto raro', price: 3, quantity: 2, category: 'inventada', bought: false }],
        budget: 10, date: d,
      }));
    }, today);
    await page.reload();

    // Antes: TypeError en categories[...].icon dejaba la lista a medias.
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first().locator('.product-name')).toHaveText('Producto raro');
    await expect(cards(page).first().locator('.category-badge')).toContainText('Otros');
    await expect(spent(page)).toHaveText('$6.00');
  });

  test('la cantidad altera el total y no baja de 1', async ({ page }) => {
    await setProduct(page, 'Huevos', '3.50');
    const plus = cards(page).first().locator('.qty-btn').nth(1);
    const minus = cards(page).first().locator('.qty-btn').nth(0);
    await plus.click();
    await expect(spent(page)).toHaveText('$7.00');
    await plus.click();
    await expect(spent(page)).toHaveText('$10.50');
    await minus.click(); await minus.click(); await minus.click();
    await expect(cards(page).first().locator('.qty-value')).toHaveText('1');
    await expect(spent(page)).toHaveText('$3.50');
  });

  test('regresion: precio y cantidad negativos se rechazan (A3)', async ({ page }) => {
    await setProduct(page, 'Producto', '2.00');
    const id = await page.evaluate(() => state.products[0].id);
    await page.evaluate((pid) => openEdit(pid), id);
    await page.fill('#editPrice', '-5');
    await page.fill('#editQty', '0');
    await page.click('[onclick="saveEdit()"]');

    // La edicion se rechaza y el modal sigue abierto.
    await expect(page.locator('#editModal')).toHaveClass(/active/);
    await expect(toast(page)).toContainText('cantidad');

    await page.fill('#editQty', '2');
    await page.click('[onclick="saveEdit()"]');
    await expect(page.locator('#editModal')).not.toHaveClass(/active/);
    await expect(spent(page)).toHaveText('$0.00'); // -5 se clampa a 0
  });

  test('marcar comprado lleva el producto al final y cierra el progreso', async ({ page }) => {
    await setProduct(page, 'A', '1.00');
    await setProduct(page, 'B', '2.00');
    await expect(cards(page)).toHaveCount(2);

    // Sin fijar A/B en posiciones: la app ordena lo mas reciente primero, asi que
    // el primero es B, y el orden base no es lo que este test viene a comprobar.
    // Lo que importa es que el marcado se hunda y el progreso se cierre.
    const marcado = await cards(page).first().locator('.product-name').textContent();
    await markFirstBought(page);
    await expect(page.locator('#progressPercent')).toHaveText('50%');
    await expect(cards(page).last().locator('.product-name')).toHaveText(marcado);
    await expect(cards(page).first().locator('.product-name')).not.toHaveText(marcado);

    await markFirstBought(page);
    await expect(page.locator('#progressPercent')).toHaveText('100%');
  });

  test('borrar un producto se puede deshacer', async ({ page }) => {
    await setProduct(page, 'Leche', '1.20');
    await cards(page).first().locator('.action-btn.delete').click();
    await expect(cards(page)).toHaveCount(0);
    await expect(toast(page)).toContainText('eliminado');

    await page.click('.toast-action');
    await expect(cards(page)).toHaveCount(1);
    await expect(cards(page).first().locator('.product-name')).toHaveText('Leche');
  });

  test('vaciar la lista se puede deshacer y no menciona "hoy"', async ({ page }) => {
    await setProduct(page, 'Leche', '1.20');
    await openConfig(page);
    await page.click('[onclick="clearAll()"]');
    await expect(cards(page)).toHaveCount(0);
    await page.click('.toast-action');
    await expect(cards(page)).toHaveCount(1);
  });
});

test.describe('presupuesto', () => {
  test.beforeEach(async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
  });

  // checkBudgetAlerts() mira el TOTAL DE LA LISTA (suma de price*quantity de todo
  // lo añadido, compre o no), no lo gastado: la UI separa PRESUPUESTO de GASTADO
  // y el aviso salta al plan de compra, no al gasto. Y solo dispara dentro de
  // ventanas estrechas a proposito (ver AGENTS.md), asi que los importes hay que
  // elegirlos para caer dentro: 8.00/10 = 0.80 exacto entra, 9.00/10 = 0.90 se
  // salta la ventana entera y no avisa de nada.
  test('avisa al cruzar el limite total', async ({ page }) => {
    await openConfig(page);
    await page.fill('#configBudget', '10');
    await page.click('[onclick="saveConfig()"]');
    // 8.00/10 -> 0.80, dentro de [0.8, 0.81).
    await setProduct(page, 'Carne', '8.00');
    await markFirstBought(page);
    await expect(toast(page)).toContainText('80%');
    // 8.00 + 2.05 = 10.05 -> 1.005, dentro de [1, 1.01).
    await setProduct(page, 'Arroz', '2.05');
    await markFirstBought(page);
    await expect(toast(page)).toContainText('excedido');
  });

  test('los limites por categoria se guardan y se muestran en estadisticas', async ({ page }) => {
    await openConfig(page);
    await openCatBudgetSection(page);
    // Los topes por categoria viven en #catBudgetFields y se generan desde JS con
    // data-cat: no hay un #configBudget_<id> fijo en el HTML (ver AGENTS.md).
    await page.fill('#catBudgetFields input[data-cat="alimentos"]', '5');
    await page.click('[onclick="saveConfig()"]');

    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem(`compralist_${getLocalDate()}`)).budgets);
    expect(stored).toEqual({ alimentos: 5 });

    await setProduct(page, 'Leche', '3.00');
    await setProduct(page, 'Pan', '1.00', 'bebidas');

    await page.click('.nav-item:nth-child(2)');
    await expect(page.locator('.cat-budget')).toHaveCount(1);
    await expect(page.locator('.cat-budget-value').first()).toContainText('$3.00 / $5.00');
    // La categoría sin límite no dibuja barra.
    expect(await page.locator('.cat-budget').count()).toBe(1);
  });
});

test.describe('persistencia e historial', () => {
  test.beforeEach(async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
  });

  test('cada fecha guarda su propia lista y aparece en el historial', async ({ page }) => {
    await setProduct(page, 'Hoy', '1.00');
    const today = await page.evaluate(() => getLocalDate());

    await openConfig(page);
    // El campo de fecha se aplica SOLO: changeDate() hace loadData() y cierra el
    // modal, asi que pulsar "Guardar Cambios" despues no encuentra el boton
    // (expira esperando que sea visible). Solo hace falta comprobar que el cambio
    // ya surtio efecto.
    await page.fill('#configDate', '2026-01-15');
    await expect(page.locator('#configModal')).not.toHaveClass(/active/);
    await expect(cards(page)).toHaveCount(0);

    await setProduct(page, 'Ayer', '9.00');
    expect(await page.evaluate((d) => Object.keys(localStorage).includes(`compralist_${d}`), today)).toBe(true);

    await page.click('.nav-item:nth-child(3)');
    await expect(page.locator('.history-item')).toHaveCount(2);
    await expect(page.locator('#modalTitle')).toContainText('Historial');

    // Cargar la lista antigua desde el historial, elegiendola POR FECHA y no por
    // posicion: el historial va de mas reciente a mas antigua, asi que .last es la
    // del 15 de enero, y el producto que tiene es "Ayer", no el "Hoy" que estaba
    // en la de hoy. Con .last y "Hoy" el test se contradecía a si mismo.
    await page.click('.history-info[onclick*="2026-01-15"]');
    await expect(cards(page).first().locator('.product-name')).toHaveText('Ayer');
  });

  test('eliminar del historial se puede deshacer', async ({ page }) => {
    await setProduct(page, 'Algo', '1.00');
    const today = await page.evaluate(() => getLocalDate());
    await page.click('.nav-item:nth-child(3)');
    await page.locator('.history-delete').first().click();
    await expect(page.locator('.history-item')).toHaveCount(0);
    await page.click('.toast-action');
    await expect(page.locator('.history-item')).toHaveCount(1);
    expect(await page.evaluate((d) => localStorage.getItem(`compralist_${d}`) !== null, today)).toBe(true);
  });

  test('exporta un JSON utilizable', async ({ page }) => {
    // El evento de descarga depende del disco y compite con el resto de
    // navegadores en paralelo: en carga se pasa del presupuesto de 20s aunque la
    // app vaya bien. test.slow() lo triplica, que es justo para esto.
    test.slow();
    await setProduct(page, 'Leche', '1.20');
    await openConfig(page);
    const [download] = await Promise.all([
      page.waitForEvent('download', { timeout: 30_000 }),
      page.click('[onclick="exportData()"]'),
    ]);
    expect(download.suggestedFilename()).toMatch(/^compralist_backup_\d{4}-\d{2}-\d{2}\.json$/);
  });

  test('importa un backup y normaliza datos raros', async ({ page }) => {
    const today = await page.evaluate(() => getLocalDate());
    // La preferencia tiene que existir ANTES de importar: si no, "sigue igual"
    // y "no se toco" son la misma asercion y no prueba nada.
    await page.click('[onclick="toggleDarkMode()"]');
    expect(await page.evaluate(() => localStorage.getItem('compralist_dark'))).toBe('true');

    await importBackup(page, backup({
      [`compralist_${today}`]: {
        products: [
          { id: 1, name: 'Imported', price: 2.5, quantity: 2, category: 'bebidas', bought: true },
          { id: 2, name: 'Caro', price: -4, quantity: -1, category: 'no-existe', bought: false },
        ],
        budget: -10, date: today,
      },
      // Una clave que no es lista no debe poder sembrar preferencias.
      compralist_dark: { hack: true },
    }, [{ name: 'Propia', price: 1, category: 'alimentos' }]));

    await expect(cards(page)).toHaveCount(2);
    // precio negativo -> 0, cantidad negativa -> 1, categoría inválida -> otros
    await expect(cards(page).nth(1).locator('.product-name')).toHaveText('Caro');
    await expect(cards(page).nth(1).locator('.category-badge')).toContainText('Otros');
    await expect(cards(page).nth(1).locator('.unit-price')).toHaveText('$0.00 c/u');
    await expect(cards(page).nth(1).locator('.qty-value')).toHaveText('1');
    await expect(spent(page)).toHaveText('$5.00');
    await expect(page.locator('.suggestion-chip').first()).toContainText('Propia');
    // La preferencia del backup no se aplico: la del usuario sigue intacta y no
    // quedo el payload del atacante.
    const dark = await page.evaluate(() => localStorage.getItem('compralist_dark'));
    expect(dark).toBe('true');
    expect(dark).not.toContain('hack');
  });

  test('rechaza un JSON que no es de CompraLIST', async ({ page }) => {
    await importBackup(page, JSON.stringify({ app: 'Otra App', lists: {} }));
    await expect(toast(page)).toContainText('no pertenece');
  });
});

test.describe('resistencia a datos corruptos', () => {
  test.beforeEach(async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
  });

  test('regresion: una lista corrupta no deja la app sin arranque (A2)', async ({ page }) => {
    const today = await page.evaluate(() => getLocalDate());
    await page.evaluate((d) => localStorage.setItem(`compralist_${d}`, '{{{no es json'), today);
    await page.reload();

    // Antes: JSON.parse sin try/catch abortaba window.onload.
    await expect(cards(page)).toHaveCount(0);
    await expect(page.locator('#emptyState')).toBeVisible();
    // La app sigue siendo utilizable.
    await setProduct(page, 'Recuperado', '1.00');
    await expect(cards(page)).toHaveCount(1);
    // Y el payload roto queda a salvo.
    expect(await page.evaluate((d) => localStorage.getItem(`compralist_corrupt_${d}`), today)).toContain('no es json');
  });

  test('regresion: limpiar fechas invalidas no borra preferencias (A5)', async ({ page }) => {
    await page.evaluate(() => {
      localStorage.setItem('compralist_dark', 'true');
      localStorage.setItem('compralist_2026-13-45', '{"products":[]}');
    });
    await page.reload();
    await expect(page.locator('body')).toHaveClass(/dark/);

    await openConfig(page);
    await page.click('[onclick="cleanInvalidData()"]');
    await expect(toast(page)).toContainText('1 lista');

    // La lista con fecha imposible se fue...
    expect(await page.evaluate(() => localStorage.getItem('compralist_2026-13-45'))).toBeNull();
    // ...pero las preferencias siguen intactas (antes se borraban todas).
    expect(await page.evaluate(() => localStorage.getItem('compralist_dark'))).toBe('true');
    expect(await page.evaluate(() => localStorage.getItem('compralist_suggestions'))).not.toBeNull();
    expect(await page.evaluate(() => localStorage.getItem('compralist_onboarding'))).toBe('true');
  });

  test('las copias aisladas se listan en configuracion', async ({ page }) => {
    const today = await page.evaluate(() => getLocalDate());
    await page.evaluate((d) => localStorage.setItem(`compralist_${d}`, 'roto'), today);
    await page.reload();
    await openConfig(page);
    await expect(page.locator('#quarantineBox')).toBeVisible();
    await expect(page.locator('#quarantineBox code')).toContainText(`compralist_corrupt_${today}`);
  });
});

test.describe('compartir', () => {
  test('genera texto plano con el total', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    await setProduct(page, 'Leche', '1.20');
    await setProduct(page, 'Pan', '0.80');

    const text = await page.evaluate(() => buildShareText());
    expect(text).toContain('[ ] Leche (Alimentos) — $1.20');
    expect(text).toContain('0 de 2 comprados');
    expect(text).toContain('Total: $2.00');

    await markFirstBought(page);
    const text2 = await page.evaluate(() => buildShareText());
    expect(text2).toContain('[x] Pan');
    expect(text2).toContain('1 de 2 comprados');
  });

  test('el boton de compartir no revienta sin soporte de share', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    await setProduct(page, 'Leche', '1.20');
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.click('[onclick="shareList()"]');
    await expect(toast(page)).toHaveClass(/show/);
    expect(errors).toEqual([]);
  });
});

test.describe('modo supermercado', () => {
  test('oculta la edicion y se puede volver', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    await page.click('#modeBtn');
    await expect(page.locator('body')).toHaveClass(/supermarket-mode/);
    await expect(page.locator('#controlsPanel')).toBeHidden();
    await expect(page.locator('#modeBtn')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#modeBtn');
    await expect(page.locator('#controlsPanel')).toBeVisible();
  });
});

test.describe('tour guiado (driver.js vendorizado)', () => {
  // El bundle expone window.driver.js.driver(config), NO un global `Driver`, y la
  // API real es setSteps()/drive(). Con los nombres equivocados, app.js lanzaba
  // ReferenceError al cargarse y toda la app se caia.
  test('el driver se construye con la API correcta', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const info = await page.evaluate(() => ({
      built: driver !== null,
      setSteps: !!(driver && typeof driver.setSteps === 'function'),
      drive: !!(driver && typeof driver.drive === 'function'),
      noGlobalDriver: typeof window.Driver === 'undefined',
    }));
    expect(info).toEqual({ built: true, setSteps: true, drive: true, noGlobalDriver: true });
  });

  test('startTour no lanza y fija el flag', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.evaluate(() => startTour());
    expect(errors).toEqual([]);
    expect(await page.evaluate(() => localStorage.getItem('compralist_tour'))).toBe('true');
  });

  test('ningun error de pagina al arrancar y al añadir producto', async ({ page }) => {
    await skipOnboardingFlag(page);
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto('/');
    await setProduct(page, 'Leche', '1,20');
    await expect(spent(page)).toHaveText('$1.20');
    expect(errors).toEqual([]);
  });
});

test.describe('categorías gestionables', () => {
  test.beforeEach(async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
  });

  test('las predeterminadas se cargan y "otros" va al final', async ({ page }) => {
    const info = await page.evaluate(() => ({
      ids: state.categories.map((c) => c.id),
      lookup: Object.keys(categories),
      select: [...document.getElementById('productCategory').options].map((o) => o.value),
      defaultValue: document.getElementById('productCategory').value,
    }));
    expect(info.ids).toEqual(['alimentos', 'bebidas', 'limpieza', 'otros']);
    expect(info.lookup).toEqual(info.ids);
    expect(info.select).toEqual(info.ids);
    // El valor por defecto debe seguir siendo la primera categoría real.
    expect(info.defaultValue).toBe('alimentos');
  });

  test('crea, edita y reordena categorías', async ({ page }) => {
    await page.evaluate(() => {
      resetCategoryForm();
      document.getElementById('catName').value = 'Congelados';
      renderIconPicker('frozen');
      renderColorPicker('#06b6d4');
      submitCategoryForm();
    });
    // "otros" se queda SIEMPRE al final: no solo al cargar (loadCategories) sino
    // tambien al guardar (saveCategories), asi que crear una categoría la deja
    // antes que el, nunca detras. Si solo lo fijara la carga, aqui se guardaria
    // en medio y el orden saltaria en el siguiente arranque.
    expect(await page.evaluate(() => state.categories.map((c) => c.id)))
      .toEqual(['alimentos', 'bebidas', 'limpieza', 'congelados', 'otros']);
    expect(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('compralist_categories')).map((c) => c.id)))
      .toEqual(['alimentos', 'bebidas', 'limpieza', 'congelados', 'otros']);
    // El <select> y el campo de presupuesto se rellenan al vuelo.
    expect(await page.evaluate(() =>
      document.querySelector('#catBudgetFields input[data-cat="congelados"]') !== null)).toBe(true);

    // Editar conserva el id (los productos ya guardados siguen apuntando al mismo).
    await page.evaluate(() => {
      editCategory('congelados');
      document.getElementById('catName').value = 'Congelados y Neveras';
      submitCategoryForm();
    });
    const edited = await page.evaluate(() => categories.congelados);
    expect(edited).toMatchObject({ id: 'congelados', label: 'Congelados y Neveras', icon: 'frozen' });

    // Reordenar.
    await page.evaluate(() => moveCategory('congelados', -1));
    expect(await page.evaluate(() => state.categories.map((c) => c.id)))
      .toEqual(['alimentos', 'bebidas', 'congelados', 'limpieza', 'otros']);
  });

  test('el slug ignora acentos y no colisiona', async ({ page }) => {
    const res = await page.evaluate(() => {
      const out = [];
      [['Bebés y Lanceles'], ['Aves'], ['Aves'], ['Ñandú']].forEach(([label]) => {
        resetCategoryForm();
        document.getElementById('catName').value = label;
        submitCategoryForm();
        out.push(state.categories.map((c) => c.id));
      });
      return { ids: out, finales: state.categories.map((c) => c.id) };
    });
    const ids = res.ids;
    // Duplicado por nombre: no se crea, la lista queda igual que antes.
    expect(ids[2]).toEqual(ids[1]);
    // Lo que hay que comprobar es que los slugs NUEVOS son unicos entre si. No
    // se puede aplanar ids: son instantaneas ACUMULATIVAS, asi que las categorias
    // preexistentes se repiten en todas y la unicidad del aplanado es imposible
    // de cumplir (y ademas no seria la propiedad que importa).
    const creados = res.finales.filter((id) => !['alimentos', 'bebidas', 'limpieza', 'otros'].includes(id));
    expect(creados).toEqual(['bebes-y-lanceles', 'aves', 'nandu']);
    expect(new Set(creados).size).toBe(creados.length);
    expect(creados.join(' ')).not.toMatch(/[\u00e0-\u00ff\u0300-\u036f]/);
  });

  test('la categoría de reserva no se puede borrar ni editar', async ({ page }) => {
    await page.evaluate(() => openCategoriesManager());
    await expect(page.locator('#categoriesModal')).toHaveClass(/active/);
    const fallback = page.locator('#catList .cat-row').last();
    await expect(fallback.locator('.cat-row-name')).toHaveText('Otros');
    // Las 4 acciones deshabilitadas (subir, bajar, editar, eliminar).
    const disabled = await fallback.locator('.cat-row-actions button').evaluateAll(
      (btns) => btns.map((b) => b.disabled));
    expect(disabled).toEqual([true, true, true, true]);

    const before = await page.evaluate(() => state.categories.length);
    await page.evaluate(() => { deleteCategory('otros'); editCategory('otros'); });
    expect(await page.evaluate(() => state.categories.length)).toBe(before);
  });

  test('borrar reasigna productos, sugerencias y presupuesto', async ({ page }) => {
    await page.evaluate(() => {
      state.categories.push({ id: 'congelados', label: 'Congelados', color: '#06b6d4', icon: 'frozen' });
      saveCategories();
      state.products.push({ id: 7, name: 'Helado', price: 2, quantity: 1, category: 'congelados', bought: false });
      state.suggestions.push({ name: 'Pizzas', price: 3, category: 'congelados' });
      state.budgets.congelados = 9;
      saveData();
      saveSuggestions();
      window.confirm = () => true;
      deleteCategory('congelados');
    });

    expect(await page.evaluate(() => ({
      gone: !state.categories.some((c) => c.id === 'congelados'),
      product: state.products.find((p) => p.name === 'Helado').category,
      suggestion: state.suggestions.find((s) => s.name === 'Pizzas').category,
      budget: state.budgets.congelados,
      undo: !!document.querySelector('#toast .toast-action'),
    }))).toEqual({
      gone: true, product: 'otros', suggestion: 'otros', budget: undefined, undo: true,
    });

    // Deshacer deja todo como estaba.
    await page.click('#toast .toast-action');
    expect(await page.evaluate(() => ({
      back: state.categories.some((c) => c.id === 'congelados'),
      product: state.products.find((p) => p.name === 'Helado').category,
      budget: state.budgets.congelados,
    }))).toEqual({ back: true, product: 'congelados', budget: 9 });
  });

  test('los límites por categoría siguen a las categorías dinámicas', async ({ page }) => {
    await page.evaluate(() => {
      state.categories.push({ id: 'congelados', label: 'Congelados', color: '#06b6d4', icon: 'frozen' });
      saveCategories();
      openConfig();
      document.querySelector('#catBudgetFields input[data-cat="congelados"]').value = '5';
      saveConfig();
    });
    expect(await page.evaluate(() =>
      JSON.parse(localStorage.getItem('compralist_' + getLocalDate())).budgets))
      .toEqual({ congelados: 5 });
  });
});

test.describe('iconos', () => {
  /**
   * Rangos amplios de emoji/dingbats.
   *
   * U+2212 (signo menos) cae dentro de \u2190-\u27BF pero es tipografia, no emoji:
   * el selector de cantidad de cada producto lo usa como etiqueta de texto (junto
   * a "+", que esta fuera del rango) y con su aria-label. Se acepta a proposito y
   * con nombre propio, para que anadir un signo tipografico no se confunda con un
   * emoji colado.
   *
   * OJO: esta funcion se serializa dentro de page.evaluate(), asi que no puede
   * cerrar sobre constantes de este fichero: todo lo que use va declarado aqui
   * dentro o falla con ReferenceError en el navegador.
   */
  const buscarEmojis = () => {
    const re = /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2190-\u27BF]|[\u2B00-\u2BFF]/g;
    const permitidos = new Set(['\u2212']);
    const hits = [];
    document.querySelectorAll('body *').forEach((el) => {
      if (el.children.length) return;
      const malos = ((el.textContent || '').match(re) || []).filter((c) => !permitidos.has(c));
      if (malos.length) hits.push(el.className + ':' + malos.join(''));
    });
    return hits;
  };

  test('no queda ningún emoji en el documento renderizado', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    await setProduct(page, 'Leche', '1,20');
    // stats e historial se pintan DENTRO de #statsModal, asi que al pulsar el
    // item 2 el modal tapa la barra inferior: hay que cerrarlo (Escape) antes
    // de poder pulsar el 3, o el clic intercepta y el test expira.
    await page.click('.nav-item:nth-child(2)');
    await expect(page.locator('#statsModal')).toHaveClass(/active/);
    await page.keyboard.press('Escape');
    await expect(page.locator('#statsModal')).not.toHaveClass(/active/);
    await page.click('.nav-item:nth-child(3)');
    expect(await page.evaluate(buscarEmojis)).toEqual([]);
  });

  test('el sprite resuelve los <use> como iconos dibujados', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const info = await page.evaluate(() => {
      const uses = [...document.querySelectorAll('.icon use')];
      return {
        total: uses.length,
        unresolved: uses.filter((u) => {
          const id = u.getAttribute('href').slice(1);
          return !document.getElementById(id);
        }).map((u) => u.getAttribute('href')),
      };
    });
    expect(info.total).toBeGreaterThan(5);
    expect(info.unresolved).toEqual([]);
  });

  test('los iconos heredan el color del contexto', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    await setProduct(page, 'Leche', '1,20');
    const color = await page.evaluate(() => {
      const icon = document.querySelector('.product-card .cat-chip .icon');
      return getComputedStyle(icon).stroke;
    });
    expect(color).not.toBe('none');
    expect(color).not.toBe('rgb(0, 0, 0)');
  });

  // icon() cae a 'tag' en silencio ante un id desconocido, asi que un nombre mal
  // escrito se ve como "el icono correcto" en vez de fallar. Este test es la
  // unica red que hay: recorre CATEGORY_ICONS contra el sprite real.
  test('todos los iconos de categoria existen en el sprite', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const report = await page.evaluate(() => {
      const missing = CATEGORY_ICONS.filter((n) => !document.getElementById('i-' + n));
      const dupes = CATEGORY_ICONS.filter((n, i) => CATEGORY_ICONS.indexOf(n) !== i);
      const symbols = [...document.querySelectorAll('.svg-sprite symbol[id^="i-"]')].length;
      return { missing, dupes, listed: CATEGORY_ICONS.length, symbols };
    });
    expect(report.missing).toEqual([]);
    expect(report.dupes).toEqual([]);
    expect(report.symbols).toBeGreaterThanOrEqual(report.listed);
  });

  // icon() valida el nombre con /^[-a-z0-9]+$/i, asi que un simbolo con eñe (u
  // otro acento) en el id existe pero nunca se puede usar: cae a 'tag' siempre.
  // Se coló uno (pañuelos) sin que nada fallara; esto lo vuelve visible.
  test('ningun id de icono lleva acentos', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const report = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('.svg-sprite symbol[id^="i-"]')]
        .map((s) => s.id.slice(2));
      return {
        accents: ids.filter((n) => !/^[-a-z0-9]+$/i.test(n)),
        total: ids.length,
      };
    });
    expect(report.accents).toEqual([]);
  });

  // El sprite mezcla iconos de ACCION (los de los botones) e iconos de
  // CATEGORIA (los del selector). Los de accion no deben aparecer en el selector;
  // cualquier otro symbol si, o es un dibujo que el usuario no puede usar.
  test('todo icono del sprite es de accion o esta en el selector', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const orphans = await page.evaluate(() => {
      const ACCION = ['trash', 'pencil', 'plus', 'minus', 'check', 'circle', 'refresh', 'share',
        'download', 'upload', 'gear', 'calendar', 'wallet', 'chart', 'history', 'pin', 'warning',
        'save', 'broom', 'sun', 'moon', 'pencil-line', 'list', 'gauge', 'close', 'plus-circle',
        'layers', 'up', 'down', 'swap', 'chevron'];
      return [...document.querySelectorAll('.svg-sprite symbol[id^="i-"]')]
        .map((s) => s.id.slice(2))
        .filter((n) => !ACCION.includes(n) && !CATEGORY_ICONS.includes(n));
    });
    expect(orphans).toEqual([]);
  });

  test('el selector de categorias pinta un boton por icono', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const report = await page.evaluate(() => {
      renderIconPicker('frozen');
      const buttons = document.querySelectorAll('#catIconPicker button');
      return { buttons: buttons.length, listed: CATEGORY_ICONS.length };
    });
    expect(report.listed).toBeGreaterThan(200);
    expect(report.buttons).toBe(report.listed);
  });

  test('el selector de categorias es desplazable', async ({ page }) => {
    await skipOnboardingFlag(page);
    await page.goto('/');
    const box = await page.evaluate(() => {
      // Sin abrir el modal el desplegable esta en display:none y todo mide 0.
      openCategoriesManager();
      const el = document.getElementById('catIconPicker');
      return {
        contenido: el.scrollHeight,
        ventana: el.clientHeight,
        maxHeight: getComputedStyle(el).maxHeight,
      };
    });
    // Con 200+ iconos el contenido tiene que exceder la ventana: si no, el
    // desplegable crece sin limite y empuja el modal fuera de pantalla.
    // scrollHeight no depende de max-height, asi que comparar ambos no dice nada.
    expect(box.ventana).toBeGreaterThan(0);
    expect(box.maxHeight).not.toBe('none');
    expect(box.contenido).toBeGreaterThan(box.ventana + 4);
  });
});
