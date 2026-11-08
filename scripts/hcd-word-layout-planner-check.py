#!/usr/bin/env python3
"""Run the read-only layout planner against an existing synthetic projection."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('projection', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    projection = args.projection.resolve()
    before = hashlib.sha256(projection.read_bytes()).hexdigest()
    with tempfile.TemporaryDirectory(prefix='word-layout-plan-', dir=repo / 'target') as temp:
        root = Path(temp)
        (root / 'src').mkdir()
        (root / 'src/main.rs').write_text((repo / 'scripts/hcd-word-layout-planner-check.rs').read_text())
        (root / 'Cargo.toml').write_text('[package]\nname="hcd-layout-planner-verify"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nhcd-core={path=' + json.dumps(str(repo / 'crates/hcd-core')) + '}\nserde_json="1"\n[workspace]\n')
        result = subprocess.run(['cargo', 'run', '--offline', '--manifest-path', str(root / 'Cargo.toml'), '--', str(projection)],
                                env={**os.environ, 'CARGO_TARGET_DIR': str(repo / 'target')},
                                capture_output=True, text=True, check=True, timeout=300)
        evidence = json.loads(result.stdout)
    assert hashlib.sha256(projection.read_bytes()).hexdigest() == before
    assert evidence['writes'] is False and evidence['disjointMerge'] and evidence['sameFieldRejected']
    evidence['projectionSha256'] = before
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / 'imported-projection.json').write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(evidence, ensure_ascii=False))


if __name__ == '__main__':
    main()
