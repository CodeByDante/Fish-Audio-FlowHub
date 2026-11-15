"""Stage the exact shared client protocol and bootstrap for the Pages API relay."""
from pathlib import Path
import json

root = Path(__file__).resolve().parent.parent
out = root / 'supabase/functions/voice-vault-api'
out.mkdir(parents=True, exist_ok=True)
(out / 'cloud-core.js').write_text((root / 'src/js/cloud-core.js').read_text())
(out / 'bootstrap-sql.js').write_text('export const BOOTSTRAP_SQL = ' + json.dumps((root / 'src/sql/bootstrap.sql').read_text(), ensure_ascii=False) + ';\n')
print(json.dumps({'prepared': ['cloud-core.js', 'bootstrap-sql.js']}))
