import { createHash } from 'node:crypto';
import { lstat, mkdtemp, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

import PptxGenJS from 'pptxgenjs';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WIDE_WIDTH = 13.333;
const WIDE_HEIGHT = 7.5;
const MIN_FULL_SLIDE_WIDTH = 1920;
const MIN_FULL_SLIDE_HEIGHT = 1080;
const WIDE_ASPECT_RATIO = 16 / 9;
const ASPECT_RATIO_TOLERANCE = 0.005;

function jpegDimensions(bytes) {
  let offset = 2;
  const startOfFrameMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) continue;
    if (offset + 1 >= bytes.length) break;
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    if (startOfFrameMarkers.has(marker)) {
      return {
        width: bytes.readUInt16BE(offset + 5),
        height: bytes.readUInt16BE(offset + 3),
      };
    }
    offset += segmentLength;
  }
  throw new Error('JPEG dimensions are invalid');
}

function fullSlideDimensions(bytes, contentType) {
  const dimensions = contentType === 'image/png'
    ? { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) }
    : jpegDimensions(bytes);
  const aspectError = Math.abs((dimensions.width / dimensions.height) - WIDE_ASPECT_RATIO) / WIDE_ASPECT_RATIO;
  if (dimensions.width < MIN_FULL_SLIDE_WIDTH
      || dimensions.height < MIN_FULL_SLIDE_HEIGHT
      || aspectError > ASPECT_RATIO_TOLERANCE) {
    throw new Error('full-slide image must be at least 1920x1080 with a 16:9 aspect ratio');
  }
  return dimensions;
}

async function imageData(path) {
  if (!isAbsolute(path)) throw new Error('image path must be absolute');
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('image must be a regular non-symlink file');
  const bytes = await readFile(path);
  let contentType;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) contentType = 'image/png';
  else if (bytes[0] === 0xff && bytes[1] === 0xd8) contentType = 'image/jpeg';
  else throw new Error('only PNG and JPEG fixture images are supported');
  fullSlideDimensions(bytes, contentType);
  return `data:${contentType};base64,${bytes.toString('base64')}`;
}

function validateSpec(specification) {
  if (!specification || typeof specification !== 'object') throw new Error('presentation specification is required');
  if (!SAFE_ID.test(specification.presentation_id ?? '')) throw new Error('presentation_id is invalid');
  if (!Array.isArray(specification.slides) || specification.slides.length === 0) {
    throw new Error('presentation requires at least one slide');
  }
  const ids = new Set();
  for (const slide of specification.slides) {
    if (!SAFE_ID.test(slide.slide_id ?? '') || ids.has(slide.slide_id)) throw new Error('slide_id must be safe and unique');
    ids.add(slide.slide_id);
    if (slide.mode !== 'image' && slide.mode !== 'editable') throw new Error('unsupported slide mode');
    if (slide.mode === 'editable' && (!Array.isArray(slide.elements) || slide.elements.length === 0)) {
      throw new Error('editable slide requires elements');
    }
  }
}

export async function createPresentation(specification, output) {
  validateSpec(specification);
  if (!isAbsolute(output) || !output.endsWith('.pptx')) throw new Error('output must be an absolute PPTX path');
  const parent = dirname(output);
  const parentMetadata = await lstat(parent);
  if (!parentMetadata.isDirectory() || parentMetadata.isSymbolicLink()) throw new Error('output parent must be a regular directory');
  const canonicalParent = await realpath(parent);
  const stagingRoot = await mkdtemp(join(canonicalParent, '.superwagie-presentation-'));
  const staged = join(stagingRoot, 'deck.pptx');
  try {
    const presentation = new PptxGenJS();
    presentation.layout = 'LAYOUT_WIDE';
    presentation.author = 'SuperWagie PresentationService Spike';
    presentation.company = 'SuperWagie';
    presentation.subject = 'Owned OOXML adapter validation';
    presentation.title = specification.presentation_id;
    presentation.lang = 'zh-CN';
    presentation.theme = {
      headFontFace: 'Microsoft YaHei',
      bodyFontFace: 'Microsoft YaHei',
      lang: 'zh-CN',
    };

    for (const slideSpec of specification.slides) {
      const slide = presentation.addSlide();
      slide.background = { color: 'FFFFFF' };
      if (slideSpec.mode === 'image') {
        slide.addImage({
          data: await imageData(slideSpec.image_path),
          x: 0, y: 0, w: WIDE_WIDTH, h: WIDE_HEIGHT,
          objectName: slideSpec.slide_id,
          altText: slideSpec.alt_text,
        });
      } else {
        slide.addImage({
          data: await imageData(slideSpec.background_path),
          x: 0, y: 0, w: WIDE_WIDTH, h: WIDE_HEIGHT,
          objectName: `background-${slideSpec.slide_id}`,
          altText: `Background for ${slideSpec.slide_id}`,
        });
        for (const element of slideSpec.elements) {
          if (element.kind !== 'text' || !SAFE_ID.test(element.object_id ?? '')) {
            throw new Error('unsupported editable element');
          }
          slide.addText(element.text, {
            x: element.x, y: element.y, w: element.w, h: element.h,
            fontFace: 'Microsoft YaHei', fontSize: element.font_size_pt,
            color: element.color, bold: element.bold === true,
            margin: 0, breakLine: false, fit: 'shrink',
            objectName: element.object_id,
            altText: `Editable text ${element.object_id}`,
          });
        }
      }
      slide.addNotes(`[Sources]\n- local-fixture:${slideSpec.slide_id}`);
    }

    await presentation.writeFile({ fileName: staged, compression: true });
    const stagedBytes = await readFile(staged);
    await rename(staged, output);
    return {
      schema_id: 'superwagie.presentation-service-spike-result.v1',
      schema_version: 1,
      presentation_id: specification.presentation_id,
      slide_count: specification.slides.length,
      slide_modes: specification.slides.map(({ mode }) => mode),
      output_sha256: createHash('sha256').update(stagedBytes).digest('hex'),
      adapter: { name: 'pptxgenjs', version: '4.0.1', ownership: 'superwagie-owned-service' },
    };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}
