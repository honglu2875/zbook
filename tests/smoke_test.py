"""Smoke-test an installed Zbook distribution, not the source checkout."""

from __future__ import annotations

import re
from importlib.metadata import distribution, version
from pathlib import Path

import zbook


def main() -> None:
    package_version = version("zbook")
    if zbook.__version__ != package_version:
        raise RuntimeError(
            f"runtime version {zbook.__version__!r} does not match metadata {package_version!r}"
        )

    package_root = Path(zbook.__file__).resolve().parent
    checkout_package = Path(__file__).resolve().parents[1] / "src" / "zbook"
    if package_root == checkout_package.resolve():
        raise RuntimeError("smoke test imported the source checkout instead of the distribution")

    static_root = package_root / "static"
    index = static_root / "index.html"
    if not index.is_file():
        raise RuntimeError("the bundled web client index is missing")

    referenced_assets = re.findall(
        r'(?:href|src)="\./assets/([^"]+)"', index.read_text(encoding="utf-8")
    )
    if not referenced_assets:
        raise RuntimeError("the bundled web client does not reference any assets")
    missing_assets = [
        asset for asset in referenced_assets if not (static_root / "assets" / asset).is_file()
    ]
    if missing_assets:
        raise RuntimeError(f"the bundled web client is missing assets: {missing_assets}")

    referenced_fonts: set[str] = set()
    for asset in referenced_assets:
        if not asset.endswith(".css"):
            continue
        stylesheet = (static_root / "assets" / asset).read_text(encoding="utf-8")
        referenced_fonts.update(re.findall(r"url\(\./([^)]+\.woff2)\)", stylesheet))
    if not referenced_fonts:
        raise RuntimeError("the bundled stylesheets do not reference any font assets")
    missing_fonts = [
        font for font in sorted(referenced_fonts) if not (static_root / "assets" / font).is_file()
    ]
    if missing_fonts:
        raise RuntimeError(f"the bundled web client is missing fonts: {missing_fonts}")

    font_licenses = static_root / "font-licenses.txt"
    notices = font_licenses.read_text(encoding="utf-8")
    if "Inter" not in notices or "JetBrains Mono" not in notices:
        raise RuntimeError("bundled font license notices are incomplete")

    entry_points = distribution("zbook").entry_points
    console_script = next(
        (
            entry_point
            for entry_point in entry_points
            if entry_point.group == "console_scripts" and entry_point.name == "zbook"
        ),
        None,
    )
    if console_script is None or console_script.value != "zbook.cli:main":
        raise RuntimeError("the zbook console script is missing or points to the wrong callable")

    print(
        f"zbook {package_version}: installed CLI, {len(referenced_assets)} web assets, "
        f"and {len(referenced_fonts)} fonts verified"
    )


if __name__ == "__main__":
    main()
