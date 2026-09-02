from __future__ import annotations

import argparse
import copy
import zipfile
from pathlib import Path

from lxml import etree


W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
PR = "http://schemas.openxmlformats.org/package/2006/relationships"
CT = "http://schemas.openxmlformats.org/package/2006/content-types"
NS = {"w": W, "r": R}


def qn(namespace: str, local: str) -> str:
    return f"{{{namespace}}}{local}"


def make_run(text: str, *, deleted: bool = False) -> etree._Element:
    run = etree.Element(qn(W, "r"))
    text_node = etree.SubElement(run, qn(W, "delText" if deleted else "t"))
    text_node.text = text
    return run


def make_footnotes() -> etree._Element:
    root = etree.Element(qn(W, "footnotes"), nsmap={"w": W})
    for footnote_id, marker in (("-1", "separator"), ("0", "continuationSeparator")):
        footnote = etree.SubElement(root, qn(W, "footnote"))
        footnote.set(qn(W, "id"), footnote_id)
        paragraph = etree.SubElement(footnote, qn(W, "p"))
        run = etree.SubElement(paragraph, qn(W, "r"))
        etree.SubElement(run, qn(W, marker))
    footnote = etree.SubElement(root, qn(W, "footnote"))
    footnote.set(qn(W, "id"), "1")
    paragraph = etree.SubElement(footnote, qn(W, "p"))
    ref_run = etree.SubElement(paragraph, qn(W, "r"))
    etree.SubElement(ref_run, qn(W, "rPr"))
    etree.SubElement(ref_run, qn(W, "footnoteRef"))
    text_run = etree.SubElement(paragraph, qn(W, "r"))
    text = etree.SubElement(text_run, qn(W, "t"))
    text.text = "True footnote: reviewer annotation anchors must survive pagination and revision changes."
    return root


def ensure_body_footnote_reference(document: etree._Element) -> None:
    if document.xpath('.//w:footnoteReference[@w:id="1"]', namespaces=NS):
        return
    matches = document.xpath('.//w:t[contains(text(), "[[FN]]")]', namespaces=NS)
    if len(matches) != 1:
        raise ValueError(f"expected one [[FN]] marker, found {len(matches)}")
    text_node = matches[0]
    before, after = (text_node.text or "").split("[[FN]]", 1)
    run = text_node.getparent()
    parent = run.getparent()
    position = parent.index(run)
    text_node.text = before
    reference = etree.Element(qn(W, "r"))
    rpr = etree.SubElement(reference, qn(W, "rPr"))
    style = etree.SubElement(rpr, qn(W, "rStyle"))
    style.set(qn(W, "val"), "FootnoteReference")
    footnote_reference = etree.SubElement(reference, qn(W, "footnoteReference"))
    footnote_reference.set(qn(W, "id"), "1")
    parent.insert(position + 1, reference)
    if after:
        trailing = copy.deepcopy(run)
        for trailing_text in trailing.xpath('.//w:t', namespaces=NS):
            trailing_text.text = after
        parent.insert(position + 2, trailing)


def ensure_tracked_repagination_edit(document: etree._Element) -> None:
    if document.xpath('.//w:ins', namespaces=NS) and document.xpath('.//w:del', namespaces=NS):
        return
    matches = document.xpath('.//w:t[text()="REPAGINATION_BASELINE"]', namespaces=NS)
    if len(matches) != 1:
        raise ValueError(f"expected one REPAGINATION_BASELINE marker, found {len(matches)}")
    run = matches[0].getparent()
    parent = run.getparent()
    position = parent.index(run)
    parent.remove(run)
    deletion = etree.Element(qn(W, "del"))
    deletion.set(qn(W, "id"), "927")
    deletion.set(qn(W, "author"), "SuperWagie fixture builder")
    deletion.set(qn(W, "date"), "2026-08-30T00:00:00Z")
    deletion.append(make_run("REPAGINATION_BASELINE", deleted=True))
    insertion = etree.Element(qn(W, "ins"))
    insertion.set(qn(W, "id"), "928")
    insertion.set(qn(W, "author"), "SuperWagie fixture builder")
    insertion.set(qn(W, "date"), "2026-08-30T00:00:00Z")
    insertion.append(make_run("REPAGINATION EDIT INSERTION - accepted tracked content changes downstream wrapping."))
    parent.insert(position, deletion)
    parent.insert(position + 1, insertion)


def ensure_relationships_and_content_type(relationships: etree._Element, content_types: etree._Element) -> None:
    relationship_type = f"{R}/footnotes"
    if not relationships.xpath(f'./pr:Relationship[@Type="{relationship_type}"]', namespaces={"pr": PR}):
        used = {item.get("Id") for item in relationships}
        next_id = 1
        while f"rId{next_id}" in used:
            next_id += 1
        relationship = etree.SubElement(relationships, qn(PR, "Relationship"))
        relationship.set("Id", f"rId{next_id}")
        relationship.set("Type", relationship_type)
        relationship.set("Target", "footnotes.xml")
    part_name = "/word/footnotes.xml"
    if not content_types.xpath(f'./ct:Override[@PartName="{part_name}"]', namespaces={"ct": CT}):
        override = etree.SubElement(content_types, qn(CT, "Override"))
        override.set("PartName", part_name)
        override.set("ContentType", "application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml")


def ensure_footnote_styles(styles: etree._Element) -> None:
    if not styles.xpath('./w:style[@w:styleId="FootnoteText"]', namespaces=NS):
        style = etree.SubElement(styles, qn(W, "style"))
        style.set(qn(W, "type"), "paragraph"); style.set(qn(W, "styleId"), "FootnoteText")
        name = etree.SubElement(style, qn(W, "name")); name.set(qn(W, "val"), "footnote text")
        based = etree.SubElement(style, qn(W, "basedOn")); based.set(qn(W, "val"), "Normal")
        ui = etree.SubElement(style, qn(W, "uiPriority")); ui.set(qn(W, "val"), "99")
        etree.SubElement(style, qn(W, "semiHidden")); etree.SubElement(style, qn(W, "unhideWhenUsed"))
    if not styles.xpath('./w:style[@w:styleId="FootnoteReference"]', namespaces=NS):
        style = etree.SubElement(styles, qn(W, "style"))
        style.set(qn(W, "type"), "character"); style.set(qn(W, "styleId"), "FootnoteReference")
        name = etree.SubElement(style, qn(W, "name")); name.set(qn(W, "val"), "footnote reference")
        based = etree.SubElement(style, qn(W, "basedOn")); based.set(qn(W, "val"), "DefaultParagraphFont")
        run_properties = etree.SubElement(style, qn(W, "rPr"))
        vertical = etree.SubElement(run_properties, qn(W, "vertAlign")); vertical.set(qn(W, "val"), "superscript")


def style_footnote(footnotes: etree._Element, styles: etree._Element, document: etree._Element, settings: etree._Element) -> None:
    ensure_footnote_styles(styles)
    target = footnotes.xpath('./w:footnote[@w:id="1"]', namespaces=NS)[0]
    paragraph = target.find(qn(W, "p"))
    paragraph_properties = paragraph.find(qn(W, "pPr"))
    if paragraph_properties is None:
        paragraph_properties = etree.Element(qn(W, "pPr")); paragraph.insert(0, paragraph_properties)
    paragraph_style = paragraph_properties.find(qn(W, "pStyle"))
    if paragraph_style is None:
        paragraph_style = etree.Element(qn(W, "pStyle")); paragraph_properties.insert(0, paragraph_style)
    paragraph_style.set(qn(W, "val"), "FootnoteText")
    for run in target.xpath('.//w:r', namespaces=NS):
        run_properties = run.find(qn(W, "rPr"))
        if run_properties is None:
            run_properties = etree.Element(qn(W, "rPr")); run.insert(0, run_properties)
        fonts = run_properties.find(qn(W, "rFonts"))
        if fonts is None:
            fonts = etree.SubElement(run_properties, qn(W, "rFonts"))
        for attribute in ("ascii", "hAnsi", "cs"):
            fonts.set(qn(W, attribute), "Aptos")
        fonts.set(qn(W, "eastAsia"), "Arial Unicode MS")
    for body_run in document.xpath('.//w:r[w:footnoteReference]', namespaces=NS):
        run_properties = body_run.find(qn(W, "rPr"))
        if run_properties is None:
            run_properties = etree.Element(qn(W, "rPr")); body_run.insert(0, run_properties)
        run_style = run_properties.find(qn(W, "rStyle"))
        if run_style is None:
            run_style = etree.Element(qn(W, "rStyle")); run_properties.insert(0, run_style)
        run_style.set(qn(W, "val"), "FootnoteReference")
    footnote_properties = settings.find(qn(W, "footnotePr"))
    if footnote_properties is None:
        footnote_properties = etree.SubElement(settings, qn(W, "footnotePr"))
    number_format = footnote_properties.find(qn(W, "numFmt"))
    if number_format is None:
        number_format = etree.SubElement(footnote_properties, qn(W, "numFmt"))
    number_format.set(qn(W, "val"), "decimal")


def patch(input_path: Path, output_path: Path) -> None:
    input_path = input_path.resolve(); output_path = output_path.resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(input_path, "r") as source:
        names = set(source.namelist())
        document = etree.fromstring(source.read("word/document.xml"))
        styles = etree.fromstring(source.read("word/styles.xml"))
        settings = etree.fromstring(source.read("word/settings.xml"))
        relationships = etree.fromstring(source.read("word/_rels/document.xml.rels"))
        content_types = etree.fromstring(source.read("[Content_Types].xml"))
        footnotes = etree.fromstring(source.read("word/footnotes.xml")) if "word/footnotes.xml" in names else make_footnotes()
        ensure_body_footnote_reference(document)
        ensure_tracked_repagination_edit(document)
        ensure_relationships_and_content_type(relationships, content_types)
        style_footnote(footnotes, styles, document, settings)
        overrides = {
            "word/footnotes.xml": etree.tostring(footnotes, xml_declaration=True, encoding="UTF-8", standalone="yes"),
            "word/styles.xml": etree.tostring(styles, xml_declaration=True, encoding="UTF-8", standalone="yes"),
            "word/document.xml": etree.tostring(document, xml_declaration=True, encoding="UTF-8", standalone="yes"),
            "word/settings.xml": etree.tostring(settings, xml_declaration=True, encoding="UTF-8", standalone="yes"),
            "word/_rels/document.xml.rels": etree.tostring(relationships, xml_declaration=True, encoding="UTF-8", standalone="yes"),
            "[Content_Types].xml": etree.tostring(content_types, xml_declaration=True, encoding="UTF-8", standalone="yes"),
        }
        temporary = output_path.with_suffix(".building.docx")
        with zipfile.ZipFile(temporary, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as target:
            for item in source.infolist():
                target.writestr(item, overrides.pop(item.filename, source.read(item.filename)))
            for name, data in overrides.items():
                info = zipfile.ZipInfo(name, date_time=(2026, 8, 30, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
                target.writestr(info, data)
    temporary.replace(output_path)
    print(output_path)


def parse_args():
    parser = argparse.ArgumentParser(description="Insert the true footnote and tracked repagination edit into a DOCX base package.")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    patch(arguments.input, arguments.output)
