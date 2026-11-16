import { sniffFile } from './files.tsx';

const blob = (bytes: number[] | string, type = 'application/octet-stream') =>
  new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)], { type });

describe('private files open by content, not by the server’s type', () => {
  it('recognises PDF and images', async () => {
    await expect(sniffFile(blob('%PDF-1.7\n', 'text/html'))).resolves.toEqual({ kind: 'pdf', type: 'application/pdf' });
    await expect(sniffFile(blob([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).resolves.toEqual({ kind: 'image', type: 'image/png' });
  });
  it('offers anything else only as a neutral download', async () => {
    const other = { kind: 'other', type: 'application/octet-stream' };
    await expect(sniffFile(blob('<html><script>alert(1)</script>', 'application/pdf'))).resolves.toEqual(other);
    await expect(sniffFile(blob('<svg onload="alert(1)"/>', 'image/svg+xml'))).resolves.toEqual(other);
  });
});
