/**
 * Phone photos are often 4–12 MB. Before sending a bill to the scanner we shrink
 * photos to at most ~2200 px on the long side (still sharp enough to read small
 * print) and re-save as JPEG. PDFs and formats the browser can't draw (HEIC on
 * some phones) are sent as they are.
 */
const MAX_EDGE = 2200;

export interface PreparedPage {
  mimeType: string;
  base64: string;
  previewUrl: string;
  name: string;
  sizeBytes: number;
}

export async function preparePage(file: File): Promise<PreparedPage> {
  const type = file.type || (file.name.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/jpeg');
  if (type.startsWith('image/') && !/heic|heif/.test(type)) {
    try {
      const blob = await shrink(file);
      return { mimeType: 'image/jpeg', base64: await blobToBase64(blob), previewUrl: URL.createObjectURL(blob), name: file.name, sizeBytes: blob.size };
    } catch {
      /* fall back to the original file */
    }
  }
  return { mimeType: type, base64: await blobToBase64(file), previewUrl: URL.createObjectURL(file), name: file.name, sizeBytes: file.size };
}

/** Each photo is kept under ~0.9 MB, so a 15-page bill still fits in one scanner request (~20 MB). */
const MAX_PHOTO_BYTES = 900_000;

async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  if (file.size <= MAX_PHOTO_BYTES && file.type === 'image/jpeg' && Math.max(bitmap.width, bitmap.height) <= MAX_EDGE) return file;
  // try a little smaller / a little more compressed until it fits (small print stays readable)
  let blob: Blob | null = null;
  for (const [edge, quality] of [[MAX_EDGE, 0.85], [MAX_EDGE, 0.75], [1900, 0.72], [1700, 0.68]] as const) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', quality));
    if (blob.size <= MAX_PHOTO_BYTES) break;
  }
  return blob!;
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
