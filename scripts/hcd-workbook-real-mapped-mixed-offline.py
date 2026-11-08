#!/usr/bin/env python3
"""Verify revision 2 of the owned mixed-draft browser fixture as an offline archive."""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile
import urllib.request

parser = argparse.ArgumentParser()
parser.add_argument('root', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--single', action='store_true', help='Verify the same-window single-blank variant')
parser.add_argument('--conflict', action='store_true', help='Verify the peer-conflict resolution variant')
parser.add_argument('--copied', action='store_true', help='Verify the copied mapped-draft variant')
args = parser.parse_args()
repo = Path(__file__).resolve().parents[1]
root = args.root.resolve()
out = args.output.resolve()
if root.parent != repo / 'target/hcd-preview-runtime' or not root.name.startswith('hcd-workbook-'):
    raise ValueError('owned workbook fixture required')
config = json.loads((root / 'private.json').read_text())
if Path(config['root']).resolve() != root or not (out / 'browser.json').is_file():
    raise ValueError('matching completed browser output required')
revision = 4 if args.copied else 3 if args.conflict else 2
url = f"http://127.0.0.1:{config['ports'][0]}/v1/documents/book/export/hcdz?revision={revision}"
request = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + config['tokens']['reader']})
with urllib.request.urlopen(request, timeout=45) as response:
    data = response.read()
archive = out / 'offline-verify.hcdz'
if archive.exists() or (out / 'offline-verify.json').exists():
    raise FileExistsError('offline verification output already exists')
archive.write_bytes(data)
binary = str(repo / 'target/debug/officecli')
with tempfile.TemporaryDirectory(prefix='hcd-mapped-offline-') as directory:
    bundle = Path(directory) / 'recovered.hcd'
    for command in [('unpack', str(archive), '--output', str(bundle)), ('validate', str(bundle))]:
        subprocess.run([binary, 'hdoc', *command, '--json'], check=True, capture_output=True, timeout=90)
    for file in bundle.rglob('*'):
        if file.is_file():
            assert file.read_bytes() == (root / 'book.hcd' / file.relative_to(bundle)).read_bytes()
    result = subprocess.run([binary, 'hdoc', 'extract-text', str(bundle), '--limit', '1000', '--json'], check=True, capture_output=True, text=True, timeout=90)
    text = json.dumps(json.loads(result.stdout), ensure_ascii=False)
    for expected in (('单格保存😀' if args.single or args.conflict or args.copied else '混合恢复普通草稿😀'), ('同伴占用甲' if args.conflict and not args.copied else '批量后续甲'), '批量后续乙'):
        assert expected in text, expected
report = {'revision': revision, 'archiveValidated': True, 'bundleBytesMatch': True, 'threeEditsInOfflineText': True, 'archiveBytes': len(data)}
(out / 'offline-verify.json').write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False))
