from __future__ import annotations

import hashlib
import io
import json
import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4, LETTER, landscape
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen import canvas


PRIMARY: Path
CORRUPT: Path
OVERSIZE: Path
SCAN_DIR: Path

NAVY = colors.HexColor("#17324D")
BLUE = colors.HexColor("#2E74B5")
PALE = colors.HexColor("#EDF4FA")
MUTED = colors.HexColor("#52677B")


def page_size_for(page: int):
    if page % 15 == 0:
        return landscape(LETTER)
    if page % 10 == 0:
        return LETTER
    return A4


def scan_image(page: int, width_px: int = 1654, height_px: int = 2339) -> Path:
    SCAN_DIR.mkdir(parents=True, exist_ok=True)
    path = SCAN_DIR / f"scan-{page:03d}.png"
    image = Image.new("RGB", (width_px, height_px), "#f7f3e8")
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=30)
    small = ImageFont.load_default(size=20)
    draw.rectangle((90, 90, width_px - 90, height_px - 90), outline="#42566b", width=6)
    draw.text((145, 150), f"PROJECT-OWNED SCANNED PAGE {page:03d}", fill="#17324d", font=font)
    draw.text((145, 215), "Synthetic raster content for Reviewer OCR and image-page handling", fill="#52677b", font=small)
    y = 330
    for row in range(24):
        indent = (row % 4) * 35
        x1 = 145 + indent
        length = 1160 - (row % 5) * 90
        draw.line((x1, y, x1 + length, y), fill="#8a7764", width=5)
        if row % 3 == 0:
            draw.ellipse((1350, y - 22, 1394, y + 22), outline="#8a7764", width=4)
        y += 68
    draw.rectangle((145, 2020, 760, 2175), outline="#2e74b5", width=5)
    draw.text((180, 2070), f"SCAN MARKER / P{page:03d} / HASH SEED {page * 7919}", fill="#2e74b5", font=small)
    image.save(path, format="PNG", optimize=True)
    return path


def draw_header(c: canvas.Canvas, page: int, width: float, height: float, title: str) -> None:
    c.setFillColor(NAVY)
    c.rect(0, height - 58, width, 58, stroke=0, fill=1)
    c.setFillColor(colors.white)
    c.setFont("Helvetica-Bold", 15)
    c.drawString(36, height - 36, title)
    c.setFont("Helvetica", 9)
    c.drawRightString(width - 36, height - 35, f"Reviewer torture fixture / page {page:03d}")


def draw_text_page(c: canvas.Canvas, page: int, width: float, height: float) -> None:
    draw_header(c, page, width, height, "Native text page")
    c.setFillColor(BLUE)
    c.setFont("Helvetica-Bold", 26)
    c.drawString(48, height - 112, f"Revision fidelity checkpoint {page:03d}")
    c.setFillColor(MUTED)
    c.setFont("Helvetica", 11)
    c.drawString(48, height - 136, "Selectable text, stable geometry, links, outlines, and annotations must survive review.")
    top = height - 184
    columns = 2 if width > height else 1
    col_width = (width - 120) / columns
    for col in range(columns):
        x = 48 + col * (col_width + 24)
        y = top
        c.setFillColor(PALE)
        c.roundRect(x, y - 310, col_width, 318, 10, stroke=0, fill=1)
        c.setFillColor(NAVY)
        c.setFont("Helvetica-Bold", 12)
        c.drawString(x + 16, y - 22, f"Evidence block {col + 1}")
        c.setFont("Helvetica", 9.5)
        for line in range(14):
            token = hashlib.sha256(f"page-{page}-col-{col}-line-{line}".encode()).hexdigest()[:16]
            c.drawString(x + 16, y - 46 - line * 17, f"L{line + 1:02d} artifact revision token {token} remains selectable.")
    c.setFillColor(NAVY)
    c.setFont("Helvetica-Bold", 11)
    c.drawString(48, 76, f"MIXED-SIZE-{int(width)}x{int(height)} / TEXT-PAGE / P{page:03d}")
    c.setStrokeColor(BLUE)
    c.setLineWidth(0.8)
    c.line(48, 68, width - 48, 68)


def draw_scan_page(c: canvas.Canvas, page: int, width: float, height: float) -> None:
    draw_header(c, page, width, height, "Scanned-image page")
    image_path = scan_image(page)
    margin = 42
    available_w = width - margin * 2
    available_h = height - 124
    ratio = min(available_w / 1654, available_h / 2339)
    draw_w = 1654 * ratio
    draw_h = 2339 * ratio
    x = (width - draw_w) / 2
    y = 34 + (available_h - draw_h) / 2
    c.drawImage(ImageReader(str(image_path)), x, y, draw_w, draw_h, preserveAspectRatio=True, mask="auto")
    c.setStrokeColor(BLUE)
    c.setLineWidth(1.2)
    c.rect(x, y, draw_w, draw_h, stroke=1, fill=0)


def build_primary() -> dict:
    c = canvas.Canvas(str(PRIMARY), pagesize=A4, pageCompression=1, invariant=1)
    c.setTitle("SuperWagie Reviewer Torture Fixture - 100 Pages")
    c.setAuthor("SuperWagie project-owned fixture builder")
    c.setSubject("Technical PDF fixture for deterministic Reviewer validation")

    for page in range(1, 101):
        size = page_size_for(page)
        c.setPageSize(size)
        width, height = size
        destination = f"page-{page:03d}"
        c.bookmarkPage(destination)
        if page == 1:
            c.addOutlineEntry("Reviewer torture fixture", destination, level=0, closed=False)
        if page in range(1, 101, 10):
            chapter = (page - 1) // 10 + 1
            c.addOutlineEntry(f"Chapter {chapter}: pages {page}-{min(page + 9, 100)}", destination, level=1, closed=False)

        if page % 5 == 0:
            draw_scan_page(c, page, width, height)
        else:
            draw_text_page(c, page, width, height)

        c.setFillColor(BLUE)
        c.setFont("Helvetica-Bold", 9)
        c.drawString(48, 42, "Open project provenance")
        c.linkURL("https://example.invalid/superwagie/project-owned-fixture", (46, 38, 184, 52), relative=0, thickness=0.5, color=BLUE)
        if page < 100:
            c.drawRightString(width - 48, 42, "Jump to final page")
            c.linkRect("Jump to final page", "page-100", Rect=(width - 148, 36, width - 44, 54), relative=0, thickness=0.5, color=BLUE)
        if page in {3, 33, 63, 93}:
            c.textAnnotation(
                f"Existing PDF annotation on project-owned fixture page {page}",
                Rect=(width - 86, height - 132, width - 58, height - 104),
                name=f"fixture-annotation-{page}",
            )
        c.showPage()
    c.save()

    reader = PdfReader(str(PRIMARY), strict=True)
    annotations = 0
    sizes = set()
    scan_pages = []
    for index, page_obj in enumerate(reader.pages, start=1):
        annotations += len(page_obj.get("/Annots") or [])
        sizes.add((round(float(page_obj.mediabox.width), 3), round(float(page_obj.mediabox.height), 3)))
        if index % 5 == 0:
            scan_pages.append(index)
    outline_items = len(reader.outline)
    return {
        "pageCount": len(reader.pages),
        "pageSizes": sorted(sizes),
        "scanPages": scan_pages,
        "annotationCount": annotations,
        "outlineTopLevelItems": outline_items,
        "sha256": hashlib.sha256(PRIMARY.read_bytes()).hexdigest(),
    }


def build_corrupt_tail() -> dict:
    primary_bytes = PRIMARY.read_bytes()
    # Deliberately remove the startxref/xref tail so strict readers terminate.
    cut = max(0, len(primary_bytes) - 512)
    malformed = primary_bytes[:cut] + b"\n%CORRUPT-TAIL: xref and trailer deliberately removed\n"
    CORRUPT.write_bytes(malformed)
    strict_error = None
    try:
        PdfReader(io.BytesIO(malformed), strict=True)
    except Exception as exc:  # expected fixture behavior
        strict_error = f"{type(exc).__name__}: {exc}"
    if not strict_error:
        raise RuntimeError("corrupt-tail.pdf unexpectedly opened in strict mode")
    return {
        "bytes": len(malformed),
        "strictError": strict_error,
        "sha256": hashlib.sha256(malformed).hexdigest(),
    }


def build_oversize() -> dict:
    target = 16 * 1024 * 1024 + 257
    block = bytes(range(256)) * 4096
    with OVERSIZE.open("wb") as handle:
        remaining = target
        while remaining:
            chunk = block[: min(len(block), remaining)]
            handle.write(chunk)
            remaining -= len(chunk)
    data_hash = hashlib.sha256(OVERSIZE.read_bytes()).hexdigest()
    return {"bytes": OVERSIZE.stat().st_size, "sha256": data_hash}


def parse_args():
    parser = argparse.ArgumentParser(description="Build the PDF, corrupt-tail, and oversize Gate 3 torture fixtures.")
    parser.add_argument("--output-dir", type=Path, default=Path.cwd())
    parser.add_argument("--work-dir", type=Path, default=Path.cwd() / ".build-pdf")
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    output_dir = arguments.output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    work_dir = arguments.work_dir.resolve()
    work_dir.mkdir(parents=True, exist_ok=True)
    PRIMARY = output_dir / "reviewer-torture-100p.pdf"
    CORRUPT = output_dir / "corrupt-tail.pdf"
    OVERSIZE = output_dir / "oversize-placeholder.bin"
    SCAN_DIR = work_dir / "pdf-scan-pages"
    evidence = {
        "primary": build_primary(),
        "corruptTail": build_corrupt_tail(),
        "oversize": build_oversize(),
    }
    print(json.dumps(evidence, indent=2, sort_keys=True))
