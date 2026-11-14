import { sniffDocument } from './documents.ts';

const blob = (bytes: number[] | string, type = 'application/octet-stream') =>
  new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type });

describe('sniffDocument', () => {
  it('recognises images and PDFs by content, not by the declared type', async () => {
    await expect(sniffDocument(blob([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).resolves.toEqual({ kind: 'image', type: 'image/png' });
    await expect(sniffDocument(blob([0xff, 0xd8, 0xff, 0xe0]))).resolves.toEqual({ kind: 'image', type: 'image/jpeg' });
    await expect(sniffDocument(blob('GIF89a....'))).resolves.toEqual({ kind: 'image', type: 'image/gif' });
    await expect(sniffDocument(blob('RIFF\0\0\0\0WEBPVP8 '))).resolves.toEqual({ kind: 'image', type: 'image/webp' });
    await expect(sniffDocument(blob('%PDF-1.7\n', 'text/plain'))).resolves.toEqual({ kind: 'pdf', type: 'application/pdf' });
  });

  it('never renders anything else, even when the server calls it an image or HTML', async () => {
    const other = { kind: 'other', type: 'application/octet-stream' };
    await expect(sniffDocument(blob('<html><script>alert(1)</script>', 'text/html'))).resolves.toEqual(other);
    await expect(sniffDocument(blob('<svg onload="alert(1)"/>', 'image/svg+xml'))).resolves.toEqual(other);
    await expect(sniffDocument(blob('not really a png', 'image/png'))).resolves.toEqual(other);
    await expect(sniffDocument(blob(''))).resolves.toEqual(other);
  });
});
