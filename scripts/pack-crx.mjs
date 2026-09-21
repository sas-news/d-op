#!/usr/bin/env node
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
} from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

// Task-25 optional CRX3 signer (`bun run pack:crx`).
//
// Chrome Web Store submissions use the unsigned zip (the store signs); a CRX
// is only needed for self-distribution. Signing is therefore strictly opt-in
// and IDENTITY-PRESERVING:
//
//   * `node scripts/pack-crx.mjs --key <private.pem>` signs
//     apps/extension/.output/d-op-<version>-chrome.zip into a sibling .crx
//     with THAT key. The derived extension id is printed so the operator can
//     confirm listing-identity continuity.
//   * `--expect-id <a…p>` additionally hard-fails when the key derives a
//     different id — a wrong key can never produce a "successful" release.
//   * The key path must exist and parse; this script NEVER generates a
//     replacement key in normal mode (a missing key is a loud failure, not a
//     new identity).
//   * `--self-test` is the only path that creates a key — an ephemeral one in
//     a fresh temp dir, labeled test-only — to prove the sign/parse/verify
//     round-trip without touching any real identity material.
//
// CRX3 layout: "Cr24" u32(3) u32(headerLen) header zip-bytes, where header is
// a protobuf CrxFileHeader{ sha256_with_rsa = Sha256WithRsaProof{ public_key
// (SPKI DER), signature }, signed_header_data = SignedData{ crx_id } }.
// signature = RSA/SHA-256 over "CRX3 SignedData\0" + u32le(len(shd)) + shd + zip.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const OUTPUT_DIR = path.join(ROOT, "apps/extension/.output")
const MAGIC = Buffer.from("Cr24")
const SIGN_PREFIX = Buffer.from("CRX3 SignedData\0", "latin1")

// --- minimal protobuf (length-delimited fields only) ------------------------
function pbField(fieldNo, bytes) {
  const tag = varint((fieldNo << 3) | 2)
  return Buffer.concat([tag, varint(bytes.length), bytes])
}
function varint(n) {
  const out = []
  let v = n
  do {
    let b = v & 0x7f
    v >>>= 7
    if (v > 0) b |= 0x80
    out.push(b)
  } while (v > 0)
  return Buffer.from(out)
}
function pbParse(buf) {
  const fields = []
  let pos = 0
  while (pos < buf.length) {
    const tag = readVarint(buf, pos)
    pos = tag.next
    const fieldNo = tag.value >>> 3
    const wire = tag.value & 7
    if (wire !== 2) throw new Error(`unsupported protobuf wire type ${wire} at field ${fieldNo}`)
    const len = readVarint(buf, pos)
    pos = len.next
    fields.push({ fieldNo, data: buf.subarray(pos, pos + len.value) })
    pos += len.value
  }
  return fields
}
function readVarint(buf, pos) {
  let value = 0
  let shift = 0
  let p = pos
  for (;;) {
    const b = buf[p++]
    value |= (b & 0x7f) << shift
    if ((b & 0x80) === 0) return { value, next: p }
    shift += 7
    if (shift > 35) throw new Error("varint overflow")
  }
}

function spkiDer(keyObject) {
  return createPublicKey(keyObject).export({ type: "spki", format: "der" })
}
function crxIdFromSpki(spki) {
  return createHash("sha256").update(spki).digest().subarray(0, 16)
}
export function extensionIdFromCrxId(crxId) {
  return [...crxId].map((b) => "abcdefghijklmnop"[b >> 4] + "abcdefghijklmnop"[b & 0xf]).join("")
}
function extensionIdFromKey(keyObject) {
  return extensionIdFromCrxId(crxIdFromSpki(spkiDer(keyObject)))
}

function signedHeaderData(crxId) {
  return pbField(1, crxId)
}
function signPayload(signedHeader, zipBytes, privateKey) {
  const len = Buffer.alloc(4)
  len.writeUInt32LE(signedHeader.length)
  return sign("RSA-SHA256", Buffer.concat([SIGN_PREFIX, len, signedHeader, zipBytes]), privateKey)
}
function buildCrx(zipBytes, privateKey) {
  const spki = spkiDer(privateKey)
  const shd = signedHeaderData(crxIdFromSpki(spki))
  const proof = Buffer.concat([
    pbField(1, spki),
    pbField(2, signPayload(shd, zipBytes, privateKey)),
  ])
  const header = Buffer.concat([pbField(2, proof), pbField(10000, shd)])
  const prefix = Buffer.alloc(12)
  MAGIC.copy(prefix)
  prefix.writeUInt32LE(3, 4)
  prefix.writeUInt32LE(header.length, 8)
  return Buffer.concat([prefix, header, zipBytes])
}
function parseCrx(crx) {
  if (!crx.subarray(0, 4).equals(MAGIC)) throw new Error("not a CRX (bad magic)")
  if (crx.readUInt32LE(4) !== 3) throw new Error("only CRX3 is supported")
  const headerLen = crx.readUInt32LE(8)
  const header = pbParse(crx.subarray(12, 12 + headerLen))
  const zipBytes = crx.subarray(12 + headerLen)
  const proof = header.find((f) => f.fieldNo === 2)
  const shd = header.find((f) => f.fieldNo === 10000)
  if (!proof || !shd) throw new Error("CRX header missing rsa proof or signed_header_data")
  const proofFields = pbParse(proof.data)
  const pub = proofFields.find((f) => f.fieldNo === 1)?.data
  const signature = proofFields.find((f) => f.fieldNo === 2)?.data
  const crxId = pbParse(shd.data).find((f) => f.fieldNo === 1)?.data
  if (!pub || !signature || !crxId) throw new Error("CRX proof incomplete")
  const len = Buffer.alloc(4)
  len.writeUInt32LE(shd.data.length)
  const ok = verify(
    "RSA-SHA256",
    Buffer.concat([SIGN_PREFIX, len, shd.data, zipBytes]),
    createPublicKey({ key: pub, format: "der", type: "spki" }),
    signature,
  )
  if (!ok) throw new Error("CRX signature does not verify")
  if (!crxIdFromSpki(pub).equals(crxId)) throw new Error("CRX id does not match proof key")
  return { crxId, extensionId: extensionIdFromCrxId(crxId), zipBytes }
}

function arg(name) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : null
}

function loadKey(keyPath) {
  if (!fs.existsSync(keyPath))
    throw new Error(
      `CRX key not found: ${keyPath}. Refusing to continue — this tool never generates a replacement signing key. ` +
        "Restore the original release key or ship the unsigned zip via the store dashboard.",
    )
  try {
    return createPrivateKey(fs.readFileSync(keyPath))
  } catch (err) {
    throw new Error(`CRX key at ${keyPath} does not parse as a private key: ${err.message}`)
  }
}

function run() {
  try {
    main()
  } catch (err) {
    console.error(`pack-crx: ${err.message}`)
    process.exit(1)
  }
}

function main() {
  const selfTest = process.argv.includes("--self-test")
  const version = JSON.parse(
    fs.readFileSync(path.join(ROOT, "apps/extension/package.json"), "utf-8"),
  ).version
  const zipPath = path.join(OUTPUT_DIR, `d-op-${version}-chrome.zip`)
  if (!fs.existsSync(zipPath)) {
    console.error(`missing ${path.relative(ROOT, zipPath)} — run "bun run build" first`)
    process.exit(1)
  }

  if (selfTest) {
    // Ephemeral, clearly-labeled test identity — the ONLY place a key may be
    // generated, and it never touches the real release identity.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d-op-crx-selftest-"))
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
    const keyPath = path.join(tmp, "TEST-ONLY-not-a-release-key.pem")
    fs.writeFileSync(keyPath, privateKey.export({ type: "pkcs8", format: "pem" }))
    const key = loadKey(keyPath)
    const crx = buildCrx(fs.readFileSync(zipPath), key)
    const parsed = parseCrx(crx)
    const derived = extensionIdFromKey(key)
    if (parsed.extensionId !== derived) throw new Error("self-test: id mismatch")
    fs.rmSync(tmp, { recursive: true, force: true })
    console.log(
      `pack-crx self-test OK — signed+verified+parsed round-trip, test id ${parsed.extensionId} (ephemeral, discarded)`,
    )
    return
  }

  const keyPath = arg("--key") ?? process.env.DOP_CRX_KEY
  if (!keyPath) {
    console.error(
      "CRX signing is opt-in: pass --key <private.pem> or set DOP_CRX_KEY. " +
        "No key was provided and none will be generated — unsigned zips are the store-submission artifacts.",
    )
    process.exit(1)
  }
  const key = loadKey(keyPath)
  const derivedId = extensionIdFromKey(key)
  const expectId = arg("--expect-id")
  if (expectId && expectId !== derivedId) {
    console.error(
      `CRX identity refusal: key derives extension id ${derivedId}, expected ${expectId}. ` +
        "Signing with a different key would break update continuity — aborted.",
    )
    process.exit(1)
  }
  const zipBytes = fs.readFileSync(zipPath)
  const crx = buildCrx(zipBytes, key)
  const parsed = parseCrx(crx) // round-trip verify before writing
  const out = path.join(OUTPUT_DIR, `d-op-${version}-chrome.crx`)
  fs.writeFileSync(out, crx)
  console.log(`signed ${path.relative(ROOT, out)} — extension id ${parsed.extensionId}`)
}

run()
