"""Resolve upstream resources in repository and bundled skill layouts."""

from pathlib import Path


def macos_probe_root() -> Path:
    skill_root = Path(__file__).resolve().parents[1]
    bundled = skill_root / "runtime" / "macos" / "wps-jsapi-probe"
    if bundled.is_dir():
        return bundled
    return Path(__file__).resolve().parents[3] / "macos" / "wps-jsapi-probe"


def template_resource_dir(probe_root: Path) -> Path:
    bundled = Path(probe_root) / "resources" / "wpsjs"
    if bundled.is_dir():
        return bundled
    return Path(probe_root) / "node_modules" / "wpsjs" / "src" / "lib" / "res"
