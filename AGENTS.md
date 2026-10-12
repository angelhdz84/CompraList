# CompraLIST Pro — agent notes

Single-page shopping-list app, **Spanish-language UI**. The shipped app is plain static files with **no build step**:
`index.html`, `css/style.css`, `js/app.js`, plus vendored `driver.js` / `tippy` / `popper` / `driver.css`. Editing those
three files is enough to ship a change; nothing is compiled or bundled.

Node was introduced **only for tooling** (tests + icon generation), never as an app dependency:

| Command | What it does |
| --- | --- |
| `npm run serve` | Static server on `http://127.0.0.1:4173` (`tests/server.mjs`, zero deps) |
| `npm test` | Playwright suite (`tests/smoke.spec.js`, `tests/paleta.spec.js`, `tests/acento.spec.js`, `tests/marca.spec.js`, `tests/empty-state.spec.js`) |
| `npx playwright test -g "coma decimal"` | Run one test by name |
| `npx playwright test --headed --debug` | Watch a single test in a real browser |
| `$env:PW_CHANNEL="chrome"; npx playwright test` | Run against the **system** Chrome (see below) |
| `npm run icons` | Regenerate `assets/icon-*.png` after editing the drawing |
| `npm run icons -- --launcher android/app/src/main/res` | The 10 PNG for the Android launcher (the workflow does this) |
| `npm run audit:css` | Flag classes used in the markup with no CSS rule |

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

### La marca vive en CUATRO ficheros, y tienen que decir lo mismo

Cambiar uno sin los otros es como mínimo un icono raro y como máximo un móvil con el logo de
Capacitor. Son:

| Dónde | Qué es | Quién lo usa |
| --- | --- | --- |
| `assets/icon.svg` | el fuente, viewBox 512 | web, PWA, apple-touch-icon |
| `tools/make-icons.mjs` → `assets/icon-*.png` | **los rasteriza a mano** | PWA (192, 512, maskable) |
| `<symbol id="i-checklist">` | el mismo dibujo en viewBox 24 | el **logo de la cabecera**, dentro de la app |
| `tools/android-icons/*.xml` | el mismo dibujo en vectorial | el **icono del launcher** en Android |

Dibujo de referencia, en coordenadas de un lienzo de 512: rectángulo `146,132 220x256 rx34`, trazo
`32`, check en `(206,264) (244,302) (318,212)`.

**`tests/marca.spec.js` es el guardián, y mira PÍXELES, no cadenas.** Ya pasó: comparar el texto de
los ficheros daba "ok" mientras el generador usaba un portapapeles más ancho que el SVG
(`0,211-0,789` frente a `0,285-0,715`), así que los dos iconos se veían de distinto tamaño y nadie lo
notaba. El test decodifica el PNG y comprueba píxeles concretos de los cuatro bordes y de los dos
segmentos del check. Si cambias la geometría, cambia los cuatro ficheros y corre esa spec.

### El icono del launcher de Android NO es `assets/icon.svg`

Es el punto que más sorprende y el que más cuesta: los iconos de la pantalla de inicio son los
`res/mipmap-*` de `android/`, que **vienen de la plantilla de Capacitor con el icono por defecto**.
Aunque `android/` esté en `.gitignore` y el repo sea "solo web", el workflow genera y copia los iconos
antes de compilar:

- `node tools/make-icons.mjs --launcher android/app/src/main/res` escribe los 10 PNG (cinco
  densidades × `ic_launcher` y `ic_launcher_round`) en forma **launcher**: fondo **a sangre** y símbolo
  al 66%. A sangre porque el launcher aplica su propia máscara encima y si el fondo también fuese
  redondeado se vería doble redondeo. Los ficheros XML del icono adaptativo (API 26+) se copian desde
  `tools/android-icons/`.
- Los XML viven en `tools/android-icons/` y **no** en `assets/` a propósito: `assets/` se copia entero
  a `www/` para el escenario web, y tres XML que la web no usa no tienen por qué acabar en el APK.
- **Nada de heredocs en el `run:` del YAML.** Bloques `cat > f <<'EOF'` dentro de un escalar literal
  son frágiles y hay que mantener el dibujo sincronizado en dos sitios. Los ficheros se versionan y
  el workflow solo hace `cp`.
- El color de fondo del icono de Android (`#4f46e5`) es el `--accent` de `css/style.css`. Si cambias
  el acento, cambia también `tools/android-icons/ic_launcher_background.xml`.
- **Un comentario XML no puede contener `--`** (XML 1.0, sección 2.5). Escribir `--accent` o
  `make-icons --launcher` dentro de un comentario de esos XML tumba el build en `mergeReleaseResources`
  con `Error: The string "--" is not permitted within comments`: un error que **no menciona los
  comentarios**, así que cuesta leer. Costó un build. `tests/marca.spec.js` lo comprueba.
  En YAML y en CSS los comentarios sí admiten `--`.
- **Hay que BORRAR los iconos que trae la plantilla antes de copiar los nuestros.** La de Capacitor
  7.4.3 trae `mipmap-*dpi/ic_launcher*.png`, `mipmap-anydpi-v26/ic_launcher*.xml`,
  `values/ic_launcher_background.xml`, `drawable/ic_launcher_background.xml` y, la que más se cuela,
  **`drawable-v24/ic_launcher_foreground.xml`**: una carpeta con sufijo de versión tiene **prioridad
  sobre `drawable/` en API 24+**, así que sin borrarla el fondo acaba siendo el nuestro pero el
  símbolo el logo de Capacitor. El build pasa igual y solo se ve en el móvil. El workflow hace
  `find android/app/src/main/res -name 'ic_launcher*' -delete` antes de copiar.
  Se detectó extrayendo el APK compilado y buscando el `pathData` del vectorial dentro.
- **Para comprobar si un PNG llegó al APK, mira el CONTENIDO, no el hash.** AAPT2 **re-codifica** los
  PNG al empaquetarlos (crunch) y convierte varios a **indexed** (`colorType 3`), así que los bytes
  dejan de coincidir. Comparar hashes dio 4 de 10 falsos negativos y parecía que había entrado
  la mitad. Lo que funciona es decodificar (los cinco filtros de línea y los modos 0/2/3/4/6, con
  paleta) y mirar el color del fondo y la proporción de blanco. Un lector que solo sepa RGB
  descarta los indexed en silencio y da la misma conclusión falsa.

### Los iconos de categoría (los del sprite)

- Todos los iconos viven en un **sprite inline** al principio de `<body>` de `index.html` (`<symbol id="i-*">`), no en un
  archivo externo. A propósito: los `<use>` se resuelven en el documento, así que no hay `fetch` y la app sigue
  funcionando abierta con `file://` y sin red.
- **No añadas emojis.** Para un icono nuevo: añade un `<symbol id="i-lo-que-sea">` al sprite y usa
  `icon('lo-que-sea')` desde JS o `<svg class="icon"><use href="#i-lo-que-sea"/></svg>` en el HTML.
- `icon(name, extraClass)` valida el nombre contra `/^[-a-z0-9]+$/i` y cae a `'tag'` si no existe el símbolo.
  `.icon` pinta con `fill:none; stroke:currentColor`, así que hereda el color del contexto sin CSS extra.
- **Los ids del sprite son ASCII, siempre.** La regex de `icon()` no acepta `ñ` ni otros acentos, así que un
  símbolo `id="i-pañuelos"` existe pero *nunca* se puede usar: `icon()` devuelve el `tag` en silencio y no falla
  nada. Sin acentos: `platano`, `jamon`, `panuelos`, `refresco`.
- El sprite mezcla dos clases de icono y no deben confundirse: los **de acción** (los de los botones:
  `trash`, `pencil`, `plus`, `chevron`, `checklist`…) y los **de categoría** (los que ofrece el selector, ~200). Los de
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

## Paleta: cada color esta medido, y hay DOS tokens por color

Los colores no son "unos colores que verian bien": estan contrastados contra WCAG 2.1 y
`tests/paleta.spec.js` los comprueba **sobre el documento renderizado**, no sobre el archivo, asi
que la herencia real (`body.dark` gana sobre `:root`) tambien cuenta. Si tocas un color, corre esa
spec: si no, el fallo aparece en la pantalla de un usuario.

- **Base neutra: 5 grises** (`--bg`, `--surface`, `--text-primary`, `--text-secondary`,
  `--border`). Ya cumplia y no se toca: 14,63:1 y 4,76:1. Es la rampa slate de Tailwind.
- **Cada color cromatico tiene dos tokens**, y esa es la parte que hay que entender:

| Uso | Token | Requisito |
| --- | --- | --- |
| Texto, icono, borde | `--accent`, `--danger`, `--warning`, `--success`, `--star` | >= 4,5:1 **sobre** superficie |
| Relleno (fondo) | `--accent-fill`, `--danger-fill`, `--warning-fill`, `--success-fill`, `--star-fill` | >= 4,5:1 del **blanco encima** |

  Son requisitos opuestos y un solo valor no puede cumplir los dos. Por eso en modo oscuro los
  tokens de texto se aclaran y los de relleno **no**: `#818cf8` da 4,90:1 sobre la superficie
  oscura (bien para texto) pero el blanco encima cae a 2,98:1 (mal para relleno). Los de relleno
  son iguales en los dos modos a proposito.
  **La regla para no equivocarte:** si el elemento lleva texto o un glifo ENCIMA, va al token
  `-fill`, siempre. `.config-badge`, `.action-btn.star:hover`, `.add-suggestion-float:hover`,
  `.add-suggestion-float.added` y `.badge-count` son cinco casos donde se cumplia mal.
- **`--star` tenia el mismo problema y no lo habia mirado** hasta casi el final: `#fbbf24` daba
  1,67:1 tanto como texto sobre blanco como con el blanco encima. Ningun valor cumple los tres
  papeles a la vez (medido), asi que tambien se separo. Ojo: `#fbbf24` si es correcto en modo
  oscuro para texto (8,76:1), porque ahi el fondo es claro y el texto oscuro.
- **Fallos que havia y se corrigieron** (medidos, no supuestos): aviso `#f59e0b` 2,15:1, exito
  `#10b981` 2,54:1 y peligro `#ef4444` 3,76:1 en modo claro; acento `#6366f1` 3,27:1 en oscuro; y
  el hover del boton primario, que ponia `var(--accent-light)` (#818cf8) con texto blanco encima
  y ya fallaba a 2,98:1.
- **Los tintes son `color-mix(...)`, no `rgba` fijo.** Habia `rgba(239, 68, 68, 0.1)` y
  `rgba(245, 158, 11, 0.1)` escritos a mano, que no siguen al token: cambiar `--danger` los
  desincronizaba en silencio. `color-mix(in srgb, var(--danger) 10%, transparent)` no puede.
- **`--accent-light` solo queda para el `.press-indicator`** (una barra de 3px sin texto). No lo
  uses de fondo con texto encima: es un color claro y no llega a 4,5:1 con blanco.
- El acento se usa **solo para acciones y estado activo**, nunca para datos. Ver la seccion
  siguiente, "Reparto del acento": hay un techo medido por pantalla y `tests/acento.spec.js`
  lo vigila.

## Jerarquia de la barra de presupuesto

PRESUPUESTO / GASTADO / RESTANTE eran **tres bloques identicos** (mismo `font-size`, mismo peso) y
`#budgetDisplay`, `#spentDisplay` y `#remainingDisplay` **no tenian ninguna regla propia**. Eso es
exactamente el "todo al mismo tamano" que hace que una pantalla parezca un panel barato: no hay
nada a donde mirar. Ahora **RESTANTE manda**: `flex: 1.6` de 3,6 y `clamp(1.3rem, 6.5vw, 1.75rem)`
contra `0.8rem` de los otros dos, mas peso 800 contra 600.

Cuatro cosas que costaron una vuelta de tuerca:

- **El dominante NO declara `color`.** El color lo ponen `.danger` / `.warning` del box, y un
  `color` en el hijo, que tiene mas especificidad por id, las pisaria y **la alerta desapareceria
  sin ningun error en consola**. Hay un test que lo comprueba.
- **`min-width: 0` en `.budget-item` es obligatorio.** Un flex item trae `min-width: auto`, o sea
  que nunca baja del tamano de su contenido: la caja crecia con el numero y el texto se salia por
  la derecha en vez de recortarse. Sin eso, `flex: 1.6` no manda sobre nada.
- **`flex: 1.6` es una proporcion, no un minimo**, de ahi el `clamp()`. A 320px un RESTANTE de
  "$1234557.89" a 1,75rem se salia de la pantalla. El `clamp` no es un breakpoint: aqui no hay
  media queries y no se ha anadido ninguna.
- **`nowrap` + `text-overflow: ellipsis`, no `overflow-wrap: anywhere`.** Un importe partido en
  dos lineas ("$1234557" / ".89") empuja la caja hacia abajo y empuja con ella todo lo que viene
  detras. Recortar mantiene la altura.

**Subir el tamano del dominante tiene un efecto lateral**: `.empty` es el ultimo bloque del flujo,
asi que engordar la barra baja el estado vacio y su texto acaba **bajo la barra inferior fija**. La
holgura se recupera recortando ARRIBA (por eso el padding de `.budget-item` es de 6px y no 8px),
nunca engordando el `padding-bottom` de body.

## Reparto del acento: el color marca ACCIONES y ESTADO, nunca DATOS

**La regla.** `--accent` es para la acción primaria y para el estado activo (pestaña
seleccionada, barra de progreso, contador). Los **datos** —precios, totales, cifras, importes— van
en `--text-primary`. La marca tampoco: el logo en negro.

**Por qué está medido y no es opinión.** `.total-price` era de acento y hay **uno por cada
producto**, así que el acento **escalaba con las filas**: con 4 productos eran 9 acentos solidos en
la lista, y con 30 serían 36. Un color que se multiplica con los datos deja de ser jerarquía y pasa
a ser ruido. `tests/acento.spec.js` mide los acentos visibles por pantalla y pone un techo.

| Pantalla | Antes | Después | Qué queda |
| --- | --- | --- | --- |
| Lista con 4 productos | 9 | **5** | barra, contador, botón, pestaña |
| Lista vacía | 5 | **4** | contador, botón, pestaña |
| Estadísticas | 3 | **0** | ninguno: el donut ya tiene color de categoría |
| Historial | 2 | **0** | ninguno |
| Configuración | 2 | **2** | botón secundario + "Guardar Cambios" |

**Lo que se movió a `--text-primary`:** `.total-price`, `.stat-value`, `.donut-value`,
`.history-amount`, `.logo` y `.logo svg`.

**El estado no se pierde, solo deja de competir con la marca.** El producto comprado sigue
distinguiéndose por el tachón, por la casilla verde y porque su `.total-price` va en `--success`; y
eso además evita depender de un par **rojo/verde**, que es justo lo que no se distingue con
daltonismo. En Stats, `.stat-value-ok` y `.stat-value-warn` ya tiñen por estado.

- **`.donut-chart` NO es acento y su color no viene del CSS.** `renderStats()` lo pinta con un
  `conic-gradient` **inline** con `categories[cat].color`. Antes la regla CSS tenía un
  `conic-gradient(var(--accent) 0% 100%)` que **nunca llegó a verse** porque el inline lo pisaba
  siempre: era código muerto. Ahora debajo solo hay un fondo neutro.
- Lo que queda de acento en el CSS son 28 usos de `--accent` (antes 45), 12 de `--accent-fill` y
  10 de `--accent-soft`. **Los 28 son legítimos**: hover, foco, estado activo. Reducirlos más ya no
  tiene criterio medible, sería gusto.

**Para medirlo bien, tres trampas** (las costó el primer inventario, que dio números falsos):
1. Los modales **no ocultan** la pantalla de debajo, solo la cubren. Hay que contar **dentro** del
   `.modal.active`, o el recuento de "pantalla Stats" incluye los precios de la lista.
2. Los `<use>` del sprite heredan el trazo del `<svg>` y cuentan el mismo acento tres veces. Todo lo
   que esté **dentro** de un `<svg>` se descarta; el `<svg>` sí cuenta.
3. El toast vive en el DOM con `opacity: 0`, así que hay que filtrarlo.

## Versions de las actions del workflow (y el aviso que sale en cadena)

Los majors actuales, todos con `runs.using: node24`:

| Action | Major | Antes |
| --- | --- | --- |
| `actions/checkout` | v7 | v4 |
| `actions/setup-java` | v6 | v4 |
| `actions/setup-node` | v7 | v4 |
| `android-actions/setup-android` | v4 | v3 |
| `actions/upload-artifact` | v7 | v4 |

**Los avisos de deprecación salen en cadena y eso engaña.** Primero ves
*"setup-java v4 is deprecated"*; al subirlo aparece *"Node.js 20 is deprecated ... actions targeting
Node.js 20 are being forced to run on Node.js 24"*, que **no es de `setup-java` sino de las cinco**.
Subir solo una deja el aviso a medias y no se distingue si el problema era de esa o de las otras: hay
que subir las cinco.

Para subirlas sin riesgo, **lee el `action.yml` del tag antes de tocar el workflow** y no confíes en
que el bloque siga igual:

```
https://raw.githubusercontent.com/<owner>/<repo>/v7/action.yml
```

Hay que comprobar dos cosas: que `runs.using` sea el nuevo (para callar el aviso) y que los inputs que
usa el workflow sigan existiendo con el mismo nombre. Así se confirmó que `distribution` /
`java-version`, `node-version` y `name` / `path` / `if-no-files-found` no han cambiado, y que
`setup-android@v4` sigue con `packages` por defecto (ver la nota de abajo).

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
- `android-actions/setup-android@v4` trae `packages: 'platform-tools'` por defecto y el paquete `tools`
  ya no existe: hay que pasar `packages:` explícito o el build muere con `Failed to find package 'tools'`.
  **Comprobado en el `action.yml` de v4: el default sigue siendo `platform-tools`, o sea que subir de
  major NO arregla la trampa por sí solo.** Sigue habiendo que pasar `packages:` a mano.
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
- **Count the arguments you pass to your own patch helper.** Calling `aplicar(etiqueta, from, to)` with **four**
  strings (because the replacement text got split across two array elements) silently drops the fourth. Here that
  left a CSS comment `/* ...` **unclosed**, so the parser ate everything after it — `.empty` and ~40 rules
  vanished and 8 tests failed with nonsense errors (`display: block` instead of `flex`). The tell was counting:
  `/*` appeared 67 times and `*/` only 66. **After any bulk CSS/HTML patch, check that braces and comment
  delimiters are balanced** (`(css.match(/\{/g)||[]).length` vs `\}`, and `/\*` vs `\*/`). An unbalanced
  comment is silent: no error, just a truncated stylesheet.
- **`.gitignore` warns "LF will be replaced by CRLF"**, so these files are **CRLF**. A patch script that
  anchors on `'\n'` won't match anything and will report `NO ENCONTRADO` — which looks exactly like a wrong
  anchor. Match with a regex tolerant of both (`/\r?\n/`) instead of giving up on the anchor.
- **Don't trust a `git stash` round-trip as proof of "I broke it"** until the failing test passes without your
  changes; that part worked, but only after `git stash pop`, which also prints the whitespace warnings that gave
  away the CRLF issue above.
- **`getComputedStyle` returns the STARTING value of a running transition** if you read it in the same tick.
  `.budget-item` has `transition: all 0.2s`, so adding a class and reading `.color` immediately gives the *old*
  color and looks like "the CSS didn't apply". Set `el.style.transition = 'none'` first in layout tests.
- **With `overflow: hidden`, `scrollWidth` still reports the full text width** even when it's being clipped. To
  detect real overflow compare `getBoundingClientRect()` against the container's rect; use `scrollWidth` only to
  know *whether* clipping is happening.
- **Don't write a test that compares two full-page measurements.** `acento: el acento no crece con las filas`
  medía la pantalla entera con 4 productos y con 30 y comparaba los dos números. Flakeó: las dos
  mediciones comparten barra de progreso, badge y nav, así que un elemento que aún no ha pintado en
  una de ellas hace que falle sin que haya cambiado nada. **Measure the region that actually grows**
  (aquí `.product-list`) and leave the shared chrome out of the comparison. A `--retries=0` run en
  bucle es la forma de demostrar que el test es estable, no de confiar en que lo sea.
- **Variables de Node no existen dentro de `page.evaluate`**: la función corre en el navegador y
  solo ve lo que se le pase como segundo argumento. `NOMBRES is not defined` es el síntoma.
- **Un `grep ... | -replace '\s+',' '` APLANA las reglas multilínea y engaña.** Al buscar reglas CSS
  para modificarlas, `background: var(--star); color: white;` parecía estar en una línea cuando en
  el fichero eran tres. Para parchear, lee la regla exacta con contexto y ancla con los saltos de
  línea reales.
- **`tools/audit-css.mjs` leía los comentarios del CSS como si fueran selectores**, así que un
  comentario que menciona un fichero (`app.js lo pinta inline`) metía `.js` y `.spec` en la lista de
  clases definidas y los reportaba como sin usar. Ahora quita los comentarios antes de buscar. Si
  añades comentarios al CSS que mencionen nombres con punto, la segunda lista del auditor se
  ensucia sola.
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