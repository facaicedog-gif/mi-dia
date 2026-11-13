// Mi día · servidor de avisos push.
// Guarda los recordatorios futuros de cada dispositivo y los envía a su hora,
// aunque la app esté cerrada. Las tablas están cerradas al navegador: sólo esta
// función (con la llave de servicio) las lee y escribe.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";
import { enHorario, siguienteHabil } from "./horario.ts";

const db = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);
const SUBJECT = Deno.env.get("SUPABASE_URL")!;
const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function secret(clave: string): Promise<string | null> {
  const { data } = await db.from("midia_secretos").select("valor").eq("clave", clave).maybeSingle();
  return data?.valor ?? null;
}

// Las claves de firma se crean solas la primera vez y nunca salen del servidor.
async function vapid() {
  let pub = await secret("vapid_pub"), priv = await secret("vapid_priv");
  if (!pub || !priv) {
    const k = webpush.generateVAPIDKeys();
    await db.from("midia_secretos").upsert(
      [{ clave: "vapid_pub", valor: k.publicKey }, { clave: "vapid_priv", valor: k.privateKey }],
      { onConflict: "clave", ignoreDuplicates: true },
    );
    pub = await secret("vapid_pub");
    priv = await secret("vapid_priv");
  }
  return { pub: pub!, priv: priv! };
}

type Dev = { device: string; endpoint: string; p256dh: string; auth: string };

async function send(dev: Dev, payload: Record<string, unknown>): Promise<number> {
  const v = await vapid();
  try {
    const r = await webpush.sendNotification(
      { endpoint: dev.endpoint, keys: { p256dh: dev.p256dh, auth: dev.auth } },
      JSON.stringify(payload),
      { vapidDetails: { subject: SUBJECT, publicKey: v.pub, privateKey: v.priv }, TTL: 3600, urgency: "high" },
    );
    return r.statusCode;
  } catch (e) {
    const code = (e as { statusCode?: number }).statusCode ?? 0;
    // El servicio de avisos dice que esa suscripción ya no existe: se olvida el dispositivo.
    if (code === 404 || code === 410) await db.from("midia_dispositivos").delete().eq("device", dev.device);
    if (!code) console.error("push", String(e));
    return code;
  }
}

// Sólo se aceptan direcciones de los servicios de avisos de los navegadores.
const HOSTS = [".push.apple.com", ".googleapis.com", ".mozilla.com", ".windows.com"];
function validSub(s: any): boolean {
  try {
    const u = new URL(s.endpoint);
    return u.protocol === "https:" && HOSTS.some((h) => u.hostname.endsWith(h)) &&
      typeof s.keys?.p256dh === "string" && typeof s.keys?.auth === "string" &&
      s.keys.p256dh.length < 200 && s.keys.auth.length < 100;
  } catch {
    return false;
  }
}
const clip = (v: unknown, n: number) => String(v ?? "").slice(0, n);
// A dónde se releva y qué se puede pedir: fijo aquí, la app no elige ni la dirección ni la operación.
const ATLAS_URL = "https://atlas.veltrion.com.co/.netlify/functions/midia-puente";
// 2026-11-11 · + sugeridas, empresa y gestion: el Workspace de bolsillo (maqueta-workspace.html). La lista sigue cerrada.
// 2026-11-12 · + pedir_codigo: el código para conectar llega solo al correo de Atlas (maqueta-conectar.html).
// 2026-11-12 · + tareas: lo que se crea en Mi día con «Ponerla en Atlas» aparece en la agenda de Atlas.
// 2026-11-12 · + toque: tocar Llamar / WhatsApp / Correo en la ficha queda anotado en Atlas, como en el panel.
const ATLAS_OPS = ["canjear", "pedir_codigo", "listar", "cerrar", "reprogramar", "desvincular", "ocupado", "sugeridas", "empresa", "gestion", "tareas", "toque"];

// Quién llama, según su sesión de Mi día. null si no trae sesión o si venció.
type Quien = { id: string; email: string };
async function quien(req: Request): Promise<Quien | null> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt || jwt.split(".").length !== 3) return null;
  const u = await fetch(Deno.env.get("SUPABASE_URL")! + "/auth/v1/user", {
    headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, Authorization: "Bearer " + jwt },
  });
  if (!u.ok) return null;
  const j = await u.json();
  return j?.id ? { id: j.id, email: String(j.email || "") } : null;
}

/* ---------- asignar tareas entre cuentas ---------- */
// El nombre que se muestra es el que la persona puso en su perfil; si no puso, la parte del correo antes de la @.
async function nombreDe(id: string, email: string): Promise<string> {
  const { data } = await db.from("midia_tareas").select("data").eq("user_id", id).eq("id", "_perfil").maybeSingle();
  const n = String((data?.data as any)?.nombre || "").trim().slice(0, 40);
  if (n) return n;
  const p = (email.split("@")[0] || "Alguien").replace(/[._-]+/g, " ").trim();
  return p.charAt(0).toUpperCase() + p.slice(1);
}
async function avisar(user: string, payload: Record<string, unknown>) {
  const { data } = await db.from("midia_dispositivos").select("device,endpoint,p256dh,auth").eq("user_id", user);
  for (const d of data ?? []) await send(d as Dev, payload);
}
const cuando = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("es-CO", {
      timeZone: "America/Bogota", weekday: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    })
    : "sin fecha";
const fecha = (v: unknown) => (typeof v === "string" && !isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);
const texto = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// Lo que ve cada lado: nunca el id de cuenta ni el correo del otro (el correo sólo lo ve quien lo escribió).
function vista(a: any, yo: string) {
  const mio = a.de === yo;
  return {
    id: a.id, mio, titulo: a.titulo, nota: a.nota, due: a.due, fin: a.fin, urgente: a.urgente, importante: a.importante,
    estado: a.estado, motivo: a.motivo, nota_fin: a.nota_fin, due_final: a.due_final, fin_final: a.fin_final,
    creado: a.creado, actualizado: a.actualizado,
    de_nombre: a.de_nombre, para_nombre: a.para_nombre, ...(mio ? { para_correo: a.para_correo } : {}),
    grupo: a.grupo ?? null, ...(a._con ? { con: a._con } : {}),
  };
}
// Avance de una tarea compartida: cuántos la tienen todavía (no rechazada ni cancelada) y cuántos la terminaron.
async function avanceGrupo(grupo: string) {
  const { data } = await db.from("midia_asignaciones").select("para_nombre,estado").eq("grupo", grupo);
  const vivos = (data ?? []).filter((x) => x.estado !== "rechazada" && x.estado !== "cancelada");
  return { total: vivos.length, hechas: vivos.filter((x) => x.estado === "hecha").length, nombres: vivos.map((x) => x.para_nombre) };
}
const MAX_PARA = 5; // personas por tarea compartida
const TOPE_DIA = 40; // envíos por cuenta en 24 h: frena el abuso sin estorbar el uso normal

/* ---------- contactos por invitación ---------- */
const ALFA = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // sin 0/O ni 1/I: se leen y se dictan sin confundirse
const nuevoCodigo = () => Array.from(crypto.getRandomValues(new Uint8Array(8)), (n) => ALFA[n % ALFA.length]).join("");
const limpiaCodigo = (v: unknown) => String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
async function huella(t: string) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return Array.from(new Uint8Array(d), (x) => x.toString(16).padStart(2, "0")).join("");
}
async function correoDe(id: string): Promise<string> {
  const { data } = await db.auth.admin.getUserById(id);
  return String(data?.user?.email ?? "");
}
// Quién invitó, para mostrarlo ANTES de entrar («Fabián te invitó»). Sólo el nombre; nada si venció o ya se usó.
async function verInvitacion(b: any) {
  const c = limpiaCodigo(b.codigo);
  if (c.length !== 8) return json({ ok: false }, 404);
  const { data } = await db.from("midia_invitaciones").select("de_nombre,vence,usado").eq("codigo_hash", await huella(c)).maybeSingle();
  if (!data || data.usado || Date.parse(data.vence) < Date.now()) return json({ ok: false, error: "Esta invitación ya se usó o venció." }, 404);
  return json({ ok: true, nombre: data.de_nombre });
}
const TOPE_INV = 20; // invitaciones por cuenta en 24 h

async function contactos(yo: Quien, b: any) {
  const accion = String(b.accion || "");
  if (accion === "invitar") {
    const desde = new Date(Date.now() - 864e5).toISOString();
    const { count } = await db.from("midia_invitaciones").select("id", { count: "exact", head: true }).eq("de", yo.id).gte("creado", desde);
    if ((count ?? 0) >= TOPE_INV) return json({ ok: false, error: "Llegaste al tope de invitaciones de hoy." }, 429);
    const codigo = nuevoCodigo();
    const { data, error } = await db.from("midia_invitaciones").insert({
      codigo_hash: await huella(codigo), de: yo.id, de_nombre: await nombreDe(yo.id, yo.email),
      vence: new Date(Date.now() + 7 * 864e5).toISOString(),
    }).select("id").single();
    if (error) return json({ ok: false, error: "No se pudo crear la invitación." }, 500);
    return json({ ok: true, codigo, id: data.id });
  }
  if (accion === "aceptar") {
    const c = limpiaCodigo(b.codigo);
    if (c.length !== 8) return json({ ok: false, error: "Esa invitación no es válida." }, 400);
    // Un solo PATCH con todas las condiciones: si dos personas usan el mismo enlace a la vez, sólo una lo logra.
    const { data: inv } = await db.from("midia_invitaciones").update({ usado: new Date().toISOString(), usado_por: yo.id })
      .eq("codigo_hash", await huella(c)).is("usado", null).gt("vence", new Date().toISOString()).neq("de", yo.id)
      .select("id,de,de_nombre").maybeSingle();
    if (!inv) return json({ ok: false, error: "Esta invitación ya se usó, venció o es tuya." }, 404);
    const { data: ya } = await db.from("midia_conexiones").select("a").or(`and(a.eq.${inv.de},b.eq.${yo.id}),and(a.eq.${yo.id},b.eq.${inv.de})`).limit(1);
    if (!ya?.length) await db.from("midia_conexiones").insert({ a: inv.de, b: yo.id, invitacion: inv.id });
    const miNombre = await nombreDe(yo.id, yo.email);
    await avisar(inv.de, { title: miNombre + " aceptó tu invitación", body: "Ya está en tus contactos de Mi día: pueden pasarse tareas.", tag: "inv-" + inv.id });
    return json({ ok: true, contacto: { nombre: inv.de_nombre, correo: await correoDe(inv.de) } });
  }
  if (accion === "conexiones") {
    const { data } = await db.from("midia_conexiones").select("a,b,invitacion,creado").or(`a.eq.${yo.id},b.eq.${yo.id}`).limit(300);
    const out = [];
    for (const x of data ?? []) {
      const otro = x.a === yo.id ? x.b : x.a;
      const correo = await correoDe(otro);
      out.push({ nombre: await nombreDe(otro, correo), correo, invitacion: x.a === yo.id ? x.invitacion : null, desde: x.creado });
    }
    return json({ ok: true, conexiones: out });
  }
  // Fotos de perfil: sólo de quien está conectado contigo (aceptó una invitación) o con quien se han pasado tareas.
  // Así nadie ve la foto de otra persona sólo con saber su correo.
  if (accion === "fotos") {
    const correos = [...new Set((Array.isArray(b.correos) ? b.correos : []).map((c: unknown) => texto(c, 120).toLowerCase()))]
      .filter((c) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c)).slice(0, 30) as string[];
    const out: Record<string, string | null> = {};
    for (const c of correos) {
      out[c] = null;
      const { data: id } = await db.rpc("midia_usuario_por_correo", { correo: c });
      if (!id || id === yo.id) continue;
      const otro = id as string;
      const [k, x] = await Promise.all([
        db.from("midia_conexiones").select("a").or(`and(a.eq.${otro},b.eq.${yo.id}),and(a.eq.${yo.id},b.eq.${otro})`).limit(1),
        db.from("midia_asignaciones").select("id").or(`and(de.eq.${otro},para.eq.${yo.id}),and(de.eq.${yo.id},para.eq.${otro})`).limit(1),
      ]);
      if (!k.data?.length && !x.data?.length) continue;
      const { data: pf } = await db.from("midia_tareas").select("data").eq("user_id", otro).eq("id", "_perfil").maybeSingle();
      const f = String((pf?.data as any)?.photo || "");
      if (f.startsWith("data:image/") && f.length <= 9000) out[c] = f;
    }
    return json({ ok: true, fotos: out });
  }
  if (accion === "existe") {
    const correo = texto(b.correo, 120).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return json({ ok: false, error: "Revisa el correo." }, 400);
    const { data: id } = await db.rpc("midia_usuario_por_correo", { correo });
    return json({ ok: true, usa: !!id, nombre: id ? await nombreDe(id as string, correo) : null });
  }
  return json({ ok: false, error: "Acción no reconocida." }, 400);
}

async function asignar(yo: Quien, b: any) {
  const accion = String(b.accion || "");
  const ahora = new Date().toISOString();

  if (accion === "enviar") {
    // Una persona (`correo`) o varias a la vez (`correos`, hasta MAX_PARA): una tarea compartida.
    const lista = (Array.isArray(b.correos) ? b.correos : [b.correo]).map((c: unknown) => texto(c, 120).toLowerCase());
    const correos = [...new Set(lista.filter(Boolean))].slice(0, MAX_PARA) as string[];
    const titulo = texto(b.titulo, 200);
    if (!correos.length || correos.some((c) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c))) return json({ ok: false, error: "Revisa el correo." }, 400);
    if (!titulo) return json({ ok: false, error: "Escribe la tarea." }, 400);
    if (correos.includes(yo.email.toLowerCase())) return json({ ok: false, error: "Ese correo es el tuyo." }, 400);
    const desde = new Date(Date.now() - 864e5).toISOString();
    const { count } = await db.from("midia_asignaciones").select("id", { count: "exact", head: true })
      .eq("de", yo.id).gte("creado", desde);
    if ((count ?? 0) + correos.length > TOPE_DIA) return json({ ok: false, error: "Llegaste al tope de envíos de hoy." }, 429);
    // Si alguno no tiene cuenta, no se manda a nadie: la app pregunta qué hacer con ese.
    const paras: string[] = [], faltan: string[] = [];
    for (const c of correos) {
      const { data: id } = await db.rpc("midia_usuario_por_correo", { correo: c });
      if (id) paras.push(id as string); else faltan.push(c);
    }
    if (faltan.length) return json({ ok: false, sinCuenta: true, faltan, error: faltan.join(", ") + (faltan.length === 1 ? " no tiene" : " no tienen") + " cuenta en Mi día." });
    const due = fecha(b.due);
    let fin = fecha(b.fin);
    if (due && (!fin || fin <= due)) fin = new Date(Date.parse(due) + 30 * 6e4).toISOString();
    const grupo = paras.length > 1 ? crypto.randomUUID() : null;
    const deNombre = await nombreDe(yo.id, yo.email);
    const filas = [];
    for (let i = 0; i < paras.length; i++) {
      filas.push({
        de: yo.id, de_nombre: deNombre, para: paras[i], para_nombre: await nombreDe(paras[i], correos[i]), para_correo: correos[i],
        titulo, nota: texto(b.nota, 300) || null, due, fin: due ? fin : null,
        urgente: !!b.urgente, importante: b.importante !== false, grupo,
      });
    }
    const { data, error } = await db.from("midia_asignaciones").insert(filas).select();
    if (error || !data?.length) return json({ ok: false, error: "No se pudo guardar." }, 500);
    for (const a of data) {
      const otros = data.filter((x) => x.id !== a.id).map((x) => x.para_nombre);
      await avisar(a.para, {
        title: deNombre + " te asignó una tarea",
        body: titulo + " · " + cuando(due) + (otros.length ? " · compartida con " + otros.join(" y ") : ""), tag: "asg-" + a.id,
      });
    }
    const vistas = data.map((a) => vista(a, yo.id));
    return json({ ok: true, asignacion: vistas[0], asignaciones: vistas });
  }

  if (accion === "listar") {
    const hace = new Date(Date.now() - 30 * 864e5).toISOString();
    const [r, e] = await Promise.all([
      db.from("midia_asignaciones").select("*").eq("para", yo.id).gte("actualizado", hace)
        .order("actualizado", { ascending: false }).limit(150),
      db.from("midia_asignaciones").select("*").eq("de", yo.id)
        .or("estado.in.(pendiente,aceptada),actualizado.gte." + hace)
        .order("actualizado", { ascending: false }).limit(150),
    ]);
    const rec = r.data ?? [];
    const grupos = [...new Set(rec.map((a) => a.grupo).filter(Boolean))];
    if (grupos.length) {
      const { data: g } = await db.from("midia_asignaciones").select("grupo,para,para_nombre").in("grupo", grupos);
      for (const a of rec) if (a.grupo) a._con = (g ?? []).filter((x) => x.grupo === a.grupo && x.para !== yo.id).map((x) => x.para_nombre);
    }
    return json({
      ok: true,
      recibidas: rec.map((a) => vista(a, yo.id)),
      enviadas: (e.data ?? []).map((a) => vista(a, yo.id)),
    });
  }

  const id = String(b.id || "");
  if (!/^[0-9a-f-]{36}$/.test(id)) return json({ ok: false, error: "Tarea no reconocida." }, 400);
  const { data: a } = await db.from("midia_asignaciones").select("*").eq("id", id).maybeSingle();
  if (!a || (a.de !== yo.id && a.para !== yo.id)) return json({ ok: false, error: "Esa tarea ya no existe." }, 404);
  const guardar = async (cambio: Record<string, unknown>) => {
    const { data, error } = await db.from("midia_asignaciones").update({ ...cambio, actualizado: ahora })
      .eq("id", id).select().single();
    if (error) throw new Error("guardar");
    return data;
  };

  // Lo que hace quien la recibió.
  if (a.para === yo.id && (accion === "responder" || accion === "avance")) {
    if (a.estado === "cancelada") return json({ ok: false, cancelada: true, error: a.de_nombre + " la canceló." }, 409);
    if (accion === "responder") {
      if (b.acepta) {
        if (a.estado !== "pendiente") return json({ ok: false, error: "Ya la habías respondido." }, 409);
        const nueva = await guardar({ estado: "aceptada", due_final: fecha(b.due) ?? a.due, fin_final: fecha(b.fin) ?? a.fin });
        await avisar(a.de, { title: a.para_nombre + " aceptó", body: a.titulo + " · " + cuando(nueva.due_final), tag: "asg-" + id });
        return json({ ok: true, asignacion: vista(nueva, yo.id) });
      }
      // rechazar: antes de aceptarla o soltándola después
      if (!["pendiente", "aceptada"].includes(a.estado)) return json({ ok: false, error: "Ya está cerrada." }, 409);
      const motivo = texto(b.motivo, 300) || null;
      const nueva = await guardar({ estado: "rechazada", motivo });
      await avisar(a.de, {
        title: a.para_nombre + " no puede con «" + a.titulo.slice(0, 60) + "»", body: motivo || "Sin motivo", tag: "asg-" + id,
      });
      return json({ ok: true, asignacion: vista(nueva, yo.id) });
    }
    // avance: la marcó hecha, la desmarcó o le cambió la hora
    if (!["aceptada", "hecha"].includes(a.estado)) return json({ ok: false, error: "Primero acéptala." }, 409);
    const cambio: Record<string, unknown> = {};
    if (typeof b.hecha === "boolean") {
      cambio.estado = b.hecha ? "hecha" : "aceptada";
      if (b.hecha) cambio.nota_fin = texto(b.nota, 300) || null;
    }
    if ("due" in b) { cambio.due_final = fecha(b.due); cambio.fin_final = fecha(b.fin); }
    if (!Object.keys(cambio).length) return json({ ok: true, asignacion: vista(a, yo.id) });
    const nueva = await guardar(cambio);
    if (b.hecha === true && a.estado !== "hecha") {
      const g = a.grupo ? await avanceGrupo(a.grupo) : null;
      const parte = g && g.total > 1 ? " · " + g.hechas + " de " + g.total : "";
      await avisar(a.de, { title: "✓ " + a.para_nombre + " terminó", body: a.titulo + (cambio.nota_fin ? " · " + cambio.nota_fin : "") + parte, tag: "asg-" + id });
      if (g && g.total > 1 && g.hechas === g.total) {
        await avisar(a.de, { title: "✓ Todos terminaron", body: a.titulo + " · " + g.nombres.join(" y "), tag: "asg-g-" + a.grupo });
      }
    }
    return json({ ok: true, asignacion: vista(nueva, yo.id) });
  }

  // Lo que hace quien la asignó.
  if (a.de === yo.id && accion === "cancelar") {
    if (!["pendiente", "aceptada"].includes(a.estado)) return json({ ok: false, error: "Ya está cerrada." }, 409);
    const nueva = await guardar({ estado: "cancelada" });
    await avisar(a.para, { title: a.de_nombre + " canceló una tarea", body: a.titulo, tag: "asg-" + id });
    return json({ ok: true, asignacion: vista(nueva, yo.id) });
  }
  if (a.de === yo.id && accion === "recordar") {
    if (!["pendiente", "aceptada"].includes(a.estado)) return json({ ok: false, error: "Ya está cerrada." }, 409);
    if (a.recordado && Date.now() - Date.parse(a.recordado) < 36e5) {
      return json({ ok: false, error: "Ya se lo recordaste hace menos de una hora." }, 429);
    }
    await db.from("midia_asignaciones").update({ recordado: ahora }).eq("id", id);
    await avisar(a.para, {
      title: a.de_nombre + " te recuerda",
      body: a.titulo + (a.estado === "pendiente" ? " · falta que la aceptes" : " · " + cuando(a.due_final ?? a.due)),
      tag: "asg-" + id,
    });
    return json({ ok: true });
  }
  return json({ ok: false, error: "Acción no reconocida." }, 400);
}

/* ---------- la agenda de Atlas, avisada desde aquí (12-nov, maqueta-agenda-compartida.html) ---------- */
// Fabián: «me llegó notificación en Telegram más no en Mi día… con eso nos quitamos Telegram como puente». Antes, este
// servidor sólo conocía los pendientes de Atlas que el celular le pasaba al abrir la app. Ahora los pone él mismo:
//   · con cada «listar» que pasa por el relevo (la foto completa, con contacto y teléfono, como la arma la app);
//   · con cada aviso de la base de Atlas (`atlas_evento`), en el momento en que algo se crea, cambia o se cierra.
// Los de Atlas siguen la regla de horario de Atlas (lun-vie 8-17, sin festivos: horario.ts). Los propios, como siempre.
const ID_ATLAS = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function mismaFirma(a: string, b: string) {
  return (await huella("f:" + a)) === (await huella("f:" + b));   // compara huellas: el tiempo no delata la firma
}
const horaCo = (t: number) => new Date(t).toLocaleTimeString("es-CO", { timeZone: "America/Bogota", hour: "numeric", minute: "2-digit" });
/** El aviso de un pendiente de Atlas, en la forma de `atlasAviso` de la app (título 📞 empresa; quién, teléfono, hora). */
function avisoAtlas(ev: any) {
  const e = ev.empresa && typeof ev.empresa === "object" ? ev.empresa : { nombre: ev.empresa || null };
  const c = ev.contacto || {};
  const tel = String(c.telefono || e.telefono || "").split(/[\/,;|]| y /)[0].trim();
  const quien = c.nombre ? c.nombre + (c.cargo ? " (" + c.cargo + ")" : "") : "";
  const t = Date.parse(ev.fecha);
  return {
    title: clip(e.nombre ? "📞 " + e.nombre : "📞 " + (ev.titulo || "Pendiente de Atlas"), 200),
    body: clip([quien, tel, isNaN(t) ? "" : horaCo(t), e.nombre ? ev.titulo : ""].filter(Boolean).join(" · "), 200),
  };
}
async function dispositivosDe(uid: string): Promise<string[]> {
  const { data } = await db.from("midia_dispositivos").select("device").eq("user_id", uid);
  return (data ?? []).map((d) => d.device);
}
/** Después de un relevo que salió bien: recordar el vínculo, tomar la foto de la agenda o soltar todo al desconectar. */
async function atlasDespues(uid: string, op: string, j: any, enlace: string) {
  const vin = typeof j.vinculo_id === "string" ? j.vinculo_id.slice(0, 64) : "";
  if ((op === "canjear" || op === "listar") && vin) {
    // 12-nov (noche) · Y la llave de la conexión, para que la app la recupere sola (2026-11-12_atlas_recordar.sql). Al
    // conectar viene en la respuesta; con «listar» es la que el celular acaba de usar y Atlas aceptó.
    const llave = op === "canjear" ? String(j.token || "") : enlace;
    const fila: Record<string, unknown> = { vinculo_id: vin, uid, actualizado: new Date().toISOString() };
    if (llave.length >= 40 && llave.length <= 200) fila.token = llave;
    if (typeof j.nombre === "string") fila.nombre = j.nombre.slice(0, 80);
    await db.from("midia_atlas_enlaces").upsert(fila);
  }
  const devs = await dispositivosDe(uid);
  if (op === "desvincular" && j.ok) {
    await db.from("midia_atlas_enlaces").update({ token: null }).eq("uid", uid);   // desconectar es desconectar: no vuelve sola
    // 12-nov (tarde) · El vínculo NO se olvida: con él, «Enviarme el código» sabe a qué usuario de Atlas volver sin que la
    // persona tenga que acordarse de su correo de Atlas (Fabián cerró sesión y el correo de Mi día no era el de Atlas).
    // No da acceso a nada: Atlas sólo avisa a vínculos activos, y el código va al correo de Atlas.
    if (devs.length) {
      await db.from("midia_recordatorios").delete().in("device", devs).like("id", "A:%");
      await db.from("midia_recordatorios").delete().in("device", devs).like("id", "N:%");
    }
    return;
  }
  if (op !== "listar" || !Array.isArray(j.eventos) || !devs.length) return;
  // La foto manda: se reemplazan TODOS los «A:» de esta persona. Los «N:» (aviso de nuevo, en espera) se quedan.
  const ahora = Date.now();
  const filas: any[] = [];
  for (const ev of j.eventos.slice(0, 100)) {
    const t = Date.parse(ev && ev.fecha);
    if (!ev || !ID_ATLAS.test(String(ev.id)) || isNaN(t)) continue;
    const due = siguienteHabil(t);
    if (due <= ahora) continue;
    const a = avisoAtlas(ev);
    for (const device of devs) filas.push({ device, id: "A:" + ev.id, title: a.title, body: a.body, due: new Date(due).toISOString(), sent_at: null });
  }
  await db.from("midia_recordatorios").delete().in("device", devs).like("id", "A:%");
  if (filas.length) {
    const { error } = await db.from("midia_recordatorios").upsert(filas);
    if (error) throw new Error("foto: " + error.message);
  }
}
/**
 * Una tarea que nació en Mi día y la cambiaron EN ATLAS (12-nov, segunda entrega): se corrige la tarea en la nube de Mi
 * día, con una `u` nueva para que el celular la tome en su próxima sincronización (gana la edición más reciente), y su
 * aviso se mueve o se quita en el servidor por si la app está cerrada. hecho → hecha; cancelado → eliminada; otra
 * hora → otra hora. El título no se toca: es de la persona. Si no hay nada distinto, no se escribe (así no hay ecos).
 */
async function tareaCambiadaEnAtlas(uid: string, ev: any) {
  const ref = clip(ev.ref, 40);
  if (!/^[A-Za-z0-9_-]{4,40}$/.test(ref)) return { ok: false, error: "ref" };
  const { data: fila } = await db.from("midia_tareas").select("data,deleted").eq("user_id", uid).eq("id", ref).maybeSingle();
  if (!fila || fila.deleted || !fila.data) return { ok: true, sin_tarea: true };
  const t: any = { ...(fila.data as any) };
  const devs = await dispositivosDe(uid);
  const quitarAviso = async () => { if (devs.length) await db.from("midia_recordatorios").delete().in("device", devs).eq("id", ref); };
  const ahora = Date.now();
  if (ev.estado === "cancelado") {
    await db.from("midia_tareas").update({ data: { u: ahora }, deleted: true, updated_at: new Date(ahora).toISOString() }).eq("user_id", uid).eq("id", ref);
    await quitarAviso();
    return { ok: true, tarea: "eliminada" };
  }
  const f = Date.parse(ev.fecha);
  const due = isNaN(f) ? t.due : new Date(f).toISOString();
  const end = isNaN(f) ? t.end : (Number(ev.duracion_min) > 0 ? new Date(f + Number(ev.duracion_min) * 60000).toISOString() : t.end && t.due ? new Date(f + (Date.parse(t.end) - Date.parse(t.due))).toISOString() : null);
  const hecho = ev.estado === "hecho";
  if (!!t.done === hecho && t.due === due && (t.end || null) === (end || null)) return { ok: true, sin_cambios: true };
  if (hecho && !t.done) t.doneAt = ahora;
  if (!hecho && t.done) { t.doneAt = null; t.order = -1; }
  t.done = hecho;
  if (t.due !== due) t.notified = Date.parse(due) <= ahora;
  t.due = due;
  t.end = end;
  t.u = ahora;
  await db.from("midia_tareas").update({ data: t, updated_at: new Date(ahora).toISOString() }).eq("user_id", uid).eq("id", ref);
  if (hecho || Date.parse(due) <= ahora) await quitarAviso();
  else if (devs.length) await db.from("midia_recordatorios").update({ due, sent_at: null }).in("device", devs).eq("id", ref);
  return { ok: true, tarea: hecho ? "hecha" : "movida" };
}

/** Un pendiente de Atlas se creó, cambió o se cerró: se programa, se mueve o se quita en todos los celulares. */
async function atlasEvento(b: any) {
  const vin = clip(b.vinculo, 64);
  const { data: en } = await db.from("midia_atlas_enlaces").select("uid").eq("vinculo_id", vin).maybeSingle();
  if (!en) return { ok: true, sin_enlace: true };   // conectó antes del 12-nov y aún no abre la app: se arregla al abrirla
  const ev = b.evento && typeof b.evento === "object" ? b.evento : {};
  if (!ID_ATLAS.test(String(ev.id))) return { ok: false, error: "evento" };
  if (b.accion === "propia") return await tareaCambiadaEnAtlas(en.uid, ev);
  const devs = await dispositivosDe(en.uid);
  if (!devs.length) return { ok: true, sin_dispositivo: true };
  const rid = "A:" + ev.id, nid = "N:" + ev.id;
  const t = Date.parse(ev.fecha);
  const ahora = Date.now();
  // 13-nov · «Revisar si ya hay contacto de…» es Atlas esperando un teléfono: en el celular no hay nada que hacer con eso
  // y no se avisa (Fabián: «el foco de la app es sólo aquellos con los que sí cuentan»). El puente tampoco lo lista.
  const espera = /^Revisar si ya hay contacto de/i.test(String(ev.titulo || ""));
  if (b.accion === "quitar" || isNaN(t) || espera) {
    await db.from("midia_recordatorios").delete().in("device", devs).in("id", [rid, nid]);
    return { ok: true, quitado: true };
  }
  const a = avisoAtlas(ev);
  const due = siguienteHabil(t);
  if (due > ahora) {
    const filas = devs.map((device) => ({ device, id: rid, title: a.title, body: a.body, due: new Date(due).toISOString(), sent_at: null }));
    const { error } = await db.from("midia_recordatorios").upsert(filas);
    if (error) throw new Error(error.message);
  } else {
    await db.from("midia_recordatorios").delete().in("device", devs).eq("id", rid);
  }
  // «Nuevo en tu agenda de Atlas»: el mismo aviso que Telegram al crear, cree quien cree el pendiente. Fuera de horario
  // se guarda para la primera hora hábil (y si ese pendiente se cierra antes, se quita con él).
  if (b.accion === "nuevo") {
    const nuevo = { title: "Nuevo en tu agenda de Atlas", body: clip((ev.titulo || a.title) + " · " + cuando(new Date(t).toISOString()), 200) };
    if (enHorario(ahora)) await avisar(en.uid, { ...nuevo, tag: rid });
    else {
      const filas = devs.map((device) => ({ device, id: nid, ...nuevo, due: new Date(siguienteHabil(ahora)).toISOString(), sent_at: null }));
      await db.from("midia_recordatorios").upsert(filas);
    }
  }
  return { ok: true };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json({ error: "método" }, 405);
  let b: any;
  try { b = await req.json(); } catch { return json({ error: "cuerpo" }, 400); }

  // Tarea programada: envía lo que ya venció.
  if (b.op === "tick") {
    const cron = await secret("cron");
    if (!cron || req.headers.get("x-cron") !== cron) return json({ error: "no" }, 401);
    const { data: due } = await db.from("midia_recordatorios")
      .select("device,id,title,body,midia_dispositivos(device,endpoint,p256dh,auth)")
      .is("sent_at", null).lte("due", new Date().toISOString()).order("due").limit(100);
    let sent = 0;
    for (const r of due ?? []) {
      const dev = r.midia_dispositivos as unknown as Dev;
      const code = await send(dev, { title: r.title, body: r.body ?? "", tag: r.id });
      if (code >= 200 && code < 300) sent++;
      // Los de Atlas traen datos de clientes (contacto, teléfono): no se guardan después de enviarlos.
      // «N:» = el aviso de «nuevo en tu agenda de Atlas» que se guardó para la primera hora hábil (12-nov).
      if (/^[AN]:/.test(String(r.id))) await db.from("midia_recordatorios").delete().eq("device", r.device).eq("id", r.id);
      else {
        await db.from("midia_recordatorios").update({ sent_at: new Date().toISOString() })
          .eq("device", r.device).eq("id", r.id);
      }
    }
    return json({ ok: true, sent });
  }

  if (b.op === "key") return json({ key: (await vapid()).pub });

  // Relevo hacia Atlas (piloto). Atlas no acepta llamadas de navegadores de otro dominio, así que la app le habla a
  // esta función y ella a Atlas, de servidor a servidor. Aquí no se guarda nada de Atlas: sólo se pasa la petición y
  // se devuelve la respuesta. Sólo para quien tenga sesión iniciada en Mi día.
  if (b.op === "atlas") {
    const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    if (!jwt) return json({ ok: false, error: "Inicia sesión en Mi día." }, 401);
    const u = await fetch(Deno.env.get("SUPABASE_URL")! + "/auth/v1/user", {
      headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, Authorization: "Bearer " + jwt },
    });
    if (!u.ok) return json({ ok: false, error: "Tu sesión de Mi día venció. Entra de nuevo." }, 401);
    const usuarioMd = await u.json().catch(() => null);
    const ll = b.llamada && typeof b.llamada === "object" ? b.llamada : {};
    if (!ATLAS_OPS.includes(String(ll.operacion))) return json({ ok: false, error: "Operación no reconocida." }, 400);
    // 12-nov (tarde) · Al pedir el código, el vínculo anterior de ESTA cuenta lo pone el servidor (nunca el celular):
    // Atlas manda el código al correo de ese usuario y dice a dónde, enmascarado.
    if (ll.operacion === "pedir_codigo") {
      delete ll.previo;
      if (usuarioMd?.id) {
        const { data: prev } = await db.from("midia_atlas_enlaces").select("vinculo_id").eq("uid", usuarioMd.id)
          .order("actualizado", { ascending: false }).limit(1);
        if (prev?.length) ll.previo = prev[0].vinculo_id;
      }
    }
    const cuerpo = JSON.stringify(ll);
    // «ocupado» lleva hasta 400 franjas y «tareas» hasta 200 tareas (12-nov): necesitan más espacio que las demás.
    if (cuerpo.length > ((ll.operacion === "ocupado" || ll.operacion === "tareas") ? 48000 : 6000)) return json({ ok: false, error: "Petición demasiado grande." }, 400);
    const enlace = typeof b.enlace === "string" ? b.enlace.slice(0, 200) : "";
    try {
      const r = await fetch(ATLAS_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + enlace },
        body: cuerpo,
      });
      const texto = await r.text();
      let j: unknown;
      try { j = JSON.parse(texto); } catch { j = { ok: false, error: "Atlas respondió algo ilegible." }; }
      // 12-nov · Lo que este servidor necesita para avisar sin que la app esté abierta. Nunca tumba la respuesta.
      if (r.ok && j && typeof j === "object" && usuarioMd?.id) {
        try { await atlasDespues(String(usuarioMd.id), String(ll.operacion), j as any, enlace); }
        catch (e) { console.error("atlas despues", String(e)); }
        delete (j as any).vinculo_id;   // el celular no lo necesita
      }
      // Atlas dice que esa llave ya no sirve (vínculo revocado): se olvida aquí también, para no devolverla al restaurar.
      if (r.status === 401 && usuarioMd?.id && enlace && ll.operacion !== "canjear" && ll.operacion !== "pedir_codigo") {
        try { await db.from("midia_atlas_enlaces").update({ token: null }).eq("uid", String(usuarioMd.id)).eq("token", enlace); }
        catch (e) { console.error("atlas olvidar", String(e)); }
      }
      return json(j, r.status);
    } catch (e) {
      console.error("atlas", String(e));
      return json({ ok: false, error: "No hubo conexión con Atlas." }, 502);
    }
  }

  // 12-nov (noche) · La conexión con Atlas que esta cuenta ya tenía: la app la pide al entrar si en el celular no está
  // (otra dirección, app reinstalada, sesión cerrada). Sólo a la misma cuenta, con su sesión; nunca a otra.
  if (b.op === "atlas_restaurar") {
    const yo = await quien(req);
    if (!yo) return json({ ok: false, error: "Tu sesión de Mi día venció. Entra de nuevo." }, 401);
    const { data } = await db.from("midia_atlas_enlaces").select("token,nombre").eq("uid", yo.id).not("token", "is", null)
      .order("actualizado", { ascending: false }).limit(1);
    const f = data?.[0];
    return json(f ? { ok: true, token: f.token, nombre: f.nombre || "" } : { ok: true, token: null });
  }

  // Ver quién invita (antes de entrar a la app): sólo el nombre.
  if (b.op === "inv") return await verInvitacion(b);

  // Contactos: invitar, aceptar una invitación, conexiones, ¿ese correo usa Mi día?
  if (b.op === "ctc") {
    const yo = await quien(req);
    if (!yo) return json({ ok: false, error: "Tu sesión de Mi día venció. Entra de nuevo." }, 401);
    try {
      return await contactos(yo, b);
    } catch (e) {
      console.error("ctc", String(e));
      return json({ ok: false, error: "No se pudo completar. Intenta de nuevo." }, 500);
    }
  }

  // Asignar tareas a otras cuentas de Mi día. Sólo con sesión iniciada.
  if (b.op === "asg") {
    const yo = await quien(req);
    if (!yo) return json({ ok: false, error: "Tu sesión de Mi día venció. Entra de nuevo." }, 401);
    try {
      return await asignar(yo, b);
    } catch (e) {
      console.error("asg", String(e));
      return json({ ok: false, error: "No se pudo completar. Intenta de nuevo." }, 500);
    }
  }

  // 12-nov · La agenda de Atlas avisa aquí en el momento en que cambia (disparador en su base, ver
  // atlas_deploy/sql/2026-11-12_midia_agenda_aviso.sql). Sin sesión de usuario: lo autoriza la firma compartida.
  if (b.op === "atlas_evento") {
    const firma = await secret("atlas_aviso");
    if (!firma || !(await mismaFirma(req.headers.get("x-atlas-firma") || "", firma))) return json({ error: "no" }, 401);
    try {
      return json(await atlasEvento(b));
    } catch (e) {
      console.error("atlas_evento", String(e));
      return json({ ok: false, error: "guardar" }, 500);
    }
  }

  const device = typeof b.device === "string" ? b.device : "";
  if (!/^[a-f0-9]{32,64}$/.test(device)) return json({ error: "dispositivo" }, 400);

  // La app manda su suscripción y la lista completa de recordatorios futuros.
  if (b.op === "sync") {
    if (!validSub(b.sub)) return json({ error: "suscripción" }, 400);
    const list = (Array.isArray(b.reminders) ? b.reminders : []).slice(0, 200)
      // 12-nov · Los de Atlas («A:») ya no los dicta el celular: los pone este servidor (con «listar» y con el aviso de
      // la base), con la regla de horario. Un celular con la versión anterior los sigue mandando: se ignoran.
      .filter((r: any) => r && typeof r.id === "string" && !/^[AN]:/.test(r.id) && !isNaN(Date.parse(r.due)))
      .map((r: any) => ({
        device, id: clip(r.id, 40), title: clip(r.title, 200) || "Pendiente",
        body: clip(r.body, 200), due: new Date(r.due).toISOString(),
      }));
    // El celular queda a nombre de la cuenta con sesión abierta (para avisarle lo que le asignen);
    // sin sesión, queda sin dueño y deja de recibir esos avisos.
    const yo = await quien(req);
    const { error: e1 } = await db.from("midia_dispositivos").upsert({
      device, endpoint: b.sub.endpoint, p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth,
      user_id: yo?.id ?? null, updated_at: new Date().toISOString(),
    });
    if (e1) return json({ error: "guardar" }, 500);
    const { data: old } = await db.from("midia_recordatorios").select("id,due,sent_at").eq("device", device);
    const prev = new Map((old ?? []).map((o) => [o.id, o]));
    const keep = new Set(list.map((r: any) => r.id));
    const gone = (old ?? []).filter((o) => !keep.has(o.id) && !/^[AN]:/.test(o.id)).map((o) => o.id);
    if (gone.length) await db.from("midia_recordatorios").delete().eq("device", device).in("id", gone);
    // Si cambió la hora de un recordatorio ya enviado, vuelve a quedar pendiente.
    const rows = list.map((r: any) => {
      const o = prev.get(r.id);
      const same = o && new Date(o.due).getTime() === new Date(r.due).getTime();
      return { ...r, sent_at: same ? o!.sent_at : null };
    });
    if (rows.length) {
      const { error: e2 } = await db.from("midia_recordatorios").upsert(rows);
      if (e2) return json({ error: "guardar" }, 500);
    }
    return json({ ok: true, n: rows.length });
  }

  // Aviso de prueba inmediato para comprobar que el celular los recibe.
  if (b.op === "test") {
    const { data: dev } = await db.from("midia_dispositivos").select("*").eq("device", device).maybeSingle();
    if (!dev) return json({ error: "sin suscripción" }, 404);
    const code = await send(dev as Dev, { title: "Mi día", body: "Los avisos están funcionando", tag: "prueba" });
    return json({ ok: code >= 200 && code < 300, code });
  }

  return json({ error: "op" }, 400);
});
