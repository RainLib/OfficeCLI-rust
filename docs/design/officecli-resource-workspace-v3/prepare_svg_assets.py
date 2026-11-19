"""Build Jiaojiao, a rounded triangular companion with a small side fringe."""
from pathlib import Path
import argparse
import copy
import json
import re
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent
NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", NS)
STATES = {
    "idle": ("待机", "5.6s 呼吸，5.8s 自然眨眼"),
    "thinking": ("思考", "3.6s 轻歪头，1.8s 思考点"),
    "working": ("工作", "1.8s 弹性轻跳，3.2s 视线轻移"),
    "complete": ("完成", "760ms 开心轻跳，380ms 勾线"),
    "waiting": ("待确认", "主体静止，保留眨眼与暂停标记"),
    "attention": ("需核对", "650ms 轻歪两次，随后停下"),
}


def static_pose(root, state):
    root = copy.deepcopy(root)
    for parent in list(root.iter()):
        for child in list(parent):
            pose = child.get("data-pose")
            if child.tag == f"{{{NS}}}style" or (pose and state not in pose.split()):
                parent.remove(child)
    for child in root.iter():
        classes = child.get("class", "").split()
        if "triangle" in classes:
            angle = {"thinking": -8, "working": 4, "complete": -4, "attention": -4}.get(state, 0)
            child.set("transform", f"rotate({angle} 160 252)")
        if "look" in classes and state == "thinking":
            child.set("transform", "translate(4 -4)")
    root.set("width", "220")
    root.set("height", "220")
    return root


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, help="Optional inline preview or master SVG to import")
    args = parser.parse_args()
    source_path = args.source or ROOT / "svg/jiaojiao-master.svg"
    source = source_path.read_text()
    match = re.search(r'<svg id="jiaojiao".*?</svg>', source, re.S)
    assert match, "Master SVG missing"
    master = ET.fromstring(match.group())
    (ROOT / "svg").mkdir(exist_ok=True)
    for prefix in ["moban", "pagecore"]:
        for old in (ROOT / "svg").glob(prefix+"-*.svg"):
            old.unlink()
    (ROOT / "svg/jiaojiao-master.svg").write_text(match.group())
    for state in STATES:
        motion = copy.deepcopy(master)
        motion.set("data-state", state)
        motion.set("width", "320")
        motion.set("height", "320")
        (ROOT / f"svg/jiaojiao-{state}.svg").write_text(ET.tostring(motion, encoding="unicode"))
        still = static_pose(master, state)
        (ROOT / f"svg/jiaojiao-{state}-static.svg").write_text(ET.tostring(still, encoding="unicode"))
    hero = static_pose(master, "idle")
    hero.set("width", "360");hero.set("height", "360")
    (ROOT / "svg/jiaojiao-hero-static.svg").write_text(ET.tostring(hero, encoding="unicode"))
    small = static_pose(master, "idle")
    small.set("viewBox", "47 45 226 215")
    small.set("width", "32");small.set("height", "32")
    for child in list(small):
        if child.get("class") == "shadow":small.remove(child)
    (ROOT / "svg/jiaojiao-mark-static.svg").write_text(ET.tostring(small, encoding="unicode"))
    small.set("width", "24");small.set("height", "24")
    (ROOT / "svg/jiaojiao-inline-static.svg").write_text(ET.tostring(small, encoding="unicode"))
    report = {"states": {k: {"label":v[0],"timing":v[1]} for k,v in STATES.items()},
              "source": "jiaojiao-master.svg", "selfContained": True, "externalResources": [],
              "animations": "SVG geometry with CSS transforms, stroke motion and opacity",
              "reducedMotion": True, "staticPoses": 6,
              "concept": "Rounded triangle with two small eyes and a subtle diagonal fringe; no human body."}
    for path in (ROOT / "svg").glob("*.svg"):
        ET.parse(path)
    (ROOT / "svg/manifest.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({"svgFiles":len(list((ROOT/"svg").glob("*.svg"))),"states":len(STATES)},ensure_ascii=False))


if __name__ == "__main__": main()
