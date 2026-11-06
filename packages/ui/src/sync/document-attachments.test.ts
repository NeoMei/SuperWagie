import { describe, expect, spyOn, test } from "bun:test"
import { strToU8, zipSync } from "fflate"
import { extractDocumentAttachments } from "./document-attachments"
import { prepareAttachmentFiles } from "./attachment-files"

const zippedFile = (name: string, entries: Record<string, string | Uint8Array>) => new File([
  zipSync(Object.fromEntries(Object.entries(entries).map(([path, value]) => [
    path,
    typeof value === "string" ? strToU8(value) : value,
  ]))),
], name)

const relationships = (items: Array<{ id: string; target: string; type?: string }>) => `
  <Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
    ${items.map((item) => `<Relationship Id="${item.id}" Target="${item.target}" Type="${item.type ?? "image"}"/>`).join("")}
  </Relationships>
`

const pngBytes = (suffix = 0) => new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, suffix])
const jpegBytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0])
const webpBytes = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
])

describe("document attachment extraction", () => {
  const escapedText = "Use &lt;customer_id&gt; and List&#60;string&#62;; 1 &#x3c; 2 and 3 &gt; 2. &quot;yes&quot; &apos;ok&apos; &amp; &amp;lt; &#38;lt; <b>nested</b>"
  const literalText = 'Use <customer_id> and List<string>; 1 < 2 and 3 > 2. "yes" \'ok\' & &lt; &lt; nested'

  test.each(["docx", "pptx"])("preserves escaped literal text in %s rich text", async (extension) => {
    const entries: Record<string, string> = extension === "docx"
      ? { "word/document.xml": `<w:document><w:p><w:r><w:t>${escapedText}</w:t></w:r><w:r><w:t> joined</w:t></w:r></w:p></w:document>` }
      : { "ppt/slides/slide1.xml": `<p:sld><a:p><a:r><a:t>${escapedText}</a:t></a:r><a:r><a:t> joined</a:t></a:r></a:p></p:sld>` }
    const text = await (await extractDocumentAttachments(zippedFile(`literal.${extension}`, entries)))?.textFile.text()
    expect(text).toContain(`${literalText} joined`)
    expect(text).not.toContain("<b>")
  })

  test.each(["inlineStr", "s"])("preserves escaped literal text in XLSX %s strings", async (type) => {
    const richText = `<r><t>${escapedText}</t></r><r><t> joined</t></r>`
    const file = zippedFile("literal.xlsx", {
      "xl/workbook.xml": '<workbook><sheets><sheet name="Data" r:id="sheet"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "worksheets/sheet1.xml" }]),
      "xl/sharedStrings.xml": `<sst><si>${richText}</si></sst>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData><row><c r="A1" t="${type}">${type === "s" ? "<v>0</v>" : `<is>${richText}</is>`}</c></row></sheetData></worksheet>`,
    })
    const text = await (await extractDocumentAttachments(file))?.textFile.text()
    expect(text).toContain(`${literalText.replaceAll('"', '""')} joined`)
    expect(text).not.toContain("<b>")
  })

  const slide = (text: string) => `<p:sld><a:p><a:r><a:t>${text}</a:t></a:r></a:p></p:sld>`
  const presentationNamespace = "http://schemas.openxmlformats.org/presentationml/2006/main"
  const relationshipNamespace = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"
  const packageNamespace = "http://schemas.openxmlformats.org/package/2006/relationships"
  const manifest = (ids = ["second", "first"]) => `<p:presentation xmlns:p="${presentationNamespace}" xmlns:r="${relationshipNamespace}"><p:sldIdLst>${ids.map((id, index) => `<p:sldId id="${256 + index}" r:id="${id}"/>`).join("")}</p:sldIdLst></p:presentation>`
  const emptyPresentation = `<p:presentation xmlns:p="${presentationNamespace}"/>`
  const slideRelationships = (first = "slides/slide1.xml", second = "slides/slide2.xml") => relationships([
    { id: "first", target: first, type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" },
    { id: "second", target: second, type: "http://purl.oclc.org/ooxml/officeDocument/relationships/slide" },
  ])

  test("uses manifest order with nonnumeric parts, notes and images", async () => {
    const file = zippedFile("ordered.pptx", {
      "ppt/presentation.xml": manifest(),
      "ppt/_rels/presentation.xml.rels": slideRelationships("../ppt/slides/final.xml", "/ppt/slides/question.xml"),
      "ppt/slides/final.xml": slide("Final answer"),
      "ppt/slides/question.xml": '<p:sld><a:p><a:t>Question first</a:t></a:p><p:pic><a:blip r:embed="image"/></p:pic></p:sld>',
      "ppt/slides/slide0.xml": slide("Orphan must be absent"),
      "ppt/slides/_rels/final.xml.rels": relationships([{ id: "notes", target: "../notesSlides/final.xml", type: "http://example/notesSlide" }]),
      "ppt/slides/_rels/question.xml.rels": relationships([
        { id: "notes", target: "../notesSlides/question.xml", type: "http://example/notesSlide" },
        { id: "image", target: "../media/image.png" },
      ]),
      "ppt/notesSlides/final.xml": '<p:notes><a:p><a:t>Answer note</a:t></a:p></p:notes>',
      "ppt/notesSlides/question.xml": '<p:notes><a:p><a:t>Question &lt;note&gt;</a:t></a:p></p:notes>',
      "ppt/media/image.png": pngBytes(),
    })
    const result = await extractDocumentAttachments(file)
    expect(await result?.textFile.text()).toBe("# Presentation\n\n## Slide 1\n\nQuestion first\n\n[ordered-image-1.png]\n\n### Slide 1 notes\n\nQuestion <note>\n\n## Slide 2\n\nFinal answer\n\n### Slide 2 notes\n\nAnswer note\n")
    expect(result?.images).toHaveLength(1)
  })

  test("keeps numeric minimal-package fallback only when both ordering parts are absent", async () => {
    const text = await (await extractDocumentAttachments(zippedFile("minimal.pptx", {
      "ppt/slides/slide10.xml": slide("Tenth"),
      "ppt/slides/slide2.xml": slide("Second"),
      "ppt/slides/custom.xml": slide("Unordered"),
    })))?.textFile.text()
    expect(text).toBe("# Presentation\n\n## Slide 1\n\nSecond\n\n## Slide 2\n\nTenth\n")
  })

  test("resolves namespace aliases and quoted relationship targets", async () => {
    const file = zippedFile("aliases.pptx", {
      "ppt/presentation.xml": '<q:presentation xmlns:q="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:link="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><!-- ignored <q:sldId/> --><q:sldIdLst><q:sldId id="256" link:id="intro"/></q:sldIdLst></q:presentation>',
      "ppt/_rels/presentation.xml.rels": '<?xml version="1.0"?><rel:Relationships xmlns:rel="http://schemas.openxmlformats.org/package/2006/relationships"><rel:Relationship Id="intro" Target="slides/a&amp;b&gt;c.XML" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide"/></rel:Relationships>',
      "ppt/slides/a&b>c.XML": slide("Alias slide"),
    })
    expect(await (await extractDocumentAttachments(file))?.textFile.text()).toBe("# Presentation\n\n## Slide 1\n\nAlias slide\n")
  })

  test("accepts an empty presentation without relationship metadata", async () => {
    const file = zippedFile("empty.pptx", { "ppt/presentation.xml": emptyPresentation, "ppt/slides/slide1.xml": slide("Orphan") })
    expect(await (await extractDocumentAttachments(file))?.textFile.text()).toBe("# Presentation\n")
  })

  test("shared attachment intake preserves extracted text and manifest order", async () => {
    const file = zippedFile("intake.pptx", {
      "ppt/presentation.xml": manifest(),
      "ppt/_rels/presentation.xml.rels": slideRelationships(),
      "ppt/slides/slide1.xml": slide("Final answer"),
      "ppt/slides/slide2.xml": slide("Question &lt;customer_id&gt;"),
    })
    const prepared = await prepareAttachmentFiles(file)
    expect(prepared).toHaveLength(1)
    expect(prepared?.[0]?.mimeType).toBe("text/plain")
    expect(await prepared?.[0]?.file.text()).toBe("# Presentation\n\n## Slide 1\n\nQuestion <customer_id>\n\n## Slide 2\n\nFinal answer\n")
  })

  test.each([manifest([]), emptyPresentation])("an empty authoritative presentation excludes orphan slides: %s", async (presentation) => {
    const text = await (await extractDocumentAttachments(zippedFile("empty.pptx", {
      "ppt/presentation.xml": presentation,
      "ppt/_rels/presentation.xml.rels": relationships([]),
      "ppt/slides/slide1.xml": slide("Orphan"),
    })))?.textFile.text()
    expect(text).toBe("# Presentation\n")
  })

  const invalidOrdering: Array<[string, string | undefined, string | undefined]> = [
    ["missing relationships", manifest(), undefined],
    ["missing manifest", undefined, slideRelationships()],
    ["empty manifest", "", slideRelationships()],
    ["empty relationships", manifest(), ""],
    ["malformed manifest", manifest().replace("</p:presentation>", ""), slideRelationships()],
    ["malformed list", manifest().replace("</p:sldIdLst>", ""), slideRelationships()],
    ["duplicated list", manifest([]).replace("</p:sldIdLst>", "</p:sldIdLst><p:sldIdLst/>"), slideRelationships()],
    ["malformed relationships", manifest(), slideRelationships().replace("</Relationships>", "")],
    ["missing ID", manifest(["missing"]), slideRelationships()],
    ["duplicate slide ID", manifest(["first", "first"]), slideRelationships()],
    ["duplicate relationship ID", manifest(["first"]), relationships([{ id: "first", target: "slides/slide1.xml", type: "http://example/slide" }, { id: "first", target: "slides/slide2.xml", type: "http://example/slide" }])],
    ["missing target", manifest(["first"]), slideRelationships("slides/missing.xml")],
    ["wrong type", manifest(["first"]), relationships([{ id: "first", target: "slides/slide1.xml", type: "http://example/image" }])],
    ["external target", manifest(["first"]), slideRelationships().replace('Id="first"', 'Id="first" TargetMode="External"')],
    ["escaping target", manifest(["first"]), slideRelationships("../../outside.xml")],
    ["malformed attribute", manifest().replace('r:id="second"', 'r:id="second'), slideRelationships()],
    ["duplicate numeric slide ID", manifest().replace('id="257"', 'id="256"'), slideRelationships()],
    ["unrecognized slide type", manifest(["first"]), relationships([{ id: "first", target: "slides/slide1.xml", type: "http://example/slide" }])],
    ["invalid target mode", manifest(["first"]), slideRelationships().replace('Id="first"', 'Id="first" TargetMode="Other"')],
    ["HTTP target", manifest(["first"]), slideRelationships("https://example.invalid/slide.xml")],
    ["nested relationship", manifest(["first"]), slideRelationships().replace('/>', '><Relationship Id="nested"/></Relationship>')],
    ["invalid XML entity", manifest().replace('r:id="second"', 'r:id="&AMP;"'), slideRelationships()],
    ["invalid XML comment", manifest().replace("<p:sldIdLst>", "<!-- invalid -- comment --><p:sldIdLst>"), slideRelationships()],
    ["unreferenced relationship without target", manifest(["first"]), slideRelationships().replace('Target="slides/slide2.xml"', "")],
    ["unreferenced relationship without type", manifest(["first"]), slideRelationships().replace('Type="http://purl.oclc.org/ooxml/officeDocument/relationships/slide"', "")],
  ]
  test.each(invalidOrdering)("rejects %s as invalid presentation metadata", async (_, presentation, rels) => {
    const entries = new Map([
      ["ppt/slides/slide1.xml", slide("One")],
      ["ppt/slides/slide2.xml", slide("Two")],
    ])
    if (presentation !== undefined) entries.set("ppt/presentation.xml", presentation)
    if (rels !== undefined) entries.set("ppt/_rels/presentation.xml.rels", rels)
    await expect(extractDocumentAttachments(zippedFile("invalid.pptx", Object.fromEntries(entries)))).rejects.toThrow("presentation")
  })

  test("shared intake rejects malformed ordering before publishing parts", async () => {
    const file = zippedFile("invalid.pptx", {
      "ppt/presentation.xml": manifest(),
      "ppt/slides/slide1.xml": slide("Cannot publish"),
    })
    await expect(prepareAttachmentFiles(file)).rejects.toThrow("presentation")
  })

  test("accepts default namespaces and strict presentation aliases", async () => {
    const file = zippedFile("strict.pptx", {
      "ppt/presentation.xml": '<presentation xmlns="http://purl.oclc.org/ooxml/presentationml/main" xmlns:link="http://purl.oclc.org/ooxml/officeDocument/relationships"><sldIdLst><sldId id="256" link:id="first"/></sldIdLst></presentation>',
      "ppt/_rels/presentation.xml.rels": slideRelationships(),
      "ppt/slides/slide1.xml": slide("Strict slide"),
    })
    expect(await (await extractDocumentAttachments(file))?.textFile.text()).toBe("# Presentation\n\n## Slide 1\n\nStrict slide\n")
  })

  const invalidNamespaces: Array<[string, string, string]> = [
    ["foreign presentation", manifest(["first"]).replace(presentationNamespace, "urn:unrelated"), slideRelationships()],
    ["unbound presentation", manifest(["first"]).replace(` xmlns:p="${presentationNamespace}"`, ""), slideRelationships()],
    ["malformed presentation QName", manifest(["first"]).replace(/p:presentation/g, "p:extra:presentation"), slideRelationships()],
    ["foreign slide list", manifest(["first"]).replace("<p:sldIdLst>", '<p:sldIdLst xmlns:p="urn:unrelated">'), slideRelationships()],
    ["foreign slide ID", manifest(["first"]).replace('<p:sldId id=', '<p:sldId xmlns:p="urn:unrelated" id='), slideRelationships()],
    ["unbound slide ID", manifest(["first"]).replace(/p:sldId\b/g, "unbound:sldId"), slideRelationships()],
    ["foreign relationship root", manifest(["first"]), slideRelationships().replace(packageNamespace, "urn:unrelated")],
    ["unbound relationship root", manifest(["first"]), slideRelationships().replace(` xmlns="${packageNamespace}"`, "")],
    ["foreign relationship child", manifest(["first"]), slideRelationships().replace('<Relationship Id="first"', '<Relationship xmlns="urn:unrelated" Id="first"')],
    ["unbound relationship child", manifest(["first"]), slideRelationships().replace('<Relationship Id="first"', '<unbound:Relationship Id="first"')],
    ["foreign relationship ID", manifest(["first"]).replace(relationshipNamespace, "urn:unrelated"), slideRelationships()],
    ["unbound relationship ID", manifest(["first"]).replace(` xmlns:r="${relationshipNamespace}"`, ""), slideRelationships()],
    ["default namespace reset", `<presentation xmlns="${presentationNamespace}" xmlns:r="${relationshipNamespace}"><sldIdLst xmlns=""><sldId id="256" r:id="first"/></sldIdLst></presentation>`, slideRelationships()],
  ]
  test.each(invalidNamespaces)("rejects %s as nonauthoritative ordering XML", async (_, presentation, rels) => {
    const file = zippedFile("namespace.pptx", {
      "ppt/presentation.xml": presentation,
      "ppt/_rels/presentation.xml.rels": rels,
      "ppt/slides/slide1.xml": slide("Must not publish"),
    })
    await expect(extractDocumentAttachments(file)).rejects.toThrow("presentation")
  })

  test.each(["<!--", "<?instruction ", "<![CDATA[", '<p:presentation attribute="'])("bounds malformed token attempts for %s", async (opening) => {
    const payload = opening.repeat(2_048)
    const execute = RegExp.prototype.exec
    const attempts: Array<{ sticky: boolean; offset: number }> = []
    const execution = spyOn(RegExp.prototype, "exec").mockImplementation(function (this: RegExp, input: string) {
      if (input === payload) attempts.push({ sticky: this.sticky, offset: this.lastIndex })
      return execute.call(this, input)
    })
    try {
      const file = zippedFile("malformed.pptx", { "ppt/presentation.xml": payload })
      await expect(extractDocumentAttachments(file)).rejects.toThrow("presentation")
    } finally {
      execution.mockRestore()
    }
    // A single sticky attempt starts at the current cursor. Failed token
    // matching cannot restart its suffix search at each subsequent opener.
    expect(attempts).toEqual([{ sticky: true, offset: 0 }])
  })

  test("extracts DOCX text and preserves inline image citations", async () => {
    const file = zippedFile("report.docx", {
      "word/document.xml": `
        <w:document xmlns:w="w" xmlns:a="a" xmlns:r="r">
          <w:body>
            <w:p><w:r><w:t>Before image</w:t></w:r></w:p>
            <w:p><w:r><w:drawing><a:blip r:embed="rId1"/></w:drawing></w:r></w:p>
            <w:p><w:r><w:t>After image</w:t></w:r></w:p>
          </w:body>
        </w:document>`,
      "word/_rels/document.xml.rels": relationships([{ id: "rId1", target: "media/image1.png" }]),
      "word/media/image1.png": pngBytes(),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("Before image\n\n[report-image-1.png]\n\nAfter image")).toBe(true)
    expect(result?.textFile.name).toBe("report.docx")
    expect(result?.textFile.type.startsWith("text/plain")).toBe(true)
    expect(result?.images).toHaveLength(1)
    expect(result?.images[0]?.name).toBe("report-image-1.png")
    expect(result?.images[0]?.type).toBe("image/png")

    const deduplicated = await extractDocumentAttachments(file, ["report-image-1.png"])
    expect((await deduplicated?.textFile.text())?.includes("[report-image-2.png]")).toBe(true)
    expect(deduplicated?.images[0]?.name).toBe("report-image-2.png")
  })

  test("extracts PPTX slide text, notes, and pictures", async () => {
    const file = zippedFile("deck.pptx", {
      "ppt/slides/slide1.xml": `
        <p:sld xmlns:p="p" xmlns:a="a" xmlns:r="r">
          <a:p><a:r><a:t>Slide title</a:t></a:r></a:p>
          <p:pic><p:blipFill><a:blip r:embed="rIdImage"/></p:blipFill></p:pic>
        </p:sld>`,
      "ppt/slides/_rels/slide1.xml.rels": relationships([
        { id: "rIdImage", target: "../media/image1.jpeg" },
        { id: "rIdNotes", target: "../notesSlides/notesSlide1.xml", type: "http://example/notesSlide" },
      ]),
      "ppt/notesSlides/notesSlide1.xml": `<p:notes xmlns:p="p" xmlns:a="a"><a:p><a:r><a:t>Speaker note</a:t></a:r></a:p></p:notes>`,
      "ppt/media/image1.jpeg": jpegBytes,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("## Slide 1")).toBe(true)
    expect(text.includes("Slide title")).toBe(true)
    expect(text.includes("[deck-image-1.jpg]")).toBe(true)
    expect(text.includes("### Slide 1 notes\n\nSpeaker note")).toBe(true)
    expect(result?.images[0]?.name).toBe("deck-image-1.jpg")
  })

  test("extracts XLSX cell values and anchors pictures to cells", async () => {
    const file = zippedFile("budget.xlsx", {
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Summary" r:id="rIdSheet"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": relationships([{ id: "rIdSheet", target: "worksheets/sheet1.xml" }]),
      "xl/sharedStrings.xml": `<sst><si><t>Revenue</t></si></sst>`,
      "xl/worksheets/sheet1.xml": `
        <worksheet xmlns:r="r"><sheetData>
          <row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>42</v></c></row>
          <row r="2"><c r="A2" t="inlineStr"><is><t>North</t></is></c><c r="B2"><v>17</v></c></row>
        </sheetData><drawing r:id="rIdDrawing"/></worksheet>`,
      "xl/worksheets/_rels/sheet1.xml.rels": relationships([{ id: "rIdDrawing", target: "../drawings/drawing1.xml" }]),
      "xl/drawings/drawing1.xml": `
        <xdr:wsDr xmlns:xdr="xdr" xmlns:a="a" xmlns:r="r"><xdr:oneCellAnchor><xdr:from><xdr:col>1</xdr:col><xdr:row>2</xdr:row></xdr:from><a:blip r:embed="rIdImage"/></xdr:oneCellAnchor></xdr:wsDr>`,
      "xl/drawings/_rels/drawing1.xml.rels": relationships([{ id: "rIdImage", target: "../media/image1.webp" }]),
      "xl/media/image1.webp": webpBytes,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("## Sheet: Summary")).toBe(true)
    expect(text.includes("Range: A1:B2\nRevenue\t42\nNorth\t17")).toBe(true)
    expect(text.includes("Image at B3: [budget-image-1.webp]")).toBe(true)
    expect(result?.images[0]?.name).toBe("budget-image-1.webp")
  })

  test("quotes TSV values and keeps sparse XLSX rows coordinate-based", async () => {
    const file = zippedFile("sparse.xlsx", {
      "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="Data" r:id="sheet"/></sheets></workbook>`,
      "xl/_rels/workbook.xml.rels": relationships([{ id: "sheet", target: "worksheets/sheet1.xml" }]),
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>line 1&#10;line 2</t></is></c><c r="B1" t="inlineStr"><is><t>say &quot;hi&quot;</t></is></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>first</t></is></c><c r="XFD2" t="inlineStr"><is><t>last</t></is></c></row>
      </sheetData></worksheet>`,
    })

    const text = await (await extractDocumentAttachments(file))?.textFile.text() ?? ""

    expect(text.includes('Range: A1:B1\n"line 1\nline 2"\t"say ""hi"""')).toBe(true)
    expect(text.includes("Cells: A2\tfirst | XFD2\tlast")).toBe(true)
  })

  test("extracts OpenDocument text, presentations, spreadsheets, and image positions", async () => {
    const image = pngBytes()
    const odt = zippedFile("notes.odt", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:draw="draw" xmlns:xlink="xlink"><text:h>Heading</text:h><text:p>Hello <text:span>world</text:span></text:p><draw:frame><draw:image xlink:href="Pictures/photo.png"/></draw:frame><text:p>After image</text:p></office:document>`,
      "Pictures/photo.png": image,
    })
    const odp = zippedFile("slides.odp", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:draw="draw"><draw:page draw:name="Intro"><text:p>Welcome</text:p></draw:page></office:document>`,
    })
    const ods = zippedFile("table.ods", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text" xmlns:table="table" xmlns:draw="draw" xmlns:xlink="xlink"><table:table table:name="Data"><table:shapes><draw:frame><draw:image xlink:href="Pictures/chart.png"/></draw:frame></table:shapes><table:table-row><table:table-cell><text:p>Name</text:p></table:table-cell><table:table-cell><text:p>Value</text:p></table:table-cell></table:table-row></table:table></office:document>`,
      "Pictures/chart.png": image,
    })

    const odtResult = await extractDocumentAttachments(odt)
    const odpResult = await extractDocumentAttachments(odp)
    const odsResult = await extractDocumentAttachments(ods)

    expect((await odtResult?.textFile.text())?.includes("Heading\n\nHello world\n\n[notes-image-1.png]\n\nAfter image")).toBe(true)
    expect(odtResult?.images).toHaveLength(1)
    expect((await odpResult?.textFile.text())?.includes("## Slide: Intro\n\nWelcome")).toBe(true)
    expect((await odsResult?.textFile.text())?.includes("## Sheet: Data\n\n[table-image-1.png]\n\nName | Value")).toBe(true)
    expect(odsResult?.images).toHaveLength(1)
  })

  test("rejects unsafe archive paths", async () => {
    const file = zippedFile("unsafe.docx", {
      "../word/document.xml": `<w:document xmlns:w="w"><w:p><w:t>Unsafe</w:t></w:p></w:document>`,
    })
    await expect(extractDocumentAttachments(file)).rejects.toThrow("unsafe file path")
  })

  test("rejects archives over the entry-count limit", async () => {
    const entries = Object.fromEntries(Array.from({ length: 5_001 }, (_, index) => [
      `metadata/entry-${index}.xml`,
      "<metadata/>",
    ]))

    await expect(extractDocumentAttachments(zippedFile("too-many.docx", entries))).rejects.toThrow("too many files")
  })

  test("bounds embedded image count and marks omitted images in document text", async () => {
    const imageTags = Array.from({ length: 51 }, (_, index) => `<w:p><a:blip r:embed="rId${index}"/></w:p>`).join("")
    const relationshipItems = Array.from({ length: 51 }, (_, index) => ({
      id: `rId${index}`,
      target: `media/image${index}.png`,
    }))
    const entries: Record<string, string | Uint8Array> = {
      "word/document.xml": `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>${imageTags}</w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships(relationshipItems),
    }
    for (let index = 0; index < 51; index += 1) entries[`word/media/image${index}.png`] = pngBytes(index)

    const result = await extractDocumentAttachments(zippedFile("gallery.docx", entries))
    const text = await result?.textFile.text() ?? ""

    expect(result?.images).toHaveLength(50)
    expect(text.includes("[Embedded image omitted by attachment limits: image50.png]")).toBe(true)
  })

  test("omits unsupported and spoofed embedded image content", async () => {
    const file = zippedFile("unsafe-images.docx", {
      "word/document.xml": `
        <w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body>
          <w:p><a:blip r:embed="svg"/></w:p>
          <w:p><a:blip r:embed="fakePng"/></w:p>
        </w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships([
        { id: "svg", target: "media/image.svg" },
        { id: "fakePng", target: "media/fake.png" },
      ]),
      "word/media/image.svg": `<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>`,
      "word/media/fake.png": new Uint8Array([1, 2, 3]),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(result?.images).toEqual([])
    expect(text.includes("[Unsupported embedded image omitted: image.svg]")).toBe(true)
    expect(text.includes("[Invalid embedded image omitted: fake.png]")).toBe(true)
  })

  test("bounds expanded ODF spaces", async () => {
    const file = zippedFile("spaces.odt", {
      "content.xml": `<office:document xmlns:office="office" xmlns:text="text"><text:p>Before<text:s text:c="999999999999999999999"/>After</text:p></office:document>`,
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.includes("[Additional spaces omitted]After")).toBe(true)
    expect(text.length).toBeLessThan(1_000)
  })

  test("does not retain images whose citations fall beyond the text limit", async () => {
    const file = zippedFile("long.docx", {
      "word/document.xml": `<w:document xmlns:w="w" xmlns:a="a" xmlns:r="r"><w:body><w:p><w:t>${"x".repeat(500_100)}</w:t></w:p><w:p><a:blip r:embed="image"/></w:p></w:body></w:document>`,
      "word/_rels/document.xml.rels": relationships([{ id: "image", target: "media/image.png" }]),
      "word/media/image.png": pngBytes(),
    })

    const result = await extractDocumentAttachments(file)
    const text = await result?.textFile.text() ?? ""

    expect(text.length <= 500_000).toBe(true)
    expect(text.endsWith("[Document text truncated by OpenChamber]\n")).toBe(true)
    expect(text.includes("[long-image-1.png]")).toBe(false)
    expect(result?.images).toEqual([])
  })
})
