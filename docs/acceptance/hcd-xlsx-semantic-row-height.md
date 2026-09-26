# XLSX 无源导出行高验收

HCD 中显式设置的 XLSX 行高现在会进入无源语义导出的 `<row ht="…" customHeight="1">`。此导出仍重建工作簿并将多个工作表扁平化；源文件导出继续用于保留公式、图表和原样式。

## 真实文件与命令

以下命令复用 [行高验收](hcd-xlsx-row-height.md) 中由真实 CSV 建立并编辑的 `/tmp/hcd-row-height-real/accept.hcd`，其中 revision 1 将第 2 行设为 48.5 磅。

```bash
cargo fmt -- --check
cargo test -p officecli semantic_xlsx
cargo clippy -p officecli --all-targets -- -D warnings
cargo build -p officecli
target/debug/officecli hdoc validate /tmp/hcd-row-height-real/accept.hcd
target/debug/officecli hdoc export /tmp/hcd-row-height-real/accept.hcd \
  --to xlsx --revision 1 --output /tmp/hcd-row-height-real/semantic-height.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
from pathlib import Path
root = Path('/tmp/hcd-row-height-real')
source = load_workbook(root / 'source.xlsx').active
exported = load_workbook(root / 'semantic-height.xlsx').active
assert list(source.values) == list(exported.values)
assert exported.row_dimensions[2].height == 48.5
assert exported.row_dimensions[1].height is None
assert exported.row_dimensions[3].height is None
print('source-free row 2 = 48.5 pt; values and adjacent heights preserved')
PY
target/debug/officecli hdoc export /tmp/hcd-row-height-demo/accept-xlsx.hcd \
  --to xlsx --revision 1 --output /tmp/hcd-row-height-demo/semantic-r1.xlsx
python3 - <<'PY'
from openpyxl import load_workbook
workbook = load_workbook('/tmp/hcd-row-height-demo/semantic-r1.xlsx')
assert workbook.active.row_dimensions[8].height == 60
print('budget-tracker revision 1 row 8 = 60 pt')
PY
```

浏览器中的编辑效果见 [第 2 行改为 60 磅的截图](../assets/hcd/xlsx-row-height-after.png)。稀疏行、前置文本块和非法高度分别由 `semantic_xlsx_preserves_hcd_grid_row_heights_after_sparse_rows` 与 `semantic_xlsx_rejects_invalid_hcd_grid_row_height` 覆盖。
