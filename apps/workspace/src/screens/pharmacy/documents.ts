export type DocumentKind = 'image' | 'pdf' | 'other';

/**
 * Decides how a prescription file may be shown from its first bytes, ignoring the server's content type (the file
 * route may answer `application/octet-stream`, and an uploaded file's name says nothing). Only these image formats
 * and PDF are rendered in the page; everything else is offered as a download with a neutral type, so no uploaded
 * HTML or SVG can ever run in the workspace's origin.
 */
export async function sniffDocument(blob: Blob): Promise<{ kind: DocumentKind; type: string }> {
  const b = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  const starts = (...bytes: number[]) => bytes.every((v, i) => b[i] === v);
  const ascii = (from: number, text: string) => [...text].every((ch, i) => b[from + i] === ch.charCodeAt(0));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return { kind: 'image', type: 'image/png' };
  if (starts(0xff, 0xd8, 0xff)) return { kind: 'image', type: 'image/jpeg' };
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return { kind: 'image', type: 'image/gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', type: 'image/webp' };
  if (ascii(0, '%PDF-')) return { kind: 'pdf', type: 'application/pdf' };
  return { kind: 'other', type: 'application/octet-stream' };
}
