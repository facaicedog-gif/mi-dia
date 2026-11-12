// horario.ts — cuándo se le puede avisar a alguien de algo de ATLAS (2026-11-12).
//
// COPIA de atlas_deploy/netlify/lib/horario-avisos.js (Regla 7: se copia byte a byte lo que funciona, no se reescribe).
// La regla es de Fabián (4-oct): «de lunes a viernes, de 8 a 5, no más», sin festivos de Colombia. Lo que cae fuera
// sale a la primera hora hábil. Se aplica SÓLO a lo que viene de Atlas: las tareas propias de Mi día suenan a la hora
// que la persona les puso, como siempre.
// La prueba atlas_deploy/tests/midia-horario.test.js carga este archivo y lo compara con el de Atlas en 400 instantes.
// Si cambias una línea aquí, cámbiala allá (y al revés), o esa prueba falla.

const CO_MS = 5 * 3600 * 1000;
const HORA_ABRE = 8;
const HORA_CIERRA = 17;   // a las 17:00 ya no
const DIA = 86400000;

function relojCo(t: number) {
  const co = new Date(t - CO_MS);
  const y = co.getUTCFullYear(), m = co.getUTCMonth(), d = co.getUTCDate();
  return {
    y, m, d,
    dow: co.getUTCDay(),
    hora: co.getUTCHours(),
    minuto: co.getUTCMinutes(),
    clave: y + '-' + String(m + 1).padStart(2, '0') + '-' + String(d).padStart(2, '0')
  };
}
function pascua(y: number) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31) - 1;
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return Date.UTC(y, mes, dia);
}
const clave = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const alLunes = (ms: number) => ms + ((8 - new Date(ms).getUTCDay()) % 7) * DIA;
const _festivos: Record<number, Set<string>> = {};
function festivosColombia(y: number) {
  if (_festivos[y]) return _festivos[y];
  const P = pascua(y);
  const fijos = [[0, 1], [4, 1], [6, 20], [7, 7], [11, 8], [11, 25]].map(([m, d]) => Date.UTC(y, m, d));
  const corridos = [[0, 6], [2, 19], [5, 29], [7, 15], [9, 12], [10, 1], [10, 11]].map(([m, d]) => alLunes(Date.UTC(y, m, d)));
  const santos = [P - 3 * DIA, P - 2 * DIA];
  const moviles = [39, 60, 68].map((n) => alLunes(P + n * DIA));
  _festivos[y] = new Set([...fijos, ...corridos, ...santos, ...moviles].map(clave));
  return _festivos[y];
}
export function enHorario(t: number) {
  const r = relojCo(t);
  if (r.dow === 0 || r.dow === 6) return false;
  if (r.hora < HORA_ABRE || r.hora >= HORA_CIERRA) return false;
  return !festivosColombia(r.y).has(r.clave);
}
// Propio de Mi día (no está en Atlas): el instante dado si está en horario; si no, la siguiente apertura hábil (8:00).
export function siguienteHabil(t: number) {
  if (enHorario(t)) return t;
  const r = relojCo(t);
  let dia = Date.UTC(r.y, r.m, r.d) + HORA_ABRE * 3600 * 1000 + CO_MS;   // ese día a las 8:00 de Colombia
  if (dia <= t) dia += DIA;
  for (let i = 0; i < 15 && !enHorario(dia); i++) dia += DIA;
  return dia;
}
