// @effect-diagnostics nodeBuiltinImport:off
// Block payloads are raw DEFLATE with a CRC-32, which node:zlib checks directly.
import * as NodeZlib from "node:zlib";
import { SaxesParser } from "saxes";

/** A file a SolidWorks assembly uses, by the path it was last saved with on its author's machine. */
export interface SolidWorksReference {
  readonly path: string;
  readonly kind: "part" | "assembly";
  /** A virtual component, saved inside the assembly rather than in a file of its own. */
  readonly virtual: boolean;
}

const BLOCK_SIGNATURE = Buffer.from([0x14, 0x00, 0x06, 0x00, 0x08, 0x00]);
const BLOCK_HEADER_BYTES = 26;
const FILE_LIST_BLOCK = "swXmlContents/COMPINSTANCETREE";
const MAX_FILE_LIST_BYTES = 64 * 1024 * 1024;

const swapNibbles = (bytes: Uint8Array) =>
  String.fromCharCode(...bytes.map((byte) => ((byte >> 4) | (byte << 4)) & 0xff));

/**
 * The XML file list inside a SolidWorks 2015 or later file. These files are a run of blocks, each
 * a 26-byte header (signature, type, CRC-32, compressed and plain sizes, name length), a
 * nibble-swapped name, and a raw DEFLATE payload. A name can repeat; the last copy whose CRC
 * matches wins. Returns null for older OLE files and anything without a valid list.
 */
function readFileListXml(bytes: Uint8Array) {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let found: Buffer | null = null;
  for (
    let at = buffer.indexOf(BLOCK_SIGNATURE);
    at >= 0;
    at = buffer.indexOf(BLOCK_SIGNATURE, at + 1)
  ) {
    if (at + BLOCK_HEADER_BYTES > buffer.length) break;
    const crc = buffer.readUInt32LE(at + 10);
    const compressed = buffer.readUInt32LE(at + 14);
    const plain = buffer.readUInt32LE(at + 18);
    const nameLength = buffer.readUInt32LE(at + 22);
    const start = at + BLOCK_HEADER_BYTES + nameLength;
    if (
      nameLength !== FILE_LIST_BLOCK.length ||
      plain > MAX_FILE_LIST_BYTES ||
      start + compressed > buffer.length ||
      swapNibbles(buffer.subarray(at + BLOCK_HEADER_BYTES, start)) !== FILE_LIST_BLOCK
    )
      continue;
    try {
      const xml = NodeZlib.inflateRawSync(buffer.subarray(start, start + compressed), {
        maxOutputLength: Math.max(1, plain),
      });
      if (xml.length === plain && NodeZlib.crc32(xml) === crc) found = xml;
    } catch {
      // A stale or truncated copy. Keep looking for a valid one.
    }
  }
  return found;
}

/**
 * Lists every file a SolidWorks assembly uses, across all of its subassemblies, without the
 * assembly itself. The list is `swHeader/swFile`; the assembly is the file whose model the
 * configuration list points at. A file is virtual when a component reference to its model says
 * `swIsVirtualComponent="YES"`. Returns null when the file has no readable list.
 */
export function readSolidWorksReferences(bytes: Uint8Array): readonly SolidWorksReference[] | null {
  const xml = readFileListXml(bytes);
  if (!xml) return null;
  const files = new Map<string, Omit<SolidWorksReference, "virtual">>();
  const modelFiles = new Map<string, string>();
  const configuredModels = new Set<string>();
  const virtualModels = new Set<string>();
  const parser = new SaxesParser();
  let failed = false;
  parser.on("error", () => {
    failed = true;
  });
  parser.on("opentag", (tag) => {
    const attribute = (name: string) => {
      const value = tag.attributes[name];
      return typeof value === "string" ? value : undefined;
    };
    const id = attribute("id");
    if (tag.name === "swFile") {
      const path = attribute("swPath");
      const type = attribute("swDocType");
      if (id && path && (type === "PART" || type === "ASSEMBLY"))
        files.set(id, { path, kind: type === "PART" ? "part" : "assembly" });
    } else if (tag.name === "swModel") {
      const fileRef = attribute("swFileRef");
      if (id && fileRef) modelFiles.set(id, fileRef);
    } else if (tag.name === "swConfiguration") {
      const modelRef = attribute("swModelRef");
      if (modelRef) configuredModels.add(modelRef);
    } else if (tag.name === "swReference") {
      const modelRef = attribute("swModelRef");
      if (modelRef && attribute("swIsVirtualComponent") === "YES") virtualModels.add(modelRef);
    }
  });
  try {
    parser.write(xml.toString("utf8")).close();
  } catch {
    return null;
  }
  if (failed) return null;
  for (const model of configuredModels) {
    const fileRef = modelFiles.get(model);
    if (fileRef) files.delete(fileRef);
  }
  const virtualFiles = new Set([...virtualModels].map((model) => modelFiles.get(model)));
  return [...files].map(([id, file]) => ({ ...file, virtual: virtualFiles.has(id) }));
}

const baseName = (path: string) => path.split(/[\\/]/).at(-1) ?? path;
const dirName = (path: string) => path.split("/").slice(0, -1).join("/");
// 3D Interconnect caches an inserted STEP (or other neutral) file as `...\IC~~\<file>.SLDPRT`.
const INTERCONNECT_CACHE = /[\\/]IC~~[\\/]/;
const SOLIDWORKS_SUFFIX = /\.sld(?:prt|asm)$/i;

export interface SolidWorksFilePlan {
  /** Workspace-relative paths of the files the assembly uses, excluding the assembly. */
  readonly files: readonly string[];
  /** File names the assembly uses that are not in the folder. */
  readonly missing: readonly string[];
}

/**
 * Finds each file an assembly uses among the project folder's CAD files, by name and ignoring
 * case like Windows does. A name found more than once resolves to the copy beside the assembly,
 * then the first by path. 3D Interconnect inserts resolve to their source file when it is in the
 * folder. SolidWorks keeps their geometry inside the assembly, so they are never missing, and the
 * same goes for virtual components. A real file a virtual component uses is still required: the
 * list names it on its own.
 *
 * Cadsense copies these files beside the assembly before SolidWorks opens it, so SolidWorks loads
 * exactly them, and hashes them for the revision. See LocalCad.md, SolidWorks files.
 */
export function planSolidWorksFiles(input: {
  readonly assemblyPath: string;
  readonly references: readonly SolidWorksReference[];
  readonly folderFiles: readonly string[];
}): SolidWorksFilePlan {
  const byName = new Map<string, string[]>();
  for (const file of [...input.folderFiles].sort()) {
    const key = baseName(file).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), file]);
  }
  const home = dirName(input.assemblyPath);
  const find = (name: string) => {
    const candidates = byName.get(name.toLowerCase()) ?? [];
    return candidates.find((file) => dirName(file) === home) ?? candidates[0];
  };
  const files = new Set<string>();
  const missing = new Set<string>();
  for (const reference of input.references) {
    if (reference.virtual) continue;
    const name = baseName(reference.path);
    if (INTERCONNECT_CACHE.test(reference.path)) {
      const source = find(name.replace(SOLIDWORKS_SUFFIX, ""));
      if (source) files.add(source);
      continue;
    }
    const file = find(name);
    if (file) files.add(file);
    else missing.add(name);
  }
  files.delete(input.assemblyPath);
  return { files: [...files].sort(), missing: [...missing].sort() };
}
