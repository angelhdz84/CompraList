# CompraLIST Pro — agent notes

Single-page shopping-list app, **Spanish-language UI**. The shipped app is plain static files with **no build step**:
`index.html`, `css/style.css`, `js/app.js`, plus vendored `driver.js` / `tippy` / `popper` / `driver.css`. Editing those
three files is enough to ship a change; nothing is compiled or bundled.

Node was introduced **only for tooling** (tests + icon generation), never as an app dependency:

| Command | What it does |
| --- | --- |
| `npm run serve` | Static server on `http://127.0.0.1:4173` (`tests/server.mjs`, zero deps) |
| `npm test` | Playwright smoke suite (`tests/smoke.spec.js`) |
| `npx playwright test -g "coma decimal"` | Run one test by name |
| `npx playwright test --headed --debug` | Watch a single test in a real browser |
| `$env:PW_CHANNEL="chrome"; npx playwright test` | Run against the **system** Chrome (see below) |
| `npm run icons` | Regenerate `assets/icon-*.png` after editing the drawing |

First-time test setup needs network: `npm install && npx playwright install chromium`. Everything else works offline.
Verification of behaviour is the Playwright suite, not eyeballing the browser.

**`npx playwright install chromium` devuelve 403 en algunas regiones** (`cdn.playwright.dev` → *"This service is
not available in your location"*). No es un fallo del repo: pon `PW_CHANNEL=chrome` y la suite corre contra el
Chrome ya instalado, sin cambiar nada más. En Windows PowerShell es `$env:PW_CHANNEL="chrome"; npx playwright test`.

Corre la suite con `--workers=1` cuando diagnostiques. En paralelo se acumulan timeouts falsos (cada `page.goto`
espera a la fuente) y una caída de 12 a 35 pruebas en verde es puro ruido de concurrencia, no un fallo real.

### Tres trampas de la suite (las tres costaron una vuelta de tuerca)

- **No uses `check()` sobre las casillas de producto.** `check()` verifica que la casilla quedara marcada y, si no,
  reintenta. `saveData()` redibuja la lista y además manda el comprado al final, así que al reintentar pulsa el
  producto que ocupa esa posición: acaban marcados dos y el progreso se va a 100%. `force: true` **no** lo arregla
  (solo salta la comprobación de estabilidad, no la de "queda marcada"). Usa `markFirstBought(page)`, que hace un
  único `.click()`. Un clic real de usuario (verificado con CDP) genera un solo `change`: la app va bien.
- **Un `<input type=checkbox>` con `opacity: 0` encima de un `.checkbox-visual` no recibe el clic "visible".** Antes
  de interactuar, comprueba `document.elementFromPoint(...)` sobre el centro de la casilla: si devuelve otra cosa
  (p. ej. `DIV.onboarding-slide`) hay un modal encima y el clic se lo come.
- **La fuente de Google bloquea el renderizado.** Va con `media="print" onload="this.media='all'"` para que si no
  llega la app se dibuja igual, y la suite corta `fonts.googleapis.com` / `fonts.gstatic.com` con `page.route` en
  un `beforeEach` global para poder correr sin red.
- **Rellenar `#configDate` cierra el modal.** `changeDate()` hace `loadData()` y `closeModal()`: el campo se aplica
  solo. Pulsar "Guardar Cambios" después no encuentra el botón y expira. Usa `openCatBudgetSection(page)` para lo que
  vive en un `<details>` plegado: aunque el input tenga layout (`getBoundingClientRect` no es 0) está sin pintar y
  `page.fill()` expira igual.
- **No elijas elementos del historial por posición.** Va de más reciente a más antigua, así que `.last` es la lista
  más antigua. El `onclick` lleva la fecha: usa `.history-info[onclick*="2026-01-15"]`. Los tests que ascendían a
  instantáneas **acumulativas** y luego las aplanaban no podían pasar nunca: los ids preexistentes se repiten en todas.
- **Un `<button class="a" class="b">` pierde el segundo `class`.** El parser HTML se queda con el primero, en silencio:
  `bd-accent` y `bd-danger` no se aplicaban. Junta las clases en un solo atributo.
- **`skipOnboardingFlag()` y `bloquearFuentesRemotas()` viven en `tests/helpers.js`, no en un spec.** Si un spec se
  olvida de cortar la fuente, su `page.goto` espera al CSS de Google hasta agotar el timeout y parece un fallo de la
  app. Si un test falla al cargar pero pasa en aislamiento, sospecha de esto antes que del código.

## Wiring

- `index.html` is the only template. No framework, no bundler, no module system — all markup is static and all dynamic
  rows/modals are string `innerHTML` built in `js/app.js`.
- `js/app.js` is one flat script of **top-level functions**, loaded last in `<body>`. Every `onclick="..."` resolves
  against these globals, so new handlers must be top-level `function` (or `window.x =`), never a `const`/arrow in a
  block.
- **Product IDs must stay numeric** (`nextId()`), because they are interpolated *unquoted* into inline handlers
  (`onclick="openEdit(${product.id})"`). A UUID with dashes would produce a syntax error at click time.
- Mutating state goes through `saveData()` / `saveSuggestions()`, which persist **and** re-render. Don't hand-patch the
  DOM after mutating `state`.
- Modals share `.modal`; only `.active` shows, and `closeModal()` closes *all* of them. Escape closes modals too.
- Toasts: `showToast(msg, type, {label, onClick})`. The third argument turns it into an undo toast (7 s instead of 3 s)
  and registers `Ctrl/Cmd+Z` via `lastUndo`. All destructive actions use this instead of `confirm()`.
- `css/style.css` has **no media queries** — mobile-first, no desktop breakpoints. Colours come only from the custom
  properties in `:root` and `body.dark`; use `var(--…)`. Dark mode is `.dark` on `<body>`, supermarket mode is
  `.supermarket-mode` on `<body>` (~lines 714–772 control what it hides).

## Iconos: sprite SVG, cero emojis

- Todos los iconos viven en un **sprite inline** al principio de `<body>` de `index.html` (`<symbol id="i-*">`), no en un
  archivo externo. A propósito: los `<use>` se resuelven en el documento, así que no hay `fetch` y la app sigue
  funcionando abierta con `file://` y sin red.
- **No añadas emojis.** Para un icono nuevo: añade un `<symbol id="i-lo-que-sea">` al sprite y usa
  `icon('lo-que-sea')` desde JS o `<svg class="icon"><use href="#i-lo-que-sea"/></svg>` en el HTML.
- `icon(name, extraClass)` valida el nombre contra `/^[-a-z0-9]+$/i` y cae a `'tag'` si no existe el símbolo.
  `.icon` pinta con `fill:none; stroke:currentColor`, así que hereda el color del contexto sin CSS extra.
- **Los ids del sprite son ASCII, siempre.** La regex de `icon()` no acepta `ñ` ni otros acentos, así que un
  símbolo `id="i-pañuelos"` existe pero *nunca* se puede usar: `icon()` devuelve el `tag` en silencio y no falla
  nada. Se coló uno y solo se vio al comparar el sprite contra `CATEGORY_ICONS`; por eso hay tests que
  comprueban que ningún id lleva acentos y que todo símbolo no-de-UI está en el selector. Sin acentos:
  `platano`, `jamon`, `panuelos`, `refresco`.
- El sprite mezcla dos clases de icono y no deben confundirse: los **de acción** (los de los botones:
  `trash`, `pencil`, `plus`, `chevron`…) y los **de categoría** (los que ofrece el selector, ~200). Los de
  acción no van en `CATEGORY_ICONS` a propósito; cualquier otro símbolo sí, o es un dibujo inalcanzable.
- `showToast()` y `setModalTitle()` escriben **HTML** (no `textContent`) porque los mensajes llevan icono. Todo lo que
  se interpola ahí tiene que venir de `icon()` o de un `label` ya escapado.
- Si un icono debe ser relleno (la estrella), añade `.icon-fill` al `extraClass`.
- Un test comprueba que el documento renderizado no contiene ni un emoji. Ese test **no** puede llevar la regex
  pelada: `−` (U+2212) está en `\u2190-\u27BF` y es tipografía, no emoji — el selector de cantidad de cada
  producto lo usa como etiqueta de texto junto a `+`. Va en una lista blanca con nombre propio, `CHARS_PERMITIDOS`.
- Los glifos de fuente no valen como icono: el desplegable de límites por categoría usaba `content: '▸'`/`'▾'`
  y ahora es `#i-chevron`, que rota con `[open]`. Lo que se pueda, sprite.
- `.icon-picker` tiene `max-height: 232px` a propósito: con 200+ iconos el contenido ronda los 420px, y sin
  tope el desplegable empuja el modal fuera de pantalla. Va con `overscroll-behavior: contain` para que el
  scroll no se lleve la página y deje el botón pulsado fuera de la vista.

## Categorías gestionables

- `DEFAULT_CATEGORIES` es inmutable; lo editable es `state.categories` (persistido en `compralist_categories`).
  `categories` es el **lookup vivo** por id, reconstruido por `syncCategories()` — por eso todas las llamadas
  `categories[id].color` siguen funcionando aunque el usuario añada o borre categorías.
- `FALLBACK_CATEGORY` (`'otros'`) existe siempre y **se reubica al final tanto al cargar como al guardar**
  (`moveFallbackToEnd()`, llamada desde `loadCategories()` y `saveCategories()`). Antes solo lo fijaba la carga, así que
  crear una categoría la dejaba detrás de `otros` **y se guardaba así**: la UI se contradecía (aparecía en medio con sus
  flechas desactivadas) y el orden saltaba en el siguiente arranque. Si añades otra vía que toque `state.categories`, que
  pase por `saveCategories()`. Mantenerlo al final preserva que el valor por defecto del `<select>` sea "Alimentos".
- No se puede borrar ni renombrar `otros`: es el `return` seguro de `getCategory()` y `normalizeCategory()`.
- `deleteCategory()` reasigna a `otros` los productos, sugerencias y el presupuesto de la categoría eliminada, y es
  reversible con deshacer. Si añades otro sitio que referencie categorías, haz lo mismo o llamará a `normalizeCategory()`.
- Los `<select>` (`productCategory`, `editCategory`, `newSuggestionCategory`, `editSuggestionCategory`) y los campos de
  presupuesto por categoría (`#catBudgetFields`) **se rellenan desde JS**. No hardcodees opciones ni
  `configBudget_<id>` en el HTML; añade la clave a `CATEGORY_ICONS` / `CATEGORY_COLORS` si hace falta.
- `normalizeCategory(id)` es la puerta única para Referentializar: nunca devolvería `categories[undefined].color`.

## Mandatory helpers (do not bypass these)

Raw `parseFloat` and `categories[key]` were the source of the worst bugs; every value now goes through a normaliser.

- **`parseMoney(v)`** — locale-tolerant money. `type="number"` rejects `1,20` and returns `""`, so a Spanish user
  typing a comma used to silently save **0**. The price/budget inputs are therefore `type="text" inputmode="decimal"`.
  **Do not "tidy" them back to `type="number"`** — that silently reintroduces the data loss.
- **`parseQty(v)`** — integer ≥ 1, so no product can reach 0 or negative quantity.
- **`getCategory(key)`** / **`normalizeCategory(id)`** — never return `undefined`. `categories[unknown].icon` used to
  throw a `TypeError` mid-`forEach` and leave the list half-rendered with no way to recover.
- **`normalizeProduct` / `normalizeProducts` / `normalizeSuggestions` / `normalizeBudgets`** — sanitise anything
  untrusted (imported backups, old `localStorage`, date overflow like `2026-02-30`).
- **`safeParse(raw, fallback)`** — `JSON.parse` that logs and returns a fallback instead of throwing.
- **Category colours live only in `categories[cat].color`.** `renderStats()` used to redefine the palette inline, so
  changing `categories` silently left the donut chart stale.

## localStorage schema (the main landmine)

Keys are prefixed `compralist_`. Per-list keys embed the date: `compralist_<YYYY-MM-DD>` holding
`{ products, budget, budgets, date }`. **History is not a stored list** — `renderHistory()` discovers lists by scanning
`compralist_` keys, stripping the prefix, and keeping only those matching `LIST_KEY_RE` *and* `isValidDate()`.

- Non-date keys (`compralist_dark`, `compralist_onboarding`, `compralist_tour`, `compralist_suggestions`) share the
  namespace and survive only because that filter skips them.
- **`cleanInvalidData()` must only touch keys matching `LIST_KEY_RE`.** It previously deleted *any* `compralist_*` key
  whose suffix wasn't a date, which wiped the dark-mode preference, the onboarding/tour flags and all custom
  suggestions. Re-check that guard if you touch this function.
- **`quarantine(name, raw)`** moves an unparseable payload to `compralist_corrupt_<name>` (deliberately *not* date-shaped,
  so it never enters history and never gets cleaned) and deletes the bad key. Configuración lists them with download /
  discard buttons via `renderQuarantine()`.
- Build dates with `getLocalDate()` / `isValidDate()` / `formatDateLong()`, never `toISOString().slice(0,10)` — the
  latter is UTC and lands on the wrong day west of Greenwich, misfiling the list under the wrong key. Formatting always
  appends `T12:00:00` for the same reason.

## PWA

- `sw.js` is **cache-first for same-origin assets** and network-first for navigation. After deploying any change to
  `index.html` / `css` / `js`, **bump `CACHE_VERSION`** or returning users stay stuck on the old build. User data is in
  `localStorage`, not the cache, so the cache only holds the app shell.
- `registerServiceWorker()` no-ops on `file://` and on browsers without SW support — opening `index.html` directly still
  works.
- Icons: `assets/icon.svg` is hand-written; `assets/icon-*.png` are generated by `tools/make-icons.mjs` (own PNG encoder,
  `node:zlib` only). Edit the drawing in the script, then `npm run icons`.
- `manifest.webmanifest` declares `assets/icon-maskable-512.png` (logo at 62%, full-bleed background) separately from the
  rounded-corner `icon-512.png`.

## APK de Android (GitHub Actions + Capacitor)

El repo es **solo la web**. El APK se compila entero en `.github/workflows/apk.yml`, en el runner de GitHub:
en la PC solo hacen falta `git` y `gh`. `package.json` **no se toca** (Capacitor se invoca con `npx -y`) y
`android/`, `www/` y `capacitor.config.json` están en `.gitignore`.

- **El APK lleva la app dentro** y la sirve desde `https://localhost`, así que funciona sin conexión. Es la
  diferencia con TWA, que solo envuelve una URL. Un WebView a pelo con `file://` se descartó por riesgo: el
  `localStorage`, que es donde viven las listas, no es un origen de confianza ahí.
- **Firma con un keystore fijo de Secrets, nunca con el debug de Gradle.** El debug se regenera en cada runner,
  así que dos builds tendrían firmas distintas y el segundo APK no podría actualizar al primero instalado
  (habría que desinstalar y perder los datos). Con un keystore fijo todas las builds se actualizan entre sí.
- **PKCS12 ignora `-keypass`**: keytool avisa al crearlo y usa el `storepass`. Por eso `keystore.properties` lleva
  `keyPassword` igual a `storePassword`; poner el otro valor hace fallar el empaquetado con
  `KeytoolException: Get Key failed: Given final block not properly padded`.
- **JDK 21, no 17**: `capacitor-android` declara `sourceCompatibility = VERSION_21`.
- `android-actions/setup-android@v3` trae `packages: 'tools platform-tools'` por defecto y el paquete `tools`
  ya no existe: hay que pasar `packages:` explícito o el build muere con `Failed to find package 'tools'`.
- **El APK sale en `android/app/build/outputs/apk/release/`**, no en `android/build/...`: `android/` es la raíz de
  Gradle y `app/` el módulo.
- Se copia a `www/` **solo lo que la app usa en ejecución**. Usar el repo entero como `webDir` metería
  `node_modules`, `tests/` y `tools/` dentro del APK.
- El build verifica la firma con `apksigner` antes de publicar el artefacto, y hay una comprobación previa con
  `keytool -importkeystore` que lee la clave privada (keytool exige contraseñas de 6+ caracteres).

### Secrets del repo (los 4, no se pueden volver a leer)

`KEYSTORE_BASE64` (el keystore en base64), `KEYSTORE_PASSWORD`, `KEY_ALIAS` y `KEY_PASSWORD`.
**Copia local de seguridad: `apk/` en el propio repo** (keystore + claves + el APK firmado), y esa carpeta está
en `.gitignore`. Comprobado: sin esa regla, un `git add -A` subiendo el `.apk` de 3 MB y, sobre todo, el fichero
con las contraseñas en un repositorio **público**. Si se pierde el keystore ya no se puede actualizar la app
instalada: hay que desinstalar y se pierden los datos del `localStorage`.

Regenerar el keystore (si algún día hace falta, p. ej. al perderlo) exige `keytool`, que viene con un JDK: se
puede lanzar un workflow temporal que lo cree y lo deje como artefacto, como se hizo la primera vez.

## Tooling gotcha worth knowing

- The `edit` tool **cannot match `oldString` containing accented characters** in this repo (it fails on `Máximo`,
  `Configuración`, etc.), while new text with accents writes fine. Workarounds that work: anchor on ASCII-only substrings,
  or run a throwaway Node script that does UTF-8-safe `String.replace` and verify it reported every replacement. Don't
  assume a failed `edit` means the anchor is wrong — it may be the accent.
- **When patching with a script, `writeFileSync` after *every* replacement, not once at the end.** A throw in the middle of
  a substitution list silently discards every earlier "ok" (they only mutated the in-memory string). That happened once
  here and 14 successful substitutions were lost; the logs all said "ok". Don't trust a patch script's output — re-read
  the file (or count the markers) to confirm the writes landed.
- Don't template-literal the replacement strings: nested `${...}` and backticks in the generated code will either
  interpolate at script-build time or break the literal. Put the generated code in a separate file and read it.
- CSS audit: every class used in the markup **must** have a rule. 22 classes were in use with no rule at all
  (the whole Stats detail block, the suggestions table, the cleanup section), so those sections rendered unstyled.
  Run `npm run audit:css` (→ `tools/audit-css.mjs`).
- **`.empty` no tenía ninguna regla** y por eso el estado vacío salía descuadrado: el `<svg class="icon icon-xl">`
  queda *inline*, se pegaba a la izquierda, mientras el `<p>` sí estaba centrado (`margin: 0 auto`). Añade la regla
  al contenedor, no a los hijos. Ojo: un bloque al final del documento lo baja todo lo que hay encima, y `.bottom-nav`
  es `position: fixed`, así que el ritmo vertical de arriba es el que decide si el texto cae bajo la barra; engordar
  el `padding-bottom` solo lo estira hacia abajo y **no lo sube**. Para la holgura de la barra usa `--nav-clearance`.
- El chequeo de clases anterior comparaba con `css.includes('.' + clase)`, que es **subcadena**: `.empty` daba "true"
  porque existen `.empty-title` y `.empty-text`. Ese falso negativo dejó pasar el bug anterior, así que no vuelvas a
  esa comprobación: `tools/audit-css.mjs` extrae nombres exactos y además lee `className =` y `classList.add/toggle`.
- **`npm run audit:css` lista dos cosas y solo una es un fallo.** "SIN REGLA" (clase usada sin estilo) es error;
  "definidas pero no detectadas en uso" es informativa. Antes de borrar de la segunda lista, verifica una por una:
  `.star`, `.success`, `.warning` y `.danger` parecen muertas pero se usan vía `toast.className = \`toast ${type} show\``
  (`.toast.star`, `.toast.success`…). El auditor las reconoce contando como "uso" cualquier cadena entrecomillada que
  coincida con una clase definida, pero sigue habiendo que mirar.
- `.icon-fill` está sin usar **a propósito**: es la API documentada para iconos rellenos. Si la borras, la instrucción
  de esta misma tabla produciría estilos rotos.
- `.stat-empty` y `.suggestions-empty` se borraron porque `renderStats()` y `renderSuggestions()` no tienen rama de
  vacío. Ojo: eso significa que **si el usuario borra todas las sugerencias, la barra queda en blanco sin explicar
  nada**. Si algún día quieres un mensaje ahí, esa clase es el sitio.

## Conventions

- **All user-facing text, code comments and section banners are in Spanish.** Keep new strings and comments in Spanish;
  don't translate existing ones. (AGENTS.md and code identifiers stay in English.)
- Escape any user-supplied string that reaches `innerHTML` via `escapeHtml()`. The suggestion chips used to skip it.
- The suggestions list is capped at `MAX_SUGGESTIONS` (20; `defaultSuggestions` ships 14). The count is mirrored in four
  DOM ids (`suggestionsBadge`, `configBadge`, `configSuggestionsCount`, `managerBadge`) — `updateSuggestionsBadges()`
  writes all of them.
- `supermarketMode` is deliberately in-memory only and resets on reload.
- **The vendored `js/driver.js.iife.js` is not standard Driver.js.** It is `this.driver.js = function(D){...}({})`, and
  because that's an IIFE, the *result* is assigned — so `window.driver.js` is an **object**, the factory lives at
  `window.driver.js.driver(config)`, and there is **no global `Driver`**. The instance API is `setSteps()` / `drive()`
  (not `defineSteps()` / `start()`), and the config keys are `overlayOpacity` / `stagePadding` (not `opacity` / `padding`).
  The old code used all four wrong names, so `app.js` threw a `ReferenceError` at top level on every load and the tour never
  worked. Driver construction is wrapped in `try/catch` for that reason — keep it that way, and keep **every** top-level
  `let`/`const` **above** that block, or a failure there silently puts unrelated bindings in TDZ.
- `showToast(msg, type, action)` accepts the undo action either as a bare function or as `{label, onClick}`. Passing
  `type` but forgetting `action` silently drops the undo button — all destructive actions rely on it.
- `checkBudgetAlerts()` fires only inside narrow ratio windows (`>=1 && <1.01`, `>=0.8 && <0.81`), i.e. exactly on the
  threshold crossing — don't "fix" it into a continuous check. Per-category caps reuse the same windows.
- Su numerador es el **total de la lista** (`price * quantity` de todo lo añadido, compre o no), **no** lo gastado: la
  UI separa `PRESUPUESTO` de `GASTADO` y el aviso salta al plan de compra. Por eso solo tiene sentido llamarla desde
  acciones que cambian ese total (añadir, editar, cantidad, marcar) y no desde un guardado o una carga, que soltaría
  un toast sin que el usuario hiciera nada. Estaba llamada **solo** desde `toggleBought`, que no cambia el total: el
  aviso no saltaba al añadir el producto que cruza el umbral, solo al marcarlo después.
- Elegir importes para un test de umbrales es delicado por las ventanas estrechas: con presupuesto 10, `8.00` entra
  (0.80) y `9.00` se salta la ventana entera (0.90) sin avisar. Para "excedido" hace falta un total en `[10.00, 10.10)`.
- `switchView('list')` only sets the nav's active class; `stats`/`history` render into `#statsModal` rather than
  swapping the main view. Preserve this if you touch the bottom nav.
- The Driver.js tour (`startTour()`) targets hardcoded selectors (`#productName`, `.budget-bar`, `.bottom-nav`, …).
  Renaming or removing any of them silently breaks the tour.