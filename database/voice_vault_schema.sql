-- Initial Voice Vault schema. No credentials or user identities are embedded.
-- Apply as the project administrator. The application uses Supabase Auth + RLS.
-- Imported libraries may remain unassigned until the owner signs in; unassigned
-- libraries are inaccessible through the client Data API.
BEGIN;

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
COMMIT;
