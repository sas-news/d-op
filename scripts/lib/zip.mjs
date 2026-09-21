import { deflateRawSync, inflateRawSync } from "node:zlib"

// Task-25 deterministic ZIP reader/writer (no dependencies).
//
// Writer emits entries sorted by name with zeroed DOS timestamps so identical
// input always produces identical bytes (same contract as WXT's zero-zip).
// Reader supports stored (0) and deflated (8) entries, which covers every
// archive produced by this repo's tooling.
//
// Entry names are normalized to forward slashes; the logical content of an
// archive is the sorted name→bytes map, so comparisons ignore timestamps and
// entry ordering entirely.

const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let crc = 0xffffffff
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

function toBuffer(content) {
  if (Buffer.isBuffer(content)) return content
  if (content instanceof Uint8Array)
    return Buffer.from(content.buffer, content.byteOffset, content.byteLength)
  return Buffer.from(String(content), "utf-8")
}

/**
 * Create a deterministic ZIP archive.
 * @param {Array<[string, (string|Buffer|Uint8Array)]>|Map<string,(string|Buffer|Uint8Array)>|Object<string,(string|Buffer|Uint8Array)>} entries
 * @returns {Buffer} archive bytes
 */
export function writeZip(entries) {
  const items = (
    entries instanceof Map
      ? [...entries.entries()]
      : Array.isArray(entries)
        ? entries
        : Object.entries(entries)
  )
    .map(([name, content]) => [name.replaceAll("\\", "/").replace(/^\/+/, ""), toBuffer(content)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, raw] of items) {
    const nameBytes = Buffer.from(name, "utf-8")
    const deflated = deflateRawSync(raw, { level: 9 })
    const useStore = deflated.length >= raw.length
    const payload = useStore ? raw : deflated
    const method = useStore ? 0 : 8
    const crc = crc32(raw)
    const utf8Flag = [...name].some((c) => c.charCodeAt(0) > 0x7f) ? 0x0800 : 0

    const local = Buffer.alloc(30 + nameBytes.length)
    local.writeUInt32LE(LOCAL_SIG, 0)
    local.writeUInt16LE(20, 4) // version needed
    local.writeUInt16LE(utf8Flag, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // mod time — zeroed for reproducibility
    local.writeUInt16LE(0, 12) // mod date — zeroed for reproducibility
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra length
    nameBytes.copy(local, 30)

    const central = Buffer.alloc(46 + nameBytes.length)
    central.writeUInt32LE(CENTRAL_SIG, 0)
    central.writeUInt16LE(20, 4) // version made by
    central.writeUInt16LE(20, 6) // version needed
    central.writeUInt16LE(utf8Flag, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12) // mod time
    central.writeUInt16LE(0, 14) // mod date
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    nameBytes.copy(central, 46)

    locals.push(local, payload)
    centrals.push(central)
    offset += local.length + payload.length
  }

  const centralSize = centrals.reduce((sum, c) => sum + c.length, 0)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  eocd.writeUInt16LE(items.length, 8)
  eocd.writeUInt16LE(items.length, 10)
  eocd.writeUInt32LE(centralSize, 12)
  eocd.writeUInt32LE(offset, 16)

  return Buffer.concat([...locals, ...centrals, eocd])
}

/**
 * Read a ZIP archive into a name→Buffer map.
 * @param {Buffer|Uint8Array} bytes
 * @returns {Map<string, Buffer>}
 */
export function readZip(bytes) {
  const buf = Buffer.isBuffer(bytes)
    ? bytes
    : Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  // EOCD sits within the last 64KiB + 22 bytes; scan backwards for the signature.
  const min = Math.max(0, buf.length - 22 - 0xffff)
  let eocd = -1
  for (let i = buf.length - 22; i >= min; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("not a zip archive (EOCD not found)")
  const count = buf.readUInt16LE(eocd + 10)
  let pos = buf.readUInt32LE(eocd + 16)

  const entries = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== CENTRAL_SIG) throw new Error(`bad central directory at ${pos}`)
    const method = buf.readUInt16LE(pos + 10)
    const compressedSize = buf.readUInt32LE(pos + 20)
    const nameLen = buf.readUInt16LE(pos + 28)
    const extraLen = buf.readUInt16LE(pos + 30)
    const commentLen = buf.readUInt16LE(pos + 32)
    const localOffset = buf.readUInt32LE(pos + 42)
    const name = buf.subarray(pos + 46, pos + 46 + nameLen).toString("utf-8")

    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new Error(`bad local header for ${name}`)
    const localNameLen = buf.readUInt16LE(localOffset + 26)
    const localExtraLen = buf.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const payload = buf.subarray(dataStart, dataStart + compressedSize)
    let content
    if (method === 0) content = Buffer.from(payload)
    else if (method === 8) content = inflateRawSync(payload)
    else throw new Error(`unsupported compression method ${method} for ${name}`)
    entries.set(name, content)

    pos += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * Logical fingerprint of an archive: sorted "sha256(name bytes)  sha256(content)  name"
 * lines. Comparing fingerprints ignores timestamps, entry order, and compression.
 * @param {Map<string, Buffer>} entries
 * @param {(data: Buffer) => string} sha256
 * @returns {string}
 */
export function logicalDigest(entries, sha256) {
  return [...entries.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, content]) => `${sha256(content)}  ${name}`)
    .join("\n")
}
