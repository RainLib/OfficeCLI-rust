#!/usr/bin/env python3
"""Exercise native layout transactions on a disposable copy of an owned archive."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('archive', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    archive = args.archive.resolve()
    source_hash = hashlib.sha256(archive.read_bytes()).hexdigest()
    binary = repo / 'target/debug/officecli'
    args.output.mkdir(parents=True, exist_ok=True)
    def cli(*values):
        result = subprocess.run([str(binary), 'hdoc', *map(str, values), '--json'], capture_output=True, text=True, check=True, timeout=120)
        return json.loads(result.stdout)['data']
    with tempfile.TemporaryDirectory(prefix='word-layout-transaction-', dir=repo / 'target') as directory:
        root = Path(directory)
        bundle, offline = root / 'fixture.hcd', root / 'offline.hcd'
        cli('unpack', archive, '--output', bundle)
        project = root / 'check'
        (project / 'src').mkdir(parents=True)
        (project / 'src/main.rs').write_text((repo / 'scripts/hcd-word-layout-transaction-check.rs').read_text())
        (project / 'Cargo.toml').write_text('[package]\nname="hcd-layout-transaction-verify"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nhcd-core={path=' + json.dumps(str(repo / 'crates/hcd-core')) + '}\nserde_json="1"\n[workspace]\n')
        run = subprocess.run(['cargo', 'run', '--offline', '--manifest-path', str(project / 'Cargo.toml'), '--', str(bundle)],
                             env={**os.environ, 'CARGO_TARGET_DIR': str(repo / 'target')},
                             capture_output=True, text=True, timeout=300)
        if run.returncode:
            raise RuntimeError(run.stderr[-6000:])
        evidence = json.loads(run.stdout)
        for revision in (4, 5, 6, 7):
            (args.output / f'projection-r{revision}.json').write_text(json.dumps(cli('editor-state', bundle, '--revision', revision), ensure_ascii=False))
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        key = '{' + ns['w'] + '}'
        reports = []
        for revision, width, height in [(4, evidence['widthBefore'], evidence['heightBefore']), (5, evidence['widthAfter'], evidence['heightBefore']), (6, evidence['widthAfter'], evidence['heightAfter']), (7, evidence['widthAfter'], evidence['heightAfter'])]:
            path = args.output / f'layout-r{revision}.docx'
            report = cli('export', bundle, '--revision', revision, '--output', path)
            with zipfile.ZipFile(path) as document:
                tree = ET.fromstring(document.read('word/document.xml'))
                sections = tree.findall('.//w:sectPr', ns)
                paper = sections[0].find('w:pgSz', ns)
                assert int(paper.attrib[key + 'w']) == width and int(paper.attrib[key + 'h']) == height
                assert len(sections) >= 2
                if revision == 7:
                    assert paper.attrib[key + 'orient'] == 'landscape'
                    assert sections[0].find('w:pgMar', ns).attrib[key + 'top'] == '1440'
                    numbering = sections[0].find('w:pgNumType', ns)
                    assert numbering.attrib[key + 'start'] == '7' and numbering.attrib[key + 'fmt'] == 'upperRoman'
                    assert (sections[0].find('w:titlePg', ns) is not None) == evidence['firstPageAfter']
                    settings = ET.fromstring(document.read('word/settings.xml'))
                    assert (settings.find('w:evenAndOddHeaders', ns) is not None) == evidence['oddEvenAfter']
            reports.append({'revision': revision, 'widthTwips': width, 'heightTwips': height, 'fidelity': report['level'], 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
        reimported = root / 'reimport.hcd'
        cli('import', args.output / 'layout-r7.docx', '--word-regions', '--output', reimported)
        assert cli('validate', reimported)['valid']
        imported_assets = json.loads((reimported / 'assets/index.json').read_text())
        imported_layout_asset = next(asset for asset in imported_assets if asset['sourcePart'] == 'word/_hcd/flow-layout-v1.json')
        imported_layout = json.loads((reimported / imported_layout_asset['href']).read_text())
        imported_page = imported_layout['sections'][0]['page']
        assert imported_page['widthTwips'] == evidence['widthAfter'] and imported_page['heightTwips'] == evidence['heightAfter']
        assert imported_page['orientation'] == 'landscape' and imported_page['marginsTwips']['top'] == 1440
        assert imported_page['numberStart'] == 7 and imported_page['numberFormat'] == 'upperRoman'
        assert imported_layout['sections'][0]['differentFirstPage'] == evidence['firstPageAfter']
        assert imported_layout['evenAndOddHeaders'] == evidence['oddEvenAfter']
        packed = root / 'layout-r7.hcdz'
        cli('pack', bundle, '--output', packed)
        cli('unpack', packed, '--output', offline)
        assert cli('validate', offline)['valid']
        for file in offline.rglob('*'):
            if file.is_file():
                assert file.read_bytes() == (bundle / file.relative_to(offline)).read_bytes()
        shutil.copyfile(packed, args.output / 'layout-r7.hcdz')
        assert hashlib.sha256(archive.read_bytes()).hexdigest() == source_hash
    evidence.update({'sourceArchiveSha256': source_hash, 'docx': reports, 'docxLayoutReimport': 'verified', 'offlineHistoryAndResources': 'verified exact'})
    (args.output / 'native-and-files.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == '__main__':
    main()
