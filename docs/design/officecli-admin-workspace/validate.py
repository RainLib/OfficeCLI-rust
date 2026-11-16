#!/usr/bin/env python3
"""Check the native admin artboards and exported review artifacts without dependencies."""

import json
import re
import struct
from pathlib import Path


BASE = Path(__file__).resolve().parent
MANIFEST = json.loads((BASE / "manifest.json").read_text())
DESIGN = json.loads((BASE / MANIFEST["design"]).read_text())
ROOTS = {node["id"]: node for node in DESIGN["children"]}
ERRORS = []


def require(condition, message):
    if not condition:
        ERRORS.append(message)


def walk(node):
    if isinstance(node, dict):
        yield node
        for value in node.values():
            yield from walk(value)
    elif isinstance(node, list):
        for value in node:
            yield from walk(value)


def png_size(path):
    data = path.read_bytes()[:24]
    require(data[:8] == b"\x89PNG\r\n\x1a\n", f"Invalid PNG: {path.name}")
    return struct.unpack(">II", data[16:24])


require(len(MANIFEST["screens"]) == 17, "Expected 17 admin screens")
require(
    [int(s["number"]) for s in MANIFEST["screens"]] == list(range(49, 66)),
    "Artboard numbers must run from 49 through 65",
)
all_ids = {
    node["id"] for node in walk(DESIGN["children"]) if "id" in node
}
variables = DESIGN["variables"]
checked_nodes = set()


def inspect(node):
    if node.get("id") in checked_nodes:
        return
    if "id" in node:
        checked_nodes.add(node["id"])
        require(bool(node.get("name")), f"Unnamed node: {node['id']}")
        require(not node.get("placeholder"), f"Unfinished node: {node['id']}")
    if node.get("type") == "ref":
        require(node["ref"] in all_ids, f"Missing component: {node['ref']}")
        if node["ref"] in ROOTS:
            for child in walk(ROOTS[node["ref"]]):
                inspect(child)
    for key, value in node.items():
        if isinstance(value, str) and re.fullmatch(r"\$[\w-]+", value):
            require(value[1:] in variables, f"Unknown variable: {value}")


screens = []
for screen in MANIFEST["screens"]:
    node = ROOTS.get(screen["node"])
    require(node is not None, f"Missing screen: {screen['name']}")
    if node is None:
        continue
    require(node.get("clip") is True, f"Screen must clip: {screen['name']}")
    expected_size = (screen["width"], screen["height"])
    require(
        (node["width"], node["height"]) == expected_size,
        f"Artboard dimensions differ: {screen['name']}",
    )
    path = BASE / screen["file"]
    require(path.is_file(), f"Missing PNG: {path.name}")
    if path.is_file():
        require(png_size(path) == expected_size, f"PNG dimensions differ: {path.name}")
    for child in walk(node):
        inspect(child)
    screens.append(node)

admin_roots = screens + [
    node for node in ROOTS.values()
    if node.get("name") in {
        "组件 / 后台导航 / Soft Canvas",
        "后台管理 / Soft Canvas · 设计章节",
    }
]
for node in admin_roots:
    for other in ROOTS.values():
        if node["id"] == other["id"]:
            continue
        if not all(isinstance(other.get(k), (int, float)) for k in ("x", "y", "width", "height")):
            continue
        overlap_w = min(node["x"] + node["width"], other["x"] + other["width"]) - max(node["x"], other["x"])
        overlap_h = min(node["y"] + node["height"], other["y"] + other["height"]) - max(node["y"], other["y"])
        require(
            overlap_w <= 0 or overlap_h <= 0,
            f"Overlapping top-level frames: {node['name']} / {other['name']}",
        )

for filename in ("index.html", "README.zh.md", "overview.png", "officecli-admin-workspace.pdf"):
    require((BASE / filename).is_file(), f"Missing artifact: {filename}")
pdf = BASE / "officecli-admin-workspace.pdf"
if pdf.is_file():
    require(pdf.read_bytes().startswith(b"%PDF-"), "Invalid PDF signature")
    page_count = len(re.findall(rb"/Type\s*/Page\b", pdf.read_bytes()))
    require(page_count == 17, f"Expected 17 PDF pages, got {page_count}")
else:
    page_count = 0

report = {
    "status": "passed" if not ERRORS else "failed",
    "screens": len(screens),
    "pdfPages": page_count,
    "checkedNodesIncludingComponents": len(checked_nodes),
    "checks": [
        "native screen IDs and sequential numbers",
        "native and PNG dimensions",
        "node names, component targets, variables and completion flags",
        "admin top-level frames do not overlap existing artboards",
        "review gallery, specification, overview and PDF exist",
        "PDF signature and page count",
    ],
    "visualReview": "All 17 PNGs reviewed in contact sheet; detailed pages reviewed at native resolution. Pixel layout is reviewed visually, not asserted by this script.",
    "errors": ERRORS,
}
(BASE / "design-validation.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
print(json.dumps(report, ensure_ascii=False, indent=2))
raise SystemExit(1 if ERRORS else 0)
