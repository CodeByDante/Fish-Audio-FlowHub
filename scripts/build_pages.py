"""Build a public Pages site from a strict allowlist, without tokens or datasets."""
from pathlib import Path
import json,re,shutil

root=Path(__file__).resolve().parent.parent
out=root/'dist/pages'
if out.exists():shutil.rmtree(out)
out.mkdir(parents=True)
files=[root/n for n in ('index.html','config.json')]
for folder in ('src','images'):
 files.extend(p for p in (root/folder).rglob('*') if p.is_file() and not p.is_symlink() and p.name!='background.js')
for p in files:
 if p.suffix in ('.js','.json','.html','.css','.sql'):
  source=p.read_text()
  if re.search(r'(?:sbp_|sb_secret_|gh[pousr]_)[A-Za-z0-9_]{20,}|BEGIN (?:RSA |EC )?PRIVATE KEY',source):raise SystemExit('Credential pattern in '+str(p.relative_to(root)))
 target=out/p.relative_to(root);target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,target)
(out/'.nojekyll').write_text('')
required=['src/js/cloud-engine.js','src/js/web-transport.js','src/js/persistent-storage.js','src/js/cloud-client.js','src/sql/bootstrap.sql']
for name in required:
 if not (out/name).is_file():raise SystemExit('Missing Pages file: '+name)
print(json.dumps({'pages_directory':str(out),'files':len(files)+1}))
