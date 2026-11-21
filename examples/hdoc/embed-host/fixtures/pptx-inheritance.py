"""Build the native placeholder inheritance fixture without Office or pip."""
import sys
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile

parts = Path(__file__).with_suffix("")
with ZipFile(sys.argv[1], "x", compression=ZIP_DEFLATED) as package:
    for part in sorted(parts.rglob("*")):
        if part.is_file():
            package.write(part, part.relative_to(parts).as_posix())
