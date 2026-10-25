import { inflateSync } from 'node:zlib';

export const posterName = /^\d{4}-\d{2}-\d{2}-(?:\d{4}-)?p[1-9]\d*\.png$/;

// Reject HTML, truncated PNGs and invalid compressed image data before archiving.
export function validatePng(bytes) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw new Error('非 PNG 签名');
  let offset = 8, header = false, end = false;
  const data = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    if (offset + length + 12 > bytes.length) throw new Error('PNG 数据截断');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (!header && type !== 'IHDR') throw new Error('PNG 缺少 IHDR');
    if (type === 'IHDR') {
      if (header || length !== 13 || !bytes.readUInt32BE(offset + 8) || !bytes.readUInt32BE(offset + 12)) throw new Error('PNG IHDR 非法');
      header = true;
    }
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (type === 'IEND') { end = length === 0; break; }
  }
  if (!header || !end || offset !== bytes.length || !data.length) throw new Error('PNG 结构不完整');
  if (!inflateSync(Buffer.concat(data)).length) throw new Error('PNG 图像数据为空');
  return true;
}
