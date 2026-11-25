import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';

const absolutePath = z.string().refine((value) => (path.posix.isAbsolute(value) || /^[A-Za-z]:[\\/]|^\\\\/.test(value))
  && !/[<>\p{Cc}]/u.test(value));
const kernelPaths = z.object({ paths: z.object({ tmp: absolutePath }) });
const catalog = z.object({ data: z.array(z.object({
  providerID: z.string(),
  modelID: z.string(),
  capabilities: z.object({ input: z.array(z.string()) }).optional(),
})) });

const inlineMime = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf']);
const inlineImages = /\.(png|jpe?g|gif|webp)$/i;
const nonInlineFile = /\.(7z|aac|avif|avi|bin|bmp|docx?|epub|flac|gz|heic|heif|m4a|m4v|mkv|mov|mp[34]|mpeg|mpg|odp|ods|odt|ogg|opus|pptx?|rar|tar|tiff?|wav|webm|wma|xls[xm]?|zip)$/i;
const copyParameter = ';x-openchamber-save-copy=1';
const fileList = z.array(z.object({ uri: z.string(), name: z.string().optional() }).passthrough());

const mimeOf = (uri) => /^data:([^;,]+)/i.exec(uri)?.[1]?.trim().toLowerCase();
const modalityOf = ({ uri, name }) => {
  if (uri.startsWith('file:')) {
    if (/\.pdf$/i.test(name ?? '')) return 'pdf';
    if (inlineImages.test(name ?? '')) return 'image';
    return nonInlineFile.test(name ?? '') ? null : 'text';
  }
  const mime = mimeOf(uri);
  if (mime?.startsWith('text/')) return 'text';
  if (mime && inlineMime.has(mime)) return mime === 'application/pdf' ? 'pdf' : 'image';
  return uri.startsWith('data:') ? null : undefined;
};

export const prepareAttachmentDelivery = async (client, model, files, inputModalities) => {
  const parts = files.map((file) => {
    const comma = file.uri.indexOf(',');
    const saveCopy = file.saveCopy || (file.uri.startsWith('data:image/') && comma >= 0 && file.uri.slice(0, comma).includes(copyParameter));
    const uri = saveCopy && comma >= 0 ? file.uri.slice(0, comma).replace(copyParameter, '') + file.uri.slice(comma) : file.uri;
    return { file, uri, saveCopy, modality: modalityOf({ ...file, uri }) };
  });
  let modalities = inputModalities;
  if (!modalities && model?.providerID && model?.id && parts.some(({ modality }) => modality === 'image' || modality === 'pdf')) {
    const response = await client.model.list({}, { signal: AbortSignal.timeout(5_000) }).catch(() => null);
    const models = catalog.safeParse(response).data?.data;
    modalities = models?.find((entry) => entry.providerID === model.providerID && entry.modelID === model.id)?.capabilities?.input;
  }
  const supported = modalities && new Set(modalities.map((value) => value.trim().toLowerCase()));

  const links = [];
  const inline = [];
  let folder;
  for (const { file, uri, modality, saveCopy } of parts) {
    const pathOnly = modality === null || (modality !== undefined && (supported
      ? !supported.has(modality) : file.deliverAsPath === true));
    if (!pathOnly) {
      const { deliverAsPath: _legacy, saveCopy: _copy, ...wire } = file;
      inline.push({ ...wire, uri });
    }
    if (!pathOnly && !saveCopy) continue;

    const index = links.length + 1;
    const name = path.win32.basename(file.name ?? '').replace(/[<>:"|?*\[\]\\\p{Cc}]/gu, '-').trim().replace(/[. ]+$/, '');
    let target;
    if (uri.startsWith('file:')) {
      const url = new URL(uri);
      const pathname = decodeURIComponent(url.pathname);
      target = url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}${pathname}`
        : /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname;
    } else {
      const comma = uri.indexOf(',');
      if (!uri.startsWith('data:') || comma < 0) throw new Error('Attachment bytes are unavailable');
      const data = uri.slice(comma + 1);
      const bytes = uri.slice(0, comma).toLowerCase().endsWith(';base64')
        ? Buffer.from(atob(data), 'latin1') : Buffer.from(decodeURIComponent(data));
      if (bytes.length === 0 && modality !== 'text') throw new Error('Attachment bytes are unavailable');
      if (!folder) {
        const info = kernelPaths.parse(await client.server.info());
        folder = `${info.paths.tmp.replace(/[\\/]+$/, '')}/openchamber/${randomBytes(8).toString('hex')}`;
      }
      const legacyExtension = /^data:image\/([a-z\d-]+)(?=[+;,])/i.exec(uri)?.[1] ?? 'bin';
      const filename = file.deliverAsPath ? `image-${index}.${legacyExtension}` : `${index}-${name || 'attachment'}`;
      const destination = `${folder}/${filename}`;
      const written = await client.experimental.file.write({ path: destination, payload: bytes });
      target = absolutePath.parse(written.data?.path);
      if (target.replaceAll('\\', '/') !== destination.replaceAll('\\', '/')) throw new Error('OpenCode did not confirm the requested attachment path');
    }
    const confirmed = absolutePath.parse(target).replaceAll('\\', '/');
    links.push(`[${name || 'attachment'}](<${confirmed}>)`);
  }
  return {
    files: inline,
    text: (original) => [original, links.join(' ')].filter(Boolean).join('\n\n'),
  };
};

export class AttachmentDeliveryError extends Error {
  constructor() {
    super('Could not prepare attachment paths.');
  }
}

export const prepareRoutedAttachments = async (client, model, body, inputModalities) => {
  const files = fileList.safeParse(body?.files).data;
  if (!files?.length) return;
  let delivery;
  try {
    delivery = await prepareAttachmentDelivery(client, model, files, inputModalities);
  } catch {
    throw new AttachmentDeliveryError();
  }
  const text = typeof body.text === 'string' ? body.text : '';
  const rendered = delivery.text(text);
  if (rendered !== text) body.text = rendered;
  if (delivery.files.length > 0) body.files = delivery.files;
  else delete body.files;
};
