# XLSX 行/列移位放行受保护的工作表

命名区域、筛选与验证那两条墙关掉之后（见 [把 workbook 里的命名区域一起带走](hcd-xlsx-grid-shift-defined-names.md)、[把自动筛选和数据验证一起带走](hcd-xlsx-grid-shift-filter-validation.md)），`assets/showcase/budget-tracker.xlsx` 里还能提插删行的表只剩一张，而那张恰恰是插行需求最大的：`Settings` 存着 `DeptList`、`CatList` 两条下拉列表源，`Transactions` 的两个验证规则就是指着它们 —— 要加一个部门，就得在这张表里插一行。它卡在自己部件里的这一句：

```
Error: unsupported mode: failed to read part: grid shift cannot update worksheet element sheetProtection
```

`Settings` 的部件元素清单是 `sheetPr`/`dimension`/`sheetViews`/`sheetFormatPr`/`cols`/`sheetData`/`sheetProtection`/`pageMargins`/`headerFooter` —— 除了最后那张保护，其余每一样移位早就跟着走了。所以这一片的改动就一条：把 `sheetProtection` 放进检查那趟的放行清单。

**为什么它不需要任何“跟着走”的代码**：`<sheetProtection>` 里写的全部是开关（`sheet`、`objects`、`scenarios`、`formatCells`、`insertRows`…）和密码材料（`password`，或者 `algorithmName`+`saltValue`+`spinCount`+`hashValue`），没有一个属性是坐标。它不指任何格子，所以移位没有任何东西可重算，导出把这个元素**按源字节原样抄**（重写那一趟根本没有它的分支，落到 fall-through 上）。反过来说，任何“重写”都是伤害：改一个开关等于替用户改动保护策略，重拼一个 base64 摘要（`qk7+2p0V1Y/5gJnZQ==` 这种串里全是容易被再次转义的字符）等于把密码改成另一个。结构上就只有一种正确输出。

没有新增号段：补丁侧一个字没改，`hcd-patch/12`/`13`/`14`/`15` 的形状与边界跟原来一样。`crates/hcd-formats/src/xlsx.rs` 这一片的 diff 是 +263 行，其中行为改动只有检查那一趟的 15 行（注释 14 行 + 放行清单里一个元素名），其余 248 行是两个测试和夹具常量。

## 复现

```bash
cargo build -p officecli
mkdir -p /tmp/hcd-sp-run
cp assets/showcase/budget-tracker.xlsx /tmp/hcd-sp-run/bt.xlsx
target/debug/officecli hdoc import /tmp/hcd-sp-run/bt.xlsx \
  --output /tmp/hcd-sp-run/bt.hcd --document-id bt
python3 - <<'PY'
import gzip, json
from pathlib import Path
bundle = Path('/tmp/hcd-sp-run/bt.hcd')
def read(p):
    p = bundle / p
    return json.loads(gzip.open(p, 'rt').read()) if p.suffix == '.gz' else json.loads(p.read_text())
index = read(read(bundle / 'manifest.json')['indexRootHref'])
ids = {}
for href in index['children']:
    for chunk in read(href).get('chunks', []):
        grid = chunk.get('grid') or {}
        if grid.get('kind') == 'cells':
            ids[grid['sheetName']] = grid['sheetId']
# 表 ID 从包里读出来，不手抄：它是内容寻址的，抄错一个字符补丁那趟就报 invalid target
print({name: sid for name, sid in ids.items()})
steps = [
    ('hcd-patch/12', 'xlsx.row.insert', {'beforeRow': 3}),
    ('hcd-patch/14', 'xlsx.row.delete', {'row': 3}),
    ('hcd-patch/13', 'xlsx.column.insert', {'beforeColumn': 2}),
    ('hcd-patch/15', 'xlsx.column.delete', {'column': 2}),
]
for rev, (schema, op, values) in enumerate(steps):
    patch = {'schemaVersion': schema, 'documentId': 'bt', 'patchId': f'protect-{rev + 1}',
             'baseRevision': rev, 'operations': [{'op': op, 'sheetId': ids['Settings'], **values}]}
    Path(f'/tmp/hcd-sp-run/patch-{rev}.json').write_text(json.dumps(patch))
PY
for rev in 0 1 2 3; do
  target/debug/officecli hdoc apply /tmp/hcd-sp-run/bt.hcd \
    --patch /tmp/hcd-sp-run/patch-$rev.json --expected-revision $rev
  target/debug/officecli hdoc validate /tmp/hcd-sp-run/bt.hcd
  target/debug/officecli hdoc export /tmp/hcd-sp-run/bt.hcd \
    --source /tmp/hcd-sp-run/bt.xlsx --revision $((rev + 1)) \
    --output /tmp/hcd-sp-run/export-$rev.xlsx --fidelity-report /tmp/hcd-sp-run/fid-$rev.txt
done
```

四个修订都是 `Applied` + `HCD validation passed` + `High fidelity`（表 ID：`Overview` `s_222b835672e046350863c446fda14a66`、`Transactions` `s_f57075da86f25afd0ac5a8b6e584b9be`、`Settings` `s_ca432f6ffc80a41638eee954b012e4a7`）。

| 修订 | 这一趟做了什么 | `dimension` | 最后一行 | `DeptList` | `CatList` | `<sheetProtection …>` | 包变了哪些部件 |
|------|----------------|-------------|----------|------------|-----------|------------------------|----------------|
| r0（源） | — | `A1:C14` | 14 | `Settings!$A$2:$A$8` | `Settings!$C$2:$C$14` | `sheet="1" objects="1" scenarios="1"` | — |
| r1 | 第 3 行前插一行（`hcd-patch/12`） | `A1:C15` | 15 | `$A$2:$A$9` | `$C$2:$C$15` | 同上，一字不动 | workbook.xml + sheet3.xml |
| r2 | 再删掉第 3 行（`hcd-patch/14`） | `A1:C14` | 14 | `$A$2:$A$8` | `$C$2:$C$14` | 同上 | **无（32 个部件逐字节等于源）** |
| r3 | 再在第 2 列前插一列（`hcd-patch/13`） | `A1:D14` | 14 | `$A$2:$A$8` | `$D$2:$D$14` | 同上 | workbook.xml + sheet3.xml |
| r4 | 再删掉第 2 列（`hcd-patch/15`） | `A1:C14` | 14 | `$A$2:$A$8` | `$C$2:$C$14` | 同上 | sheet3.xml（见末尾那条已知偏差） |

格子真的搬了：源里第 3 行是 `A3=s:13 / C3=s:57`（`t="s"`，值是 `sharedStrings.xml` 的下标），r1 写成第 4 行 `A4=s:13 / C4=s:57`，第 3 行是插出来的空行 `<row r="3"/>`，原来最后一行 `C14=s:87` 变成 `C15=s:87`；r3 之后 C 列那批格子整体右移成 `D2…D14`。命名区域跟着端点走是上一片的规则，这一片第一次在**受保护**的表上验证它们同时成立。`DeptList` = `Settings!$A$2:$A$8` 在第 3 行前插一行变成 `$A$2:$A$9`：首行 2 在插入点上面不动，末行 8 ≥ 3 所以 +1；r3 插的是列，A 列 < 2 两个端点都不动，于是 `DeptList` 保持 `$A$2:$A$8`，而 `CatList` 的 C 列（第 3 列）≥ 2 → 两端都变 `D`。两条列表源因此始终盖住列表本身，不露头也不吃进空行 —— `Transactions` 那两个下拉读的就是这两条名字，所以保护表插一行之后筛选下拉的选项还是完整的一批。

`xl/styles.xml`、`sharedStrings.xml`、另外两张表、`[Content_Types].xml` 在四个修订里都不在 changed 清单里 —— 保护相关的样式表从来没被这个路径碰过。

改之前的对照：`/tmp/hcd-sp-src` 是 `git archive HEAD` 出来的（HEAD 即 `0d43c85`，含筛选那一片、不含这一片），在那里 `cargo build -p officecli --target-dir /tmp/hcd-sp-target` 得到改之前的 `officecli`。同一份包、同样四个修订：

```text
--- baseline rev 0
Applied patch protect-1: revision 1 (1 dirty chunk(s))
Error: unsupported mode: failed to read part: grid shift cannot update worksheet element sheetProtection
--- baseline rev 1 … rev 3
Error: unsupported mode: failed to read part: grid shift cannot update worksheet element sheetProtection
```

四条全部停在检查那一趟，`/bin/ls` 里没有任何 `export-*.xlsx` —— 拒绝不落半份文件。

## 开关不是给用户外的程序准备的

有一件事值得写明：**移位不替用户解除保护，也不新增保护**。

`sheet="1"`/`insertRows="1"` 这些开关约束的是**打开这份文件的交互用户**：Excel/WPS 会照它们拦菜单和快捷键。重写这个文件的程序不是那个用户 —— OOXML 的保护本来就不加密内容，任何一个写 XML 的工具都能改任何格子，这是既成事实；HCD 不会因为一张表写了保护就拒绝自己已经承诺的移位操作，也不会反过来偷偷把开关抹掉让保护失效。导出之后开关原样留着，用户在 Excel 里按“插入行”仍然照样被拦。所以编辑器侧这一片也什么都不改：受保护表上的**在选中行前插入**照常可点、照常成功，跟它在别处被保护拦下来这件事是两层。

还有一条容易误解的：“哪些格子允许编辑”不住在 `sheetProtection` 里，住在单元格样式里 —— `cellXfs` 的 `<protection locked="0"/>`。移位从不重写 `xl/styles.xml`（上面四个修订的 changed 清单里都没有它），格子带着自己的 `s=` 下标搬家，所以解锁的那批格子跟着它所覆盖的行/列一起走，表单移位之后可编辑的还是那批字段。（这份 `budget-tracker.xlsx` 自己没用解锁样式 —— 源 `styles.xml` 里 `<protection` 出现 0 次 —— 所以这一条是结构上的规则，不是这次的实测。）

## 保护、冻结、移位三件并存

`Settings` 的源部件没有窗格。先 `hcd-patch/45` 冻结首行，再在第 3 行前插一行（`/tmp/hcd-sp-freeze`），两条修订都 `High fidelity`，r2 的 `sheetViews` 与保护同时成立：

```xml
<sheetViews><sheetView tabSelected="1" zoomScale="293" zoomScaleNormal="293" workbookViewId="0">
  <pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>
  <selection pane="bottomLeft" activeCell="A2" sqref="A2"/>
</sheetView></sheetViews>
<sheetProtection sheet="1" objects="1" scenarios="1"/>
```

HCD 写的窗格换掉源的那一套（这里源根本没有窗格），移位再把带宽从第 3 行的插入里放大一格（`c2c6286` 那条规则），保护那一条在旁边一个字不改。包变了 `xl/workbook.xml` + `xl/worksheets/sheet3.xml`，其余照抄。

## 仍然拒绝的保护形状

放行一条不等于放行“保护”这个主题下的一切。这三类继续停在检查那一趟，由 `a_protection_that_names_cells_still_stops_the_shift` 钉住：

| 形状 | 报错 | 为什么 |
|------|------|--------|
| `<sheetProtection …/><protectedRanges><protectedRange sqref="B2:B100" name="Editable"/></protectedRanges>` | `… worksheet element protectedRanges` | “允许用户编辑的区域”是保护主题下唯一**由地址组成**的东西：它决定哪些格子能改，移位必须把它一起搬，而现在没有代码搬它。它是本片唯一的“下一步”。 |
| `<sheetProtection sheet="1"><allowed range="A1:C3"/></sheetProtection>` | `… worksheet element allowed` | 有生产者把保护内容写在元素**里面**而不是旁边。开关之外冒出来的元素，这一趟读不出地址，照 `ext` 的规矩整条拒绝。 |
| `<sheetProtection …/><scenarios count="1">…` | `… worksheet element scenarios` | `scenarios="1"` 那个开关什么也不说，旁边的场景表里每个场景带一条 `formula` 和它自己隐藏的行列，不是一趟移位能顺手搬的。 |

`protectedRanges`/`protectedRange` 与筛选、验证那一族的差别只在“还没人搬它的 `sqref`”——搬的机器（`shifted_xlsx_area_list` + `rewrite_xlsx_area_attributes`）已经在，接法跟 `dataValidation/@sqref` 一模一样，所以那是独立的一小片，这一片不搭车。

## 落在导出路径上的哪一步

拒绝和放行的唯一裁决点是 `verify_grid_shift_source` 的那个 catch-all 放行清单（不认识的工作表元素一律 `failed to read part: grid shift cannot update worksheet element {tag}`），在任何一个字节的包被写出去之前。写出去那一趟 `rewrite_worksheet` 没有 `sheetProtection` 分支，落到把未知内容照抄的 fall-through —— 这一片不需要给它加任何东西，因为正确输出只有一种：原样。

另外有一处早就备好了：`xlsx_element_follows_sheet_views` 把 `sheetProtection` 列在“必须排在窗口清单之后”的元素里，所以一张从没写过 `sheetViews` 的受保护表被 HCD 加上窗口时，插入点仍然落在 schema 正确的位置（上面那个冻结实测就是这条路径）。

## 覆盖与不覆盖

对应 Rust 测试（`crates/hcd-formats/src/xlsx.rs` 的 `xlsx::tests`，夹具沿用筛选那一片的三表 `create_filter_validation_fixture`，把 caller 传入的那一段换成保护块）：

- `a_shift_moves_a_protected_sheet_and_leaves_the_protection_alone` —— 一张带开关 + 遗留 `password` + `SHA-512`/salt/spin/hash 的表走插行、插列、删行三份修订：每份修订里整个 `<sheetProtection …/>` 元素逐字节出现在导出部件里（base64 里的 `+`、`/`、`=` 一个不多一个不少），`dimension` 与格子地址跟着走（`A1:C13` → `A1:D13` → `A1:D12`，`C13` → `D13` → `D12`），另外两张表、`xl/workbook.xml`、`xl/_rels/workbook.xml.rels`、`[Content_Types].xml` 全部逐字节等于源；不动网格的修订导出与该部件逐字节一致。
- `a_protection_that_names_cells_still_stops_the_shift` —— 上面那三类形状，每个都先证明不动网格时导出与源逐字节一致，再证明移位停在检查那一趟且**没在磁盘上留文件**。

`cargo test -p hcd-formats --lib` 155 条全过，`cargo test -p hcd-core --lib` 72 条全过，`cargo fmt -- --check` 干净，`cargo clippy -p hcd-formats --all-targets` 在 `xlsx.rs` 上零告警（剩下的 `textual.rs`/`pdf.rs`/`patch.rs`/`oxml`/`pdf-handler` 几条是本片之前就有的）。

这一片不碰的：

- `protectedRanges`/`protectedRange/@sqref` —— 保护主题下剩下的那条地址墙，接法同验证区，独立一片。
- `Overview` 的物化窗口（`insert before a materialized XLSX row`，补丁侧）—— 按指示留给再下一片，这一片一个字没动它。记这一片时 `budget-tracker.xlsx` 是三张表里两张能插删行/列（`Transactions`、`Settings`）；`Overview` 那条紧接着也关了，见 [XLSX 行移位落进源文件没写出来的那一行](hcd-xlsx-grid-shift-gap-rows.md)，现在三张表都插得出行。
- **表格部件、超链接、批注 `legacyDrawing`**：硬拒绝清单三条不变。
- 整窗重建把 `mergeCells` 按记录顺序重排那条边界照旧（见 `docs/acceptance/hcd-xlsx-sheet-freeze.md`），指示里也点了名这一片不动它。
- 这一轮实测顺手记下的一条既有偏差（与保护无关，本片没改）：上面 r4 把行列都挪回原位，`xl/workbook.xml` 已经逐字节回原，`sheet3.xml` 却还差一点 —— 源写 `width="18"`，移位重排 `<cols>` 时按 `{:.*2}` 重写成 `width="18.00"`（`crates/hcd-formats/src/xlsx.rs` 的列宽写入处，改动前即如此，本片的 diff 不含任何 width 相关行）。值等价，不是错文件，但“插了又删要回得去原字节”这条在列宽上还没成立，留给列宽那一族自己处理。
- 没有源文件走 `--to xlsx` 的语义导出不读工作部件，与这一片无关。
