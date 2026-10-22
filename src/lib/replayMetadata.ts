import { SlippiGame } from "@slippi/slippi-js";
import type { MetadataType } from "@slippi/slippi-js";

const RAW_HEADER = [0x7b, 0x55, 0x03, 0x72, 0x61, 0x77, 0x5b, 0x24, 0x55, 0x23, 0x6c];
const METADATA_KEY = [0x55, 0x08, 0x6d, 0x65, 0x74, 0x61, 0x64, 0x61, 0x74, 0x61];
const RAW_POSITION = 15;
export const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_RECOVERY_BYTES = 64 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

/** A valid prefix can still be a snapshot taken before Dolphin closed the file. */
export class IncompleteReplayError extends Error {
  constructor() {
    super("replay is still being written or its metadata tail is truncated");
    this.name = "IncompleteReplayError";
  }
}

export class ReplayMetadataError extends Error {
  constructor(detail = "could not be decoded") {
    super(`Replay metadata ${detail}. The file may be damaged or use an unsupported metadata format.`);
    this.name = "ReplayMetadataError";
  }
}

/**
 * slippi-js returns null for both unfinished files and metadata decode errors.
 * Older Dolphin writers counted characters instead of UTF-8 bytes in netplay
 * names (slippi-js#126). Recover that specific defect without guessing a date
 * or treating every completed, malformed file as perpetually mid-write.
 */
export function readReplayMetadata(game: SlippiGame, bytes: Uint8Array): MetadataType {
  if (bytes.length < RAW_POSITION || !RAW_HEADER.every((value, i) => bytes[i] === value)) {
    const metadata = game.getMetadata();
    if (!metadata) throw new IncompleteReplayError();
    return metadata;
  }
  const rawLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(11);
  const rawEnd = RAW_POSITION + rawLength;
  if (!rawLength || rawEnd >= bytes.length) throw new IncompleteReplayError();
  const tail = bytes.subarray(rawEnd);
  // Bound the input tail before invoking slippi-js, including full parses.
  // The separate recovery reader below also bounds nesting and value counts.
  if (tail.length > MAX_METADATA_BYTES) throw new ReplayMetadataError("exceeds the supported size limit");
  const metadata = game.getMetadata();
  // Keep compatibility with existing, valid metadata (including legacy files
  // with no date). The stricter identity checks below apply only to recovery.
  if (metadata) return metadata;
  return recoverMetadata(tail);
}

type Value = null | boolean | number | string | Value[] | { [key: string]: Value };
type ObjectValue = { [key: string]: Value };

class MetadataReadError extends Error {
  readonly offset: number;
  readonly incomplete: boolean;

  constructor(offset: number, incomplete = false) {
    super("invalid metadata encoding");
    this.offset = offset;
    this.incomplete = incomplete;
  }
}

/** Only the fallback uses this small, strict subset of UBJSON. */
class MetadataReader {
  private offset = 0;
  private values = 0;
  repairs = 0;
  private readonly bytes: Uint8Array;
  private readonly modes: number;

  constructor(bytes: Uint8Array, modes: number) {
    this.bytes = bytes;
    this.modes = modes;
  }

  read(): ObjectValue {
    for (const byte of METADATA_KEY) {
      if (this.byte() !== byte) this.invalid();
    }
    const result = this.value([], 0);
    if (!isObject(result) || this.byte() !== 0x7d || this.offset !== this.bytes.length) this.invalid();
    return result;
  }

  private invalid(): never {
    throw new MetadataReadError(this.offset);
  }

  private require(length: number): void {
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RECOVERY_BYTES) this.invalid();
    if (length > this.bytes.length - this.offset) throw new MetadataReadError(this.bytes.length, true);
  }

  private byte(): number {
    this.require(1);
    return this.bytes[this.offset++]!;
  }

  private number(tag: number): number {
    const lengths: Record<number, number> = { 0x55: 1, 0x69: 1, 0x49: 2, 0x6c: 4, 0x4c: 8, 0x64: 4, 0x44: 8 };
    const length = lengths[tag];
    if (!length) this.invalid();
    this.require(length);
    const view = new DataView(this.bytes.buffer, this.bytes.byteOffset + this.offset, length);
    this.offset += length;
    const result = tag === 0x55 ? view.getUint8(0)
      : tag === 0x69 ? view.getInt8(0)
      : tag === 0x49 ? view.getInt16(0)
      : tag === 0x6c ? view.getInt32(0)
      : tag === 0x4c ? Number(view.getBigInt64(0))
      : tag === 0x64 ? view.getFloat32(0) : view.getFloat64(0);
    if (!Number.isFinite(result) || (tag === 0x4c && !Number.isSafeInteger(result))) this.invalid();
    return result;
  }

  private length(): number {
    const tag = this.byte();
    if (![0x55, 0x69, 0x49, 0x6c, 0x4c].includes(tag)) this.invalid();
    const length = this.number(tag);
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_RECOVERY_BYTES) this.invalid();
    return length;
  }

  private string(length: number, mode = 0): string {
    const start = this.offset;
    this.require(length);
    if (mode === 0) {
      this.offset += length;
    } else {
      // Mode 1 counts Unicode scalar values; mode 2 counts UTF-16 code units.
      // Never infer string boundaries by searching for braces or key markers:
      // those may be literal characters inside a player's display name.
      let count = 0;
      while (count < length) {
        const lead = this.byte();
        const width = lead < 0x80 ? 1 : lead >= 0xc2 && lead <= 0xdf ? 2
          : lead >= 0xe0 && lead <= 0xef ? 3 : lead >= 0xf0 && lead <= 0xf4 ? 4 : 0;
        if (!width || lead < 0x20 || lead === 0x7f) this.invalid();
        this.require(width - 1);
        this.offset += width - 1;
        count += mode === 2 && width === 4 ? 2 : 1;
      }
      if (count !== length) this.invalid();
      if (this.offset - start !== length) this.repairs++;
    }
    try {
      return utf8.decode(this.bytes.subarray(start, this.offset));
    } catch {
      this.invalid();
    }
  }

  private value(path: string[], depth: number): Value {
    if (depth > 12 || ++this.values > 2048) this.invalid();
    const tag = this.byte();
    if (tag === 0x5a) return null;
    if (tag === 0x54 || tag === 0x46) return tag === 0x54;
    if (tag === 0x53) {
      const length = this.length();
      const name = path.length === 4 && path[0] === "players" && /^[0-3]$/.test(path[1]!) && path[2] === "names" && path[3] === "netplay";
      const mode = name ? Math.floor(this.modes / 3 ** Number(path[1])) % 3 : 0;
      return this.string(length, mode);
    }
    if (tag === 0x43) return this.string(1);
    if (tag === 0x7b) {
      const object: ObjectValue = Object.create(null) as ObjectValue;
      while (true) {
        this.require(1);
        if (this.bytes[this.offset] === 0x7d) {
          this.offset++;
          return object;
        }
        const key = this.string(this.length());
        if (Object.hasOwn(object, key)) this.invalid();
        object[key] = this.value([...path, key], depth + 1);
      }
    }
    if (tag === 0x5b) {
      const array: Value[] = [];
      while (true) {
        this.require(1);
        if (this.bytes[this.offset] === 0x5d) {
          this.offset++;
          return array;
        }
        array.push(this.value([...path, String(array.length)], depth + 1));
      }
    }
    return this.number(tag);
  }
}

function isObject(value: Value | undefined): value is ObjectValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTimestamp(value: Value | undefined): value is string {
  if (typeof value !== "string") return false;
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!parts) return false;
  const [, year, month, day, hour, minute, second] = parts;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][Number(month) - 1] ?? 0;
  return Number(month) >= 1 && Number(month) <= 12 && Number(day) >= 1 && Number(day) <= days
    && Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60 && Number.isFinite(Date.parse(value));
}

function recoverMetadata(tail: Uint8Array): MetadataType {
  if (tail.length > MAX_RECOVERY_BYTES) throw new ReplayMetadataError("is too large for safe recovery");
  let recovered: ObjectValue | null = null;
  let fingerprint: string | null = null;
  let furthest: MetadataReadError | null = null;
  let completeButInvalid = false;
  // Four player names, three possible length conventions: a hard bound of 81
  // parses of at most 64 KiB, with separate depth/value limits in the reader.
  for (let modes = 0; modes < 81; modes++) {
    const reader = new MetadataReader(tail, modes);
    try {
      const metadata = reader.read();
      const lastFrame = metadata.lastFrame;
      if (!reader.repairs || !validTimestamp(metadata.startAt)
        || (lastFrame !== undefined && (typeof lastFrame !== "number" || !Number.isInteger(lastFrame) || lastFrame < -123 || lastFrame > 0x7fff_ffff))) {
        completeButInvalid = true;
        continue;
      }
      const next = JSON.stringify(metadata);
      if (fingerprint !== null && fingerprint !== next) throw new ReplayMetadataError("has ambiguous name lengths");
      fingerprint = next;
      recovered = metadata;
    } catch (error) {
      if (!(error instanceof MetadataReadError)) throw error;
      if (!furthest || error.offset > furthest.offset || (error.offset === furthest.offset && error.incomplete)) furthest = error;
    }
  }
  // Preserve the original timestamp verbatim: it participates in game identity.
  if (recovered) return recovered as unknown as MetadataType;
  if (!completeButInvalid && furthest?.incomplete) throw new IncompleteReplayError();
  throw new ReplayMetadataError();
}
