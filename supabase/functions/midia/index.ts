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
  "Access-Control-Allow-Headers": "content-type",
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
      await db.from("midia_recordatorios").update({ sent_at: new Date().toISOString() })
        .eq("device", r.device).eq("id", r.id);
    }
    return json({ ok: true, sent });
  }

  if (b.op === "key") return json({ key: (await vapid()).pub });

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
    const { error: e1 } = await db.from("midia_dispositivos").upsert({
      device, endpoint: b.sub.endpoint, p256dh: b.sub.keys.p256dh, auth: b.sub.keys.auth,
      updated_at: new Date().toISOString(),
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
