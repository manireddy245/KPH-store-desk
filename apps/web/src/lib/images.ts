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

async function shrink(file: File): Promise<Blob> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 1_500_000 && file.type === 'image/jpeg') return file;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', 0.85));
}

async function blobToBase64(b: Blob): Promise<string> {
  const buf = new Uint8Array(await b.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}
