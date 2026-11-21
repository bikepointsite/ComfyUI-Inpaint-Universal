"""Install the Inpaint Universal bundle into an existing ComfyUI installation."""
import argparse
import hashlib
import os
from pathlib import Path
import shutil
import tempfile

PACKAGE = Path(__file__).resolve().parent

def digest(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def install(root, skip_models, dry_run):
    if not (root / 'main.py').is_file() and (root / 'ComfyUI/main.py').is_file():
        root = root / 'ComfyUI'
    if not (root / 'main.py').is_file() or not (root / 'custom_nodes').is_dir():
        raise SystemExit('Choose the directory containing ComfyUI/main.py or the portable root.')
    files = sorted(p for folder in ('custom_nodes', 'user', 'input')
                   for p in (PACKAGE/folder).rglob('*') if p.is_file()
                   and '__pycache__' not in p.parts and p.suffix != '.pyc')
    if not skip_models and (PACKAGE/'models').is_dir():
        for line in (PACKAGE/'models.sha256').read_text().splitlines():
            _, name = line.split('  ',1)
            if not (PACKAGE/name).is_file():
                raise SystemExit(f'Incomplete offline model set: {name}. Use --skip-models to install code only.')
            files.append(PACKAGE/name)
    planned, conflicts = [], []
    for source in files:
        target = root / source.relative_to(PACKAGE)
        if target.exists():
            if not target.is_file() or target.stat().st_size != source.stat().st_size or digest(target) != digest(source):
                conflicts.append(str(target))
        else:
            planned.append((source,target))
    if conflicts:
        raise SystemExit('Different files already exist. Use a clean installation or compare these files first:\n'+'\n'.join(conflicts))
    total = sum(s.stat().st_size for s,_ in planned)
    print(f'{root}: {len(planned)} new files, {total/1e9:.2f} GB. Identical files are skipped.')
    if dry_run:
        return
    for source,target in planned:
        target.parent.mkdir(parents=True,exist_ok=True)
        # Stage on the destination volume. A stopped copy can be retried safely.
        with tempfile.NamedTemporaryFile(dir=target.parent,prefix='.inpaint-install-',delete=False) as f:
            part = Path(f.name)
        try:
            shutil.copyfile(source,part)
            if os.name=='nt':
                os.rename(part,target)  # Windows fails if a different installer already created the target.
            else:
                os.link(part,target)
        finally:
            part.unlink(missing_ok=True)
    # Create credentials on the destination machine. Preserve any existing key.
    config = root / 'inpaint-grok.local.json'
    try:
        fd = os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        with os.fdopen(fd, 'w', encoding='utf-8') as out:
            out.write('{\n  "api_key": "",\n  "model": ""\n}\n')
    print(f'Optional Grok settings: {config}')
    print('Files installed. Install requirements in ComfyUI Python, then restart ComfyUI.')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('comfy',type=Path,help='ComfyUI directory or its portable parent')
    parser.add_argument('--skip-models',action='store_true',help='Install only nodes, sample and workflow')
    parser.add_argument('--dry-run',action='store_true',help='Check conflicts and print the planned size')
    args=parser.parse_args()
    install(args.comfy.resolve(),args.skip_models,args.dry_run)

