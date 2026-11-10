// Mi día · servidor de avisos push.
// Guarda los recordatorios futuros de cada dispositivo y los envía a su hora,
// aunque la app esté cerrada. Las tablas están cerradas al navegador: sólo esta
// función (con la llave de servicio) las lee y escribe.
import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

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
const ATLAS_OPS = ["canjear", "listar", "cerrar", "reprogramar", "desvincular", "ocupado"];

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
  };
}
const TOPE_DIA = 40; // envíos por cuenta en 24 h: frena el abuso sin estorbar el uso normal

async function asignar(yo: Quien, b: any) {
  const accion = String(b.accion || "");
  const ahora = new Date().toISOString();

  if (accion === "enviar") {
    const correo = texto(b.correo, 120).toLowerCase();
    const titulo = texto(b.titulo, 200);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return json({ ok: false, error: "Revisa el correo." }, 400);
    if (!titulo) return json({ ok: false, error: "Escribe la tarea." }, 400);
    if (correo === yo.email.toLowerCase()) return json({ ok: false, error: "Ese correo es el tuyo." }, 400);
    const desde = new Date(Date.now() - 864e5).toISOString();
    const { count } = await db.from("midia_asignaciones").select("id", { count: "exact", head: true })
      .eq("de", yo.id).gte("creado", desde);
    if ((count ?? 0) >= TOPE_DIA) return json({ ok: false, error: "Llegaste al tope de envíos de hoy." }, 429);
    const { data: para } = await db.rpc("midia_usuario_por_correo", { correo });
    if (!para) return json({ ok: false, sinCuenta: true, error: "Ese correo no tiene cuenta en Mi día." });
    const due = fecha(b.due);
    let fin = fecha(b.fin);
    if (due && (!fin || fin <= due)) fin = new Date(Date.parse(due) + 30 * 6e4).toISOString();
    const fila = {
      de: yo.id, de_nombre: await nombreDe(yo.id, yo.email),
      para, para_nombre: await nombreDe(para as string, correo), para_correo: correo,
      titulo, nota: texto(b.nota, 300) || null, due, fin: due ? fin : null,
      urgente: !!b.urgente, importante: b.importante !== false,
    };
    const { data, error } = await db.from("midia_asignaciones").insert(fila).select().single();
    if (error) return json({ ok: false, error: "No se pudo guardar." }, 500);
    await avisar(para as string, {
      title: fila.de_nombre + " te asignó una tarea", body: titulo + " · " + cuando(due), tag: "asg-" + data.id,
    });
    return json({ ok: true, asignacion: vista(data, yo.id) });
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
    return json({
      ok: true,
      recibidas: (r.data ?? []).map((a) => vista(a, yo.id)),
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
      await avisar(a.de, { title: "✓ " + a.para_nombre + " terminó", body: a.titulo + (cambio.nota_fin ? " · " + cambio.nota_fin : ""), tag: "asg-" + id });
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
      if (String(r.id).startsWith("A:")) await db.from("midia_recordatorios").delete().eq("device", r.device).eq("id", r.id);
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
    const ll = b.llamada && typeof b.llamada === "object" ? b.llamada : {};
    if (!ATLAS_OPS.includes(String(ll.operacion))) return json({ ok: false, error: "Operación no reconocida." }, 400);
    const cuerpo = JSON.stringify(ll);
    // «ocupado» lleva hasta 400 franjas (sólo inicio y fin): necesita más espacio que las demás.
    if (cuerpo.length > (ll.operacion === "ocupado" ? 48000 : 6000)) return json({ ok: false, error: "Petición demasiado grande." }, 400);
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
      return json(j, r.status);
    } catch (e) {
      console.error("atlas", String(e));
      return json({ ok: false, error: "No hubo conexión con Atlas." }, 502);
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

  const device = typeof b.device === "string" ? b.device : "";
  if (!/^[a-f0-9]{32,64}$/.test(device)) return json({ error: "dispositivo" }, 400);

  // La app manda su suscripción y la lista completa de recordatorios futuros.
  if (b.op === "sync") {
    if (!validSub(b.sub)) return json({ error: "suscripción" }, 400);
    const list = (Array.isArray(b.reminders) ? b.reminders : []).slice(0, 200)
      .filter((r: any) => r && typeof r.id === "string" && !isNaN(Date.parse(r.due)))
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
    const gone = (old ?? []).filter((o) => !keep.has(o.id)).map((o) => o.id);
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
