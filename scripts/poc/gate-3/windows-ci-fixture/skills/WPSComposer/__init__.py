"""Controlled Windows CI bridge. It never launches WPS or Office."""

from pathlib import Path
import shutil


class ConversionError(RuntimeError):
    pass


def convert_to_pdf(source, output=None, *, overwrite=False, wps_application=None):
    target = Path(wps_application).resolve(strict=True)
    if target.suffix.lower() != ".exe" or not target.is_file():
        raise ConversionError("controlled explicit WPS target is invalid")
    repo_root = Path(__file__).resolve().parents[6]
    audited_pdf = repo_root / "fixtures/gate-3/G3-REVIEW-001/fixtures/reviewer-torture-100p.pdf"
    destination = Path(output)
    if destination.exists() or overwrite:
        raise ConversionError("controlled bridge requires a new output")
    shutil.copyfile(audited_pdf, destination)
    return str(destination)
