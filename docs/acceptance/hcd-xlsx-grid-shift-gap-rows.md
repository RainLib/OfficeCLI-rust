# XLSX 行移位落进源文件没写出来的那一行

`sheetProtection` 那条墙关掉之后（见 [行/列移位放行受保护的工作表](hcd-xlsx-grid-shift-protection.md)），`assets/showcase/budget-tracker.xlsx` 三张表里只剩 `Overview` 还会拒绝插删行，而且拒绝的位置很怪：同一个操作在第 3 行前能做，在第 2 行前就不能做。墙在补丁侧，两条报错：

```text
Error: unsupported mode: insert before a materialized XLSX row
Error: unsupported mode: delete an existing XLSX row
```

原因在源文件本身。`xl/worksheets/sheet1.xml` 声明 `<dimension ref="A1:H15">`，但 `<sheetData>` 里只写十二个 `<row>`：1、3、4、7、8、9、10、11、12、13、14、15。第 2、5、6 行**有行号、没有行元素** —— 表格里那是三行存在的空行（第 1 行是标题，第 2 行是留白的隔行，第 5、6 行夹在两个小计块之间），生产者在文件里就是不给它们写 `<row>`。导入器按写出来的行分片，索引里也只有这十二个 `<tr data-hcd-row>`。旧的定位逻辑要求目标分片里**字面上有那一行**，于是这三行两头问不到：窗口明明覆盖它们，可谁也不“持有”它们，整个表就变成插不进、删不掉的三行。

**这一片的改动只有一条规则**：按行号找**覆盖它的窗口**（`rowStart ≤ N ≤ rowEnd`），不按“那一行在不在窗口里”找。命中的分片里字面带着那一行时照旧优先（那是原来唯一能走通的路径），带不到时由覆盖它的窗口接住。行移位本来就是按行号换算的——一行的号由它的相对位置决定，由它下面所有行跟着挪 —— 源跳没跳过这一行不影响这个算术。

没有新操作、没有新 schema、**不占号段**：`hcd-patch/12`/`13`/`14`/`15` 的形状与边界一字未改，编辑器也一字未改（按钮早就在了，只是在 `Overview` 上按下去会报 unsupported）。`crates/hcd-core/src/patch.rs` 的 diff 是 +63/−29。

## 改了哪四处

| 位置 | 改之前 | 改之后 |
|------|--------|--------|
| `find_xlsx_row_insert_target` | 只认字面带 `<tr data-hcd-row="N">` 的分片，找不到就 `insert before a materialized XLSX row` | 窗口覆盖但没带这一行的分片记成 `gap_target`，`target.or(gap_target)`；贴着表末追加那条（`before_row == last_row + 1` 用尾分片）不动 |
| `find_xlsx_row_delete_target` | 同上，报 `delete an existing XLSX row` | 同一套 `covers` + `gap_target` 兜底 |
| `shift_xlsx_row_window` | 新行插在 `N + 1` 那一行前面，找不到就 `PreconditionFailed("XLSX insertion row disappeared")` | 新行插在**窗口里移位后最低的那一行**前面（空行的后继就是它下面第一行真实存在的行）；窗口里没有更低行时贴在 `</tbody>` 前 |
| `delete_xlsx_row_window` | 窗口覆盖却没删掉任何一行就 `InvalidBundle("XLSX deletion row is missing")` | 不再报：覆盖而没带是源跳行，下面的行顶上来一格就是删除的全部。真正自相矛盾的包由紧随其后的窗口边界重写那趟绊住 |

## 复现

```bash
cargo build -p officecli
mkdir -p /tmp/hcd-gap-run
cp assets/showcase/budget-tracker.xlsx /tmp/hcd-gap-run/bt.xlsx
target/debug/officecli hdoc import /tmp/hcd-gap-run/bt.xlsx \
  --output /tmp/hcd-gap-run/bt.hcd --document-id bt
python3 - <<'PY'
import gzip, json, shutil, subprocess
from pathlib import Path
src = Path('/tmp/hcd-gap-run/bt.hcd')
def read(b, p):
    p = b / p
    return json.loads(gzip.open(p, 'rt').read()) if p.suffix == '.gz' else json.loads(p.read_text())
ids = {}
index = read(src, read(src, 'manifest.json')['indexRootHref'])
for href in index['children']:
    for chunk in read(src, href).get('chunks', []):
        grid = chunk.get('grid') or {}
        if grid.get('kind') == 'cells':
            ids[grid['sheetName']] = grid['sheetId']
OV = ids['Overview']            # 空行 2、5、6 就在这张表上
for rev, (schema, op, values) in enumerate([
    ('hcd-patch/12', 'xlsx.row.insert', {'beforeRow': 2}),
    ('hcd-patch/12', 'xlsx.row.insert', {'beforeRow': 5}),
    ('hcd-patch/12', 'xlsx.row.insert', {'beforeRow': 6}),
    ('hcd-patch/14', 'xlsx.row.delete', {'row': 2}),
    ('hcd-patch/14', 'xlsx.row.delete', {'row': 5}),
    ('hcd-patch/14', 'xlsx.row.delete', {'row': 6}),
], 1):
    b = Path(f'/tmp/hcd-gap-run/ov{rev}'); shutil.rmtree(b, ignore_errors=True); shutil.copytree(src, b)
    patch = {'schemaVersion': schema, 'documentId': 'bt', 'patchId': f'gap-{rev}', 'baseRevision': 0,
             'operations': [{'op': op, 'sheetId': OV, **values}]}
    pj = Path(f'/tmp/hcd-gap-run/gap-{rev}.json'); pj.write_text(json.dumps(patch))
    print(subprocess.run(['target/debug/officecli', 'hdoc', 'apply', str(b), '--patch', str(pj),
                          '--expected-revision', '0'], capture_output=True, text=True).stdout.strip())
    print(subprocess.run(['target/debug/officecli', 'hdoc', 'export', str(b), '--source',
                          '/tmp/hcd-gap-run/bt.xlsx', '--revision', '1', '--output',
                          f'/tmp/hcd-gap-run/ov{rev}.xlsx', '--fidelity-report',
                          f'/tmp/hcd-gap-run/fid{rev}.txt'], capture_output=True, text=True).stdout.strip())
PY
```

六条都是 `Applied patch … revision 1` + `High fidelity`。

## 三张表的全部行位置

把三张表的每一个行号都试一遍（插入 1…末行+1，删除 1…末行），改前改后各跑一次同一份包：

| 表 | 索引窗口 | 位置数 | 改之前拒绝 | 改之后拒绝 |
|----|----------|--------|------------|------------|
| `Overview` | 1–15 | 31 | **6**：插 2、插 5、插 6、删 2、删 5、删 6 | 0 |
| `Transactions` | 1–21 | 43 | 0 | 0 |
| `Settings` | 1–14 | 29 | 0 | 0 |
| 合计 | — | **103** | **6** | **0** |

拒绝的六个位置正好是那三个空行的两个方向，一个不多一个不少 —— 所以这松完，`budget-tracker.xlsx` 三张表的插行删行全部可编辑（插列/删列那两条路径本来就不看行，上一片已在 `Settings`、`Transactions` 上验过）。改之前的报错原文（同一个包、同一条补丁）：

```text
unsupported mode: insert before a materialized XLSX row
unsupported mode: delete an existing XLSX row
```

## 导出的文件真的挪了行

`Overview` 的部件是 `sheet1.xml`，另带一张图（`xl/drawings/drawing1.xml` 里一个 `twoCellAnchor`，源里 `from/row=17`、`to/row=35`）：

| 修订 | 操作 | `dimension` | 写出的行 | 图表锚 | fidelity |
|------|------|-------------|----------|--------|----------|
| 源 | — | `A1:H15` | 1,3,4,7,8,9,10,11,12,13,14,15 | 17 / 35 | — |
| 插第 2 行前 | `xlsx.row.insert` `beforeRow=2` | `A1:H16` | 1,**2**,4,5,8,9,10,11,12,13,14,15,16 | 18 / 36 | HIGH |
| 插第 5 行前 | `beforeRow=5` | `A1:H16` | 1,3,4,**5**,8,9,10,11,12,13,14,15,16 | 18 / 36 | HIGH |
| 插第 6 行前 | `beforeRow=6` | `A1:H16` | 1,3,4,**6**,8,9,10,11,12,13,14,15,16 | 18 / 36 | HIGH |
| 删第 2 行 | `xlsx.row.delete` `row=2` | `A1:H14` | 1,2,3,6,7,8,9,10,11,12,13,14 | 16 / 34 | HIGH |
| 删第 5 行 | `row=5` | `A1:H14` | 1,3,4,6,7,8,9,10,11,12,13,14 | 16 / 34 | HIGH |
| 删第 6 行 | `row=6` | `A1:H14` | 1,3,4,6,7,8,9,10,11,12,13,14 | 16 / 34 | HIGH |

三件事值得写明：

- **空行的号确实被占掉了。** 在第 2 行前插一行，源的第 3、4 行变成第 4、5 行，新行落在第 2 行；删第 5 行和第 6 行得到同一份行清单，因为它们本来都是空行，删除的作用只是让下面的行整体顶上来一格 —— 这正是 WPS/Excel 里对空行做这两件事的结果。
- **`dimension` 的末行按既有规则走**：增长取「源声明的末行」与「移位后最低内容行」里更大的那个，删减按实际内容收。源声明 `A1:H15` 且第 15 行有内容，所以插一行写 `A1:H16`、删一行写 `A1:H14`。
- **图表跟着走**。锚是 0 基的行号，源里 `17/35` 就是第 18 行到第 36 行；插行后 `18/36`、删行后 `16/34`，图仍然压在它原来那批数据下面。这是 `shift_xlsx_visual_anchor` 那条既有规则第一次在空行上验证。

索引这边也对上了：插第 2 行前之后，`Overview` 的分片窗口从 `1–15` 变 `1–16`，`<tr data-hcd-row>` 从十二个变十三个，新增的那个是 `<tr data-hcd-row="2"></tr>`，排在 4 前面（不在表尾）；删第 2 行之后窗口 `1–14`、十三个变十二个，块计数从 12 到 13 再回 12 —— 删空行不减少块数，因为本来就没有块。

补出来的那一行是普通行：接着用 `hcd-patch/11` 往 `A2` 写字（`xlsx.cell.set`，`row=2` `column=1`，`Carry-forward notes`），导出得到

```xml
<row r="2"><c r="A2" t="inlineStr"><is><t>Carry-forward notes</t></is></c></row>
```

同表 21 个 `t="s"` 的共享字符串格子不受影响，`xl/sharedStrings.xml` 也不在 changed 清单里。

## 编辑器里按下去

这一片一个字没改编辑器，所以 UI 这边不需要新按钮，只需要把那两个本来就在的按钮按到空行上。跑的是仓库里的开发栈（按 `examples/hdoc/editor/README.md` 顶部那一套：`hdoc serve` + 协作 sidecar + Vite，`budget-tracker.xlsx` 以 `accept-xlsx` 导入 demo 根），界面语言选英文，起始 r0：

```bash
cargo build -p officecli
mkdir -p /tmp/hcd-gap-demo/sources
cp assets/showcase/budget-tracker.xlsx /tmp/hcd-gap-demo/sources/accept-xlsx.xlsx
target/debug/officecli hdoc import assets/showcase/budget-tracker.xlsx \
  --output /tmp/hcd-gap-demo/accept-xlsx.hcd --document-id accept-xlsx
SECRET="$(openssl rand -hex 32)"
HCD_TOKEN_SECRET="$SECRET" target/debug/officecli hdoc serve \
  --root /tmp/hcd-gap-demo --bind 127.0.0.1:8766
cd examples/hdoc/editor            # npm ci 之后
HCD_TOKEN_SECRET="$SECRET" npm run sidecar
HCD_DEMO_ROOT=/tmp/hcd-gap-demo HCD_TOKEN_SECRET="$SECRET" \
  npm run dev -- --port 8767 --strictPort
# 打开 http://127.0.0.1:8767/ → 点 XLSX「成绩册」卡片 → Overview
# 两次按下之后，服务端写的就是这个包，直接从它导出那两修订：
for rev in 1 2; do
  target/debug/officecli hdoc export /tmp/hcd-gap-demo/accept-xlsx.hcd \
    --source /tmp/hcd-gap-demo/sources/accept-xlsx.xlsx --revision $rev \
    --output /tmp/hcd-gap-ui-r$rev.xlsx --fidelity-report /tmp/hcd-gap-ui-fid$rev.txt
done
```

| 步 | 选中 | 按下 | 编辑器状态行 | 落到的修订 |
|----|------|------|--------------|------------|
| 0 | `A1`（`Overview`） | — | `revision 0 · Canvas loads near the viewport`，右上 `Saved` | r0 |
| 1 | `A2`（编辑栏是空的 —— 源没写出这一行） | 插入页 →「在选中行前插入 1 行」 | `revision 1 · At 2 rowbeforeinserted empty rows` | r1 |
| 2 | `A3`（上一步把源第 3 行顶成第 4 行，第 3 行成了新的空行） | 插入页 →「删除选中行」→ 弹窗确认 | `Revision 2 · Deleted row 3` | r2 |

两步都直接落修订，右上角回到 `Saved`，没有报错条。第 1 步按的就是扫描表里改之前被拒的「插 2」；第 2 步删的第 3 行不是源里那一行，而是第 1 步插完之后自己空出来的那一行（下面夹具表里 r5 同一条形状：窗口覆盖它、字面上没有它），所以这两次按下正好把放宽的两条路径各走了一遍。导出对得上：r1 的 `xl/worksheets/sheet1.xml` 是 `dimension A1:H16`、行 `1,2,4,5,8…16`，r2 回到 `A1:H15`、行 `1,2,3,4,7…15`，两份 fidelity 都是 `HIGH`。

顺带记一条与这一片无关的既有毛病（没改）：第 1 步的状态行在英文界面下是拼出来的。`sourceLocale.tsx` 对 `revision N · 已(删除|新增|撤销)第 M 行/列` 有一条整句正则（第 322 行），所以第 2 步显示成通顺的 `Revision 2 · Deleted row 3`；`已在第 2 行前插入空行` 这条句式不在任何整句正则里，只能落到片段表（第 295 行的 `' · 已在第 '`、`'插入空行'`）上逐个替换，出来是 `At 2 rowbeforeinserted empty rows`。数字和内容都对，词序不顺，要改的是词条，不是补丁侧，也不是这一片带来的。

## 回不到原字节那条，不是这一片带来的

`Overview` 满是共享公式（源里 `t="shared"` 出现 21 次），任何行移位都会把它们摊平成普通 `<f>`+`<v/>`，所以“插了又删要回得去原字节”这一条在这张表上本来就不成立。为了把这片的责任划清，跑了三组对照：

| 对照 | 操作 | 与源的差集 |
|------|------|------------|
| 空行往返 | 插第 2 行 → 删第 2 行 | 20 个部件里差 2 个：`xl/workbook.xml`（`calcPr fullCalcOnLoad` 重算标记）、`xl/worksheets/sheet1.xml`（`t="shared"` 21 → 0，行清单精确回到 1,3,4,7…15） |
| 实行往返 | 插第 3 行 → 删第 3 行 | **同一个差集，逐字节相同**（20/20 部件一致） |
| 改前二进制 | 插第 3 行 → 删第 3 行（`git archive HEAD` 另编） | **也与上面两份逐字节相同** |

也就是说：这片只让空行走得通，走通之后落到的是那条一直在的共享公式摊平路径，一个字节都没多差。

## 仍然拒绝的行号

窗口之外的行号照旧要人先补一行 —— 这片放宽的是“窗口里没有那一行”，不是“窗口之外”。测试里钉着两条：

| 形状 | 报错 |
|------|------|
| 在 `Overview` 第 99 行前插入（末行 15 + 1 之外） | `unsupported mode: insert at or before the next XLSX row` |
| 删 `Overview` 第 99 行 | `XLSX row selection extends beyond the materialized sheet` |

按指示这一片也没碰这三样：`protectedRanges`（保护主题下剩下的地址墙）、整窗重建把 `mergeCells` 按记录顺序重排、以及列宽 `width="18"` 被重排成 `width="18.00"` 那条既有偏差（见 [受保护的工作表](hcd-xlsx-grid-shift-protection.md) 末尾）。

## 覆盖与不覆盖

对应 Rust 测试 `crates/hcd-formats/src/xlsx.rs` 的 `a_row_the_source_never_wrote_still_takes_its_place_in_the_grid`，夹具 `create_gap_row_fixture`：`Gaps` 表声明 `A1:D9` 只写 1、3、4、5、7 行（2 和 6 是空行），另有一张逐行写满、从不移位的 `Plain` 表用来逐字节对照。先证明修订 0 的导出与该部件逐字节一致，再走五份修订：

| 修订 | 操作 | 导出的行 | 钉住的东西 |
|------|------|----------|------------|
| r1 | 在第 2 行前插入（空行，下面有行） | 1,2,4,5,6,8 | `<row r="2"/>`、`A4=Row 3`、`A8=Row 7`、没有 `A7`；窗口 1–8 |
| r2 | `xlsx.cell.set` 写 A2 | 同上 | `<c r="A2" t="inlineStr"><is><t>Written into the gap</t></is></c>` |
| r3 | 删第 8 行（最后写出的那行） | 1,2,4,5,6 | `Row 7` 与 `A8` 都不在文件里；窗口 1–7，于是**窗口末号底下没有行了** |
| r4 | 在第 7 行前插入（窗口底部空行，没有后继） | 1,2,4,5,6,7 | `<row r="7"/>` 贴在窗口末尾；窗口 1–8 |
| r5 | 删第 3 行（移位自己造出来的空行） | 1,2,3,4,5,6 | 下面的行整体顶上来：`A3=Row 3`、`D5=Right 5`，A2 的字还在；窗口 1–7 |

每一行都同时核对导出部件与索引分片（`<tr data-hcd-row>` 清单与 `rowEnd`），并核对 `Plain` 表、`[Content_Types].xml`、`xl/_rels/workbook.xml.rels` 五份修订全部逐字节等于源。夹具的 `dimension` 故意写成 `A1:D9`（比写出的最后一行大），所以 r1/r2/r4 的导出仍是 `A1:D9`，而带删除的 r3/r5 收成 `A1:D6` —— 上面那条 dimension 规则在测试里也是钉住的。片尾再补两条拒绝（第 99 行前插入、删第 99 行），报错文案逐字比对。

`cargo test -p hcd-formats --lib` 156 条全过，`cargo test -p hcd-core --lib` 72 条全过，`cargo test --workspace` 797 条全过，`cargo fmt -- --check` 干净，`cargo clippy -p hcd-core -p hcd-formats --all-targets` 在本片改动的行上零告警（还剩 8 条是本片之前就有的：`patch.rs` 图片变更聚合那一处 `collapsible_match`、`textual.rs`、`pdf.rs`、`oxml`、`pdf-handler`）。

这一片不碰的：`xlsx.sheet.filter` 那类“加/改/删筛选”仍需号段登记；受保护表的 `protectedRanges`、`mergeCells` 重排、列宽重写那三条按指示原样留着。
