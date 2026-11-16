"""Audit native XLSX calculations using a new temporary workbook only.

Exits with 1 when any result differs from the documented Excel semantics.
Does not start Agents, call a model, or open existing user documents.
"""
import argparse
import json
from pathlib import Path
import subprocess
import tempfile


REPO = Path(__file__).resolve().parents[3]
parser = argparse.ArgumentParser()
parser.add_argument('--binary', type=Path, default=REPO / 'target/debug/officecli')
parser.add_argument('--output', type=Path)
args = parser.parse_args()
binary = args.binary.resolve()
root = Path(tempfile.mkdtemp(prefix='officecli-formula-audit-'))
workbook = root / 'formula-check.xlsx'


def cli(*arguments):
    result = subprocess.run([str(binary), *map(str, arguments), '--json'],
                            cwd=REPO, capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    if not payload.get('success'):
        raise RuntimeError('CLI command did not report success')
    return payload['data']


cli('create', workbook)
for address, value in [('A1', '1'), ('A2', '2')]:
    cli('set', workbook, f'/Sheet1/{address}', '--prop', f'value={value}')

cases = [('LEN("中文")', 2), ('COUNTBLANK(A1:A3)', 1),
         ('COUNTA(A1:A3)', 2), ('ROUNDUP(-1.21,1)', -1.3),
         ('ROUNDDOWN(-1.21,1)', -1.2)]
checks = []
for row, (formula, expected) in enumerate(cases, 1):
    address = f'/Sheet1/B{row}'
    cli('set', workbook, address, '--prop', f'formula={formula}')
    result = cli('get', workbook, address)['results'][0]
    assert result['format']['formula'] == formula
    actual = result.get('text', '')
    try:
        passed = abs(float(actual) - expected) < 1e-9
    except ValueError:
        passed = False
    checks.append({'formula': formula, 'expected': expected,
                   'actual': actual, 'passed': passed})

report = {'scope': 'native XLSX CLI; not the guarded HCD sheet calculator',
          'input': 'A1=1, A2=2, A3 blank', 'checks': checks,
          'mismatches': sum(not check['passed'] for check in checks)}
if args.output:
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n')
print(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(1 if report['mismatches'] else 0)
