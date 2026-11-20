import hashlib
import json
import subprocess
import sys
from pathlib import Path
from zipfile import ZipFile

from openpyxl import load_workbook

root = Path(sys.argv[1])
bin = Path(sys.argv[2])
source = root / "pivot-source.xlsx"
original_digest=hashlib.sha256(source.read_bytes()).hexdigest()

# Inspect the exact browser download before performing independent CLI edits.
browser_output = root / "pivot-browser-roundtrip.xlsx"
browser_book = load_workbook(browser_output)
browser_report = browser_book["汇总"]
assert browser_report["E5"].value == 210 and browser_report["E6"].value == 240
assert browser_report["I7"].value == 480
assert browser_book["销售"]["C2"].value == 120
assert browser_book["销售"]["C3"].value == "=C2*2"
browser_pivot = browser_report._pivots[0]
assert browser_pivot.name == "RevenueByRegion" and browser_pivot.location.ref == "D3:J7"
assert browser_pivot.cache.cacheSource.worksheetSource.ref == "A1:D6"
assert len(browser_pivot.cache.records.r) == 5
with ZipFile(source) as original, ZipFile(browser_output) as browser_saved:
    for part in ("xl/charts/chart1.xml", "xl/styles.xml"):
        assert original.read(part) == browser_saved.read(part), part

def cli(*args, errors=False):
    result=subprocess.run([bin,*map(str,args)], capture_output=True,text=True)
    if not errors and result.returncode:
        raise AssertionError(result.stdout+result.stderr)
    return result

def import_source(path, id, folder):
    bundle=root/folder
    cli("hdoc","import",path,"-o",bundle,"--storage-codec","none","--document-id",id)
    return bundle

def index(bundle, revision=0):
    page=json.loads(cli("hdoc","get-index-page",bundle,0,"--json").stdout)["data"]["indexPage"]
    assert page["revision"]==revision, page
    return page["chunks"]

def put(bundle, doc, revision, operation, patch_version=59, fail=False):
    patch={"schemaVersion":f"hcd-patch/{patch_version}","documentId":doc,"patchId":f'{doc}-{revision}-{operation.get("pivotId", "edit")}-{fail}',
        "baseRevision":revision,"operations":[operation]}
    patch_file=root/f"{patch['patchId']}.json"
    patch_file.write_text(json.dumps(patch))
    return cli("hdoc","apply",bundle,"--patch",patch_file,"--expected-revision",revision, errors=fail)

def export(bundle, path, filename, revision=None):
    output=root/filename
    opts=[] if revision is None else ["--revision",revision]
    cli("hdoc","export",bundle,"--source",path,"-o",output,*opts)
    cli("validate",output)
    return output

bundle=import_source(source,"pivot-proof-original","pivot-source.hcd")
metadata=index(bundle)
ids={chunk["grid"]["sheetName"]:chunk["grid"]["sheetId"] for chunk in metadata if chunk["grid"]["kind"]=="cells"}
config={
    "name":"RevenueByRegion","sourceSheetId":ids["销售"],
    "sourceRange":{"startRow":1,"endRow":6,"startColumn":1,"endColumn":4},
    "anchorRow":3,"anchorColumn":4,"rows":[0],"columns":[1],
    "values":[{"field":2,"aggregate":"sum"},{"field":3,"aggregate":"count"}],
}
def op(target, spec, identity="a"*32):
    return {"op":"xlsx.pivot.set","sheetId":target,"pivotId":identity,"config":spec}

collision=put(bundle,"pivot-proof-original",0,op(ids["汇总"],dict(config,anchorRow=1,anchorColumn=1)),fail=True)
assert collision.returncode and "would overwrite" in collision.stderr, collision.stderr
put(bundle,"pivot-proof-original",0,op(ids["汇总"],config))
plan=next(chunk["grid"]["pivots"][0] for chunk in index(bundle,1) if chunk["grid"].get("pivots"))
report=plan["snapshot"]["report"]
assert [[cell.get("value") for cell in row] for row in report["cells"][2:]] == [
    ["华北","130","2","25","1","155","3"],
    ["华南","80","1","5","0","85","1"],
    ["Grand Total","210","3","30","1","240","4"],
], report
expected=export(bundle,source,"pivot-roundtrip.xlsx")
native=load_workbook(expected)
assert native["汇总"]["E5"].value==130 and native["汇总"]["I7"].value==240
assert native["汇总"]["A20"].value=="保留尾行" and native["汇总"]["A1"].value=="已有备注"
assert native["汇总"]["B1"].value=="=SUM(E5:E6)"
pivot=native["汇总"]._pivots[0]
assert pivot.name=="RevenueByRegion" and pivot.location.ref=="D3:J7"
assert pivot.cache.cacheSource.worksheetSource.sheet=="销售"
assert pivot.cache.cacheSource.worksheetSource.ref=="A1:D6"
assert len(pivot.cache.records.r)==5 and len(pivot.dataFields)==2
with ZipFile(source) as original, ZipFile(expected) as saved:
    for part in ("xl/worksheets/sheet1.xml","xl/charts/chart1.xml","xl/styles.xml"):
        assert original.read(part)==saved.read(part), part
assert hashlib.sha256(source.read_bytes()).hexdigest()==original_digest

reopened=import_source(expected,"pivot-proof-reopened","pivot-reopened.hcd")
p=next((chunk["grid"]["sheetId"],chunk["grid"]["pivots"][0]) for chunk in index(reopened) if chunk["grid"].get("pivots"))
target,pivot=p
assert pivot["config"]["values"]==config["values"]
same_sheet_by_id={c["grid"]["sheetId"]:c["grid"]["sheetName"] for c in index(reopened) if c["grid"]["kind"]=="cells"}
assert same_sheet_by_id[pivot["config"]["sourceSheetId"]]=="销售"
assert pivot["config"]["rows"]==[0] and pivot["config"]["columns"]==[1]
edited=dict(pivot["config"],name="RevenueAverage",values=[{"field":2,"aggregate":"average"}])
put(reopened,"pivot-proof-reopened",0,op(target,edited,pivot["id"]))
second=export(reopened,expected,"pivot-updated.xlsx")
new=load_workbook(second)
assert len(new["汇总"]._pivots)==1 and new["汇总"]._pivots[0].name=="RevenueAverage"
assert new["汇总"]["E5"].value==65 and new["汇总"]["G7"].value==48
assert new["汇总"]["H7"].value is None and new["汇总"]["I7"].value is None
put(reopened,"pivot-proof-reopened",1,op(target,None,pivot["id"]))
clean=load_workbook(export(reopened,expected,"pivot-removed.xlsx"))
assert len(clean["汇总"]._pivots)==0 and clean["汇总"]["E5"].value is None and clean["汇总"]["A20"].value=="保留尾行"
history=load_workbook(export(reopened,expected,"pivot-historical.xlsx",1))
assert history["汇总"]["G7"].value==48
(root/"native-verification.json").write_text(json.dumps({"browserDownloadIndependentlyVerified":True,"resultPlacementProtected":True,"sourcePartsIdentical":True,
    "nativePivotDefinition":True,"nativeTypedCacheRecords":True,"reportCellsMaterialized":True,
    "reopenEditRemove":True,"historicalExport":True},indent=2))
print("Native PivotTable verified with typed data, source formulas, report cells and historical exports.")
