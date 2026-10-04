// ZIP ファイルの作成（無圧縮。写真・動画はすでに圧縮されているため圧縮しない）
// 依存ライブラリなし。ブラウザと Node.js（テスト）の両方で動く

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2));
  const date = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

const enc = new TextEncoder();
const MAX_ZIP_BYTES = 0xffffffff - 1024 * 1024; // ZIP64 には対応しない（約 4GB まで）

async function toBytes(data) {
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(await data.arrayBuffer());
}

/**
 * files: [{ name: 'photos/a.jpg', data: Blob | Uint8Array | string, date?: Date }]
 * onProgress(done, total)
 * 戻り値: Blob（application/zip）
 */
export async function createZip(files, { onProgress } = {}) {
  if (files.length > 65000) throw new Error('too_many_files');
  const parts = [];
  const central = [];
  let offset = 0;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const name = enc.encode(f.name);
    const bytes = await toBytes(f.data);
    const crc = crc32(bytes);
    const { time, date } = dosDateTime(f.date || new Date());
    if (offset + bytes.length + 30 + name.length > MAX_ZIP_BYTES) throw new Error('too_large');

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // 展開に必要なバージョン
    local.setUint16(6, 0x0800, true); // ファイル名は UTF-8
    local.setUint16(8, 0, true); // 無圧縮
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, bytes.length, true);
    local.setUint32(22, bytes.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(local.buffer, name, f.data instanceof Blob ? f.data : bytes);

    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true);
    cd.setUint16(6, 20, true);
    cd.setUint16(8, 0x0800, true);
    cd.setUint16(10, 0, true);
    cd.setUint16(12, time, true);
    cd.setUint16(14, date, true);
    cd.setUint32(16, crc, true);
    cd.setUint32(20, bytes.length, true);
    cd.setUint32(24, bytes.length, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, name);

    offset += 30 + name.length + bytes.length;
    onProgress?.(i + 1, files.length);
  }
  const cdSize = central.reduce((n, p) => n + p.byteLength, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}

// ファイル名に使えない文字を置き換える
export function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 60) || 'untitled';
}
