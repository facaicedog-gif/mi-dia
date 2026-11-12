-- 2026-11-12 · Mi día recibe los avisos de la agenda de Atlas (maqueta-agenda-compartida.html, aprobada «Sí, constrúyela»).
--
-- La base de Atlas avisa con el id del VÍNCULO (midia_vinculos de Atlas), no con la cuenta de Mi día: Atlas no sabe quién
-- es la persona aquí. Esta tabla lo traduce. Se llena sola: el relevo la escribe cuando Atlas responde a «canjear» o
-- «listar» con `vinculo_id`, y la borra al desconectar. Cerrada al navegador, como las demás: sólo la función la usa.
--
-- Además se guarda la firma compartida con Atlas (la misma del secreto `midia_aviso_firma` de su Vault), FUERA de este
-- archivo y con el mismo valor al azar:
--   insert into public.midia_secretos (clave, valor) values ('atlas_aviso', '<el mismo valor>');

create table if not exists public.midia_atlas_enlaces (
  vinculo_id  text primary key,
  uid         uuid not null references auth.users (id) on delete cascade,
  actualizado timestamptz not null default now()
);
create index if not exists midia_atlas_enlaces_uid on public.midia_atlas_enlaces (uid);

alter table public.midia_atlas_enlaces enable row level security;
revoke all on public.midia_atlas_enlaces from anon, authenticated;
