import { readdirSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Borra los iconos del launcher que trae la plantilla de Capacitor, para que los
 * nuestros sean los unicos. La plantilla de 7.4.3 deja:
 *
 *   mipmap-*dpi/ic_launcher.png, ic_launcher_round.png
 *   mipmap-*dpi/ic_launcher_foreground.png
 *   mipmap-anydpi-v26/ic_launcher.xml, ic_launcher_round.xml
 *   values/ic_launcher_background.xml
 *   drawable/ic_launcher_background.xml
 *   drawable-v24/ic_launcher_foreground.xml   <-- la que mas se cuela
 *
 * El del drawable-v24 es el importante: una carpeta con sufijo de version tiene
 * PRIORIDAD sobre drawable/ en API 24+, asi que si sobrevive, el fondo acaba
 * siendo el nuestro pero el simbolo el logo de Capacitor.
 *
 * Esto es un script y no un `find ... -delete` en el YAML por dos motivos:
 *  1. Es portable: `find` no existe en Windows y el test que lo verifica corre
 *     en Windows, asi que con find no se podria comprobar el orden.
 *  2. El orden importa en las dos direcciones y ya se ha roto las dos:
 *       - borrar DESPUES de generar se lleva los PNG del generador y el APK sale
 *         con cero iconos propios
 *       - borrar ANTES de generar es lo correcto
 *     Con la logica aqui se puede testear de verdad en vez de cruzarse.
 *
 *   node tools/purge-launcher-icons.mjs android/app/src/main/res
 */

const raiz = process.argv[2];
if (!raiz) {
  console.error('uso: node tools/purge-launcher-icons.mjs <carpeta res/>');
  process.exit(1);
}

const PATRON = /^ic_launcher/;
let borrados = 0;

function recorrer(dir) {
  for (const entrada of readdirSync(dir)) {
    const ruta = join(dir, entrada);
    if (statSync(ruta).isDirectory()) {
      recorrer(ruta);
    } else if (PATRON.test(entrada)) {
      unlinkSync(ruta);
      borrados++;
      console.log('  borrado  ' + ruta.replace(raiz + '/', '').replace(raiz + '\\', ''));
    }
  }
}

try {
  recorrer(raiz);
  console.log(`ok  ${borrados} icono(s) de la plantilla eliminado(s) de ${raiz}`);
} catch (e) {
  console.error('ERROR: ' + e.message);
  process.exit(1);
}
