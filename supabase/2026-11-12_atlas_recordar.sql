-- 2026-11-12 (noche) · Mi día recuerda la conexión con Atlas.
-- Fabián: «cada vez que se actualiza o haces algún despliegue de la app se sale la cuenta de Atlas y tengo que volver a
-- enviar código… déjalo para que recuerde la sesión». Medido ese día: su vínculo de las 14:55 seguía activo en Atlas
-- (sin revocar) y aun así tuvo que conectar de nuevo a las 19:30: la conexión vivía SÓLO en el almacenamiento del
-- celular, y se perdía al cambiar de dirección (github.io → atlas.veltrion.com.co), al cerrar sesión o cuando la sesión
-- de Mi día vencía (la app confundía ese 401 con el de Atlas).
-- Ahora la llave de la conexión también queda aquí, a nombre de la cuenta de Mi día (uid). La tabla sigue cerrada al
-- navegador (RLS sin políticas): sólo la función `midia` la lee, y sólo se la devuelve a la misma cuenta con sesión.
-- «Desconectar» la borra; un 401 de Atlas (vínculo revocado) también.
alter table public.midia_atlas_enlaces add column if not exists token text;
alter table public.midia_atlas_enlaces add column if not exists nombre text;
