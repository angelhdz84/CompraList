// === app.js ===

// === FUNCIÓN PARA OBTENER FECHA LOCAL ===
function getLocalDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ========== UTILIDADES ==========

const MAX_SUGGESTIONS = 20;

// Declarados aqui, antes de cualquier inicializacion que pueda fallar: un error en
// `const driver = ...` dejaba estos binding en TDZ y rompia funciones sin relacion.
let lastId = Date.now();
let toastTimer = null;
let lastUndo = null;

/** Marcador de icono del sprite SVG, listo para innerHTML. */
function icon(name, extraClass) {
  const safe = /^[-a-z0-9]+$/i.test(String(name || '')) ? name : 'tag';
  return '<svg class="icon ' + (extraClass || '') + '" aria-hidden="true" focusable="false">' +
    '<use href="#i-' + safe + '"/></svg>';
}
 /**
 * Categoría segura: nunca devuelve undefined.
 * Los datos importados o de versiones antiguas pueden traer una categoría que ya
 * no existe, y desreferenciar `categories[clave].icon` rompía el render entero.
 */
function getCategory(key) {
  return categories[key] || categories[FALLBACK_CATEGORY];
}

/**
 * Parseo de dinero tolerante a la configuración regional.
 * Acepta "1.20", "1,20", "$1,20", "1.234,56" y bloquea negativos/NaN -> 0.
 * Nota: en <input type="number"> el navegador rechaza la coma y devuelve "",
 * lo que antes guardaba 0 en silencio. Por eso los campos de precio usan
 * type="text" inputmode="decimal" (ver index.html).
 */
function parseMoney(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : 0;
  let s = String(value == null ? '' : value).replace(/[^\d,.-]/g, '');
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/** Cantidad entera >= 1. */
function parseQty(value) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Formatea una fecha YYYY-MM-DD en largo, en español y sin desfase de zona horaria. */
function formatDateLong(dateStr) {
  if (!isValidDate(dateStr)) return dateStr;
  return new Date(dateStr + 'T12:00:00').toLocaleDateString('es-ES', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });
}

/** JSON.parse que no revienta la app. Devuelve `fallback` si el payload está corrupto. */
function safeParse(raw, fallback) {
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.error('JSON corrupto en localStorage:', err);
    return fallback;
  }
}

/** Normaliza un producto de cualquier origen (estado, backup importado, lista vieja). */
function normalizeProduct(p) {
  if (!p || typeof p !== 'object') return null;
  const name = String(p.name == null ? '' : p.name).trim();
  if (!name) return null;
  const id = Number(p.id);
  return {
    id: Number.isFinite(id) && id > 0 ? id : Date.now() + Math.floor(Math.random() * 1000),
    name: name.slice(0, 120),
    price: parseMoney(p.price),
    quantity: parseQty(p.quantity),
    category: normalizeCategory(p.category),
    bought: Boolean(p.bought)
  };
}

function normalizeProducts(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map(normalizeProduct).filter(Boolean).filter(p => {
    if (seen.has(p.id)) p.id = Date.now() + Math.floor(Math.random() * 1000);
    seen.add(p.id);
    return true;
  });
}

function normalizeSuggestion(s, index = 0) {
  if (!s || typeof s !== 'object') return null;
  const name = String(s.name == null ? '' : s.name).trim();
  if (!name) return null;
  return {
    name: name.slice(0, 60),
    price: parseMoney(s.price),
    category: normalizeCategory(s.category)
  };
}

function normalizeSuggestions(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  return list.map(normalizeSuggestion).filter(Boolean).filter(s => {
    const k = s.name.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, MAX_SUGGESTIONS);
}

/** Normaliza el objeto de presupuestos por categoría (presupuestos = {} -> solo claves válidas). */
function normalizeBudgets(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.keys(categories).forEach((cat) => {
    const v = parseMoney(raw[cat]);
    if (v > 0) out[cat] = v;
  });
  return out;
}


// Estado
let state = {
  products: [],
  budget: 0,
  budgets: {},          // límites por categoría: { alimentos, bebidas, limpieza, otros }
  categories: [],       // definiciones gestionables por el usuario
  date: getLocalDate(),
  supermarketMode: false,
  suggestions: []
};

// Claves de lista: solo las que llevan una fecha embebida. Cualquier otra clave
// `compralist_*` es una preferencia (dark, onboarding, tour, suggestions) y nunca
// debe borrarse por limpieza de fechas.
const LIST_KEY_RE = /^compralist_(\d{4}-\d{2}-\d{2})$/;
const CORRUPT_PREFIX = 'compralist_corrupt_';

// Long press
let longPressTimer;
let isLongPress = false;
const LONG_PRESS_DURATION = 600;

// ========== CATEGORÍAS (gestionables por el usuario) ==========
// 'otros' es la categoría de reserva: no se puede borrar ni renombrar porque
// getCategory() y normalizeCategory() dependen de ella como fallback seguro.
const FALLBACK_CATEGORY = 'otros';

// Iconos disponibles para el selector de categorías. Cada id debe existir como
// <symbol id="i-..."> en el sprite de index.html: icon() cae a 'tag' en
// silencio ante un nombre desconocido, así que un id mal escrito no da error.
const CATEGORY_ICONS = [
  'cart', 'bag', 'box', 'food', 'drink', 'clean', 'pantry', 'frozen',
  'bakery', 'meat', 'baby', 'tag', 'star', 'target',
  'fruta', 'platano', 'naranja', 'uva', 'fresa', 'sandia', 'limon', 'cereza',
  'tomate', 'zanahoria', 'papa', 'cebolla', 'ajo', 'pimiento', 'champinon',
  'brocoli', 'maiz', 'aguacate', 'coco', 'ensalada', 'pollo', 'huevo', 'queso',
  'mantequilla', 'pan', 'cruasan', 'pastel', 'galle', 'chocolate', 'caramelo',
  'palomitas', 'papas', 'hamburguesa', 'hotdog', 'pizza', 'sandwich', 'taco',
  'sushi', 'helado', 'donut', 'ensaladilla', 'sopa', 'arroz', 'pasta', 'cereal',
  'bote', 'aceite', 'miel', 'mermelada', 'lata', 'frasco', 'carne', 'cerdo',
  'cordero', 'chorizo', 'jamon', 'bacon', 'pescado', 'gamba', 'cangrejo',
  'langostino', 'mejillon', 'pulpo', 'vieira', 'agua', 'refresco', 'zumo',
  'cafe', 'te', 'cerveza', 'vino', 'licor', 'energia', 'leche', 'botella',
  'vaso', 'termo', 'jabon', 'detergente', 'lejia', 'esponja', 'cepillo',
  'fregona', 'cubo', 'guantes', 'pulverizador', 'papel', 'servilleta',
  'bolsa-basura', 'reciclar', 'eco', 'champu', 'dientes', 'pasta-dientes',
  'desodorante', 'perfume', 'crema', 'maquinilla', 'espejo', 'peine', 'gafas',
  'panuelos',
  'camiseta', 'pantalon', 'falda', 'vestido', 'abrigo', 'zapato', 'bota',
  'sombrero', 'calcetines', 'bufanda', 'reloj', 'mochila', 'percha',
  'paraguas', 'bolsa', 'frigorifico', 'horno', 'microondas', 'tostadora',
  'licuadora', 'lavavajillas', 'lavadora', 'aspiradora', 'plancha',
  'television', 'mando', 'portatil', 'movil', 'tableta', 'bombilla',
  'enchufe', 'pila', 'cable', 'caja-herramientas', 'martillo', 'destornillador',
  'silla', 'mesa', 'sofa', 'cama', 'lampara', 'planta', 'vela', 'llave',
  'cerradura', 'perro', 'gato', 'pajaro', 'comida-mascota', 'hueso',
  'cuenco', 'biberon', 'panal', 'chupete', 'cochecito', 'juguete', 'pelota',
  'ticket', 'etiqueta-precio', 'codigo-barras', 'balanza', 'billete', 'monedas',
  'tarjeta', 'factura', 'regalo', 'reloj-arena', 'mapa', 'ubicacion',
  'camion', 'coche', 'bicicleta', 'bus', 'tren', 'avion', 'wifi', 'nube',
  'campana', 'altavoz', 'filtro', 'ordenar', 'lupa', 'cuadricula', 'libro',
  'periodico', 'telefono'
];

const CATEGORY_COLORS = [
  '#ef4444', '#f97316', '#f59e0b', '#eab308', '#84cc16', '#10b981',
  '#14b8a6', '#06b6d4', '#3b82f6', '#6366f1', '#8b5cf6', '#ec4899'
];

const DEFAULT_CATEGORIES = [
  { id: 'alimentos', label: 'Alimentos', color: '#ef4444', icon: 'food' },
  { id: 'bebidas', label: 'Bebidas', color: '#3b82f6', icon: 'drink' },
  { id: 'limpieza', label: 'Limpieza', color: '#10b981', icon: 'clean' },
  { id: 'otros', label: 'Otros', color: '#f59e0b', icon: 'box' }
];

// Lookup vivo por id. Se reconstruye con syncCategories(); todas las llamadas
// existentes (categories[id].color, categories[id].label...) siguen igual.
let categories = {};

/** Normaliza una definición de categoría venga de donde venga. */
function normalizeCategoryDef(def) {
  if (!def || typeof def !== 'object') return null;
  const id = String(def.id == null ? '' : def.id).trim().slice(0, 24);
  const label = String(def.label == null ? id : def.label).trim().slice(0, 24);
  if (!id || !label) return null;
  const color = /^#[0-9a-fA-F]{6}$/.test(String(def.color)) ? String(def.color).toLowerCase() : '#64748b';
  const iconName = CATEGORY_ICONS.includes(def.icon) ? def.icon : 'tag';
  return { id, label, color, icon: iconName };
}

/** Reconstruye el lookup 'categories' desde state.categories. */
function syncCategories() {
  categories = {};
  (state.categories || []).forEach((def) => {
    if (def && def.id) categories[def.id] = def;
  });
  if (!categories[FALLBACK_CATEGORY]) {
    categories[FALLBACK_CATEGORY] = Object.assign({}, DEFAULT_CATEGORIES[3]);
  }
  renderCategorySelects();
  renderCategoryBudgetFields();
}

/** Devuelve un id de categoría válido, o el de reserva. */
function normalizeCategory(id) {
  return categories[id] ? id : FALLBACK_CATEGORY;
}

/** Genera un id único y legible a partir de la etiqueta. */
function slugifyCategory(label, taken) {
  const base = String(label).toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'cat';
  let id = base;
  let n = 2;
  while (taken.has(id) || id === FALLBACK_CATEGORY) { id = base + '-' + n; n++; }
  return id;
}

function loadCategories() {
  const raw = safeParse(localStorage.getItem('compralist_categories'), null);
  const seen = new Set();
  const list = [];

  if (Array.isArray(raw)) {
    raw.forEach((def) => {
      const clean = normalizeCategoryDef(def);
      if (!clean || seen.has(clean.id)) return;
      seen.add(clean.id);
      list.push(clean);
    });
  }

  // Las categorías por defecto que falten se añaden al final.
  DEFAULT_CATEGORIES.forEach((def) => {
    if (seen.has(def.id)) return;
    seen.add(def.id);
    list.push(Object.assign({}, def));
  });

  // La de reserva SIEMPRE existe, y siempre al final: así el valor por defecto del
  // <select> sigue siendo la primera categoría real (Alimentos), como antes de que
  // las categorías fueran gestionables.
  const fallbackIndex = list.findIndex((c) => c.id === FALLBACK_CATEGORY);
  if (fallbackIndex === -1) {
    list.push(Object.assign({}, DEFAULT_CATEGORIES[3]));
  } else {
    moveFallbackToEnd(list);
  }

  state.categories = list;
  localStorage.setItem('compralist_categories', JSON.stringify(list));
  syncCategories();
}

/**
 * Deja la categoría de reserva siempre al final de la lista.
 *
 * La usan TANTO loadCategories() COMO saveCategories(): si solo la carga la
 * fijara, crear una categoría nueva la añadiría detrás de "otros" y se guardaría
 * así, dejando el orden mal hasta el siguiente arranque. Eso hace que la UI se
 * contradiga: "otros" aparece en medio y sus flechas están desactivadas
 * precisamente porque "el almacenamiento lo revierte" (ver renderCategoriesManager).
 */
function moveFallbackToEnd(list) {
  const i = list.findIndex((c) => c.id === FALLBACK_CATEGORY);
  if (i !== -1 && i !== list.length - 1) {
    const [fallback] = list.splice(i, 1);
    list.push(fallback);
  }
  return list;
}

function saveCategories() {
  moveFallbackToEnd(state.categories);
  localStorage.setItem('compralist_categories', JSON.stringify(state.categories));
  syncCategories();
}

const defaultSuggestions = [
  { name: 'Leche', price: 1.20, category: 'alimentos' },
  { name: 'Huevos', price: 3.50, category: 'alimentos' },
  { name: 'Pan', price: 1.80, category: 'alimentos' },
  { name: 'Arroz', price: 2.30, category: 'alimentos' },
  { name: 'Azúcar', price: 1.90, category: 'alimentos' },
  { name: 'Café', price: 5.00, category: 'alimentos' },
  { name: 'Aceite', price: 3.20, category: 'alimentos' },
  { name: 'Pasta', price: 1.50, category: 'alimentos' },
  { name: 'Jabón', price: 2.10, category: 'limpieza' },
  { name: 'Detergente', price: 4.50, category: 'limpieza' },
  { name: 'Papel', price: 3.80, category: 'limpieza' },
  { name: 'Coca Cola', price: 2.00, category: 'bebidas' },
  { name: 'Agua', price: 1.00, category: 'bebidas' },
  { name: 'Jugo', price: 2.50, category: 'bebidas' }
];

// Inicialización
window.onload = () => {
  // Cargar preferencia de modo oscuro
  const darkPref = localStorage.getItem('compralist_dark') === 'true';
  document.body.classList.toggle('dark', darkPref);
  syncToggleAria();

  // Inicializar tooltips
  if (typeof tippy !== 'undefined') {
    tippy('[data-tippy-content]', {
      placement: 'top',
      animation: 'scale',
      duration: 200,
    });
  }

  // Un fallo al leer datos no debe impedir que la app arranque.
  try {
    loadCategories();
  } catch (err) {
    console.error('loadCategories falló', err);
    state.categories = DEFAULT_CATEGORIES.map((c) => Object.assign({}, c));
    syncCategories();
  }

  try {
    loadSuggestions();
  } catch (err) {
    console.error('loadSuggestions falló', err);
    state.suggestions = [...defaultSuggestions];
  }
  try {
    loadData();
  } catch (err) {
    console.error('loadData falló', err);
    state.products = [];
    state.budget = 0;
    state.budgets = {};
    render();
  }

  // Mostrar onboarding si no se ha visto
  if (!localStorage.getItem('compralist_onboarding')) {
    setTimeout(() => {
      document.getElementById('onboardingModal').classList.add('active');
    }, 500);
  }

  document.getElementById('productName').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('productPrice').focus();
    }
  });
  document.getElementById('productPrice').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addProduct();
    }
  });

  registerServiceWorker();
};

/** Mantiene sincronizados los aria-pressed de los toggles de la cabecera. */
function syncToggleAria() {
  const darkBtn = document.getElementById('darkModeBtn');
  if (darkBtn) darkBtn.setAttribute('aria-pressed', String(document.body.classList.contains('dark')));
  const modeBtn = document.getElementById('modeBtn');
  if (modeBtn) modeBtn.setAttribute('aria-pressed', String(state.supermarketMode));
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // El service worker no funciona con file:// y solo tiene sentido servida por HTTP.
  if (!location.protocol.startsWith('http')) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('Service worker no registrado:', err);
    });
  });
}

// Modo oscuro
function toggleDarkMode() {
  document.body.classList.toggle('dark');
  const isDark = document.body.classList.contains('dark');
  localStorage.setItem('compralist_dark', String(isDark));
  const use = document.querySelector('#darkModeBtn use');
  if (use) use.setAttribute('href', isDark ? '#i-sun' : '#i-moon');
  syncToggleAria();
}

// ========== ONBOARDING ==========
let currentSlide = 0;

function showSlide(index) {
  const slides = document.querySelectorAll('.onboarding-slide');
  const dots = document.querySelectorAll('.dot');
  slides.forEach(s => s.classList.add('hidden'));
  slides[index].classList.remove('hidden');
  dots.forEach((d, i) => {
    d.classList.toggle('active', i === index);
  });
  document.getElementById('onboardingPrev').disabled = index === 0;
  const tourBtn = document.getElementById('onboardingTour');
  if (index === 3) {
    tourBtn.style.display = 'block';
  } else {
    tourBtn.style.display = 'none';
  }
}

function nextSlide() {
  if (currentSlide < 3) {
    currentSlide++;
    showSlide(currentSlide);
  } else {
    completeOnboarding();
  }
}

function prevSlide() {
  if (currentSlide > 0) {
    currentSlide--;
    showSlide(currentSlide);
  }
}

function skipOnboarding() {
  completeOnboarding();
}

function completeOnboarding() {
  localStorage.setItem('compralist_onboarding', 'true');
  document.getElementById('onboardingModal').classList.remove('active');
}

function closeOnboarding(e) {
  if (e.target.classList.contains('modal')) {
    skipOnboarding();
  }
}

// ---- Tour guiado (driver.js) ----
// OJO: el bundle vendorizado NO expone un global `Driver`. Su forma real es:
//
//   this.driver.js = function(D){ ... return D.driver = ke ... }({})
//
// es decir, `this.driver.js = function(){}({})` asigna el RESULTADO de la IIFE, asi
// que `window.driver.js` es un objeto y la fabrica vive en `window.driver.js.driver`.
// La instancia expone setSteps()/drive() (no defineSteps()/start()) y las claves de
// config son overlayOpacity y stagePadding (no opacity ni padding).
// Se construye en un try/catch para que un fallo aqui no pueda abortar el resto de app.js.
let driver = null;
try {
  const factory = window.driver && window.driver.js && window.driver.js.driver;
  if (typeof factory === 'function') {
    driver = factory({
      animate: true,
      overlayOpacity: 0.75,
      stagePadding: 10,
      allowClose: true,
      doneBtnText: 'Finalizar',
      closeBtnText: 'Cerrar',
      nextBtnText: 'Siguiente',
      prevBtnText: 'Anterior',
    });
  } else {
    console.warn('driver.js no disponible: el tutorial quedara deshabilitado');
  }
} catch (err) {
  console.error('No se pudo inicializar el tour guiado:', err);
}

function startTour() {
  if (!driver) {
    showToast('El tutorial no está disponible', 'warning');
    return;
  }
  driver.setSteps([
    {
      element: '#productName',
      popover: {
        title: 'Agregar producto',
        description: 'Escribe aquí el nombre del producto. Luego presiona Enter o haz clic en "Agregar".',
        position: 'bottom',
      }
    },
    {
      element: '#productPrice',
      popover: {
        title: 'Precio (opcional)',
        description: 'Puedes escribir el precio unitario. Si lo dejas vacío, será 0.',
        position: 'bottom',
      }
    },
    {
      element: '#productCategory',
      popover: {
        title: 'Categoría',
        description: 'Selecciona una categoría para organizar mejor tus productos.',
        position: 'bottom',
      }
    },
    {
      element: '.suggestions-bar',
      popover: {
        title: 'Sugerencias rápidas',
        description: 'Haz clic en una sugerencia para agregarla automáticamente. Mantén presionado para editarla.',
        position: 'bottom',
      }
    },
    {
      element: '.progress-container',
      popover: {
        title: 'Progreso',
        description: 'Aquí verás cuántos productos has comprado y el porcentaje completado.',
        position: 'bottom',
      }
    },
    {
      element: '.budget-bar',
      popover: {
        title: 'Presupuesto',
        description: 'Puedes establecer un presupuesto en configuración. Te avisará cuando estés cerca del límite.',
        position: 'bottom',
      }
    },
    {
      element: '.bottom-nav',
      popover: {
        title: 'Navegación',
        description: 'Cambia entre la lista, estadísticas e historial.',
        position: 'top',
      }
    }
  ]);
  driver.drive();
  localStorage.setItem('compralist_tour', 'true');
}

function restartTour() {
  closeModal();
  startTour();
}

// ========== CRUD DE CATEGORÍAS ==========
let editingCategoryId = null;

/** Rellena los <select> de categoría a partir de state.categories. */
function renderCategorySelects() {
  const selects = ['productCategory', 'editCategory', 'newSuggestionCategory', 'editSuggestionCategory'];
  selects.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const previous = el.value;
    el.innerHTML = (state.categories || [])
      .map((c) => '<option value="' + escapeHtml(c.id) + '">' + escapeHtml(c.label) + '</option>')
      .join('');
    if (previous && categories[previous]) el.value = previous;
  });
}

/** Rellena los campos de presupuesto por categoría (se muestran/ocultan en runtime). */
function renderCategoryBudgetFields() {
  const box = document.getElementById('catBudgetFields');
  if (!box) return;
  const cats = (state.categories || []).filter((c) => c.id !== FALLBACK_CATEGORY);
  box.innerHTML = cats.map((c) =>
    '<label class="cat-budget-field">' +
      '<span>' + icon(c.icon) + ' ' + escapeHtml(c.label) + '</span>' +
      '<input type="text" inputmode="decimal" autocomplete="off" placeholder="—" data-cat="' +
        escapeHtml(c.id) + '" oninput="updateCategoryBudgetRealtime(this.dataset.cat)">' +
    '</label>'
  ).join('');
  (state.categories || []).forEach((c) => {
    const input = box.querySelector('input[data-cat="' + c.id + '"]');
    if (input && state.budgets[c.id]) input.value = state.budgets[c.id];
  });
}

function openCategoriesManager() {
  closeModal();
  editingCategoryId = null;
  renderCategoriesManager();
  // resetCategoryForm() es lo que puebla los selectores de icono y color.
  resetCategoryForm();
  document.getElementById('categoriesModal').classList.add('active');
}

function renderCategoriesManager() {
  const list = document.getElementById('catList');
  if (!list) return;
  const counts = countByCategory(state.products);
  const lastIndex = state.categories.length - 1;

  list.innerHTML = state.categories.map((c, i) => {
    const isFallback = c.id === FALLBACK_CATEGORY;
    const n = counts[c.id] || 0;
    // La de reserva queda siempre al final (loadCategories() lo garantiza), asi que
    // sus flechas se desactivan para no prometer algo que el almacenamiento revierte.
    const canUp = i > 0 && !isFallback;
    const canDown = i < lastIndex && !isFallback;
    return '<div class="cat-row" data-id="' + escapeHtml(c.id) + '">' +
      '<span class="cat-row-icon" style="background:' + escapeHtml(c.color) + '">' + icon(c.icon) + '</span>' +
      '<span class="cat-row-info">' +
        '<span class="cat-row-name">' + escapeHtml(c.label) + '</span>' +
        '<span class="cat-row-meta">' + n + ' producto' + (n === 1 ? '' : 's') +
          (isFallback ? ' · categoría de reserva' : '') + '</span>' +
      '</span>' +
      '<span class="cat-row-actions">' +
        '<button onclick="moveCategory(\'' + escapeHtml(c.id) + '\', -1)" title="Subir" aria-label="Subir ' +
          escapeHtml(c.label) + '"' + (canUp ? '' : ' disabled') + '>' + icon('up') + '</button>' +
        '<button onclick="moveCategory(\'' + escapeHtml(c.id) + '\', 1)" title="Bajar" aria-label="Bajar ' +
          escapeHtml(c.label) + '"' + (canDown ? '' : ' disabled') + '>' + icon('down') + '</button>' +
        '<button onclick="editCategory(\'' + escapeHtml(c.id) + '\')" title="Editar" aria-label="Editar ' +
          escapeHtml(c.label) + '"' + (isFallback ? ' disabled' : '') + '>' + icon('pencil') + '</button>' +
        '<button class="danger" onclick="deleteCategory(\'' + escapeHtml(c.id) + '\')" title="Eliminar" aria-label="Eliminar ' +
          escapeHtml(c.label) + '"' + (isFallback ? ' disabled' : '') + '>' + icon('trash') + '</button>' +
      '</span>' +
    '</div>';
  }).join('');
}

function countByCategory(products) {
  const counts = {};
  (products || []).forEach((p) => {
    const c = normalizeCategory(p.category);
    counts[c] = (counts[c] || 0) + 1;
  });
  return counts;
}

function moveCategory(id, delta) {
  const i = state.categories.findIndex((c) => c.id === id);
  const j = i + delta;
  if (i === -1 || j < 0 || j >= state.categories.length) return;
  const [item] = state.categories.splice(i, 1);
  state.categories.splice(j, 0, item);
  saveCategories();
  renderCategoriesManager();
}

function editCategory(id) {
  const c = categories[id];
  if (!c) return;
  if (id === FALLBACK_CATEGORY) {
    showToast('La categoría de reserva no se puede editar', 'warning');
    return;
  }
  editingCategoryId = id;
  document.getElementById('catFormTitle').textContent = 'Editar categoría';
  document.getElementById('catName').value = c.label;
  renderIconPicker(c.icon);
  renderColorPicker(c.color);
  document.getElementById('catSubmitBtn').textContent = 'Guardar';
  document.getElementById('catCancelBtn').classList.remove('hidden');
}

function resetCategoryForm() {
  editingCategoryId = null;
  document.getElementById('catFormTitle').textContent = 'Nueva categoría';
  document.getElementById('catName').value = '';
  renderIconPicker('cart');
  renderColorPicker(CATEGORY_COLORS[0]);
  document.getElementById('catSubmitBtn').textContent = 'Agregar';
  document.getElementById('catCancelBtn').classList.add('hidden');
}

let pendingIcon = 'cart';
let pendingColor = '#ef4444';

function renderIconPicker(selected) {
  pendingIcon = selected;
  document.getElementById('catIconPicker').innerHTML = CATEGORY_ICONS.map((name) =>
    '<button type="button" data-icon="' + name + '" onclick="pickCategoryIcon(this.dataset.icon)"' +
    ' aria-label="Icono ' + name + '" aria-pressed="' + (name === selected) + '">' +
    icon(name) + '</button>'
  ).join('');
}

function renderColorPicker(selected) {
  pendingColor = selected;
  document.getElementById('catColorPicker').innerHTML = CATEGORY_COLORS.map((color) =>
    '<button type="button" class="color-swatch" data-color="' + color + '"' +
    ' style="background:' + color + '" onclick="pickCategoryColor(this.dataset.color)"' +
    ' aria-label="Color ' + color + '" aria-pressed="' + (color === selected) + '"></button>'
  ).join('');
}

function pickCategoryIcon(name) {
  if (!CATEGORY_ICONS.includes(name)) return;
  renderIconPicker(name);
}

function pickCategoryColor(color) {
  renderColorPicker(color);
}

function submitCategoryForm() {
  const label = document.getElementById('catName').value.trim().slice(0, 24);
  if (!label) {
    showToast('Escribe un nombre para la categoría', 'warning');
    document.getElementById('catName').focus();
    return;
  }

  if (editingCategoryId) {
    const c = categories[editingCategoryId];
    if (!c) return;
    c.label = label;
    c.icon = pendingIcon;
    c.color = pendingColor;
    saveCategories();
    renderCategoriesManager();
    renderSuggestionsTable();
    resetCategoryForm();
    showToast('Categoría actualizada');
    return;
  }

  const taken = new Set(state.categories.map((c) => c.id));
  const dupLabel = state.categories.some((c) => c.label.toLowerCase() === label.toLowerCase());
  if (dupLabel) {
    showToast('Ya existe una categoría con ese nombre', 'warning');
    return;
  }
  const id = slugifyCategory(label, taken);
  state.categories.push({ id, label, color: pendingColor, icon: pendingIcon });
  saveCategories();
  renderCategoriesManager();
  resetCategoryForm();
  showToast('Categoría creada');
}

/**
 * Borra una categoría y reasigna a la de reserva sus productos, sugerencias y
 * presupuesto, para no dejar referencias colgando.
 */
function deleteCategory(id) {
  if (id === FALLBACK_CATEGORY) {
    showToast('La categoría de reserva no se puede eliminar', 'warning');
    return;
  }
  const c = categories[id];
  if (!c) return;

  const affected = state.products.filter((p) => p.category === id).length;
  const extra = affected === 1 ? '1 producto' : affected + ' productos';
  const target = getCategory(FALLBACK_CATEGORY).label;
  if (!confirm('¿Eliminar "' + c.label + '"? ' + (affected ? extra + ' pasarán a "' + target + '".' : ''))) return;

  const previousProducts = JSON.parse(JSON.stringify(state.products));
  const previousSuggestions = JSON.parse(JSON.stringify(state.suggestions));
  const previousBudgets = Object.assign({}, state.budgets);
  const previousCategories = JSON.parse(JSON.stringify(state.categories));

  state.products.forEach((p) => { if (p.category === id) p.category = FALLBACK_CATEGORY; });
  state.suggestions.forEach((s) => { if (s.category === id) s.category = FALLBACK_CATEGORY; });
  delete state.budgets[id];
  state.categories = state.categories.filter((x) => x.id !== id);

  saveCategories();
  saveSuggestions();
  saveData();

  showToast('Categoría eliminada', 'warning', function () {
    state.categories = previousCategories;
    state.products = previousProducts;
    state.suggestions = previousSuggestions;
    state.budgets = previousBudgets;
    saveCategories();
    saveSuggestions();
    saveData();
    renderCategoriesManager();
    showToast('Categoría restaurada');
  });
}

/** Devuelve las 4 categorías predeterminadas sin borrar las que haya creado el usuario. */
function restoreDefaultCategories() {
  const missing = DEFAULT_CATEGORIES.filter((def) => !state.categories.some((c) => c.id === def.id));
  if (missing.length === 0) {
    showToast('Las 4 predeterminadas ya están', 'warning');
    return;
  }
  const previous = JSON.parse(JSON.stringify(state.categories));
  missing.forEach((def) => state.categories.push(Object.assign({}, def)));
  saveCategories();
  renderCategoriesManager();
  showToast(`${missing.length} categoría(s) restaurada(s)`, 'success', function () {
    state.categories = previous;
    saveCategories();
    renderCategoriesManager();
    showToast('Cambio deshecho');
  });
}

// ========== SUGERENCIAS ==========
function updateSuggestionsBadges() {
  const count = state.suggestions.length;
  const max = MAX_SUGGESTIONS;
  const badge = document.getElementById('suggestionsBadge');
  const configBadge = document.getElementById('configBadge');
  const configCount = document.getElementById('configSuggestionsCount');
  const managerBadge = document.getElementById('managerBadge');

  if (badge) {
    badge.textContent = `${count}/${max}`;
    badge.className = 'suggestions-badge';
    if (count >= max) {
      badge.classList.add('danger');
    } else if (count >= max - 4) {
      badge.classList.add('warning');
    }
    badge.setAttribute('title', `${count} de ${max} sugerencias`);
  }

  if (configBadge) configBadge.textContent = count;
  if (configCount) configCount.textContent = `${count}/${max}`;
  if (managerBadge) managerBadge.textContent = `(${count}/${max})`;
}

function loadSuggestions() {
  const saved = localStorage.getItem('compralist_suggestions');
  if (saved) {
    const parsed = safeParse(saved, null);
    if (Array.isArray(parsed)) {
      state.suggestions = normalizeSuggestions(parsed);
      saveSuggestions();
    } else {
      quarantine('suggestions', saved);
      state.suggestions = [...defaultSuggestions];
      saveSuggestions();
    }
  } else {
    state.suggestions = [...defaultSuggestions];
    saveSuggestions();
  }
  updateSuggestionsBadges();
  renderSuggestions();
}

/**
 * Guarda una copia de un payload corrupto bajo una clave que NO parece una fecha
 * (para que no aparezca en el historial ni la borre cleanInvalidData) y elimina la
 * clave original, de modo que la app pueda volver a arrancar.
 */
function quarantine(name, raw) {
  try {
    localStorage.setItem(CORRUPT_PREFIX + name, raw);
    if (name !== 'suggestions') localStorage.removeItem(`compralist_${name}`);
  } catch (err) {
    console.error('No se pudo aislar el dato corrupto:', err);
  }
}

function saveSuggestions() {
  localStorage.setItem('compralist_suggestions', JSON.stringify(state.suggestions));
  updateSuggestionsBadges();
}

function renderSuggestions() {
  const bar = document.getElementById('suggestionsBar');
  if (!bar) return;
  bar.innerHTML = '';
  
  const currentNames = state.products.map(p => p.name.toLowerCase());
  const available = state.suggestions.filter(s => !currentNames.includes(s.name.toLowerCase()));
  const toShow = available.length > 0 ? available : state.suggestions;
  
  toShow.slice(0, MAX_SUGGESTIONS).forEach((item) => {
    const cat = getCategory(item.category);
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'suggestion-chip';
    chip.dataset.index = String(state.suggestions.indexOf(item));
    chip.setAttribute('aria-label', `Agregar ${item.name} a la lista. Mantén pulsado para editar.`);
    chip.innerHTML = `
      <span class="cat-chip" style="color:${cat.color}">${icon(cat.icon)}</span>
      <span>${escapeHtml(item.name)}</span>
      <span class="price-tag">$${item.price.toFixed(2)}</span>
      <div class="press-indicator" aria-hidden="true"></div>
    `;
    
    chip.addEventListener('mousedown', handlePressStart);
    chip.addEventListener('touchstart', handlePressStart, {passive: true});
    chip.addEventListener('mouseup', handlePressEnd);
    chip.addEventListener('touchend', handlePressEnd);
    chip.addEventListener('mouseleave', handlePressCancel);
    chip.addEventListener('touchmove', handlePressCancel);
    chip.addEventListener('contextmenu', e => e.preventDefault());
    
    chip.addEventListener('click', (e) => {
      if (!isLongPress) {
        document.getElementById('productName').value = item.name;
        document.getElementById('productPrice').value = item.price;
        document.getElementById('productCategory').value = item.category;
        addProduct();
      }
    });
    
    bar.appendChild(chip);
  });
}

function handlePressStart(e) {
  isLongPress = false;
  const chip = e.currentTarget;
  chip.classList.add('pressing');
  
  if (navigator.vibrate) navigator.vibrate(50);
  
  longPressTimer = setTimeout(() => {
    isLongPress = true;
    chip.classList.remove('pressing');
    const index = parseInt(chip.dataset.index);
    openEditSuggestion(index);
  }, LONG_PRESS_DURATION);
}

function handlePressEnd(e) {
  clearTimeout(longPressTimer);
  const chip = e.currentTarget;
  chip.classList.remove('pressing');
}

function handlePressCancel(e) {
  clearTimeout(longPressTimer);
  const chip = e.currentTarget;
  chip.classList.remove('pressing');
}

function openEditSuggestion(index) {
  const suggestion = state.suggestions[index];
  if (!suggestion) return;
  
  document.getElementById('editSuggestionIndex').value = index;
  document.getElementById('editSuggestionName').value = suggestion.name;
  document.getElementById('editSuggestionPrice').value = suggestion.price;
  document.getElementById('editSuggestionCategory').value = suggestion.category;
  
  document.getElementById('editSuggestionModal').classList.add('active');
}

function saveSuggestionEdit() {
  const index = parseInt(document.getElementById('editSuggestionIndex').value);
  const suggestion = state.suggestions[index];
  if (!suggestion) return;

  const name = document.getElementById('editSuggestionName').value.trim().slice(0, 60);
  if (!name) {
    showToast('El nombre no puede quedar vacío', 'warning');
    return;
  }
  const clash = state.suggestions.find((s, i) => i !== index && s.name.toLowerCase() === name.toLowerCase());
  if (clash) {
    showToast('Ya existe una sugerencia con ese nombre', 'warning');
    return;
  }

  const selectedCat = document.getElementById('editSuggestionCategory').value;
  suggestion.name = name;
  suggestion.price = parseMoney(document.getElementById('editSuggestionPrice').value);
  suggestion.category = categories[selectedCat] ? selectedCat : 'otros';

  saveSuggestions();
  renderSuggestions();
  renderSuggestionsTable();
  closeModal();
  showToast('Sugerencia actualizada');
}

/** Borra una sugerencia con opción de deshacer (sin confirm()). */
function removeSuggestion(index) {
  const suggestion = state.suggestions[index];
  if (!suggestion) return;
  state.suggestions.splice(index, 1);
  saveSuggestions();
  renderSuggestions();
  renderSuggestionsTable();
  closeModal();
  showToast(`"${suggestion.name}" eliminada`, 'warning', () => {
    state.suggestions.splice(Math.min(index, state.suggestions.length), 0, suggestion);
    saveSuggestions();
    renderSuggestions();
    renderSuggestionsTable();
    showToast('Sugerencia restaurada');
  });
}

function deleteSuggestionFromEdit() {
  removeSuggestion(parseInt(document.getElementById('editSuggestionIndex').value));
}

function addToSuggestions(product) {
  const exists = state.suggestions.find(s => s.name.toLowerCase() === product.name.toLowerCase());
  if (!exists) {
    state.suggestions.unshift({
      name: product.name.slice(0, 60),
      price: parseMoney(product.price),
      category: categories[product.category] ? product.category : 'otros'
    });
    if (state.suggestions.length > MAX_SUGGESTIONS) state.suggestions.length = MAX_SUGGESTIONS;
    saveSuggestions();
    renderSuggestions();
    return true;
  }
  return false;
}

function openSuggestionsManager() {
  closeModal();
  renderSuggestionsTable();
  updateSuggestionsBadges();
  document.getElementById('suggestionsModal').classList.add('active');
}

function renderSuggestionsTable() {
  const tbody = document.getElementById('suggestionsTableBody');
  tbody.innerHTML = '';
  
  state.suggestions.forEach((item, index) => {
    const cat = getCategory(item.category);
    const row = document.createElement('div');
    row.className = 'suggestion-table-row';
    row.innerHTML = `
      <div class="suggestion-name">
        <span class="cat-chip" style="color:${cat.color}">${icon(cat.icon)}</span> ${escapeHtml(item.name)}
      </div>
      <div class="suggestion-price">$${item.price.toFixed(2)}</div>
      <div class="suggestion-category">${cat.label}</div>
      <button class="suggestion-delete" onclick="deleteSuggestionFromManager(${index})"
              title="Eliminar" aria-label="Eliminar ${escapeHtml(item.name)} de las sugerencias">
        <svg class="icon icon-inline" aria-hidden="true"><use href="#i-trash"/></svg>
      </button>
    `;
    
    row.addEventListener('dblclick', () => {
      openEditSuggestion(index);
      closeModal();
      setTimeout(() => {
        document.getElementById('editSuggestionModal').classList.add('active');
      }, 100);
    });
    
    tbody.appendChild(row);
  });
  
  if (state.suggestions.length === 0) {
    tbody.innerHTML = '<div style="text-align: center; padding: 40px; color: var(--text-secondary);">No hay sugerencias guardadas</div>';
  }
}

function addNewSuggestion() {
  const name = document.getElementById('newSuggestionName').value.trim().slice(0, 60);
  const price = parseMoney(document.getElementById('newSuggestionPrice').value);
  const category = document.getElementById('newSuggestionCategory').value;
  
  if (!name) {
    showToast('Ingresa un nombre para la sugerencia', 'warning');
    return;
  }
  
  if (state.suggestions.length >= MAX_SUGGESTIONS) {
    showToast('Máximo 20 sugerencias permitidas', 'warning');
    return;
  }
  
  const exists = state.suggestions.find(s => s.name.toLowerCase() === name.toLowerCase());
  if (exists) {
    showToast('Esta sugerencia ya existe', 'warning');
    return;
  }
  
  state.suggestions.unshift({ name, price, category });
  saveSuggestions();
  renderSuggestionsTable();
  renderSuggestions();
  
  document.getElementById('newSuggestionName').value = '';
  document.getElementById('newSuggestionPrice').value = '';
  
  showToast('Sugerencia agregada', 'success');
}

function deleteSuggestionFromManager(index) {
  removeSuggestion(index);
}

function restoreDefaultSuggestions() {
  const previous = [...state.suggestions];
  state.suggestions = [...defaultSuggestions];
  saveSuggestions();
  renderSuggestionsTable();
  renderSuggestions();
  showToast(`${defaultSuggestions.length} sugerencias restauradas`, 'success', () => {
    state.suggestions = previous;
    saveSuggestions();
    renderSuggestionsTable();
    renderSuggestions();
    showToast('Cambio deshecho');
  });
}

// ========== LIMPIEZA DE DATOS INVÁLIDOS ==========
function cleanInvalidData() {
  const keys = Object.keys(localStorage);
  let removed = 0;
  let kept = 0;

  // Solo se tocan las claves con forma de lista (compralist_YYYY-MM-DD).
  // Antes se borraba cualquier clave compralist_* cuyo sufijo no fuese fecha, lo que
  // destruia las preferencias (dark, onboarding, tour, suggestions).
  keys.forEach(key => {
    if (!key.startsWith('compralist_')) return;
    const match = key.match(LIST_KEY_RE);
    if (!match) {
      kept++; // preferencia o copia aislada: no se toca
      return;
    }
    if (!isValidDate(match[1])) {
      localStorage.removeItem(key);
      removed++;
    }
  });

  const suffix = kept > 0 ? ` (${kept} preferencia(s) intactas)` : '';
  if (removed > 0) {
    showToast(`${removed} lista(s) con fechas inválidas eliminadas${suffix}`, 'success');
    const statsModal = document.getElementById('statsModal');
    if (statsModal && statsModal.classList.contains('active') && document.getElementById('modalTitle').textContent.includes('Historial')) {
      renderHistory();
    }
  } else {
    showToast(`No se encontraron fechas inválidas${suffix}`, 'success');
  }
}

/** Copias aisladas de datos corruptos, para que el usuario no las pierda en silencio. */
function listQuarantined() {
  return Object.keys(localStorage)
    .filter(k => k.startsWith(CORRUPT_PREFIX))
    .sort();
}

function renderQuarantine() {
  const box = document.getElementById('quarantineBox');
  if (!box) return;
  const items = listQuarantined();
  if (items.length === 0) {
    box.innerHTML = '';
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  box.innerHTML = `
    <div class="cleanup-info mb-2">
      Se aislaron ${items.length} bloque(s) con datos dañados para que la app no falle.
      Descárgalos si contienen información que quieras recuperar.
    </div>
    ${items.map(k => `
      <div class="quarantine-row">
        <code>${escapeHtml(k)}</code>
        <button class="btn btn-secondary" onclick="downloadQuarantined('${k}')" title="Descargar copia">&#11015;</button>
        <button class="btn btn-danger" onclick="discardQuarantined('${k}')" title="Descartar">&#128465;</button>
      </div>
    `).join('')}
  `;
}

function downloadQuarantined(key) {
  const raw = localStorage.getItem(key);
  if (raw == null) return;
  const blob = new Blob([raw], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${key}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Copia descargada');
}

function discardQuarantined(key) {
  localStorage.removeItem(key);
  renderQuarantine();
  showToast('Copia descartada');
}

function isValidDate(dateString) {
  const regex = /^\d{4}-\d{2}-\d{2}$/;
  if (!regex.test(dateString)) return false;
  
  const date = new Date(dateString);
  const timestamp = date.getTime();
  
  if (typeof timestamp !== 'number' || Number.isNaN(timestamp)) return false;
  
  return dateString === date.toISOString().split('T')[0];
}

// ========== DATOS ==========
function getStorageKey() {
  return `compralist_${state.date}`;
}

function loadData() {
  const key = getStorageKey();
  const saved = localStorage.getItem(key);
  if (saved) {
    const data = safeParse(saved, null);
    if (data && typeof data === 'object') {
      state.products = normalizeProducts(data.products);
      state.budget = parseMoney(data.budget);
      state.budgets = normalizeBudgets(data.budgets);
    } else {
      // Aislar el payload roto: si no, una sola lista corrupta deja la app sin arrancar
      // y no habria forma de borrarla desde la interfaz.
      quarantine(state.date, saved);
      localStorage.removeItem(key);
      state.products = [];
      state.budget = 0;
      state.budgets = {};
    }
  } else {
    state.products = [];
    state.budget = 0;
    state.budgets = {};
  }
  
  syncConfigInputs();
  render();
  renderSuggestions();
}

/** Vuelca el estado en los campos de Configuracion (presupuesto total y por categoria). */
function syncConfigInputs() {
  const dateInput = document.getElementById('configDate');
  const budgetInput = document.getElementById('configBudget');
  if (dateInput) dateInput.value = state.date;
  if (budgetInput) budgetInput.value = state.budget || '';
  Object.keys(categories).forEach(cat => {
    const input = document.getElementById(`configBudget_${cat}`);
    if (input) input.value = state.budgets[cat] || '';
  });
}

function saveData() {
  localStorage.setItem(getStorageKey(), JSON.stringify({
    products: state.products,
    budget: state.budget,
    budgets: state.budgets,
    date: state.date
  }));
  render();
  renderSuggestions();
}

function changeDate() {
  const next = document.getElementById('configDate').value;
  if (!isValidDate(next)) {
    showToast('Fecha no válida', 'warning');
    syncConfigInputs();
    return;
  }
  state.date = next;
  loadData();
  closeModal();
  showToast('Fecha cambiada');
}

function updateBudgetRealtime() {
  state.budget = parseMoney(document.getElementById('configBudget').value);
  updateProgress();
}

function updateCategoryBudgetRealtime(cat) {
  const input = document.querySelector('#catBudgetFields input[data-cat="' + cat + '"]');
  if (!input) return;
  const value = parseMoney(input.value);
  if (value > 0) {
    state.budgets[cat] = value;
  } else {
    delete state.budgets[cat];
  }
}

function saveConfig() {
  state.budget = parseMoney(document.getElementById('configBudget').value);
  const raw = {};
  document.querySelectorAll('#catBudgetFields input[data-cat]').forEach((input) => {
    raw[input.dataset.cat] = input.value;
  });
  state.budgets = normalizeBudgets(raw);
  saveData();
  closeModal();
  showToast('Configuración guardada');
}

// ========== PRODUCTOS ==========
function addProduct() {
  const nameInput = document.getElementById('productName');
  const priceInput = document.getElementById('productPrice');
  const name = nameInput.value.trim();
  const rawPrice = priceInput.value;
  const price = parseMoney(rawPrice);
  const categoryInput = document.getElementById('productCategory');
  const category = categories[categoryInput.value] ? categoryInput.value : 'otros';

  if (!name) {
    showToast('Ingresa el nombre del producto', 'warning');
    nameInput.focus();
    return;
  }

  const product = {
    id: nextId(),
    name: name.slice(0, 120),
    price: price,
    quantity: 1,
    category: category,
    bought: false
  };

  state.products.unshift(product);
  addToSuggestions(product);
  saveData();
  
  nameInput.value = '';
  priceInput.value = '';
  nameInput.focus();
  
  if (navigator.vibrate) navigator.vibrate(40);

  // Aviso si se escribio algo que no se pudo interpretar como precio.
  if (String(rawPrice).trim() !== '' && price === 0) {
    showToast('Precio no válido, se guardó como 0', 'warning');
    return; // el precio ya se rechazo: no encima otro aviso encima
  }
  showToast('Producto agregado', 'success');
  checkBudgetAlerts();
}

/** IDs numericos y monotonos: se interpolan sin comillas en los onclick inline. */
function nextId() {
  lastId = Math.max(lastId + 1, Date.now());
  return lastId;
}

function toggleBought(id) {
  const product = state.products.find(p => p.id === id);
  if (product) {
    product.bought = !product.bought;
    
    const idx = state.products.indexOf(product);
    state.products.splice(idx, 1);
    if (product.bought) {
      state.products.push(product);
    } else {
      state.products.unshift(product);
    }
    
    saveData();
    if (navigator.vibrate) navigator.vibrate(30);
    checkBudgetAlerts();
  }
}

function changeQuantity(id, delta) {
  const product = state.products.find(p => p.id === id);
  if (product && product.quantity + delta > 0) {
    product.quantity += delta;
    saveData();
    if (navigator.vibrate) navigator.vibrate(20);
    checkBudgetAlerts();
  }
}

function openEdit(id) {
  const product = state.products.find(p => p.id === id);
  if (!product) return;
  
  document.getElementById('editId').value = product.id;
  document.getElementById('editName').value = product.name;
  document.getElementById('editPrice').value = product.price;
  document.getElementById('editQty').value = product.quantity;
  document.getElementById('editCategory').value = categories[product.category] ? product.category : 'otros';
  
  document.getElementById('editModal').classList.add('active');
}

function saveEdit() {
  const id = parseInt(document.getElementById('editId').value);
  const product = state.products.find(p => p.id === id);
  if (!product) return;

  const name = document.getElementById('editName').value.trim().slice(0, 120);
  if (!name) {
    showToast('El nombre no puede quedar vacío', 'warning');
    return;
  }
  const rawQty = document.getElementById('editQty').value;
  if (parseInt(rawQty, 10) < 1) {
    showToast('La cantidad debe ser 1 o mayor', 'warning');
    return;
  }
  const rawPrice = document.getElementById('editPrice').value;
  const price = parseMoney(rawPrice);
  if (String(rawPrice).trim() !== '' && price === 0) {
    showToast('Precio no válido, se guardará como 0', 'warning');
  }

  const selectedCat = document.getElementById('editCategory').value;
  product.name = name;
  product.price = price;
  product.quantity = parseQty(rawQty);
  product.category = categories[selectedCat] ? selectedCat : 'otros';
  
  saveData();
  closeModal();
  showToast('Producto actualizado');
  checkBudgetAlerts();
}

/** Borra un producto con opción de deshacer (sin confirm()). */
function deleteProduct(id) {
  const index = state.products.findIndex(p => p.id === id);
  if (index === -1) return;
  const [product] = state.products.splice(index, 1);
  saveData();
  if (navigator.vibrate) navigator.vibrate(20);
  showToast(`"${product.name}" eliminado`, 'warning', () => {
    state.products.splice(Math.min(index, state.products.length), 0, product);
    saveData();
    showToast('Producto restaurado');
  });
}

function addProductToSuggestions(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;
  
  const added = addToSuggestions(product);
  if (added) {
    showToast(icon('star') + ' Agregado a sugerencias', 'star');
    if (navigator.vibrate) navigator.vibrate([50, 30, 50]);
    
    const btn = document.querySelector(`[data-product-id="${productId}"].add-suggestion-float`);
    if (btn) {
      btn.classList.add('added');
      btn.innerHTML = icon('check');
      btn.title = 'Ya en sugerencias';
    }
  } else {
    showToast('Este producto ya está en sugerencias', 'warning');
  }
}

function clearAll() {
  // El mensaje anterior decia "de hoy" pero state.date puede ser cualquier fecha
  // cargada desde el historial o la configuracion.
  const previous = [...state.products];
  if (previous.length === 0) {
    closeModal();
    showToast('La lista ya está vacía');
    return;
  }
  state.products = [];
  saveData();
  closeModal();
  showToast(`${previous.length} producto(s) eliminado(s)`, 'warning', () => {
    state.products = previous;
    saveData();
    showToast('Lista restaurada');
  });
}

// ========== RENDER ==========
function render() {
  const list = document.getElementById('productList');
  const empty = document.getElementById('emptyState');
  
  if (state.products.length === 0) {
    list.innerHTML = '';
    empty.classList.remove('hidden');
    updateProgress();
    return;
  }
  
  empty.classList.add('hidden');
  list.innerHTML = '';
  
  const suggestionNames = state.suggestions.map(s => s.name.toLowerCase());
  
  state.products.forEach(product => {
    // getCategory evita el TypeError que rompia todo el render si la categoría no existe.
    const cat = getCategory(product.category);
    const isInSuggestions = suggestionNames.includes(product.name.toLowerCase());
    const safeName = escapeHtml(product.name);
    const card = document.createElement('div');
    card.className = `product-card ${product.bought ? 'bought' : ''}`;
    
    card.innerHTML = `
      ${!isInSuggestions ? `
        <button class="add-suggestion-float" 
                data-product-id="${product.id}"
                onclick="addProductToSuggestions(${product.id})" 
                title="Agregar a sugerencias"
                aria-label="Agregar ${safeName} a las sugerencias rápidas">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
          </svg>
        </button>
      ` : ''}
      
      <div class="product-main">
        <div class="checkbox-wrapper">
          <input type="checkbox" ${product.bought ? 'checked' : ''} 
                 onchange="toggleBought(${product.id})"
                 aria-label="Marcar ${safeName} como comprado">
          <div class="checkbox-visual" aria-hidden="true"><svg class="icon icon-inline"><use href="#i-check"/></svg></div>
        </div>
        
        <div class="product-info">
          <div class="product-name">${safeName}</div>
          <div class="product-meta">
            <span class="category-badge cat-chip" style="color:${cat.color}">${icon(cat.icon)} ${cat.label}</span>
            <span class="unit-price">$${product.price.toFixed(2)} c/u</span>
          </div>
          <div class="supermarket-details">
            <span><svg class="icon" aria-hidden="true"><use href="#i-wallet"/></svg> $${product.price.toFixed(2)}</span>
            <span><svg class="icon" aria-hidden="true"><use href="#i-box"/></svg> ${product.quantity} unidad${product.quantity > 1 ? 'es' : ''}</span>
          </div>
        </div>
        
        <div class="card-actions">
          <button class="action-btn edit" onclick="openEdit(${product.id})" title="Editar"
                  aria-label="Editar ${safeName}">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M20 14.66V20a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5.34" />
              <polygon points="18 2 22 6 12 16 8 16 8 12 18 2" />
            </svg>
          </button>
          <button class="action-btn delete" onclick="deleteProduct(${product.id})" title="Eliminar"
                  aria-label="Eliminar ${safeName}">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0h10" />
              <line x1="10" y1="11" x2="10" y2="17" />
              <line x1="14" y1="11" x2="14" y2="17" />
            </svg>
          </button>
        </div>
      </div>
      
      <div class="product-footer">
        <div class="qty-section">
          <span class="qty-label" id="qtyLabel_${product.id}">Cantidad</span>
          <div class="qty-controls" role="group" aria-labelledby="qtyLabel_${product.id}">
            <button class="qty-btn" onclick="changeQuantity(${product.id}, -1)"
                    aria-label="Quitar una unidad de ${safeName}">&minus;</button>
            <span class="qty-value">${product.quantity}</span>
            <button class="qty-btn" onclick="changeQuantity(${product.id}, 1)"
                    aria-label="Añadir una unidad de ${safeName}">+</button>
          </div>
          <div class="qty-display">
            <span class="qty-big">${product.quantity}</span>
            <span class="qty-label-sm">unidad${product.quantity > 1 ? 'es' : ''}</span>
          </div>
        </div>
        
        <div class="total-section">
          <div class="total-label">Total</div>
          <div class="total-price">$${(product.price * product.quantity).toFixed(2)}</div>
        </div>
      </div>
    `;
    
    list.appendChild(card);
  });
  
  updateProgress();
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function categoryTotals() {
  const totals = {};
  Object.keys(categories).forEach(cat => { totals[cat] = 0; });
  state.products.forEach(p => {
    const cat = categories[p.category] ? p.category : 'otros';
    totals[cat] += parseMoney(p.price) * parseQty(p.quantity);
  });
  return totals;
}

function updateProgress() {
  const total = state.products.reduce((sum, p) => sum + (p.price * p.quantity), 0);
  const bought = state.products.filter(p => p.bought).length;
  const totalItems = state.products.length;
  const percent = totalItems > 0 ? (bought / totalItems) * 100 : 0;
  
  document.getElementById('progressText').textContent = `${bought} de ${totalItems} productos`;
  document.getElementById('progressPercent').textContent = `${Math.round(percent)}%`;
  
  const bar = document.getElementById('progressBar');
  bar.style.width = `${percent}%`;
  bar.className = 'progress-bar-fill';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuenow', String(Math.round(percent)));
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-label', 'Progreso de la compra');
  
  document.getElementById('budgetDisplay').textContent = `$${state.budget.toFixed(2)}`;
  document.getElementById('spentDisplay').textContent = `$${total.toFixed(2)}`;
  
  const remaining = state.budget - total;
  const remainingBox = document.getElementById('remainingBox');
  const remainingDisplay = document.getElementById('remainingDisplay');
  
  remainingDisplay.textContent = `$${remaining.toFixed(2)}`;
  remainingBox.className = 'budget-item';
  
  if (state.budget > 0) {
    const ratio = total / state.budget;
    if (ratio >= 1) {
      bar.classList.add('danger');
      remainingBox.classList.add('danger');
    } else if (ratio >= 0.8) {
      bar.classList.add('warning');
      remainingBox.classList.add('warning');
    }
  }

  updateCategoryBudgetWarnings();
}

/** Marca en la cabecera las categorias que se han pasado de su propio limite. */
function updateCategoryBudgetWarnings() {
  if (!state.budgets || Object.keys(state.budgets).length === 0) return;
  const totals = categoryTotals();
  Object.keys(state.budgets).forEach(cat => {
    const cap = state.budgets[cat];
    const spent = totals[cat] || 0;
    const el = document.getElementById(`spentBox_${cat}`);
    if (!el || cap <= 0) return;
    const ratio = spent / cap;
    el.className = 'cat-budget-value';
    if (ratio >= 1) {
      el.classList.add('danger');
      el.title = `${getCategory(cat).label}: excedido por $${(spent - cap).toFixed(2)}`;
    } else if (ratio >= 0.8) {
      el.classList.add('warning');
      el.title = `${getCategory(cat).label}: llevas el ${Math.round(ratio * 100)}%`;
    } else {
      el.title = `${getCategory(cat).label}: $${spent.toFixed(2)} de $${cap.toFixed(2)}`;
    }
  });
}

/**
 * Avisa al cruzar el umbral de presupuesto.
 *
 * El numerador es el TOTAL DE LA LISTA (todo lo añadido, compre o no), no lo
 * gastado: la UI separa PRESUPUESTO de GASTADO y el aviso salta al plan de
 * compra. Por eso solo tiene sentido llamarla desde acciones que cambian ese
 * total —añadir, editar, cambiar cantidad, marcar— y NO desde un guardado o una
 * carga, que dispara un toast sin que el usuario haya hecho nada.
 */
function checkBudgetAlerts() {
  const total = state.products.reduce((sum, p) => sum + (p.price * p.quantity), 0);
  if (state.budget > 0) {
    const ratio = total / state.budget;
    if (ratio >= 1 && ratio < 1.01) {
      showToast(icon('warning') + ' ¡Presupuesto excedido!', 'danger');
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
      return;
    } else if (ratio >= 0.8 && ratio < 0.81) {
      showToast(icon('warning') + ' Has usado el 80% del presupuesto', 'warning');
      return;
    }
  }
  // Aviso por categoria: se comprueba el cruce del limite de cada una.
  const totals = categoryTotals();
  Object.keys(state.budgets || {}).forEach(cat => {
    const cap = state.budgets[cat];
    if (cap <= 0) return;
    const ratio = (totals[cat] || 0) / cap;
    if (ratio >= 1 && ratio < 1.01) {
      showToast(icon('warning') + ` ${getCategory(cat).label}: presupuesto de categoría excedido`, 'danger');
      if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
    } else if (ratio >= 0.8 && ratio < 0.81) {
      showToast(icon('warning') + ` ${getCategory(cat).label}: 80% de su presupuesto`, 'warning');
    }
  });
}

// ========== MODO SUPERMERCADO ==========
function toggleSupermarketMode() {
  state.supermarketMode = !state.supermarketMode;
  document.body.classList.toggle('supermarket-mode', state.supermarketMode);
  document.getElementById('modeBtn').innerHTML = state.supermarketMode 
    ? '<svg viewBox="0 0 24 24"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M14 4v10.54a4 4 0 1 1-4 0V4M8 2h8"/></svg>';
  document.getElementById('controlsPanel').classList.toggle('hidden', state.supermarketMode);
  document.querySelector('.suggestions-section').classList.toggle('hidden', state.supermarketMode);
  syncToggleAria();
  showToast(state.supermarketMode ? 'Modo Supermercado activado' : 'Modo Edición activado');
}

// ========== VISTAS ==========
const VIEWS = ['list', 'stats', 'history'];

function switchView(view) {
  document.querySelectorAll('.nav-item').forEach((btn, idx) => {
    const isActive = VIEWS[idx] === view;
    btn.classList.toggle('active', isActive);
    if (isActive) {
      btn.setAttribute('aria-current', 'page');
    } else {
      btn.removeAttribute('aria-current');
    }
  });
  
  if (view === 'stats') {
    renderStats();
  } else if (view === 'history') {
    renderHistory();
  }
}

function renderStats() {
  setModalTitle(icon('chart') + ' Estadísticas');
  const total = state.products.reduce((sum, p) => sum + (p.price * p.quantity), 0);
  const bought = state.products.filter(p => p.bought).length;
  const pending = state.products.length - bought;
  
  let html = `
    <div class="stat-grid">
      <div class="stat-card-simple">
        <div class="stat-value">$${total.toFixed(2)}</div>
        <div class="stat-label">Total Gastado</div>
      </div>
      <div class="stat-card-simple">
        <div class="stat-value">${state.products.length}</div>
        <div class="stat-label">Productos</div>
      </div>
      <div class="stat-card-simple">
        <div class="stat-value stat-value-ok">${bought}</div>
        <div class="stat-label">Comprados</div>
      </div>
      <div class="stat-card-simple">
        <div class="stat-value stat-value-warn">${pending}</div>
        <div class="stat-label">Pendientes</div>
      </div>
    </div>
  `;
  
  const catTotals = {};
  state.products.forEach(p => {
    // Normaliza la clave: antes una categoria desconocida rompia el render del donut.
    const cat = categories[p.category] ? p.category : 'otros';
    if (!catTotals[cat]) catTotals[cat] = { total: 0, products: [] };
    catTotals[cat].total += parseMoney(p.price) * parseQty(p.quantity);
    catTotals[cat].products.push(p);
  });
  
  if (total > 0 && Object.keys(catTotals).length > 0) {
    let gradient = [];
    let currentAngle = 0;
    // El color vive en categories[cat].color; no duplicar la paleta aqui o el
    // donut se queda desincronizado al cambiar el tema.
    Object.entries(catTotals).forEach(([cat, data]) => {
      const percent = (data.total / total) * 100;
      const color = getCategory(cat).color;
      gradient.push(`${color} ${currentAngle}% ${currentAngle + percent}%`);
      currentAngle += percent;
    });
    
    html += `
      <div class="chart-container">
        <div class="donut-chart" style="background: conic-gradient(${gradient.join(', ')});" role="img"
             aria-label="Reparto del gasto por categoría">
          <div class="donut-hole">
            <div class="donut-value">$${total.toFixed(2)}</div>
            <div class="donut-label">Total</div>
          </div>
        </div>
      </div>
      <div class="chart-legend">
    `;
    
    Object.entries(catTotals).sort((a, b) => b[1].total - a[1].total).forEach(([cat, data]) => {
      const info = getCategory(cat);
      const percent = ((data.total / total) * 100).toFixed(1);
      html += `
        <div class="legend-item">
          <div class="legend-color" style="background: ${info.color}"></div>
          <span class="legend-text"><span class="cat-chip" style="color:${info.color}">${icon(info.icon)}</span> ${info.label}</span>
          <span class="legend-value">$${data.total.toFixed(2)} (${percent}%)</span>
        </div>
      `;
    });
    
    html += '</div>';
  }
  
  html += '<div class="mt-5"><div class="section-heading">' + icon('layers') + ' Detalle por Categoría</div>';
  
  Object.entries(catTotals).sort((a, b) => b[1].total - a[1].total).forEach(([cat, data]) => {
    const info = getCategory(cat);
    const percent = total > 0 ? (data.total / total * 100).toFixed(1) : 0;
    
    html += `
      <div class="category-detail">
        <div class="category-header">
          <div class="category-title">
            <span class="cat-title-icon">${icon(info.icon)}</span>
            <span>${info.label}</span>
          </div>
          <div class="category-total">
            <div class="category-amount">$${data.total.toFixed(2)}</div>
            <div class="category-percent">${percent}% del total</div>
          </div>
        </div>
        ${renderCategoryBudgetBar(cat, data.total)}
        <div class="product-detail-list">
    `;
    
    data.products.forEach(p => {
      const itemTotal = (parseMoney(p.price) * parseQty(p.quantity)).toFixed(2);
      html += `
        <div class="product-detail-item">
          <div class="product-detail-name ${p.bought ? 'product-detail-bought' : ''}">
            ${p.bought ? icon('check', 'inline') + ' ' : icon('circle', 'icon-inline') + ' '}${escapeHtml(p.name)}
            <span class="product-detail-info">(${parseQty(p.quantity)} × $${parseMoney(p.price).toFixed(2)})</span>
          </div>
          <div class="product-detail-price">$${itemTotal}</div>
        </div>
      `;
    });
    
    html += '</div></div>';
  });
  
  if (Object.keys(catTotals).length === 0) {
    html += '<div style="color: var(--text-secondary); text-align: center; padding: 40px; font-weight: 600;">No hay datos para mostrar</div>';
  }
  
  html += '</div>';
  
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('statsModal').classList.add('active');
}

/** Barra de limite por categoria, o nada si esa categoria no tiene presupuesto. */
function renderCategoryBudgetBar(cat, spent) {
  const cap = state.budgets[cat];
  if (!cap || cap <= 0) return '';
  const ratio = spent / cap;
  const cls = ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : '';
  const pct = Math.min(100, Math.round(ratio * 100));
  return `
    <div class="cat-budget">
      <div class="cat-budget-head">
        <span>Límite ${getCategory(cat).label}</span>
        <span class="cat-budget-value ${cls}">$${spent.toFixed(2)} / $${cap.toFixed(2)}</span>
      </div>
      <div class="cat-budget-track">
        <div class="cat-budget-fill ${cls}" style="width: ${pct}%"></div>
      </div>
    </div>
  `;
}

function renderHistory() {
  setModalTitle(icon('history') + ' Historial');
  
  const today = getLocalDate();
  const keys = Object.keys(localStorage)
    .filter(k => k.startsWith('compralist_'))
    .filter(k => {
      const dateStr = k.replace('compralist_', '');
      return isValidDate(dateStr) && dateStr <= today;
    })
    .sort()
    .reverse();
  
  let html = '';
  
  if (keys.length === 0) {
    html = `
      <div class="empty history-empty">
        <div class="empty-icon"><svg class="icon icon-xl" aria-hidden="true"><use href="#i-history"/></svg></div>
        <div style="font-size: 1.2rem; font-weight: 700; margin-bottom: 8px;">No tienes listas guardadas aún</div>
        <div style="color: var(--text-secondary);">Las listas que crees aparecerán aquí</div>
      </div>
    `;
  } else {
    html = `
      <div class="stat-grid" style="margin-bottom: 20px;">
        <div class="stat-card-simple" style="grid-column: 1/-1;">
          <div class="stat-value">${keys.length}</div>
          <div class="stat-label">Listas guardadas</div>
        </div>
      </div>
      <div>
    `;
    
    keys.forEach(key => {
      const date = key.replace('compralist_', '');
      const rawData = localStorage.getItem(key);
      const data = safeParse(rawData, null);
      if (!data || typeof data !== 'object') return;

      const products = Array.isArray(data.products) ? normalizeProducts(data.products) : [];
      const budget = parseMoney(data.budget);
      const catBudgets = normalizeBudgets(data.budgets);
      const budgetsTotal = Object.values(catBudgets).reduce((a, b) => a + b, 0);
      const capLabel = budgetsTotal > 0
        ? `Límites: $${budgetsTotal.toFixed(2)}`
        : `Presupuesto: $${budget.toFixed(2)}`;

      const total = products.reduce((sum, p) => sum + (p.price * p.quantity), 0);
      const isToday = date === today;
      const longDate = formatDateLong(date);
      
      html += `
        <div class="history-item">
          <div class="history-info" role="button" tabindex="0"
               onclick="loadHistory('${date}')"
               onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();loadHistory('${date}')}"
               aria-label="Cargar la lista del ${longDate}">
            <div class="history-date">${isToday ? icon('pin', 'icon-inline') + ' ' : ''}${longDate}</div>
            <div class="history-meta">${products.length} productos • ${capLabel} • Total $${total.toFixed(2)}</div>
          </div>
          <div style="display: flex; align-items: center; gap: 8px;">
            <div class="history-amount" role="button" tabindex="0"
                 onclick="loadHistory('${date}')"
                 onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();loadHistory('${date}')}"
                 aria-label="Cargar la lista del ${longDate}">$${total.toFixed(2)}</div>
            <button class="history-delete" onclick="deleteHistory('${date}', event)"
                    title="Eliminar lista" aria-label="Eliminar la lista del ${longDate}"><svg class="icon" aria-hidden="true"><use href="#i-trash"/></svg></button>
          </div>
        </div>
      `;
    });
    
    html += '</div>';
  }
  
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('statsModal').classList.add('active');
}

function loadHistory(date) {
  if (!isValidDate(date)) return;
  state.date = date;
  loadData();
  closeModal();
  showToast('Lista cargada correctamente');
  switchView('list');
}

/** Elimina una lista del historial con opción de deshacer. */
function deleteHistory(date, event) {
  if (event) event.stopPropagation();
  const key = `compralist_${date}`;
  const raw = localStorage.getItem(key);
  if (raw == null) return;
  localStorage.removeItem(key);
  renderHistory();
  showToast(`Lista del ${formatDateLong(date)} eliminada`, 'warning', () => {
    localStorage.setItem(key, raw);
    renderHistory();
    showToast('Lista restaurada');
  });
}

// ========== MODALES ==========
function openConfig() {
  updateSuggestionsBadges();
  syncConfigInputs();
  renderQuarantine();
  document.getElementById('configModal').classList.add('active');
}

function closeModal(e) {
  if (!e || e.target.classList.contains('modal') || e.target.classList.contains('close-btn')) {
    document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
  }
}

// ========== COMPARTIR ==========

/** Texto plano de la lista actual, listo para WhatsApp/SMS/correo. */
function buildShareText() {
  const lines = [];
  lines.push(`CompraLIST · ${formatDateLong(state.date)}`);
  lines.push('');
  if (state.products.length === 0) {
    lines.push('(lista vacía)');
  } else {
    state.products.forEach(p => {
      const cat = getCategory(p.category);
      const mark = p.bought ? 'x' : ' ';
      const qty = p.quantity > 1 ? ` x${p.quantity}` : '';
      const price = p.price > 0 ? ` — $${(p.price * p.quantity).toFixed(2)}` : '';
      lines.push(`[${mark}] ${p.name}${qty} (${cat.label})${price}`);
    });
  }
  const total = state.products.reduce((sum, p) => sum + (p.price * p.quantity), 0);
  const bought = state.products.filter(p => p.bought).length;
  lines.push('');
  lines.push(`${bought} de ${state.products.length} comprados`);
  if (total > 0) lines.push(`Total: $${total.toFixed(2)}`);
  if (state.budget > 0) lines.push(`Presupuesto: $${state.budget.toFixed(2)}`);
  return lines.join('\n');
}

function shareList() {
  const text = buildShareText();
  const title = `Lista de compras · ${formatDateLong(state.date)}`;

  if (navigator.share) {
    navigator.share({ title, text }).catch(err => {
      if (err && err.name === 'AbortError') return;
      copyToClipboard(text);
    });
    return;
  }
  copyToClipboard(text);
}

function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text)
      .then(() => showToast('Lista copiada al portapapeles', 'success'))
      .catch(() => legacyCopy(text));
    return;
  }
  legacyCopy(text);
}

function legacyCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch (err) { ok = false; }
  document.body.removeChild(ta);
  showToast(ok ? 'Lista copiada al portapapeles' : 'No se pudo copiar; usa Exportar', ok ? 'success' : 'danger');
}

// ========== EXPORT/IMPORT ==========
function exportData() {
  const data = {
    exportDate: new Date().toISOString(),
    app: 'CompraLIST Pro',
    version: 2,
    suggestions: state.suggestions,
    lists: {}
  };
  
  // Solo claves de lista con fecha, y sin dejar que un payload roto tumbe la exportacion.
  Object.keys(localStorage).forEach(key => {
    const match = key.match(LIST_KEY_RE);
    if (!match || !isValidDate(match[1])) return;
    const parsed = safeParse(localStorage.getItem(key), null);
    if (parsed) data.lists[key] = parsed;
  });
  
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `compralist_backup_${getLocalDate()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  
  showToast('Datos exportados');
}

function importData() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json';
  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => {
      const data = safeParse(event.target.result, null);
      if (!data || typeof data !== 'object') {
        showToast('El archivo no es un JSON válido', 'danger');
        return;
      }
      if (data.app && data.app !== 'CompraLIST Pro') {
        showToast('El archivo no pertenece a CompraLIST', 'warning');
        return;
      }

      if (Array.isArray(data.suggestions)) {
        state.suggestions = normalizeSuggestions(data.suggestions);
        saveSuggestions();
      }
      
      let count = 0;
      if (data.lists && typeof data.lists === 'object') {
        Object.entries(data.lists).forEach(([key, value]) => {
          // Solo se aceptan claves con fecha valida: un backup manipulado no debe
          // poder sembrar preferences (por ejemplo compralist_dark).
          const match = key.match(LIST_KEY_RE);
          if (!match || !isValidDate(match[1])) return;
          if (!value || typeof value !== 'object') return;
          const normalized = {
            products: normalizeProducts(value.products),
            budget: parseMoney(value.budget),
            budgets: normalizeBudgets(value.budgets),
            date: match[1]
          };
          localStorage.setItem(key, JSON.stringify(normalized));
          count++;
        });
      }
      loadData();
      showToast(count > 0 ? `${count} lista(s) importada(s)` : 'No había listas válidas en el archivo', count > 0 ? 'success' : 'warning');
    };
    reader.readAsText(file);
  };
  input.click();
}

// ========== TOAST ==========

/**
 * Toast con acción opcional de deshacer.
 * Acepta la acción como función suelta o como {label, onClick}.
 * @param {string} message
 * @param {'success'|'warning'|'danger'|'star'} type
 * @param {?(Function|{label?: string, onClick: Function})} action
 */
function showToast(message, type = 'success', action = null) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  clearTimeout(toastTimer);

  const onClick = typeof action === 'function'
    ? action
    : (action && typeof action.onClick === 'function' ? action.onClick : null);
  const label = (action && typeof action === 'object' && action.label) || 'Deshacer';

  // Guarda el último deshacer para el atajo Ctrl/Cmd+Z.
  lastUndo = onClick;

  // Acepta HTML a proposito: los mensajes llevan el icono del sprite. Todo lo que
  // se interpola aqui viene de icon() o de getCategory().label ya escapado.
  toast.innerHTML = '<span class="toast-text">' + message + '</span>';

  if (onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'toast-action';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      hideToast();
      onClick();
    });
    toast.appendChild(btn);
  }

  toast.className = `toast ${type} show`;

  // Con acción se necesita más tiempo para que el usuario pulse "Deshacer".
  toastTimer = setTimeout(hideToast, onClick ? 7000 : 3000);
}

/** Escribe el título del modal de stats/historial aceptando HTML (para el icono). */
function setModalTitle(html) {
  const el = document.getElementById('modalTitle');
  if (el) el.innerHTML = html;
}

function hideToast() {
  clearTimeout(toastTimer);
  const toast = document.getElementById('toast');
  if (toast) toast.classList.remove('show');
}

// Atajos de teclado: Escape cierra modales, Ctrl/Cmd+Z deshace el último borrado.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && runLastUndo()) {
    e.preventDefault();
  }
});

function runLastUndo() {
  if (typeof lastUndo !== 'function') return false;
  const fn = lastUndo;
  lastUndo = null;
  hideToast();
  fn();
  return true;
}

// Evita que Escape en un input numérico propagate rarezas de iOS.
document.addEventListener('gesturestart', function (e) {
  e.preventDefault();
});