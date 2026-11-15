-- Voice Vault bundled bootstrap v1. Generated from database/voice_vault_schema.sql
-- and database/online_api.sql. No credentials, SQL interpolation or UI SQL.
-- Existing compatible schemas are left unchanged. Partial/unknown schemas stop.
BEGIN;
SELECT pg_catalog.pg_advisory_xact_lock(981376142);
DO $vault_bootstrap$
DECLARE schema_status jsonb;
BEGIN
  IF current_user <> 'postgres' THEN RAISE EXCEPTION 'Administrator access required' USING ERRCODE='42501'; END IF;
  EXECUTE $vault_probe$
WITH expected_tables(name) AS (VALUES ('libraries'),('folders'),('voices'),('user_settings')),
expected_columns(table_name,column_name,type_name) AS (VALUES
('libraries','id','uuid'),
('libraries','owner_id','uuid'),
('libraries','name','text'),
('libraries','metadata','jsonb'),
('libraries','created_at','timestamptz'),
('libraries','updated_at','timestamptz'),
('libraries','version','int8'),
('libraries','deleted_at','timestamptz'),
('folders','library_id','uuid'),
('folders','id','text'),
('folders','name','text'),
('folders','kind','text'),
('folders','sort_order','int4'),
('folders','metadata','jsonb'),
('folders','created_at','timestamptz'),
('folders','updated_at','timestamptz'),
('folders','version','int8'),
('folders','deleted_at','timestamptz'),
('voices','library_id','uuid'),
('voices','id','text'),
('voices','title','text'),
('voices','url','text'),
('voices','audio_url','text'),
('voices','cover_image','text'),
('voices','folder_id','text'),
('voices','notes','text'),
('voices','is_favorite','bool'),
('voices','metadata','jsonb'),
('voices','created_at','timestamptz'),
('voices','updated_at','timestamptz'),
('voices','version','int8'),
('voices','deleted_at','timestamptz'),
('user_settings','owner_id','uuid'),
('user_settings','preferences','jsonb'),
('user_settings','created_at','timestamptz'),
('user_settings','updated_at','timestamptz'),
('user_settings','version','int8')),
expected_functions(signature,body_hash) AS (VALUES
('public.vault_touch_record()','ad921f25dea9d9338b2b10a6544503dd'),
('public.vault_require_active_folder()','4303779afbf8e9771c3ea7cb9bf701a7'),
('public.vault_archive_folder()','9f4b996d52771b7e3b5f954359c043cf'),
('public.vault_export_snapshot(uuid)','a1812933bac2ff55ea2d9ddf9519f07a'),
('public.vault_apply_snapshot(uuid,bigint,jsonb)','e0379a87c46b920b0c179062e6e1f60e')),
expected_triggers(table_name,trigger_name,function_signature) AS (VALUES
 ('libraries','libraries_touch','public.vault_touch_record()'),
 ('folders','folders_touch','public.vault_touch_record()'),
 ('folders','folders_archive','public.vault_archive_folder()'),
 ('voices','voices_touch','public.vault_touch_record()'),
 ('voices','voices_folder_check','public.vault_require_active_folder()'),
 ('user_settings','settings_touch','public.vault_touch_record()')),
table_state AS (
 SELECT count(c.oid)::integer AS present,
 bool_and(c.relkind='r' AND c.relrowsecurity) AS protected
 FROM expected_tables e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
 LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.name),
column_state AS (
 SELECT count(*) FILTER (WHERE a.attname IS NULL OR t.typname<>e.type_name) AS invalid
 FROM expected_columns e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
 LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name
 LEFT JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attname=e.column_name AND a.attnum>0 AND NOT a.attisdropped
 LEFT JOIN pg_catalog.pg_type t ON t.oid=a.atttypid),
function_state AS (
 SELECT count(p.oid)::integer AS present,
 count(*) FILTER (WHERE p.oid IS NULL OR md5(replace(p.prosrc,'public.','__vault__.'))<>e.body_hash OR p.prosecdef) AS invalid
 FROM expected_functions e LEFT JOIN pg_catalog.pg_proc p ON p.oid=to_regprocedure(e.signature)),
trigger_state AS (
 SELECT count(*) FILTER (WHERE t.oid IS NULL OR t.tgfoid<>to_regprocedure(e.function_signature)::oid OR t.tgenabled NOT IN ('O','A')) AS invalid
 FROM expected_triggers e LEFT JOIN pg_catalog.pg_namespace n ON n.nspname='public'
 LEFT JOIN pg_catalog.pg_class c ON c.relnamespace=n.oid AND c.relname=e.table_name
 LEFT JOIN pg_catalog.pg_trigger t ON t.tgrelid=c.oid AND t.tgname=e.trigger_name AND NOT t.tgisinternal),
key_state AS (
 SELECT (SELECT count(*) FROM pg_catalog.pg_constraint k
  JOIN pg_catalog.pg_class c ON c.oid=k.conrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND k.contype='p' AND k.convalidated
  AND ((c.relname='libraries' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num)=ARRAY['id'])
    OR (c.relname IN ('folders','voices') AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num)=ARRAY['library_id','id'])
    OR (c.relname='user_settings' AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.num)=ARRAY['owner_id']))) AS primary_keys,
 (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid=to_regclass('public.voices') AND k.confrelid=to_regclass('public.folders') AND k.contype='f' AND k.convalidated
   AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.conkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=x.num)=ARRAY['library_id','folder_id']
   AND (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(k.confkey) WITH ORDINALITY x(num,ord) JOIN pg_catalog.pg_attribute a ON a.attrelid=k.confrelid AND a.attnum=x.num)=ARRAY['library_id','id']) AS isolated_folder_fk,
 (SELECT count(*) FROM pg_catalog.pg_constraint k WHERE k.conrelid IN(to_regclass('public.folders'),to_regclass('public.voices')) AND k.contype='c' AND k.convalidated AND k.conname IN('folders_valid_id','folders_virtual_ids','voices_valid_id')) AS guards),
privilege_state AS (
 SELECT COALESCE(has_function_privilege('anon',to_regprocedure('public.vault_export_snapshot(uuid)'),'EXECUTE'),false)
 OR COALESCE(has_function_privilege('authenticated',to_regprocedure('public.vault_export_snapshot(uuid)'),'EXECUTE'),false)
 OR COALESCE(has_function_privilege('anon',to_regprocedure('public.vault_apply_snapshot(uuid,bigint,jsonb)'),'EXECUTE'),false)
 OR COALESCE(has_function_privilege('authenticated',to_regprocedure('public.vault_apply_snapshot(uuid,bigint,jsonb)'),'EXECUTE'),false) AS exposed)
SELECT jsonb_build_object('state',CASE
 WHEN ts.present=0 AND fs.present=0 THEN 'empty'
 WHEN ts.present=4 AND ts.protected AND cs.invalid=0 AND fs.invalid=0 AND tr.invalid=0
  AND ks.primary_keys=4 AND ks.isolated_folder_fk=1 AND ks.guards=3 AND NOT ps.exposed THEN 'compatible'
 ELSE 'incompatible' END,
 'tablesPresent',ts.present,'invalidColumns',cs.invalid,'invalidFunctions',fs.invalid,
 'invalidTriggers',tr.invalid,'primaryKeys',ks.primary_keys,'isolatedFolderForeignKeys',ks.isolated_folder_fk)
 AS schema_state FROM table_state ts CROSS JOIN column_state cs CROSS JOIN function_state fs
 CROSS JOIN trigger_state tr CROSS JOIN key_state ks CROSS JOIN privilege_state ps
  $vault_probe$ INTO schema_status;
  IF schema_status->>'state' = 'empty' THEN
    EXECUTE $vault_schema$
-- Initial Voice Vault schema. No credentials or user identities are embedded.
-- Apply as the project administrator. The application uses Supabase Auth + RLS.
-- Imported libraries may remain unassigned until the owner signs in; unassigned
-- libraries are inaccessible through the client Data API.
DO $guard$
BEGIN
  IF to_regclass('public.libraries') IS NOT NULL OR to_regclass('public.folders') IS NOT NULL
     OR to_regclass('public.voices') IS NOT NULL OR to_regclass('public.user_settings') IS NOT NULL THEN
    RAISE EXCEPTION 'Application tables already exist. Review them before applying this initial migration.';
  END IF;
END
$guard$;

CREATE TABLE public.libraries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz
);
CREATE INDEX libraries_owner_idx ON public.libraries(owner_id);

CREATE TABLE public.folders (
  library_id uuid NOT NULL REFERENCES public.libraries(id) ON DELETE RESTRICT,
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'custom' CHECK (kind IN ('custom', 'virtual', 'unassigned')),
  sort_order integer NOT NULL DEFAULT 0,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  PRIMARY KEY (library_id, id),
  CONSTRAINT folders_valid_id CHECK (length(btrim(id)) BETWEEN 1 AND 200 AND id = btrim(id)),
  CONSTRAINT folders_virtual_ids CHECK ((id IN ('all', 'f_favorites')) = (kind = 'virtual'))
);

CREATE TABLE public.voices (
  library_id uuid NOT NULL REFERENCES public.libraries(id) ON DELETE RESTRICT,
  id text NOT NULL DEFAULT gen_random_uuid()::text,
  title text NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 500),
  url text NOT NULL CHECK (url ~ '^https://' AND length(url) <= 4096),
  audio_url text NOT NULL DEFAULT '' CHECK (audio_url = '' OR (audio_url ~ '^https://' AND length(audio_url) <= 16384)),
  cover_image text NOT NULL DEFAULT '' CHECK (length(cover_image) <= 2000000),
  folder_id text,
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 50000),
  is_favorite boolean NOT NULL DEFAULT false,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  deleted_at timestamptz,
  PRIMARY KEY (library_id, id),
  CONSTRAINT voices_folder_same_library FOREIGN KEY (library_id, folder_id)
    REFERENCES public.folders(library_id, id) ON DELETE RESTRICT,
  CONSTRAINT voices_valid_id CHECK (length(btrim(id)) BETWEEN 1 AND 200 AND id = btrim(id))
);

CREATE TABLE public.user_settings (
  owner_id uuid PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
  preferences jsonb NOT NULL DEFAULT '{"showQuickFolderBadge":false,"showSidebarFolders":true}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  CONSTRAINT user_settings_object CHECK (jsonb_typeof(preferences) = 'object'),
  CONSTRAINT user_settings_size CHECK (octet_length(preferences::text) <= 65536)
);

CREATE INDEX voices_active_folder_idx ON public.voices(library_id, folder_id, created_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX voices_active_favorites_idx ON public.voices(library_id, created_at DESC) WHERE is_favorite AND deleted_at IS NULL;
CREATE INDEX folders_active_order_idx ON public.folders(library_id, sort_order, name) WHERE deleted_at IS NULL;

CREATE FUNCTION public.vault_touch_record()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'libraries' THEN
      IF NEW.owner_id IS DISTINCT FROM OLD.owner_id AND current_user NOT IN ('postgres', 'supabase_admin') THEN
        RAISE EXCEPTION 'The owner cannot be changed by a client' USING ERRCODE = '42501';
      END IF;
      IF NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'The library ID cannot be changed' USING ERRCODE = '42501';
      END IF;
    ELSIF TG_TABLE_NAME = 'user_settings' THEN
      IF NEW.owner_id IS DISTINCT FROM OLD.owner_id THEN
        RAISE EXCEPTION 'The owner cannot be changed' USING ERRCODE = '42501';
      END IF;
    ELSE
      IF NEW.library_id IS DISTINCT FROM OLD.library_id OR NEW.id IS DISTINCT FROM OLD.id THEN
        RAISE EXCEPTION 'The library and record ID cannot be changed' USING ERRCODE = '42501';
      END IF;
    END IF;
    NEW.created_at := OLD.created_at;
    NEW.version := OLD.version + 1;
  ELSE
    NEW.version := 1;
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END
$fn$;

CREATE FUNCTION public.vault_require_active_folder()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
BEGIN
  IF NEW.folder_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.folders f WHERE f.library_id = NEW.library_id AND f.id = NEW.folder_id
      AND f.deleted_at IS NULL AND f.kind <> 'virtual'
  ) THEN
    RAISE EXCEPTION 'The folder is unavailable, virtual or belongs to another library' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$fn$;

CREATE FUNCTION public.vault_archive_folder()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $fn$
BEGIN
  IF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
    UPDATE public.voices SET folder_id = NULL,
      metadata = metadata || jsonb_build_object('previousFolderId', OLD.id)
    WHERE library_id = OLD.library_id AND folder_id = OLD.id;
  END IF;
  RETURN NEW;
END
$fn$;

CREATE TRIGGER libraries_touch BEFORE INSERT OR UPDATE ON public.libraries FOR EACH ROW EXECUTE FUNCTION public.vault_touch_record();
CREATE TRIGGER folders_touch BEFORE INSERT OR UPDATE ON public.folders FOR EACH ROW EXECUTE FUNCTION public.vault_touch_record();
CREATE TRIGGER folders_archive BEFORE UPDATE OF deleted_at ON public.folders FOR EACH ROW EXECUTE FUNCTION public.vault_archive_folder();
CREATE TRIGGER voices_touch BEFORE INSERT OR UPDATE ON public.voices FOR EACH ROW EXECUTE FUNCTION public.vault_touch_record();
CREATE TRIGGER voices_folder_check BEFORE INSERT OR UPDATE OF folder_id, library_id ON public.voices FOR EACH ROW EXECUTE FUNCTION public.vault_require_active_folder();
CREATE TRIGGER settings_touch BEFORE INSERT OR UPDATE ON public.user_settings FOR EACH ROW EXECUTE FUNCTION public.vault_touch_record();

ALTER TABLE public.libraries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY libraries_select_own ON public.libraries FOR SELECT TO authenticated USING ((SELECT auth.uid()) = owner_id);
CREATE POLICY libraries_insert_own ON public.libraries FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY libraries_update_own ON public.libraries FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = owner_id) WITH CHECK ((SELECT auth.uid()) = owner_id);

CREATE POLICY folders_select_own ON public.folders FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.libraries l WHERE l.id = library_id AND l.owner_id = (SELECT auth.uid())));
CREATE POLICY folders_insert_own ON public.folders FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.libraries l WHERE l.id = library_id AND l.owner_id = (SELECT auth.uid()) AND l.deleted_at IS NULL));
CREATE POLICY folders_update_own ON public.folders FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.libraries l WHERE l.id = library_id AND l.owner_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.libraries l WHERE l.id = library_id AND l.owner_id = (SELECT auth.uid()) AND l.deleted_at IS NULL));

CREATE POLICY voices_select_own ON public.voices FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.libraries l WHERE l.id = library_id AND l.owner_id = (SELECT auth.uid())));
CREATE POLICY voices_insert_own ON public.voices FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.libraries l WHERE l.id = library_id AND l.owner_id = (SELECT auth.uid()) AND l.deleted_at IS NULL));
CREATE POLICY voices_update_own ON public.voices FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.libraries l WHERE l.id = library_id AND l.owner_id = (SELECT auth.uid())))
  WITH CHECK (EXISTS (SELECT 1 FROM public.libraries l WHERE l.id = library_id AND l.owner_id = (SELECT auth.uid()) AND l.deleted_at IS NULL));

CREATE POLICY settings_select_own ON public.user_settings FOR SELECT TO authenticated USING ((SELECT auth.uid()) = owner_id);
CREATE POLICY settings_insert_own ON public.user_settings FOR INSERT TO authenticated WITH CHECK ((SELECT auth.uid()) = owner_id);
CREATE POLICY settings_update_own ON public.user_settings FOR UPDATE TO authenticated USING ((SELECT auth.uid()) = owner_id) WITH CHECK ((SELECT auth.uid()) = owner_id);

REVOKE ALL ON TABLE public.libraries, public.folders, public.voices, public.user_settings FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.libraries, public.folders, public.voices, public.user_settings TO authenticated;
REVOKE ALL ON FUNCTION public.vault_touch_record(), public.vault_require_active_folder(), public.vault_archive_folder() FROM PUBLIC, anon, authenticated;

DO $realtime$
DECLARE t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
  FOREACH t IN ARRAY ARRAY['libraries','folders','voices','user_settings'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END
$realtime$;

COMMENT ON TABLE public.libraries IS 'Library ownership. An imported library with owner_id NULL is private and awaits assignment to a real authenticated user.';
COMMENT ON TABLE public.voices IS 'Fish Audio references and metadata, with favorites and recoverable soft deletion.';
COMMENT ON TABLE public.folders IS 'Includes original virtual all/favorites folder labels. Virtual folders cannot contain voice records.';
COMMENT ON COLUMN public.voices.metadata IS 'Original imported object, including legacy name, sampleAudio, folderName and createdAt, preserved without loss.';
COMMENT ON COLUMN public.voices.version IS 'Server revision. Client UPDATE requests must filter by their expected version to detect stale writes.';
COMMENT ON COLUMN public.voices.deleted_at IS 'Set to archive, or NULL to restore. Physical DELETE is not granted to clients.';
NOTIFY pgrst, 'reload schema';
    $vault_schema$;
    EXECUTE $vault_api$
-- Personal extension administrator API. No credentials are embedded here.
-- Apply with the Supabase project administrator; this does not grant client access.
CREATE OR REPLACE FUNCTION public.vault_export_snapshot(p_library_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE result jsonb;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Administrator access required' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'libraryId', l.id,
    'revision', l.version,
    'settings', CASE WHEN jsonb_typeof(l.metadata->'settings') = 'object' THEN l.metadata->'settings'
      ELSE '{"showQuickFolderBadge":false,"showSidebarFolders":true}'::jsonb END,
    'folders', COALESCE((
      SELECT jsonb_agg(f.metadata || jsonb_build_object('id', f.id, 'name', f.name) ORDER BY f.sort_order, f.created_at, f.id)
      FROM public.folders f WHERE f.library_id = l.id AND f.deleted_at IS NULL
    ), '[]'::jsonb),
    'voices', COALESCE((
      SELECT jsonb_agg((v.metadata - ARRAY['coverStoragePath','coverExpiresAt']) || jsonb_build_object(
        'id', v.id, 'title', v.title, 'name', v.title, 'url', v.url,
        'audioUrl', v.audio_url, 'sampleAudio', v.audio_url,
        'coverImage', CASE WHEN v.cover_image LIKE 'storage://voice-vault-images/%' THEN '' ELSE v.cover_image END,
        'coverStoragePath', CASE WHEN v.cover_image LIKE 'storage://voice-vault-images/%' THEN substring(v.cover_image FROM length('storage://voice-vault-images/') + 1) ELSE '' END, 'notes', v.notes, 'isFavorite', v.is_favorite,
        'folderId', COALESCE(v.folder_id, 'f_sueltas'),
        'folderName', COALESCE(f.name, (SELECT uf.name FROM public.folders uf WHERE uf.library_id = l.id AND uf.id = 'f_sueltas' AND uf.deleted_at IS NULL), 'Voces Sueltas'),
        'createdAt', COALESCE(v.metadata->'createdAt', to_jsonb(v.created_at))
      ) ORDER BY COALESCE((
        SELECT o.ord FROM jsonb_array_elements_text(CASE WHEN jsonb_typeof(l.metadata->'voiceOrder') = 'array' THEN l.metadata->'voiceOrder' ELSE '[]'::jsonb END)
          WITH ORDINALITY AS o(id, ord) WHERE o.id = v.id LIMIT 1
      ), 9223372036854775807), v.created_at DESC, v.id)
      FROM public.voices v LEFT JOIN public.folders f ON f.library_id = v.library_id AND f.id = v.folder_id AND f.deleted_at IS NULL
      WHERE v.library_id = l.id AND v.deleted_at IS NULL
    ), '[]'::jsonb)
  ) INTO result FROM public.libraries l WHERE l.id = p_library_id AND l.deleted_at IS NULL;
  IF result IS NULL THEN
    RAISE EXCEPTION 'Library unavailable' USING ERRCODE = '22023';
  END IF;
  RETURN result;
END
$fn$;

CREATE OR REPLACE FUNCTION public.vault_apply_snapshot(p_library_id uuid, p_expected_version bigint, p_payload jsonb)
RETURNS jsonb LANGUAGE plpgsql VOLATILE SECURITY INVOKER SET search_path = '' AS $fn$
DECLARE
  lib public.libraries%ROWTYPE;
  item jsonb;
  item_order bigint;
  item_title text;
  item_audio text;
  item_folder text;
  item_cover text;
  item_cover_path text;
  existing_metadata jsonb;
  existing_cover text;
  known_voice_keys text[] := ARRAY['id','title','name','url','audioUrl','sampleAudio','coverImage','coverStoragePath','coverExpiresAt','notes','isFavorite','folderId','folderName','createdAt'];
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Administrator access required' USING ERRCODE = '42501';
  END IF;
  IF p_expected_version IS NULL OR p_expected_version < 1 OR jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_payload->'folders') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'voices') IS DISTINCT FROM 'array'
     OR jsonb_typeof(p_payload->'settings') IS DISTINCT FROM 'object'
     OR octet_length(p_payload::text) > 25000000
     OR octet_length((p_payload->'settings')::text) > 65536
     OR jsonb_array_length(p_payload->'folders') > 5000
     OR jsonb_array_length(p_payload->'voices') > 50000 THEN
    RAISE EXCEPTION 'Invalid complete snapshot' USING ERRCODE = '22023';
  END IF;

  -- Serialize concurrent writers before checking the expected revision.
  SELECT * INTO lib FROM public.libraries WHERE id = p_library_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Library unavailable' USING ERRCODE = '22023'; END IF;
  IF lib.version <> p_expected_version THEN
    RAISE EXCEPTION 'VAULT_REVISION_CONFLICT' USING ERRCODE = '40001';
  END IF;

  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'folders') x GROUP BY x->>'id' HAVING count(*) > 1)
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'voices') x GROUP BY x->>'id' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'Duplicate record IDs' USING ERRCODE = '22023';
  END IF;

  -- Validate the entire payload BEFORE modifying any record.
  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'folders') LOOP
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
       OR length(btrim(item->>'id')) NOT BETWEEN 1 AND 200 OR item->>'id' <> btrim(item->>'id')
       OR jsonb_typeof(item->'name') IS DISTINCT FROM 'string'
       OR length(btrim(item->>'name')) NOT BETWEEN 1 AND 200 THEN
      RAISE EXCEPTION 'Invalid folder' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'voices') LOOP
    item_title := COALESCE(item->>'title', item->>'name');
    item_audio := CASE WHEN item ? 'audioUrl' THEN item->>'audioUrl' ELSE COALESCE(item->>'sampleAudio', '') END;
    item_folder := NULLIF(item->>'folderId', '');
    IF item_folder = 'f_sueltas' THEN item_folder := NULL; END IF;
    item_cover_path := COALESCE(item->>'coverStoragePath','');
    item_cover := COALESCE(item->>'coverImage','');
    IF item_cover_path = '' AND item_cover LIKE 'storage://voice-vault-images/%' THEN
      item_cover_path := substring(item_cover FROM length('storage://voice-vault-images/') + 1);
    END IF;
    IF item_cover_path <> '' THEN item_cover := 'storage://voice-vault-images/' || item_cover_path; END IF;
    IF jsonb_typeof(item) IS DISTINCT FROM 'object'
       OR jsonb_typeof(item->'id') IS DISTINCT FROM 'string'
       OR length(btrim(item->>'id')) NOT BETWEEN 1 AND 200 OR item->>'id' <> btrim(item->>'id')
       OR (jsonb_typeof(COALESCE(item->'title', item->'name')) IS DISTINCT FROM 'string')
       OR item_title IS NULL OR length(btrim(item_title)) NOT BETWEEN 1 AND 500
       OR jsonb_typeof(item->'url') IS DISTINCT FROM 'string'
       OR (item->>'url') !~ '^https://[^/?#[:space:]@:]+(:[0-9]+)?([/?#][^[:space:]]*)?$' OR length(item->>'url') > 4096
       OR item_audio IS NULL OR length(item_audio) > 16384 OR (item_audio <> '' AND item_audio !~ '^https://[^/?#[:space:]@:]+(:[0-9]+)?([/?#][^[:space:]]*)?$')
       OR (item ? 'audioUrl' AND jsonb_typeof(item->'audioUrl') IS DISTINCT FROM 'string')
       OR (NOT item ? 'audioUrl' AND item ? 'sampleAudio' AND jsonb_typeof(item->'sampleAudio') IS DISTINCT FROM 'string')
       OR (item ? 'coverImage' AND (jsonb_typeof(item->'coverImage') IS DISTINCT FROM 'string' OR length(item->>'coverImage') > 2000000))
       OR (item ? 'coverStoragePath' AND jsonb_typeof(item->'coverStoragePath') IS DISTINCT FROM 'string')
       OR (item_cover_path <> '' AND (item_cover_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[a-f0-9]{64}\.(png|jpg|jpeg|webp)$' OR split_part(item_cover_path,'/',1) <> p_library_id::text))
       OR (item_cover_path = '' AND item_cover ~ '^https://[^/]+/storage/v1/object/sign/voice-vault-images/')
       OR (item ? 'notes' AND (jsonb_typeof(item->'notes') IS DISTINCT FROM 'string' OR length(item->>'notes') > 50000))
       OR (item ? 'isFavorite' AND jsonb_typeof(item->'isFavorite') IS DISTINCT FROM 'boolean')
       OR (item ? 'folderId' AND jsonb_typeof(item->'folderId') NOT IN ('string', 'null'))
       OR item_folder IN ('all','f_favorites')
       OR (item_folder IS NOT NULL AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'folders') f WHERE f->>'id' = item_folder)) THEN
      RAISE EXCEPTION 'Invalid voice or folder reference' USING ERRCODE = '22023';
    END IF;
  END LOOP;

  FOR item, item_order IN SELECT value, ordinality - 1 FROM jsonb_array_elements(p_payload->'folders') WITH ORDINALITY LOOP
    INSERT INTO public.folders AS existing (library_id, id, name, kind, sort_order, metadata)
    VALUES (p_library_id, item->>'id', item->>'name',
      CASE WHEN item->>'id' IN ('all','f_favorites') THEN 'virtual' WHEN item->>'id' = 'f_sueltas' THEN 'unassigned' ELSE 'custom' END,
      item_order::integer,
      COALESCE((SELECT metadata FROM public.folders WHERE library_id = p_library_id AND id = item->>'id'), item) || (item - ARRAY['id','name']))
    ON CONFLICT (library_id, id) DO UPDATE SET name = EXCLUDED.name, kind = EXCLUDED.kind,
      sort_order = EXCLUDED.sort_order, metadata = EXCLUDED.metadata, deleted_at = NULL
    WHERE (existing.name, existing.kind, existing.sort_order, existing.metadata, existing.deleted_at)
      IS DISTINCT FROM (EXCLUDED.name, EXCLUDED.kind, EXCLUDED.sort_order, EXCLUDED.metadata, NULL::timestamptz);
  END LOOP;

  -- These three original navigation folders are never deleted by a snapshot.
  INSERT INTO public.folders (library_id, id, name, kind, sort_order)
  VALUES (p_library_id, 'all', 'Todas', 'virtual', 0),
    (p_library_id, 'f_favorites', 'Favoritas', 'virtual', 1),
    (p_library_id, 'f_sueltas', 'Voces Sueltas', 'unassigned', 2)
  ON CONFLICT (library_id, id) DO NOTHING;

  FOR item IN SELECT value FROM jsonb_array_elements(p_payload->'voices') LOOP
    item_title := COALESCE(item->>'title', item->>'name');
    item_audio := CASE WHEN item ? 'audioUrl' THEN item->>'audioUrl' ELSE COALESCE(item->>'sampleAudio', '') END;
    item_folder := NULLIF(item->>'folderId', '');
    IF item_folder = 'f_sueltas' THEN item_folder := NULL; END IF;
    item_cover_path := COALESCE(item->>'coverStoragePath','');
    item_cover := COALESCE(item->>'coverImage','');
    IF item_cover_path = '' AND item_cover LIKE 'storage://voice-vault-images/%' THEN
      item_cover_path := substring(item_cover FROM length('storage://voice-vault-images/') + 1);
    END IF;
    IF item_cover_path <> '' THEN item_cover := 'storage://voice-vault-images/' || item_cover_path; END IF;
    SELECT metadata,cover_image INTO existing_metadata,existing_cover FROM public.voices
      WHERE library_id = p_library_id AND id = item->>'id';
    existing_metadata := COALESCE(existing_metadata,item) - ARRAY['coverStoragePath','coverExpiresAt'];
    IF item_cover_path <> '' OR existing_cover LIKE 'storage://voice-vault-images/%'
       OR (item_cover = '' AND COALESCE(existing_cover,'') <> '') THEN
      existing_metadata := existing_metadata - 'coverImage';
    END IF;
    INSERT INTO public.voices AS existing
      (library_id,id,title,url,audio_url,cover_image,folder_id,notes,is_favorite,metadata)
    VALUES (p_library_id,item->>'id',item_title,item->>'url',item_audio,
      item_cover,item_folder,COALESCE(item->>'notes',''),COALESCE((item->>'isFavorite')::boolean,false),
      existing_metadata || (item - known_voice_keys))
    ON CONFLICT (library_id,id) DO UPDATE SET title = EXCLUDED.title, url = EXCLUDED.url,
      audio_url = EXCLUDED.audio_url, cover_image = EXCLUDED.cover_image, folder_id = EXCLUDED.folder_id,
      notes = EXCLUDED.notes, is_favorite = EXCLUDED.is_favorite, metadata = EXCLUDED.metadata, deleted_at = NULL
    WHERE (existing.title,existing.url,existing.audio_url,existing.cover_image,existing.folder_id,existing.notes,existing.is_favorite,existing.metadata,existing.deleted_at)
      IS DISTINCT FROM (EXCLUDED.title,EXCLUDED.url,EXCLUDED.audio_url,EXCLUDED.cover_image,EXCLUDED.folder_id,EXCLUDED.notes,EXCLUDED.is_favorite,EXCLUDED.metadata,NULL::timestamptz);
  END LOOP;

  UPDATE public.voices v SET deleted_at = clock_timestamp()
  WHERE v.library_id = p_library_id AND v.deleted_at IS NULL
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'voices') AS incoming(value) WHERE incoming.value->>'id' = v.id);
  UPDATE public.folders f SET deleted_at = clock_timestamp()
  WHERE f.library_id = p_library_id AND f.deleted_at IS NULL AND f.id NOT IN ('all','f_favorites','f_sueltas')
    AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_payload->'folders') AS incoming(value) WHERE incoming.value->>'id' = f.id);

  UPDATE public.libraries SET metadata = metadata || jsonb_build_object(
    'settings',p_payload->'settings',
    'voiceOrder',(SELECT COALESCE(jsonb_agg(value->'id' ORDER BY ordinality),'[]'::jsonb) FROM jsonb_array_elements(p_payload->'voices') WITH ORDINALITY)
  ) WHERE id = p_library_id;
  RETURN public.vault_export_snapshot(p_library_id);
END
$fn$;

REVOKE ALL ON FUNCTION public.vault_export_snapshot(uuid), public.vault_apply_snapshot(uuid,bigint,jsonb)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.vault_export_snapshot(uuid), public.vault_apply_snapshot(uuid,bigint,jsonb) TO postgres;
COMMENT ON FUNCTION public.vault_apply_snapshot(uuid,bigint,jsonb) IS 'Administrator-only atomic snapshot update. Serializes writers, rejects stale library versions, preserves unknown metadata and archives missing records.';
NOTIFY pgrst, 'reload schema';
    $vault_api$;
  ELSIF schema_status->>'state' <> 'compatible' THEN
    RAISE EXCEPTION 'VAULT_SCHEMA_INCOMPATIBLE: existing application schema requires review' USING ERRCODE='22023';
  END IF;
END
$vault_bootstrap$;
COMMIT;
