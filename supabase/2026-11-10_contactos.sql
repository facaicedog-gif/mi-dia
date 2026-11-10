-- Mi día · contactos por invitación y tareas compartidas (10-nov-2026).
-- Todo cerrado al navegador: sólo la función `midia` (llave de servicio) lee y escribe.

-- 1) Invitaciones: el código viaja por WhatsApp; aquí sólo queda su huella (sha256). Un solo uso, vence en 7 días.
create table if not exists public.midia_invitaciones (
  id          uuid primary key default gen_random_uuid(),
  codigo_hash text not null unique,
  de          uuid not null,
  de_nombre   text not null,
  creado      timestamptz not null default now(),
  vence       timestamptz not null,
  usado       timestamptz,
  usado_por   uuid
);
create index if not exists midia_inv_de on public.midia_invitaciones (de, creado desc);
alter table public.midia_invitaciones enable row level security;
revoke all on public.midia_invitaciones from anon, authenticated;

-- 2) Conexiones: quién quedó conectado con quién al aceptar una invitación (una fila por pareja).
create table if not exists public.midia_conexiones (
  a           uuid not null,             -- quien invitó
  b           uuid not null,             -- quien aceptó
  invitacion  uuid references public.midia_invitaciones(id) on delete set null,
  creado      timestamptz not null default now(),
  primary key (a, b),
  check (a <> b)
);
create index if not exists midia_con_b on public.midia_conexiones (b);
alter table public.midia_conexiones enable row level security;
revoke all on public.midia_conexiones from anon, authenticated;

-- 3) Tareas compartidas: las filas enviadas juntas llevan el mismo grupo.
alter table public.midia_asignaciones add column if not exists grupo uuid;
create index if not exists midia_asig_grupo on public.midia_asignaciones (grupo) where grupo is not null;
