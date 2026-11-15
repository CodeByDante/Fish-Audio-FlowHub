-- Non-persistent integration tests: all fixtures and changes are rolled back.
BEGIN;
INSERT INTO auth.users(id) VALUES
 ('10000000-0000-4000-8000-000000000001'),
 ('10000000-0000-4000-8000-000000000002');
INSERT INTO public.libraries(id,owner_id,name) VALUES
 ('20000000-0000-4000-8000-000000000001','10000000-0000-4000-8000-000000000001','Test A'),
 ('20000000-0000-4000-8000-000000000002','10000000-0000-4000-8000-000000000002','Test B'),
 ('20000000-0000-4000-8000-000000000003',NULL,'Unassigned test');
INSERT INTO public.folders(library_id,id,name) VALUES
 ('20000000-0000-4000-8000-000000000001','folder-a','A'),
 ('20000000-0000-4000-8000-000000000002','folder-b','B');
INSERT INTO public.voices(library_id,id,title,url,folder_id) VALUES
 ('20000000-0000-4000-8000-000000000001','voice-a','A','https://fish.audio/m/test-a','folder-a'),
 ('20000000-0000-4000-8000-000000000002','voice-b','B','https://fish.audio/m/test-b','folder-b'),
 ('20000000-0000-4000-8000-000000000003','unassigned-voice','Private','https://fish.audio/m/test-private',NULL);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
DO $test$
DECLARE n integer; rev bigint;
BEGIN
  SELECT count(*) INTO n FROM public.voices;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: owner A can read foreign or unassigned data'; END IF;
  SELECT count(*) INTO n FROM public.libraries;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL: library ownership isolation'; END IF;
  UPDATE public.voices SET title='Not allowed' WHERE id='voice-b';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: foreign update succeeded'; END IF;
  BEGIN
    INSERT INTO public.voices(library_id,id,title,url) VALUES
      ('20000000-0000-4000-8000-000000000002','intruder','Bad','https://fish.audio/m/bad');
    RAISE EXCEPTION 'FAIL: foreign insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.libraries SET owner_id='10000000-0000-4000-8000-000000000002'
      WHERE id='20000000-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'FAIL: owner transfer succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    UPDATE public.voices SET folder_id='folder-b' WHERE id='voice-a';
    RAISE EXCEPTION 'FAIL: cross-library folder accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  UPDATE public.voices SET is_favorite=true, version=999 WHERE id='voice-a' AND version=1 RETURNING version INTO rev;
  IF rev <> 2 THEN RAISE EXCEPTION 'FAIL: authoritative revision'; END IF;
  UPDATE public.voices SET title='stale write' WHERE id='voice-a' AND version=1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL: stale version matched'; END IF;
  UPDATE public.folders SET deleted_at=now() WHERE id='folder-a';
  IF NOT EXISTS (SELECT 1 FROM public.voices WHERE id='voice-a' AND folder_id IS NULL AND metadata->>'previousFolderId'='folder-a') THEN
    RAISE EXCEPTION 'FAIL: archiving a folder lost its voice';
  END IF;
  BEGIN
    UPDATE public.voices SET folder_id='folder-a' WHERE id='voice-a';
    RAISE EXCEPTION 'FAIL: archived folder accepted';
  EXCEPTION WHEN foreign_key_violation THEN NULL; END;
  UPDATE public.voices SET deleted_at=now() WHERE id='voice-a';
  UPDATE public.voices SET deleted_at=NULL WHERE id='voice-a';
  IF NOT EXISTS (SELECT 1 FROM public.voices WHERE id='voice-a' AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'FAIL: restore failed';
  END IF;
  INSERT INTO public.user_settings(preferences) VALUES ('{"test":true}');
  UPDATE public.user_settings SET preferences='{"test":false}';
  IF NOT EXISTS (SELECT 1 FROM public.user_settings WHERE version=2 AND preferences='{"test":false}') THEN
    RAISE EXCEPTION 'FAIL: settings update';
  END IF;
  IF has_table_privilege('authenticated','public.voices','DELETE') THEN
    RAISE EXCEPTION 'FAIL: physical DELETE granted';
  END IF;
END
$test$;

SELECT set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
DO $test$
BEGIN
  IF (SELECT count(*) FROM public.voices) <> 1 OR NOT EXISTS (SELECT 1 FROM public.voices WHERE id='voice-b') THEN
    RAISE EXCEPTION 'FAIL: owner B isolation';
  END IF;
END
$test$;

SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub','',true);
DO $test$
BEGIN
  BEGIN
    PERFORM 1 FROM public.voices;
    RAISE EXCEPTION 'FAIL: anonymous read succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO public.libraries(name) VALUES('Anonymous');
    RAISE EXCEPTION 'FAIL: anonymous insert succeeded';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END
$test$;
ROLLBACK;
SELECT 'PASS: ownership isolation, unassigned privacy, foreign writes, safe folders, favorites, revisions, restoration, settings, anonymous denial' AS validation;
