-- Personal extension administrator API. No credentials are embedded here.
-- Apply with the Supabase project administrator; this does not grant client access.
BEGIN;

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
COMMIT;
