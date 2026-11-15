-- Administrator RPC integration checks. Only a transaction-local fixture is written.
-- Run with the Supabase Management SQL API as postgres, after online_api.sql.
-- Every fixture is rolled back, including when the test raises an exception.
BEGIN;
DO $test$
DECLARE
  fixture constant uuid := '10000000-1111-4111-8111-111111111111';
  other_library constant uuid := '20000000-2222-4222-8222-222222222222';
  payload jsonb;
  snapshot jsonb;
  before_snapshot jsonb;
  bad jsonb;
  voice jsonb;
  path text;
  revision bigint;
  voice_version bigint;
  rejected boolean;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Run this administrator test as postgres';
  END IF;
  IF EXISTS (SELECT 1 FROM public.libraries WHERE id IN (fixture, other_library)) THEN
    RAISE EXCEPTION 'Test fixture UUID already exists; refusing to modify it';
  END IF;
  INSERT INTO public.libraries (id, owner_id, name, metadata)
  VALUES (fixture, NULL, 'Transactional RPC fixture', '{"unknownLibraryField":"preserved"}');

  snapshot := public.vault_export_snapshot(fixture);
  IF snapshot->>'libraryId' IS DISTINCT FROM fixture::text
     OR (snapshot->>'revision')::bigint IS DISTINCT FROM 1::bigint
     OR snapshot->'voices' IS DISTINCT FROM '[]'::jsonb
     OR snapshot->'folders' IS DISTINCT FROM '[]'::jsonb
     OR jsonb_typeof(snapshot->'settings') IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Empty export shape or initial revision failed';
  END IF;

  payload := jsonb_build_object(
    'folders', '[{"id":"all","name":"Todas"},{"id":"f_favorites","name":"Favoritas"},{"id":"f_sueltas","name":"Voces Sueltas"},{"id":"alpha","name":"Alpha","unknownFolderField":7},{"id":"beta","name":"Beta"}]'::jsonb,
    'voices', '[{"id":"voice-one","title":"Título original","name":"Alias obsoleto","url":"https://fish.audio/m/voice-one/","sampleAudio":"https://example.com/one.mp3","coverImage":"","folderId":"alpha","notes":"Nota original","isFavorite":false,"createdAt":1700000000000,"unknownVoiceField":{"keep":true}},{"id":"voice-two","name":"Segunda voz","url":"https://fish.audio/m/voice-two/","audioUrl":"https://example.com/two.mp3","folderId":"beta","isFavorite":false}]'::jsonb,
    'settings', '{"showQuickFolderBadge":true,"showSidebarFolders":true,"customSetting":"kept"}'::jsonb
  );
  snapshot := public.vault_apply_snapshot(fixture, 1, payload);
  revision := (snapshot->>'revision')::bigint;
  SELECT value INTO voice FROM jsonb_array_elements(snapshot->'voices') WHERE value->>'id' = 'voice-one';
  IF revision IS DISTINCT FROM 2::bigint
     OR jsonb_array_length(snapshot->'voices') IS DISTINCT FROM 2
     OR jsonb_array_length(snapshot->'folders') IS DISTINCT FROM 5
     OR voice->>'title' IS DISTINCT FROM 'Título original'
     OR voice->>'name' IS DISTINCT FROM 'Título original'
     OR voice->>'audioUrl' IS DISTINCT FROM 'https://example.com/one.mp3'
     OR voice->>'sampleAudio' IS DISTINCT FROM 'https://example.com/one.mp3'
     OR voice->'createdAt' IS DISTINCT FROM '1700000000000'::jsonb
     OR voice->'unknownVoiceField' IS DISTINCT FROM '{"keep":true}'::jsonb
     OR snapshot->'settings' IS DISTINCT FROM payload->'settings' THEN
    RAISE EXCEPTION 'Initial apply, aliases, settings or metadata preservation failed';
  END IF;
  IF (SELECT metadata->>'unknownLibraryField' FROM public.libraries WHERE id = fixture) IS DISTINCT FROM 'preserved' THEN
    RAISE EXCEPTION 'Library metadata was lost';
  END IF;

  -- A saved snapshot advances the library revision but leaves unchanged rows alone.
  SELECT version INTO voice_version FROM public.voices WHERE library_id = fixture AND id = 'voice-one';
  snapshot := public.vault_apply_snapshot(fixture, revision, payload);
  revision := (snapshot->>'revision')::bigint;
  IF revision IS DISTINCT FROM 3::bigint
     OR (SELECT version FROM public.voices WHERE library_id = fixture AND id = 'voice-one') IS DISTINCT FROM voice_version THEN
    RAISE EXCEPTION 'No-op save changed child rows or failed to advance the library revision';
  END IF;

  -- Rename and reorder folders, reorder voices, update canonical aliases and favorite.
  payload := jsonb_set(payload, '{folders}', '[{"id":"all","name":"Todas"},{"id":"f_favorites","name":"Favoritas"},{"id":"f_sueltas","name":"Voces Sueltas"},{"id":"beta","name":"Beta"},{"id":"alpha","name":"Renombrada"}]');
  payload := jsonb_set(payload, '{voices}', jsonb_build_array(payload->'voices'->1, payload->'voices'->0));
  payload := jsonb_set(payload, '{voices,1,title}', '"Título editado"');
  payload := jsonb_set(payload, '{voices,1,audioUrl}', '"https://example.com/new.mp3"');
  payload := jsonb_set(payload, '{voices,1,isFavorite}', 'true');
  payload := jsonb_set(payload, '{voices,1,notes}', '"Nota editada"');
  snapshot := public.vault_apply_snapshot(fixture, revision, payload);
  revision := (snapshot->>'revision')::bigint;
  voice := snapshot->'voices'->1;
  IF revision IS DISTINCT FROM 4::bigint
     OR snapshot->'voices'->0->>'id' IS DISTINCT FROM 'voice-two'
     OR snapshot->'folders'->3->>'id' IS DISTINCT FROM 'beta'
     OR voice->>'id' IS DISTINCT FROM 'voice-one'
     OR voice->>'title' IS DISTINCT FROM 'Título editado'
     OR voice->>'name' IS DISTINCT FROM 'Título editado'
     OR voice->>'folderName' IS DISTINCT FROM 'Renombrada'
     OR voice->>'sampleAudio' IS DISTINCT FROM 'https://example.com/new.mp3'
     OR voice->'isFavorite' IS DISTINCT FROM 'true'::jsonb
     OR voice->>'notes' IS DISTINCT FROM 'Nota editada'
     OR (SELECT metadata->'unknownFolderField' FROM public.folders WHERE library_id = fixture AND id = 'alpha') IS DISTINCT FROM '7'::jsonb THEN
    RAISE EXCEPTION 'Edit, favorite, rename, order or unknown folder metadata failed';
  END IF;

  before_snapshot := snapshot;
  rejected := false;
  BEGIN
    PERFORM public.vault_apply_snapshot(fixture, revision - 1, payload);
  EXCEPTION WHEN serialization_failure THEN rejected := true;
  END;
  IF NOT rejected OR public.vault_export_snapshot(fixture) IS DISTINCT FROM before_snapshot THEN
    RAISE EXCEPTION 'Stale revision was accepted or modified data';
  END IF;

  rejected := false;
  bad := jsonb_set(payload, '{voices,0,folderId}', '"missing-folder"');
  BEGIN
    PERFORM public.vault_apply_snapshot(fixture, revision, bad);
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  IF NOT rejected OR public.vault_export_snapshot(fixture) IS DISTINCT FROM before_snapshot THEN
    RAISE EXCEPTION 'Invalid folder reference was accepted or partially written';
  END IF;

  rejected := false;
  bad := jsonb_set(payload, '{voices}', jsonb_build_array(payload->'voices'->0, payload->'voices'->0));
  BEGIN
    PERFORM public.vault_apply_snapshot(fixture, revision, bad);
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  IF NOT rejected OR public.vault_export_snapshot(fixture) IS DISTINCT FROM before_snapshot THEN
    RAISE EXCEPTION 'Duplicate IDs were accepted or partially written';
  END IF;

  rejected := false;
  BEGIN
    PERFORM public.vault_apply_snapshot(fixture, revision, payload - 'settings');
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  IF NOT rejected OR public.vault_export_snapshot(fixture) IS DISTINCT FROM before_snapshot THEN
    RAISE EXCEPTION 'Partial snapshot was accepted or partially written';
  END IF;

  -- The database stores a stable private-object reference, never a signed URL.
  path := fixture::text || '/' || repeat('a', 64) || '.png';
  payload := jsonb_set(payload, '{voices,1,coverStoragePath}', to_jsonb(path));
  payload := jsonb_set(payload, '{voices,1,coverImage}', '"https://fixture.supabase.co/storage/v1/object/sign/voice-vault-images/transient?token=temporary"');
  payload := jsonb_set(payload, '{voices,1,coverExpiresAt}', '1900000000000');
  snapshot := public.vault_apply_snapshot(fixture, revision, payload);
  revision := (snapshot->>'revision')::bigint;
  voice := snapshot->'voices'->1;
  IF voice->>'coverStoragePath' IS DISTINCT FROM path
     OR voice->>'coverImage' IS DISTINCT FROM ''
     OR (SELECT cover_image FROM public.voices WHERE library_id = fixture AND id = 'voice-one') IS DISTINCT FROM ('storage://voice-vault-images/' || path)
     OR (SELECT metadata ?| ARRAY['coverStoragePath','coverExpiresAt','coverImage'] FROM public.voices WHERE library_id = fixture AND id = 'voice-one') THEN
    RAISE EXCEPTION 'Private Storage path or transient signed-URL stripping failed';
  END IF;

  before_snapshot := snapshot;
  rejected := false;
  bad := jsonb_set(payload, '{voices,1,coverStoragePath}', to_jsonb(other_library::text || '/' || repeat('b', 64) || '.png'));
  BEGIN
    PERFORM public.vault_apply_snapshot(fixture, revision, bad);
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  IF NOT rejected OR public.vault_export_snapshot(fixture) IS DISTINCT FROM before_snapshot THEN
    RAISE EXCEPTION 'Foreign-library Storage path was accepted or partially written';
  END IF;

  rejected := false;
  bad := jsonb_set(payload, '{voices,1,coverStoragePath}', '""');
  BEGIN
    PERFORM public.vault_apply_snapshot(fixture, revision, bad);
  EXCEPTION WHEN invalid_parameter_value THEN rejected := true;
  END;
  IF NOT rejected OR public.vault_export_snapshot(fixture) IS DISTINCT FROM before_snapshot THEN
    RAISE EXCEPTION 'Expiring signed URL without a stable path was persisted';
  END IF;

  payload := jsonb_set(payload, '{voices,1,coverStoragePath}', '""');
  payload := jsonb_set(payload, '{voices,1,coverImage}', '""');
  snapshot := public.vault_apply_snapshot(fixture, revision, payload);
  revision := (snapshot->>'revision')::bigint;
  IF snapshot->'voices'->1->>'coverStoragePath' IS DISTINCT FROM ''
     OR (SELECT cover_image FROM public.voices WHERE library_id = fixture AND id = 'voice-one') IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'Removing a cover retained its Storage path';
  END IF;

  -- Omitting a voice archives it; exported snapshots hide it and navigation stays.
  payload := jsonb_set(payload, '{voices}', jsonb_build_array(payload->'voices'->1));
  snapshot := public.vault_apply_snapshot(fixture, revision, payload);
  revision := (snapshot->>'revision')::bigint;
  IF jsonb_array_length(snapshot->'voices') IS DISTINCT FROM 1
     OR (SELECT deleted_at IS NOT NULL FROM public.voices WHERE library_id = fixture AND id = 'voice-two') IS DISTINCT FROM true
     OR (SELECT count(*) FROM public.voices WHERE library_id = fixture) IS DISTINCT FROM 2::bigint THEN
    RAISE EXCEPTION 'Voice removal was not recoverable soft deletion';
  END IF;

  -- Move the surviving voice out of a deleted folder in the same atomic save.
  payload := jsonb_set(payload, '{voices,0,folderId}', '"f_sueltas"');
  payload := jsonb_set(payload, '{folders}', '[{"id":"all","name":"Todas"},{"id":"f_favorites","name":"Favoritas"},{"id":"f_sueltas","name":"Voces Sueltas"},{"id":"beta","name":"Beta"}]');
  snapshot := public.vault_apply_snapshot(fixture, revision, payload);
  revision := (snapshot->>'revision')::bigint;
  IF snapshot->'voices'->0->>'folderId' IS DISTINCT FROM 'f_sueltas'
     OR (SELECT deleted_at IS NOT NULL FROM public.folders WHERE library_id = fixture AND id = 'alpha') IS DISTINCT FROM true
     OR (SELECT folder_id IS NULL FROM public.voices WHERE library_id = fixture AND id = 'voice-one') IS DISTINCT FROM true
     OR jsonb_array_length(snapshot->'folders') IS DISTINCT FROM 4 THEN
    RAISE EXCEPTION 'Folder removal and move to unassigned failed';
  END IF;

  -- The archive trigger also rescues references if an administrator archives directly.
  UPDATE public.folders SET deleted_at = NULL WHERE library_id = fixture AND id = 'alpha';
  UPDATE public.voices SET folder_id = 'alpha' WHERE library_id = fixture AND id = 'voice-one';
  UPDATE public.folders SET deleted_at = clock_timestamp() WHERE library_id = fixture AND id = 'alpha';
  IF (SELECT folder_id IS NULL AND metadata->>'previousFolderId' = 'alpha' FROM public.voices WHERE library_id = fixture AND id = 'voice-one') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Folder archive trigger left a stranded voice';
  END IF;

  -- Re-importing the same ID restores the archived voice, without physical duplicates.
  payload := jsonb_set(payload, '{voices}', payload->'voices' || '[{"id":"voice-two","name":"Restaurada","url":"https://fish.audio/m/voice-two/","folderId":"f_sueltas","isFavorite":true}]'::jsonb);
  snapshot := public.vault_apply_snapshot(fixture, revision, payload);
  IF jsonb_array_length(snapshot->'voices') IS DISTINCT FROM 2
     OR (SELECT count(*) FROM public.voices WHERE library_id = fixture) IS DISTINCT FROM 2::bigint
     OR (SELECT deleted_at IS NULL AND title = 'Restaurada' AND is_favorite FROM public.voices WHERE library_id = fixture AND id = 'voice-two') IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Restoring an archived voice failed or created a duplicate';
  END IF;
END
$test$;
SELECT 'PASS: snapshot RPC, metadata, revisions, conflict rejection, atomic validation, favorites, ordering, folders, archives and private Storage paths' AS result;
ROLLBACK;
