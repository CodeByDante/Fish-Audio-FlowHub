"""Build a reproducible unpacked-extension ZIP from a strict public-file allowlist."""
from pathlib import Path
import json
import re
import zipfile
import hashlib

root = Path(__file__).resolve().parent.parent
dest = root / 'dist'
dest.mkdir(exist_ok=True)
manifest = json.loads((root / 'manifest.json').read_text())
version = manifest['version']
files = [root / name for name in ('manifest.json', 'index.html', 'config.json')]
for directory in ('src', 'images'):
    files.extend(p for p in (root / directory).rglob('*') if p.is_file() and not p.is_symlink())
files.sort(key=lambda p: p.relative_to(root).as_posix())
required = ('src/js/background.js', 'src/js/app.js', 'src/js/cloud-core.js', 'src/js/cloud-client.js', 'src/js/storage.js', 'src/styles/main.css', 'src/sql/bootstrap.sql', 'src/js/cloud-engine.js', 'src/js/web-transport.js', 'src/js/persistent-storage.js')
for name in required:
    if root / name not in files:
        raise SystemExit('Falta archivo requerido: ' + name)
for path in files:
    if path.suffix in ('.js', '.html', '.json', '.css', '.sql'):
        text = path.read_text()
        if re.search(r'(?:sbp_|sb_secret_|gh[pousr]_)[A-Za-z0-9_]{20,}|BEGIN (?:RSA |EC )?PRIVATE KEY', text):
            raise SystemExit('Patrón de credencial encontrado en ' + str(path.relative_to(root)))
        if 'localhost:8080' in text or '127.0.0.1:8080' in text or 'firebase-admin' in text:
            raise SystemExit('Dependencia del servidor anterior en ' + str(path.relative_to(root)))
archive = dest / f'fish-audio-vault-online-v{version}.zip'
with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for path in files:
        info = zipfile.ZipInfo(path.relative_to(root).as_posix(), (2026, 1, 1, 0, 0, 0))
        info.compress_type = zipfile.ZIP_DEFLATED
        info.external_attr = 0o644 << 16
        z.writestr(info, path.read_bytes())
print(json.dumps({'archive': str(archive), 'files': len(files), 'bytes': archive.stat().st_size, 'sha256': hashlib.sha256(archive.read_bytes()).hexdigest()}))
