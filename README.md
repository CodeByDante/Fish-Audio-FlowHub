# Fish Audio Voice Vault Online

<img src="images/icon128.png" width="72" height="72" alt="Logo Fish Audio Voice Vault Online">

Aplicación web y extensión de Chrome que conservan la interfaz negra de [Fish Audio Vault](https://github.com/CodeByDante/fish-audio-vault), con una biblioteca compartida en Supabase. Ambas conectan mediante tu token personal de administración. No necesitan el antiguo servidor local ni Firebase.

## Abrir la web

[**Abrir Fish Audio Vault Online en GitHub Pages**](https://codebydante.github.io/fish-audio-vault-online/)

Introduce tu token para cargar la misma biblioteca de la extensión. Después se guarda una copia cifrada en este navegador: abrir, recargar o volver a la pestaña muestra esa copia sin consultar Supabase. Pulsa **Actualizar** para traer los cambios guardados desde otro navegador o desde la extensión. La reproducción no guarda la biblioteca.

La sesión se recuerda en este navegador hasta pulsar **Cerrar sesión**, tanto en la web como en la extensión. El token y la copia de la biblioteca se cifran localmente con AES-GCM en IndexedDB, usando una clave Web Crypto no extraíble. No se publican en GitHub, URLs ni cookies y no se sincronizan con Chrome Sync. Al cerrar sesión se eliminan la conexión guardada y las copias de biblioteca y portadas. Si el token caduca o lo revocas, tendrás que conectar uno válido cuando vuelvas a consultar o guardar en Supabase.

## Instalar la extensión

1. Descarga el ZIP de **Assets** en la [última versión](https://github.com/CodeByDante/fish-audio-vault-online/releases/latest) y descomprímelo.
2. Abre `chrome://extensions` y activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona la carpeta que contiene `manifest.json`.
4. Pulsa el icono de la extensión. Introduce tu token personal de Supabase (`sbp_…`) y pulsa **Conectar biblioteca**.

El proyecto y la biblioteca de esta instalación vienen configurados en `config.json`. Son identificadores públicos, sin credenciales. La base preparada contiene **118 voces, 14 carpetas y 3 favoritos**. Los datos personales y el archivo de importación no se publican en este repositorio.

La extensión también recuerda la sesión mediante almacenamiento local cifrado. Tras la primera conexión podrás recargarla o volver a abrirla sin pegar el token otra vez. **Cerrar sesión** elimina las credenciales guardadas. Usa un token nuevo si compartiste el anterior en un chat o captura.

## Herramientas

- Buscar y ordenar voces; reproducir, pausar y desplazar el audio.
- Agregar, editar y archivar voces; títulos, enlaces, notas y portadas.
- Carpetas, favoritos, versiones de una voz, selección múltiple y reordenación de carpetas por arrastre.
- **Herramientas → Mostrar notas** permite ver u ocultar las notas de cada tarjeta. Para escribirlas, abre **Editar esta voz → Notas**.
- Las notas se desplazan con la rueda, el panel táctil o el teclado sin una barra visible. Al editar una voz se bloquea el desplazamiento de la página de fondo.
- Subir o pegar una imagen, recortarla y guardarla en Supabase Storage.
- Importar/exportar JSON y descargar copias de respaldo manuales.
- Actualizar desde Supabase y sincronizar cambios entre instalaciones conectadas a la misma biblioteca.
- Indicador de consultas API, disponibles y cuenta regresiva de reinicio.

Los cambios se guardan al editar. No hay consultas periódicas ni al cambiar de ventana: **Actualizar** consulta en ese momento. Si otro equipo guardó antes, una revisión impide sobrescribirlo: la aplicación conserva la edición pendiente y permite exportarla o recargar la versión online. Espera a ver **Guardado en Supabase** antes de cerrar; una edición pendiente solo existe en la memoria de esa pestaña. Si todavía no existe una copia guardada en este navegador, pulsa **Actualizar** para descargarla antes de editar.

La descarga de una copia JSON es opcional. La biblioteca principal está en Supabase y no depende de un archivo local.

## Portadas y audio

Las portadas nuevas se suben al bucket privado `voice-vault-images`. Se aceptan PNG/JPEG/WebP de hasta **512 KiB**; el recorte reduce su tamaño. La base guarda una ruta estable y la extensión solicita enlaces temporales de lectura de una hora. Las firmas se renuevan sin volver a subir la imagen. La importación JSON también migra sus imágenes incrustadas.

El nombre del archivo usa SHA-256: volver a subir exactamente la misma imagen reutiliza su objeto. Al reemplazar o quitar una portada se conserva el objeto anterior; no hay borrado físico automático. Los archivos antiguos pueden limpiarse manualmente desde Storage cuando ya no se necesiten. El límite de 512 KiB es por imagen, no una medición del espacio total del plan.

En la web se consultan muestras públicas de Fish Audio sin leer cookies de otras páginas. Los modelos que exigen una sesión de Fish Audio pueden necesitar la extensión, que puede usar la sesión de su navegador cuando el servicio lo permite.

Los audios se reproducen desde sus enlaces de Fish Audio; no se guardan archivos de audio en Supabase. Reproducir, pausar o renovar un enlace de muestra no guarda la biblioteca ni consume peticiones de Supabase. Los enlaces renovados se reutilizan en una caché temporal de la sesión; se borran al salir o cambiar de biblioteca. La extensión puede consultar el modelo de Fish Audio para renovar una muestra, usando la sesión del propio navegador cuando el servicio lo permita. Los permisos y disponibilidad de Fish Audio siguen siendo necesarios.

## Contador de API

Según la [documentación de Supabase](https://supabase.com/docs/reference/api/introduction), la cuota de Management API es por usuario, proyecto y endpoint, compartida entre sus tokens. La aplicación lee los encabezados reales de Supabase; si no están disponibles muestra **estimado**. El tiempo de reinicio del servidor se interpreta en segundos restantes.

- Leer las 118 voces juntas consume **una petición**, no 118.
- Cada guardado de una edición consume una petición. Escuchar o renovar una muestra de Fish Audio no guarda datos en Supabase.
- Subir o firmar un lote de imágenes hace una consulta adicional para autorizar el token; también se cuenta.
- Abrir o recargar una sesión recordada y cambiar de ventana consumen **cero peticiones**: se usa la biblioteca guardada en este navegador. No hay consultas automáticas cada 15 segundos.
- Pulsar **Actualizar** normalmente hace una sola lectura de la biblioteca. La firma de portadas se reutiliza mientras sea válida; renovar firmas vencidas cuenta aparte y se hace al consultar manualmente. Las portadas cuyo enlace haya caducado pueden necesitar esa actualización para volver a mostrarse.
- El reloj y las consultas internas del indicador no hacen llamadas HTTP.
- Fish Audio tiene su propia API y no consume este contador.

Un `429` pausa las peticiones hasta el reinicio. El indicador no garantiza mostrar llamadas que otros clientes hagan después de la última respuesta recibida.

## Arquitectura y permisos

Es una herramienta personal de administración. El token maestro tiene los permisos de tu cuenta; no es una clave pública para distribuir entre usuarios. Cada instalación debe usar un token autorizado para su proyecto. No introduzcas una clave `service_role` ni la contraseña PostgreSQL.

El service worker de Chrome y la versión web comparten el mismo motor. La extensión llama a Management API directamente; GitHub Pages utiliza la Edge Function `voice-vault-api`, que recibe únicamente operaciones permitidas, construye SQL fijo y valida el PAT contra el proyecto. El relay nunca guarda tokens y no necesita una clave de servicio. Ambas modalidades usan las mismas revisiones de Supabase para impedir sobrescrituras. Las funciones `vault_export_snapshot` y `vault_apply_snapshot` solo están disponibles para `postgres`. El guardado completo es transaccional, comprueba la revisión y conserva campos adicionales importados.

Tablas: `libraries`, `folders`, `voices` y `user_settings`. RLS está activado; la biblioteca personal no tiene propietario Auth y no se expone a los roles públicos de Data API. Los ajustes de esta modalidad administrativa se guardan en los metadatos de la biblioteca. Los borrados de voces/carpetas son archivados recuperables por un administrador.

Las imágenes pasan por la Edge Function `voice-vault-storage`: valida el token contra el proyecto, comprueba la biblioteca, formato y tamaño y usa la credencial de servicio únicamente dentro del servidor. La verificación JWT de la plataforma está desactivada porque esta función autentica un PAT de Management API; no permite operaciones sin token válido.

Permisos Chrome: `storage`, `clipboardWrite` y acceso a los hosts de Supabase y Fish Audio. No solicita leer todas las cookies, todas las páginas ni el historial. La política CSP carga scripts únicamente desde la propia extensión.

## Preparación automática al conectar

La extensión revisa las tablas y funciones del proyecto seleccionado al introducir el token:

- Si no existe la estructura de Voice Vault, crea las tablas, políticas RLS y funciones de administración.
- Si ya existe y es compatible, la reutiliza y carga sus datos.
- Si falta la biblioteca seleccionada, crea una biblioteca vacía con Todas, Favoritas y Voces Sueltas.
- Si encuentra tablas parciales o una estructura incompatible, detiene la conexión y explica el problema. No sustituye ni borra datos existentes.

Esta revisión usa consultas API y se incluye en el contador. La creación solo se realiza cuando hace falta. El token necesita `database_write`, también para cargar las funciones de administración como `postgres`.

Para usar otro proyecto, abre **Proyecto y biblioteca** en la pantalla de conexión e introduce su referencia y un UUID de biblioteca. El token debe tener permisos en ese proyecto. Conserva un respaldo antes de importar datos.

La instalación preconfigurada ya tiene el servicio de imágenes desplegado. En otro proyecto, las portadas requieren `voice-vault-storage` y la web requiere `voice-vault-api`. Antes de desplegar esta última, ejecuta `python3 scripts/prepare_edge_api.py`: prepara copias exactas del protocolo y del SQL canónico. Despliega ambas con `verify_jwt = false`; los handlers validan el PAT y utilizan únicamente las variables privadas del runtime. La preparación automática de tablas no copia credenciales ni despliega servicios externos. Los orígenes web de las funciones se limitan a `https://codebydante.github.io`; adapta ese origen si alojas tu propia copia en otro dominio.

Los archivos de `database/` documentan el esquema y contienen las verificaciones transaccionales, que terminan con `ROLLBACK`.

## Desarrollo

Sin dependencias npm:

```sh
npm run check
npm test
npm run package
npm run build:pages
```

El paquete queda en `dist/fish-audio-vault-online-v2.2.3.zip`. Solo incluye archivos necesarios de la extensión, con una lista permitida explícita y revisión de patrones de credenciales. GitHub Actions ejecuta las comprobaciones y genera el ZIP.

`npm run build:pages` genera `dist/pages` usando una lista explícita de archivos públicos. `.github/workflows/pages.yml` comprueba y publica ese directorio en GitHub Pages al actualizar `main`. GitHub Actions publica el código; los datos se sincronizan a través de Supabase, no de commits.

La web se sirve por HTTPS. En Chrome, el mismo código detecta su contexto de extensión y utiliza su service worker. No hacen falta credenciales en GitHub Actions.

Interfaz y herramientas adaptadas de `CodeByDante/fish-audio-vault`, referencia de origen `8cecd961811a018b44b4879698ed3a2ae8c46aaf`. El repositorio original permanece independiente.
