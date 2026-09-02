import fs from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';
import { Presentation, PresentationFile } from '@oai/artifact-tool';

function parseArgs(argv) {
  const options = {
    output: path.resolve('reviewer-torture-20s.pptx'),
    workDir: path.resolve('.build-pptx'),
    renderPreview: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--output') options.output = path.resolve(argv[++index] ?? '');
    else if (argument === '--work-dir') options.workDir = path.resolve(argv[++index] ?? '');
    else if (argument === '--no-preview') options.renderPreview = false;
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const FINAL = options.output;
const WORK_DIR = options.workDir;
const PREVIEW_DIR = path.join(WORK_DIR, 'pptx-artifact-render');
const W = 1280;
const H = 720;
const BG = '#F5F8FB';
const NAVY = '#17324D';
const BLUE = '#2E74B5';
const CYAN = '#4DA3D9';
const TEXT = '#243447';
const MUTED = '#65798A';

async function writeBlob(filePath, blob) {
  await fs.writeFile(filePath, new Uint8Array(await blob.arrayBuffer()));
}

function patternSvg(index, title, accent = '#2E74B5') {
  const circles = Array.from({ length: 12 }, (_, i) => {
    const x = 90 + ((i * 103 + index * 37) % 1100);
    const y = 90 + ((i * 67 + index * 53) % 500);
    const r = 18 + ((i * 7) % 48);
    const opacity = (0.15 + (i % 5) * 0.10).toFixed(2);
    return `<circle cx="${x}" cy="${y}" r="${r}" fill="${accent}" opacity="${opacity}"/>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#EAF4FB"/><stop offset="1" stop-color="#B9D9ED"/></linearGradient></defs>
    <rect width="1280" height="720" fill="url(#g)"/>${circles}
    <path d="M0 570 C260 470 410 690 700 555 C930 450 1080 560 1280 470 L1280 720 L0 720Z" fill="${accent}" opacity="0.26"/>
    <text x="84" y="626" font-family="Arial" font-size="26" fill="#17324D">PROJECT-OWNED SYNTHETIC IMAGE ${String(index).padStart(2, '0')}</text>
    <text x="84" y="666" font-family="Arial" font-size="18" fill="#52677B">${title}</text>
  </svg>`;
}

function addText(slide, name, text, position, style = {}) {
  const shape = slide.shapes.add({
    geometry: 'textbox',
    name,
    position,
    fill: 'none',
    line: { style: 'solid', fill: 'none', width: 0 },
  });
  shape.text = text;
  shape.text.style = {
    typeface: 'Aptos',
    fontSize: style.fontSize ?? 20,
    bold: style.bold ?? false,
    color: style.color ?? TEXT,
    alignment: style.alignment ?? 'left',
    verticalAlignment: style.verticalAlignment ?? 'top',
    autoFit: 'shrinkText',
    insets: { top: 4, right: 6, bottom: 4, left: 6 },
    ...(style.typeface ? { typeface: style.typeface } : {}),
  };
  return shape;
}

function addChrome(slide, number, title, subtitle = '') {
  slide.background.fill = BG;
  slide.shapes.add({
    geometry: 'rect', name: `accent-${number}`,
    position: { left: 64, top: 56, width: 10, height: 74 },
    fill: BLUE, line: { style: 'solid', fill: 'none', width: 0 },
  });
  addText(slide, `title-${number}`, title, { left: 92, top: 54, width: 1040, height: 64 }, { fontSize: 40, bold: true, color: NAVY });
  if (subtitle) addText(slide, `subtitle-${number}`, subtitle, { left: 94, top: 118, width: 1040, height: 44 }, { fontSize: 18, color: MUTED });
  addText(slide, `page-${number}`, String(number).padStart(2, '0'), { left: 1160, top: 640, width: 52, height: 34 }, { fontSize: 17, bold: true, color: MUTED, alignment: 'right' });
}

function setNotes(slide) {
  slide.speakerNotes.textFrame.setText('[Sources]\n- SuperWagie project-owned synthetic fixture content; no external sources.');
  slide.speakerNotes.setVisible(true);
}

function addCaption(slide, text) {
  addText(slide, `caption-${slide.index}`, text, { left: 86, top: 618, width: 940, height: 42 }, { fontSize: 17, color: MUTED });
}

async function buildDeck() {
  await fs.mkdir(WORK_DIR, { recursive: true });
  await fs.mkdir(path.dirname(FINAL), { recursive: true });
  if (options.renderPreview) await fs.mkdir(PREVIEW_DIR, { recursive: true });
  const deck = Presentation.create({ slideSize: { width: W, height: H } });

  // 1. Minimal title.
  {
    const slide = deck.slides.add();
    slide.background.fill = { type: 'gradient', gradientKind: 'linear', angleDeg: 25, stops: [{ offset: 0, color: '#F7FBFF' }, { offset: 100000, color: '#CDE7F5' }] };
    slide.shapes.add({ geometry: 'ellipse', name: 'title-orbit-a', position: { left: 760, top: 70, width: 390, height: 390 }, fill: '#2E74B5/18', line: { style: 'solid', fill: '#2E74B5/28', width: 2 } });
    slide.shapes.add({ geometry: 'ellipse', name: 'title-orbit-b', position: { left: 900, top: 210, width: 250, height: 250 }, fill: '#4DA3D9/28', line: { style: 'solid', fill: 'none', width: 0 } });
    addText(slide, 'deck-title', 'Office Reviewer\nTorture Fixture', { left: 82, top: 150, width: 690, height: 190 }, { fontSize: 58, bold: true, color: NAVY });
    addText(slide, 'deck-subtitle', '20 real slides | native objects | deterministic technical validation', { left: 90, top: 368, width: 720, height: 64 }, { fontSize: 24, color: MUTED });
    addText(slide, 'deck-version', 'SuperWagie Gate 3 / G3-REVIEW-001', { left: 92, top: 570, width: 580, height: 42 }, { fontSize: 18, bold: true, color: BLUE });
    setNotes(slide);
  }

  // 2-3. Image-first slides.
  for (let n = 2; n <= 3; n++) {
    const slide = deck.slides.add();
    slide.images.add({ svg: patternSvg(n, n === 2 ? 'image-first full-frame crop' : 'image-first overlay and contrast', n === 2 ? '#2E74B5' : '#0F766E'), alt: `Project-owned image-first fixture ${n}`, fit: 'cover', position: { left: 0, top: 0, width: W, height: H } });
    slide.shapes.add({ geometry: 'roundRect', name: `image-overlay-${n}`, position: { left: 70, top: 78, width: 590, height: 270 }, fill: '#FFFFFF/84', line: { style: 'solid', fill: '#FFFFFF/65', width: 1 }, borderRadius: 22, shadow: 'shadow-md' });
    addText(slide, `image-title-${n}`, n === 2 ? 'Image-first content stays reviewable' : 'Overlay contrast survives export', { left: 102, top: 112, width: 520, height: 110 }, { fontSize: 42, bold: true, color: NAVY });
    addText(slide, `image-body-${n}`, 'The background is a native embedded image object; the headline and explanation remain editable text.', { left: 104, top: 244, width: 500, height: 76 }, { fontSize: 19, color: TEXT });
    setNotes(slide);
  }

  // 4. SVG test.
  {
    const slide = deck.slides.add(); addChrome(slide, 4, 'Native SVG survives as an editable image object', 'Vector media and DrawingML text coexist.');
    slide.images.add({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 720 360"><defs><linearGradient id="v" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#2E74B5"/><stop offset="1" stop-color="#70C1E4"/></linearGradient></defs><rect x="8" y="8" width="704" height="344" rx="28" fill="url(#v)"/><path d="M90 260 L210 120 L330 235 L450 90 L630 265" fill="none" stroke="white" stroke-width="16" stroke-linecap="round" stroke-linejoin="round"/><circle cx="450" cy="90" r="24" fill="#FFD166"/></svg>`, alt: 'Native SVG line study', fit: 'contain', position: { left: 150, top: 200, width: 760, height: 360 } });
    addText(slide, 'svg-callout', 'SVG', { left: 965, top: 270, width: 180, height: 90 }, { fontSize: 44, bold: true, color: BLUE, alignment: 'center' });
    addText(slide, 'svg-body', 'Inspect vector fallback and image relationship.', { left: 930, top: 370, width: 250, height: 82 }, { fontSize: 18, color: MUTED, alignment: 'center' });
    setNotes(slide);
  }

  // 5. Native chart.
  {
    const slide = deck.slides.add(); addChrome(slide, 5, 'Native chart data remains inspectable', 'Four renderer passes with visible values.');
    slide.charts.add('bar', { position: { left: 120, top: 190, width: 820, height: 370 }, categories: ['Open', 'Render', 'Annotate', 'Confirm'], series: [{ name: 'Pass rate', values: [98, 96, 93, 99], fill: BLUE }], barOptions: { direction: 'column', grouping: 'clustered', gapWidth: 48 }, hasLegend: false, yAxis: { min: 0, max: 100, majorUnit: 20, majorGridlines: { style: 'solid', fill: '#DCE5ED', width: 1 }, textStyle: { fontSize: 14, fill: MUTED } }, xAxis: { textStyle: { fontSize: 15, fill: TEXT } }, dataLabels: { showValue: true, position: 'outEnd', textStyle: { fontSize: 15, fill: NAVY, bold: true } }, chartFill: 'white', chartLine: { style: 'solid', fill: '#D6E1EA', width: 1 } });
    addText(slide, 'chart-callout', '99%', { left: 1000, top: 245, width: 180, height: 82 }, { fontSize: 46, bold: true, color: BLUE, alignment: 'center' });
    addText(slide, 'chart-note', 'Version confirmation\nfixture peak', { left: 990, top: 330, width: 200, height: 92 }, { fontSize: 19, color: MUTED, alignment: 'center' });
    setNotes(slide);
  }

  // 6. Native table.
  {
    const slide = deck.slides.add(); addChrome(slide, 6, 'Native table exposes real cells', 'Rows, columns, values, fills, and borders remain editable.');
    const table = slide.tables.add({ rows: 5, columns: 4, left: 104, top: 194, width: 1040, height: 340, columnTracks: [{ mode: 'fixed', value: 190 }, { mode: 'fr', value: 2.2 }, { mode: 'fr', value: 1 }, { mode: 'fixed', value: 150 }], values: [['Feature', 'Evidence', 'Risk', 'Expected'], ['Chart', 'Native chart XML', 'Medium', 'Pass'], ['Table', 'Native cell grid', 'Medium', 'Pass'], ['SVG', 'Vector relationship', 'High', 'Pass'], ['Media', 'Poster-frame relationship', 'High', 'Pass']] });
    table.styleOptions = { headerRow: true, bandedRows: true };
    table.borders.assign({ style: 'solid', fill: '#C8D5E0', width: 1 });
    for (let c = 0; c < 4; c++) { table.getCell(0, c).fill = NAVY; table.getCell(0, c).text.style = { fontSize: 17, bold: true, color: '#FFFFFF', alignment: 'center', verticalAlignment: 'middle' }; }
    for (let r = 1; r < 5; r++) for (let c = 0; c < 4; c++) table.getCell(r, c).text.style = { fontSize: 16, color: TEXT, alignment: c === 1 ? 'left' : 'center', verticalAlignment: 'middle' };
    setNotes(slide);
  }

  // 7. Transparency.
  {
    const slide = deck.slides.add(); addChrome(slide, 7, 'Transparency reveals stacking behavior', 'Overlapping native shapes use distinct alpha values.');
    const specs = [
      { left: 220, top: 220, color: '#2E74B5/58', name: 'transparent-blue' },
      { left: 430, top: 260, color: '#0F766E/52', name: 'transparent-green' },
      { left: 640, top: 205, color: '#E07A5F/48', name: 'transparent-coral' },
    ];
    for (const spec of specs) slide.shapes.add({ geometry: 'ellipse', name: spec.name, position: { left: spec.left, top: spec.top, width: 300, height: 300 }, fill: spec.color, line: { style: 'solid', fill: '#FFFFFF/70', width: 3 } });
    addText(slide, 'alpha-label', 'ALPHA', { left: 480, top: 340, width: 300, height: 76 }, { fontSize: 42, bold: true, color: '#FFFFFF', alignment: 'center', verticalAlignment: 'middle' });
    setNotes(slide);
  }

  // 8. Gradient.
  {
    const slide = deck.slides.add(); addChrome(slide, 8, 'Gradient fills exercise DrawingML stops', 'Linear and radial gradients use native fill definitions.');
    slide.shapes.add({ geometry: 'roundRect', name: 'linear-gradient-test', position: { left: 120, top: 210, width: 480, height: 270 }, fill: { type: 'gradient', gradientKind: 'linear', angleDeg: 32, stops: [{ offset: 0, color: '#17324D' }, { offset: 48000, color: '#2E74B5' }, { offset: 100000, color: '#7CC4E4' }] }, line: { style: 'solid', fill: 'none', width: 0 }, borderRadius: 26 });
    slide.shapes.add({ geometry: 'ellipse', name: 'radial-gradient-test', position: { left: 735, top: 205, width: 300, height: 300 }, fill: { type: 'gradient', gradientKind: 'path', stops: [{ offset: 0, color: '#FFFFFF' }, { offset: 45000, color: '#70C1E4' }, { offset: 100000, color: '#17324D' }] }, line: { style: 'solid', fill: '#DDEAF2', width: 2 } });
    addText(slide, 'gradient-linear-label', 'LINEAR', { left: 240, top: 314, width: 240, height: 60 }, { fontSize: 30, bold: true, color: '#FFFFFF', alignment: 'center' });
    addText(slide, 'gradient-radial-label', 'RADIAL', { left: 785, top: 325, width: 200, height: 58 }, { fontSize: 28, bold: true, color: NAVY, alignment: 'center' });
    setNotes(slide);
  }

  // 9. Two objects patched into a native group after export.
  {
    const slide = deck.slides.add(); addChrome(slide, 9, 'Grouped shapes move as one object', 'The exported slide is patched into a true p:grpSp container.');
    const a = slide.shapes.add({ geometry: 'roundRect', name: 'GROUP_A', position: { left: 230, top: 230, width: 340, height: 220 }, fill: '#EAF4FB', line: { style: 'solid', fill: BLUE, width: 3 }, borderRadius: 24 });
    a.text = 'GROUP A'; a.text.style = { typeface: 'Aptos', fontSize: 30, bold: true, color: NAVY, alignment: 'center', verticalAlignment: 'middle' };
    const b = slide.shapes.add({ geometry: 'rightArrow', name: 'GROUP_B', position: { left: 550, top: 280, width: 410, height: 120 }, fill: CYAN, line: { style: 'solid', fill: '#287FA8', width: 2 } });
    b.text = 'GROUP B'; b.text.style = { typeface: 'Aptos', fontSize: 28, bold: true, color: '#FFFFFF', alignment: 'center', verticalAlignment: 'middle' };
    addCaption(slide, 'Feature evidence: p:grpSp / EDITABLE_GROUP_REBUILD');
    setNotes(slide);
  }

  // 10. Poster frame patched into a native video relationship after export.
  {
    const slide = deck.slides.add(); addChrome(slide, 10, 'Media poster frame remains visible', 'A project-owned poster image is paired with a native video/media relationship.');
    slide.images.add({ svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 480"><defs><linearGradient id="m" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#17324D"/><stop offset="1" stop-color="#2E74B5"/></linearGradient></defs><rect width="960" height="480" rx="24" fill="url(#m)"/><circle cx="480" cy="240" r="82" fill="white" opacity=".92"/><path d="M454 188 L454 292 L544 240 Z" fill="#2E74B5"/><text x="480" y="410" text-anchor="middle" font-family="Arial" font-size="27" fill="white">PROJECT-OWNED POSTER FRAME</text></svg>`, alt: 'Project-owned media poster frame', fit: 'contain', position: { left: 180, top: 188, width: 880, height: 390 } }).name = 'MEDIA_POSTER_FRAME_TEST';
    addCaption(slide, 'Poster frame is the truth shown before playback; media bytes are an inert fixture placeholder.');
    setNotes(slide);
  }

  // 11. Missing font substitution.
  {
    const slide = deck.slides.add(); addChrome(slide, 11, 'Missing font substitution must not lose text', 'The typeface is intentionally absent from the host.');
    addText(slide, 'missing-font-test', 'MISSING FONT\nSUBSTITUTION', { left: 150, top: 220, width: 980, height: 180 }, { fontSize: 52, bold: true, color: NAVY, alignment: 'center', verticalAlignment: 'middle', typeface: 'SuperWagieMissingFont-927' });
    addText(slide, 'missing-font-body', 'Readable fallback is expected; the original typeface name remains in the PPTX for audit.', { left: 220, top: 430, width: 840, height: 72 }, { fontSize: 20, color: MUTED, alignment: 'center', typeface: 'SuperWagieMissingFont-927' });
    setNotes(slide);
  }

  // 12. Rebuilt object.
  {
    const slide = deck.slides.add(); addChrome(slide, 12, 'A rebuilt object keeps semantic identity', 'The replacement is native, named, and separately editable.');
    slide.shapes.add({ geometry: 'roundRect', name: 'REBUILD_SOURCE_GHOST', position: { left: 120, top: 220, width: 390, height: 250 }, fill: '#94A3B8/16', line: { style: 'dashed', fill: '#94A3B8', width: 2 }, borderRadius: 22 });
    const rebuilt = slide.shapes.add({ geometry: 'roundRect', name: 'REBUILT_OBJECT', position: { left: 690, top: 220, width: 390, height: 250 }, fill: { type: 'gradient', gradientKind: 'linear', angleDeg: 0, stops: [{ offset: 0, color: '#2E74B5' }, { offset: 100000, color: '#70C1E4' }] }, line: { style: 'solid', fill: '#17324D', width: 2 }, borderRadius: 22, shadow: 'shadow-md' });
    rebuilt.text = 'REBUILT\nOBJECT'; rebuilt.text.style = { typeface: 'Aptos', fontSize: 34, bold: true, color: '#FFFFFF', alignment: 'center', verticalAlignment: 'middle' };
    slide.shapes.add({ geometry: 'rightArrow', name: 'rebuild-arrow', position: { left: 535, top: 310, width: 130, height: 70 }, fill: '#4DA3D9', line: { style: 'solid', fill: 'none', width: 0 } });
    setNotes(slide);
  }

  // 13. Line chart.
  {
    const slide = deck.slides.add(); addChrome(slide, 13, 'Revisions change without breaking the trend', 'A second chart varies category and series wiring.');
    slide.charts.add('line', { position: { left: 130, top: 190, width: 1000, height: 380 }, categories: ['r1', 'r2', 'r3', 'r4', 'r5'], series: [{ name: 'Relocation confidence', values: [62, 72, 79, 88, 94], line: { style: 'solid', fill: '#0F766E', width: 4 }, marker: { symbol: 'circle', size: 10 } }, { name: 'Fallback usage', values: [38, 28, 21, 12, 6], line: { style: 'dashed', fill: '#E07A5F', width: 3 }, marker: { symbol: 'diamond', size: 9 } }], legend: { position: 'bottom', overlay: false, textStyle: { fontSize: 15, fill: TEXT } }, yAxis: { min: 0, max: 100, majorUnit: 20, majorGridlines: { style: 'solid', fill: '#DCE5ED', width: 1 } }, dataLabels: { showValue: false }, chartFill: 'white', chartLine: { style: 'solid', fill: '#D6E1EA', width: 1 } });
    setNotes(slide);
  }

  // 14. Merged native table.
  {
    const slide = deck.slides.add(); addChrome(slide, 14, 'Merged cells exercise table reconstruction', 'The spanning title row and banded body remain native.');
    const table = slide.tables.add({ rows: 5, columns: 3, left: 170, top: 190, width: 920, height: 350, values: [['Reviewer cache contract', '', ''], ['Input', 'Required key', 'Failure if absent'], ['Artifact', 'SHA-256', 'Stale preview'], ['Renderer', 'Version + fonts', 'Visual drift'], ['Parameters', 'Page/slide options', 'Wrong output']] });
    table.merge({ startRow: 0, endRow: 0, startColumn: 0, endColumn: 2 });
    table.getCell(0, 0).fill = NAVY; table.getCell(0, 0).text.style = { fontSize: 24, bold: true, color: '#FFFFFF', alignment: 'center', verticalAlignment: 'middle' };
    for (let c = 0; c < 3; c++) { table.getCell(1, c).fill = '#DCEAF4'; table.getCell(1, c).text.style = { fontSize: 17, bold: true, color: NAVY, alignment: 'center', verticalAlignment: 'middle' }; }
    for (let r = 2; r < 5; r++) for (let c = 0; c < 3; c++) table.getCell(r, c).text.style = { fontSize: 16, color: TEXT, alignment: c === 2 ? 'left' : 'center', verticalAlignment: 'middle' };
    table.borders.assign({ style: 'solid', fill: '#B8C9D6', width: 1 });
    setNotes(slide);
  }

  // 15. Image crop and mask.
  {
    const slide = deck.slides.add(); addChrome(slide, 15, 'Image crop and mask stay deterministic', 'The same project-owned SVG uses cover fit and a rounded mask.');
    slide.images.add({ svg: patternSvg(15, 'cropped cover image', '#7C3AED'), alt: 'Cropped fixture image', fit: 'cover', crop: { left: 0.12, top: 0.08, right: 0.18, bottom: 0.05 }, geometry: 'roundRect', borderRadius: 28, position: { left: 150, top: 190, width: 980, height: 390 } });
    setNotes(slide);
  }

  // 16. Chinese and Latin editable text.
  {
    const slide = deck.slides.add(); addChrome(slide, 16, 'Mixed-script text remains editable', 'Chinese, Latin, numerals, and symbols share one slide.');
    const cjk = addText(slide, 'mixed-script-test', '', { left: 145, top: 220, width: 990, height: 220 }, { fontSize: 38, bold: true, color: NAVY, alignment: 'center', verticalAlignment: 'middle' });
    cjk.text.set([[{ run: '超级牛马审阅视图', textStyle: { typeface: 'Arial Unicode MS', fontSize: '38pt', bold: true, color: NAVY } }], [{ run: 'Office Reviewer / Revision 16 / Ω', textStyle: { typeface: 'Aptos', fontSize: '28pt', color: BLUE } }]]);
    addText(slide, 'mixed-script-note', 'Text extraction and real-WPS rendering must preserve every semantic token.', { left: 220, top: 470, width: 840, height: 60 }, { fontSize: 19, color: MUTED, alignment: 'center' });
    setNotes(slide);
  }

  // 17. Connectors and simple diagram.
  {
    const slide = deck.slides.add(); addChrome(slide, 17, 'Connectors stay behind their nodes', 'A simple native diagram tests z-order and routing.');
    const left = slide.shapes.add({ geometry: 'roundRect', name: 'node-artifact', position: { left: 170, top: 270, width: 260, height: 150 }, fill: '#EAF4FB', line: { style: 'solid', fill: BLUE, width: 2 }, borderRadius: 20 });
    const right = slide.shapes.add({ geometry: 'roundRect', name: 'node-preview', position: { left: 830, top: 270, width: 260, height: 150 }, fill: '#E8F4F1', line: { style: 'solid', fill: '#0F766E', width: 2 }, borderRadius: 20 });
    slide.shapes.connect(left, right, { kind: 'elbow', fromSide: 'right', toSide: 'left', line: { style: 'solid', fill: '#52677B', width: 3 }, head: { type: 'triangle', width: 'med', length: 'med' } });
    left.text = 'ARTIFACT\nREVISION'; left.text.style = { fontSize: 25, bold: true, color: NAVY, alignment: 'center', verticalAlignment: 'middle' };
    right.text = 'PREVIEW\nREVISION'; right.text.style = { fontSize: 25, bold: true, color: '#0F5B51', alignment: 'center', verticalAlignment: 'middle' };
    addText(slide, 'connector-label', 'hash + renderer + font environment + parameters', { left: 440, top: 290, width: 380, height: 90 }, { fontSize: 18, color: MUTED, alignment: 'center', verticalAlignment: 'middle' });
    setNotes(slide);
  }

  // 18. Layered transparency over SVG.
  {
    const slide = deck.slides.add();
    slide.images.add({ svg: patternSvg(18, 'layered transparency on image', '#D97706'), alt: 'Layered transparency image', fit: 'cover', position: { left: 0, top: 0, width: W, height: H } });
    slide.shapes.add({ geometry: 'rect', name: 'layered-dark-overlay', position: { left: 0, top: 0, width: W, height: H }, fill: '#0F172A/52', line: { style: 'solid', fill: 'none', width: 0 } });
    addText(slide, 'layered-title', 'Transparency over media', { left: 120, top: 230, width: 1040, height: 100 }, { fontSize: 48, bold: true, color: '#FFFFFF', alignment: 'center' });
    addText(slide, 'layered-body', 'Image + alpha overlay + editable text', { left: 220, top: 350, width: 840, height: 62 }, { fontSize: 24, color: '#E6F2FA', alignment: 'center' });
    setNotes(slide);
  }

  // 19. Feature ledger.
  {
    const slide = deck.slides.add(); addChrome(slide, 19, 'The feature ledger makes evidence auditable', 'Each required structure has a named native object or package signature.');
    const items = [['Images', 'slides 2, 3, 15, 18'], ['SVG', 'slide 4'], ['Chart', 'slides 5, 13'], ['Table', 'slides 6, 14'], ['Alpha + gradient', 'slides 7, 8'], ['Group + rebuild', 'slides 9, 12'], ['Poster frame', 'slide 10'], ['Missing font', 'slide 11']];
    for (let i = 0; i < items.length; i++) {
      const col = i % 2, row = Math.floor(i / 2);
      const left = 120 + col * 540, top = 188 + row * 102;
      slide.shapes.add({ geometry: 'roundRect', name: `ledger-${i}`, position: { left, top, width: 480, height: 78 }, fill: i % 2 ? '#E8F4F1' : '#EAF4FB', line: { style: 'solid', fill: i % 2 ? '#A5D2C9' : '#B7D7EA', width: 1 }, borderRadius: 16 });
      addText(slide, `ledger-label-${i}`, items[i][0], { left: left + 18, top: top + 13, width: 170, height: 50 }, { fontSize: 20, bold: true, color: NAVY });
      addText(slide, `ledger-value-${i}`, items[i][1], { left: left + 175, top: top + 14, width: 280, height: 48 }, { fontSize: 18, color: MUTED, alignment: 'right' });
    }
    setNotes(slide);
  }

  // 20. Close.
  {
    const slide = deck.slides.add();
    slide.background.fill = NAVY;
    addText(slide, 'final-title', '20 slides complete', { left: 140, top: 190, width: 1000, height: 110 }, { fontSize: 54, bold: true, color: '#FFFFFF', alignment: 'center' });
    addText(slide, 'final-body', 'Every slide is project-owned and intended for structural + visual torture testing before real-WPS Reviewer validation.', { left: 235, top: 340, width: 810, height: 110 }, { fontSize: 22, color: '#D9EAF4', alignment: 'center' });
    addText(slide, 'final-marker', 'END OF FIXTURE', { left: 465, top: 530, width: 350, height: 52 }, { fontSize: 20, bold: true, color: '#78C7E8', alignment: 'center' });
    setNotes(slide);
  }

  if (deck.slides.items.length !== 20) throw new Error(`expected 20 slides, got ${deck.slides.items.length}`);
  if (options.renderPreview) {
    for (const [index, slide] of deck.slides.items.entries()) {
      const stem = `slide-${String(index + 1).padStart(2, '0')}`;
      await writeBlob(path.join(PREVIEW_DIR, `${stem}.png`), await deck.export({ slide, format: 'png', scale: 1 }));
      const layout = await slide.export({ format: 'layout' });
      await fs.writeFile(path.join(PREVIEW_DIR, `${stem}.layout.json`), await layout.text());
    }
    await writeBlob(path.join(PREVIEW_DIR, 'montage.webp'), await deck.export({ format: 'webp', montage: true, scale: 1 }));
  }
  const inspect = await deck.inspect({ kind: 'slide,textbox,shape,image,table,chart,notes', maxChars: 120000 });
  await fs.writeFile(path.join(WORK_DIR, 'pptx-inspect.ndjson'), inspect.ndjson ?? String(inspect));
  const pptx = await PresentationFile.exportPptx(deck);
  await pptx.save(FINAL);
}

function minimalMp4Bytes() {
  const ftypPayload = Buffer.from('69736f6d0000020069736f6d69736f326d703431', 'hex');
  const ftypSize = Buffer.alloc(4); ftypSize.writeUInt32BE(ftypPayload.length + 8);
  const mdat = Buffer.from('000000086d646174', 'hex');
  return Buffer.concat([ftypSize, Buffer.from('66747970', 'hex'), ftypPayload, mdat]);
}

function findNamedBlock(xml, tag, name) {
  const re = new RegExp(`<p:${tag}>[\\s\\S]*?<p:cNvPr\\b[^>]*\\bname="${name}"[^>]*>[\\s\\S]*?<\\/p:${tag}>|<p:${tag}>[\\s\\S]*?<p:cNvPr\\b[^>]*\\bname="${name}"[^>]*/>[\\s\\S]*?<\\/p:${tag}>`);
  const match = xml.match(re);
  if (!match) throw new Error(`missing ${tag} named ${name}`);
  return match[0];
}

async function patchNativeFeatures() {
  const bytes = await fs.readFile(FINAL);
  const zip = await JSZip.loadAsync(bytes);

  // True group on slide 9: use full-slide child coordinates to preserve rendering.
  let slide9 = await zip.file('ppt/slides/slide9.xml').async('string');
  const groupA = findNamedBlock(slide9, 'sp', 'GROUP_A');
  const groupB = findNamedBlock(slide9, 'sp', 'GROUP_B');
  slide9 = slide9.replace(groupA, '').replace(groupB, '');
  const groupXml = `<p:grpSp xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:nvGrpSpPr><p:cNvPr id="9001" name="EDITABLE_GROUP_REBUILD"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="12192000" cy="6858000"/><a:chOff x="0" y="0"/><a:chExt cx="12192000" cy="6858000"/></a:xfrm></p:grpSpPr>${groupA}${groupB}</p:grpSp>`;
  slide9 = slide9.replace('</p:spTree>', `${groupXml}</p:spTree>`);
  zip.file('ppt/slides/slide9.xml', slide9);

  // Native media/poster relationship on slide 10.
  let slide10 = await zip.file('ppt/slides/slide10.xml').async('string');
  const poster = findNamedBlock(slide10, 'pic', 'MEDIA_POSTER_FRAME_TEST');
  const mediaNvPr = '<p:nvPr><a:videoFile xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:link="rId900"/><p:extLst><p:ext uri="{DAA4B4D4-6D71-4841-9C3D-6A8B3A9C9F6F}"><p14:media xmlns:p14="http://schemas.microsoft.com/office/powerpoint/2010/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="rId901"/></p:ext></p:extLst></p:nvPr>';
  const patchedPoster = poster.includes('<p:nvPr />')
    ? poster.replace('<p:nvPr />', mediaNvPr)
    : poster.replace('<p:nvPr>', mediaNvPr.replace('</p:nvPr>', ''));
  slide10 = slide10.replace(poster, patchedPoster);
  zip.file('ppt/slides/slide10.xml', slide10);
  let rels10 = await zip.file('ppt/slides/_rels/slide10.xml.rels').async('string');
  rels10 = rels10.replace('</Relationships>', '<Relationship Id="rId900" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/video" Target="../media/reviewer-poster-test.mp4"/><Relationship Id="rId901" Type="http://schemas.microsoft.com/office/2007/relationships/media" Target="../media/reviewer-poster-test.mp4"/></Relationships>');
  zip.file('ppt/slides/_rels/slide10.xml.rels', rels10);
  let types = await zip.file('[Content_Types].xml').async('string');
  if (!types.includes('Extension="mp4"')) types = types.replace('</Types>', '<Default Extension="mp4" ContentType="video/mp4"/></Types>');
  zip.file('[Content_Types].xml', types);
  zip.file('ppt/media/reviewer-poster-test.mp4', minimalMp4Bytes());

  const finalBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  await fs.writeFile(FINAL, finalBytes);
}

await buildDeck();
await patchNativeFeatures();
console.log(FINAL);
