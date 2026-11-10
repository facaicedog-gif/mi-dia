-- Mi día · asignar tareas entre usuarios (10-nov-2026).
-- Todo cerrado al navegador: sólo la función `midia` (llave de servicio) lee y escribe.

-- 1) Cada celular sabe de qué cuenta es, para poder avisarle a una persona y no a un dispositivo.
alter table public.midia_dispositivos add column if not exists user_id uuid;
create index if not exists midia_dispositivos_user on public.midia_dispositivos (user_id);

-- 2) Las tareas que una cuenta le pide a otra.
create table if not exists public.midia_asignaciones (
  id          uuid primary key default gen_random_uuid(),
  de          uuid not null,
  de_nombre   text not null,
  para        uuid not null,
  para_nombre text not null,
  para_correo text not null,
  titulo      text not null check (length(titulo) between 1 and 200),
  nota        text check (length(nota) <= 300),
  due         timestamptz,
  fin         timestamptz,
  urgente     boolean not null default false,
  importante  boolean not null default true,
  estado      text not null default 'pendiente'
              check (estado in ('pendiente','aceptada','rechazada','hecha','cancelada')),
  motivo      text check (length(motivo) <= 300),
  nota_fin    text check (length(nota_fin) <= 300),
  due_final   timestamptz,
  fin_final   timestamptz,
  recordado   timestamptz,
  creado      timestamptz not null default now(),
  actualizado timestamptz not null default now()
);
create index if not exists midia_asig_de   on public.midia_asignaciones (de, actualizado desc);
create index if not exists midia_asig_para on public.midia_asignaciones (para, actualizado desc);
alter table public.midia_asignaciones enable row level security;
revoke all on public.midia_asignaciones from anon, authenticated;

-- 3) Buscar una cuenta por correo exacto (sólo cuentas con el correo confirmado). Sólo la función la usa.
create or replace function public.midia_usuario_por_correo(correo text)
returns uuid language sql stable security definer set search_path = '' as $$
  select id from auth.users
  where lower(email) = lower(trim(correo)) and email_confirmed_at is not null
  limit 1
$$;
revoke all on function public.midia_usuario_por_correo(text) from public, anon, authenticated;
grant execute on function public.midia_usuario_por_correo(text) to service_role;

-- Para apagarlo todo sin borrar nada:  update public.midia_asignaciones set estado = 'cancelada' where estado in ('pendiente','aceptada');
