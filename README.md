# Fish Audio Voice Vault Online

Extensión de Chrome que conserva la interfaz negra y las herramientas de [Fish Audio Vault](https://github.com/CodeByDante/fish-audio-vault), con biblioteca online en Supabase. Se abre en una pestaña completa y conecta mediante tu token personal de administración. No necesita el antiguo servidor local ni Firebase.

## Instalar

1. Descarga el ZIP de **Assets** en la [última versión](https://github.com/CodeByDante/fish-audio-vault-online/releases/latest) y descomprímelo.
2. Abre `chrome://extensions` y activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona la carpeta que contiene `manifest.json`.
4. Pulsa el icono de la extensión. Introduce tu token personal de Supabase (`sbp_…`) y pulsa **Conectar biblioteca**.

El proyecto y la biblioteca de esta instalación vienen configurados en `config.json`. Son identificadores públicos, sin credenciales. La base preparada contiene **118 voces, 14 carpetas y 3 favoritos**. Los datos personales y el archivo de importación no se publican en este repositorio.

El token permanece en `chrome.storage.session`, restringido a los contextos internos de la extensión. Se borra al cerrar Chrome, cerrar sesión o recargar/desactivar la extensión. No se guarda en el código, `localStorage` ni sincronización de Chrome. Usa un token nuevo si compartiste el anterior en un chat o captura.

## Herramientas

- Buscar y ordenar voces; reproducir, pausar y desplazar el audio.
- Agregar, editar y archivar voces; títulos, enlaces, notas y portadas.
- Carpetas, favoritos, versiones de una voz, selección múltiple y organizador con arrastre.
- Subir o pegar una imagen, recortarla y guardarla en Supabase Storage.
- Importar/exportar JSON y descargar copias de respaldo manuales.
- Actualizar desde Supabase y sincronizar cambios entre instalaciones conectadas a la misma biblioteca.
- Indicador de consultas API, disponibles y cuenta regresiva de reinicio.

Los cambios se guardan al editar. Con la pestaña visible se consulta la biblioteca cada 15 segundos. **Actualizar** consulta en ese momento. Si otro equipo guardó antes, una revisión impide sobrescribirlo: la aplicación conserva la edición pendiente y permite exportarla o recargar la versión online. Espera a ver **Guardado en Supabase** antes de cerrar; una edición pendiente solo existe en la memoria de esa pestaña.

La descarga de una copia JSON es opcional. La biblioteca principal está en Supabase y no depende de un archivo local.

## Portadas y audio

Las portadas nuevas se suben al bucket privado `voice-vault-images`. Se aceptan PNG/JPEG/WebP de hasta **512 KiB**; el recorte reduce su tamaño. La base guarda una ruta estable y la extensión solicita enlaces temporales de lectura de una hora. Las firmas se renuevan sin volver a subir la imagen. La importación JSON también migra sus imágenes incrustadas.

El nombre del archivo usa SHA-256: volver a subir exactamente la misma imagen reutiliza su objeto. Al reemplazar o quitar una portada se conserva el objeto anterior; no hay borrado físico automático. Los archivos antiguos pueden limpiarse manualmente desde Storage cuando ya no se necesiten. El límite de 512 KiB es por imagen, no una medición del espacio total del plan.

Los audios se reproducen desde sus enlaces de Fish Audio; no se guardan archivos de audio en Supabase. La extensión puede consultar el modelo de Fish Audio para renovar una muestra, usando la sesión del propio navegador cuando el servicio lo permita. Los permisos y disponibilidad de Fish Audio siguen siendo necesarios.

## Contador de API

Según la [documentación de Supabase](https://supabase.com/docs/reference/api/introduction), la cuota de Management API es por usuario, proyecto y endpoint, compartida entre sus tokens. La aplicación lee los encabezados reales de Supabase; si no están disponibles muestra **estimado**. El tiempo de reinicio del servidor se interpreta en segundos restantes.

- Leer las 118 voces juntas consume **una petición**, no 118.
- Cada guardado consume una petición.
- Subir o firmar un lote de imágenes hace una consulta adicional para autorizar el token; también se cuenta.
- La firma de portadas se reutiliza mientras sea válida.
- El reloj y las consultas internas del indicador no hacen llamadas HTTP.
- Fish Audio tiene su propia API y no consume este contador.

Un `429` pausa las peticiones hasta el reinicio. El indicador no garantiza mostrar llamadas que otros clientes hagan después de la última respuesta recibida.

## Arquitectura y permisos

Es una herramienta personal de administración. El token maestro tiene los permisos de tu cuenta; no es una clave pública para distribuir entre usuarios. Cada instalación debe usar un token autorizado para su proyecto. No introduzcas una clave `service_role` ni la contraseña PostgreSQL.

El service worker hace consultas SQL fijas y parametrizadas mediante Management API. Las funciones `vault_export_snapshot` y `vault_apply_snapshot` solo están disponibles para `postgres`. El guardado completo es transaccional, comprueba la revisión y conserva campos adicionales importados.

Tablas: `libraries`, `folders`, `voices` y `user_settings`. RLS está activado; la biblioteca personal no tiene propietario Auth y no se expone a los roles públicos de Data API. Los ajustes de esta modalidad administrativa se guardan en los metadatos de la biblioteca. Los borrados de voces/carpetas son archivados recuperables por un administrador.

Las imágenes pasan por la Edge Function `voice-vault-storage`: valida el token contra el proyecto, comprueba la biblioteca, formato y tamaño y usa la credencial de servicio únicamente dentro del servidor. La verificación JWT de la plataforma está desactivada porque esta función autentica un PAT de Management API; no permite operaciones sin token válido.

Permisos Chrome: `storage`, `clipboardWrite` y acceso a los hosts de Supabase y Fish Audio. No solicita leer todas las cookies, todas las páginas ni el historial. La política CSP carga scripts únicamente desde la propia extensión.

## Configurar otra base

La instalación configurada ya tiene tablas y función desplegadas. Para un proyecto diferente:

1. Ejecuta `database/voice_vault_schema.sql` y después `database/online_api.sql` como administrador.
2. Crea una fila en `libraries` y sus carpetas iniciales (`all`, `f_favorites`, `f_sueltas`). El propietario puede ser nulo en esta modalidad personal de administración.
3. Despliega `supabase/functions/voice-vault-storage/index.ts`, con `verify_jwt = false`. La función usa las variables privadas que Supabase proporciona al runtime; nunca las copies a la extensión.
4. Cambia `config.json` o abre **Proyecto y biblioteca** en la pantalla de conexión. Usa un PAT con `database_write` para ese proyecto: también se necesita al conectar y cargar, porque las funciones de administración se ejecutan como `postgres`. El SELECT de carga es fijo y no modifica datos.
5. Importa tu copia JSON desde Configuración. Conserva un respaldo antes de sustituir una biblioteca.

Las verificaciones SQL de `database/verify_voice_vault.sql` y `database/verify_online_api.sql` crean datos temporales dentro de una transacción y terminan con `ROLLBACK`.

## Desarrollo

Sin dependencias npm:

```sh
npm run check
npm test
npm run package
```

El paquete queda en `dist/fish-audio-vault-online-v2.0.0.zip`. Solo incluye archivos necesarios de la extensión, con una lista permitida explícita y revisión de patrones de credenciales. GitHub Actions ejecuta las comprobaciones y genera el ZIP.

La extensión se instala en Chrome; abrir `index.html` como una web normal no proporciona el service worker ni la API `chrome.storage.session`.

Interfaz y herramientas adaptadas de `CodeByDante/fish-audio-vault`, referencia de origen `8cecd961811a018b44b4879698ed3a2ae8c46aaf`. El repositorio original permanece independiente.
