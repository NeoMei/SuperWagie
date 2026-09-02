from __future__ import annotations

import hashlib
import json
import re
import zipfile
import argparse
from pathlib import Path

from pypdf import PdfReader


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def zip_texts(path: Path) -> tuple[set[str], dict[str, str]]:
    with zipfile.ZipFile(path) as package:
        names = set(package.namelist())
        texts = {
            name: package.read(name).decode("utf-8", errors="replace")
            for name in names
            if name.endswith((".xml", ".rels"))
        }
    return names, texts


def audit_docx(path: Path) -> dict:
    names, texts = zip_texts(path)
    document = texts["word/document.xml"]
    styles = texts["word/styles.xml"]
    numbering = texts["word/numbering.xml"]
    page_breaks = len(re.findall(r'<w:br[^>]*w:type="page"', document))
    sect_prs = document.count("<w:sectPr")
    headers = sorted(name for name in names if re.fullmatch(r"word/header\d+\.xml", name))
    footers = sorted(name for name in names if re.fullmatch(r"word/footer\d+\.xml", name))
    checks = {
        "packageSignature": path.read_bytes()[:2] == b"PK",
        "contentTypes": "[Content_Types].xml" in names,
        "computedPageCount": 1 + page_breaks + (sect_prs - 1),
        "tocField": " TOC \\o &quot;1-3&quot; \\h \\z \\u " in document or " TOC \\o" in document,
        "numberingPart": "word/numbering.xml" in names and "<w:abstractNum" in numbering,
        "headingNumberingLink": "<w:numPr>" in styles and "Heading1" in styles,
        "sectionCount": sect_prs,
        "headerParts": headers,
        "footerParts": footers,
        "pageField": "PAGE" in "".join(texts.values()),
        "footnotesPart": "word/footnotes.xml" in names,
        "footnoteReference": "<w:footnoteReference" in document,
        "footnoteBody": "True footnote: reviewer annotation anchors" in texts.get("word/footnotes.xml", ""),
        "table": "<w:tbl>" in document,
        "floatingAnchor": "<wp:anchor" in document,
        "mixedScript": bool(re.search(r"[\u4e00-\u9fff]", document)) and "Office Reviewer" in document,
        "missingFont": "SuperWagieMissingFont-927" in "".join(texts.values()),
        "trackedReplacement": "<w:del" in document and "<w:ins" in document,
    }
    required = {
        "packageSignature": True,
        "computedPageCount": 30,
        "tocField": True,
        "numberingPart": True,
        "headingNumberingLink": True,
        "sectionCount": 3,
        "footnotesPart": True,
        "footnoteReference": True,
        "footnoteBody": True,
        "table": True,
        "floatingAnchor": True,
        "mixedScript": True,
        "missingFont": True,
        "trackedReplacement": True,
    }
    failures = [key for key, expected in required.items() if checks.get(key) != expected]
    if len(headers) < 3:
        failures.append("headerParts")
    if len(footers) < 3:
        failures.append("footerParts")
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": sha256(path), "checks": checks, "failures": failures}


def audit_pptx(path: Path) -> dict:
    names, texts = zip_texts(path)
    all_text = "".join(texts.values())
    slide_names = sorted(name for name in names if re.fullmatch(r"ppt/slides/slide\d+\.xml", name))
    media_names = sorted(name for name in names if name.startswith("ppt/media/"))
    checks = {
        "packageSignature": path.read_bytes()[:2] == b"PK",
        "contentTypes": "[Content_Types].xml" in names,
        "slideCount": len(slide_names),
        "nativeEditableText": all_text.count("<a:t>") >= 40,
        "nativeCharts": any("/charts/chart" in name for name in names),
        "nativeTables": "<a:tbl>" in all_text,
        "svgImage": any(name.lower().endswith(".svg") for name in media_names),
        "rasterImage": any(name.lower().endswith((".png", ".jpg", ".jpeg")) for name in media_names),
        "transparency": "<a:alpha" in all_text or " alpha=" in all_text,
        "gradient": "<a:gradFill" in all_text,
        "nativeGroup": "<p:grpSp" in all_text,
        "rebuildObject": "REBUILT_OBJECT" in all_text and "REBUILD_SOURCE_GHOST" in all_text,
        "posterFrameVideo": "<a:videoFile" in all_text and any(name.lower().endswith(".mp4") for name in media_names),
        "missingFont": "SuperWagieMissingFont-927" in all_text,
        "speakerNotes": any(name.startswith("ppt/notesSlides/notesSlide") and name.endswith(".xml") for name in names),
    }
    required = {
        "packageSignature": True,
        "slideCount": 20,
        "nativeEditableText": True,
        "nativeCharts": True,
        "nativeTables": True,
        "svgImage": True,
        "rasterImage": True,
        "transparency": True,
        "gradient": True,
        "nativeGroup": True,
        "rebuildObject": True,
        "posterFrameVideo": True,
        "missingFont": True,
        "speakerNotes": True,
    }
    failures = [key for key, expected in required.items() if checks.get(key) != expected]
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": sha256(path), "checks": checks, "media": media_names, "failures": failures}


def count_outline_entries(items) -> int:
    count = 0
    for item in items:
        if isinstance(item, list):
            count += count_outline_entries(item)
        else:
            count += 1
    return count


def audit_pdf(path: Path) -> dict:
    data = path.read_bytes()
    reader = PdfReader(str(path), strict=True)
    sizes = set()
    annotation_count = 0
    image_pages = []
    uri_links = 0
    internal_links = 0
    text_annotations = 0
    for index, page in enumerate(reader.pages, start=1):
        sizes.add((round(float(page.mediabox.width), 3), round(float(page.mediabox.height), 3)))
        resources = page.get("/Resources") or {}
        xobjects = resources.get("/XObject") or {}
        if xobjects:
            image_pages.append(index)
        for annotation_ref in page.get("/Annots") or []:
            annotation_count += 1
            annotation = annotation_ref.get_object()
            subtype = annotation.get("/Subtype")
            if subtype == "/Text":
                text_annotations += 1
            if subtype == "/Link":
                action = annotation.get("/A") or {}
                if action.get("/S") == "/URI":
                    uri_links += 1
                if annotation.get("/Dest") is not None:
                    internal_links += 1
    checks = {
        "pdfSignature": data.startswith(b"%PDF-"),
        "pageCount": len(reader.pages),
        "mixedPageSizes": len(sizes) >= 3,
        "textExtractable": "Revision fidelity checkpoint" in (reader.pages[0].extract_text() or ""),
        "imagePageCount": len(image_pages),
        "scanPagesExact": image_pages == list(range(5, 101, 5)),
        "outlineEntryCount": count_outline_entries(reader.outline),
        "annotationCount": annotation_count,
        "textAnnotationCount": text_annotations,
        "uriLinkCount": uri_links,
        "internalLinkCount": internal_links,
    }
    required = {
        "pdfSignature": True,
        "pageCount": 100,
        "mixedPageSizes": True,
        "textExtractable": True,
        "imagePageCount": 20,
        "scanPagesExact": True,
        "textAnnotationCount": 4,
        "uriLinkCount": 100,
        "internalLinkCount": 99,
    }
    failures = [key for key, expected in required.items() if checks.get(key) != expected]
    if checks["outlineEntryCount"] < 11:
        failures.append("outlineEntryCount")
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": sha256(path), "checks": checks, "pageSizes": sorted(sizes), "failures": failures}


def audit_corrupt(path: Path) -> dict:
    data = path.read_bytes()
    strict_error = None
    try:
        PdfReader(str(path), strict=True)
    except Exception as exc:
        strict_error = f"{type(exc).__name__}: {exc}"
    checks = {"pdfSignature": data.startswith(b"%PDF-"), "corruptMarker": b"%CORRUPT-TAIL" in data, "strictOpenFails": bool(strict_error)}
    return {"path": path.name, "bytes": path.stat().st_size, "sha256": sha256(path), "checks": checks, "strictError": strict_error, "failures": [key for key, value in checks.items() if not value]}


def main(fixture_dir: Path) -> None:
    fixture_dir = fixture_dir.resolve()
    results = {
        "docx": audit_docx(fixture_dir / "reviewer-torture-30p.docx"),
        "pptx": audit_pptx(fixture_dir / "reviewer-torture-20s.pptx"),
        "pdf": audit_pdf(fixture_dir / "reviewer-torture-100p.pdf"),
        "corruptTail": audit_corrupt(fixture_dir / "corrupt-tail.pdf"),
    }
    results["ok"] = all(not item["failures"] for item in results.values() if isinstance(item, dict) and "failures" in item)
    print(json.dumps(results, indent=2, sort_keys=True, ensure_ascii=False))
    if not results["ok"]:
        raise SystemExit(1)


def parse_args():
    parser = argparse.ArgumentParser(description="Audit a rebuilt or checked-in Gate 3 fixture directory.")
    parser.add_argument("--fixture-dir", type=Path, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    main(arguments.fixture_dir)
