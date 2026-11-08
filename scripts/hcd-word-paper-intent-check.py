#!/usr/bin/env python3
"""Compare browser paper intents with the native planner on an imported fixture."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile

repo = Path(__file__).resolve().parents[1]
source = repo / 'docs/assets/hcd-flow-regions-2026-10-26/projection-r4.json'
before = hashlib.sha256(source.read_bytes()).hexdigest()
with tempfile.TemporaryDirectory(prefix='word-paper-intent-', dir=repo / 'target') as tmp:
    root = Path(tmp)
    (root / 'src').mkdir()
    (root / 'src/main.rs').write_text((repo / 'scripts/hcd-word-paper-intent-check.rs').read_text())
    (root / 'Cargo.toml').write_text('[package]\nname="hcd-paper-intent-check"\nversion="0.0.0"\nedition="2021"\n[dependencies]\nhcd-core={path=' + json.dumps(str(repo / 'crates/hcd-core')) + '}\nserde_json="1"\n[workspace]\n')
    generated = subprocess.run(['node', '--import', 'tsx', str(repo / 'scripts/hcd-word-paper-intent-check.mts'), str(source)], cwd=repo / 'examples/hdoc/editor', capture_output=True, text=True, check=True, timeout=60)
    plan = root / 'plan.json'
    plan.write_text(generated.stdout)
    native = subprocess.run(['cargo', 'run', '--offline', '--manifest-path', str(root / 'Cargo.toml'), '--', str(source), str(plan)], env={**os.environ, 'CARGO_TARGET_DIR': str(repo / 'target')}, capture_output=True, text=True, check=True, timeout=300)
    result = json.loads(native.stdout)
assert hashlib.sha256(source.read_bytes()).hexdigest() == before
result['projectionSha256'] = before
print(json.dumps(result))
