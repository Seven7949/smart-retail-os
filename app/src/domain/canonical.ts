/**
 * Canonical JSON + SHA-256 — byte-identical to the Rust (`ledger-core`) and
 * Python (`spec/gen_vectors.py`) implementations. See docs/LEDGER_SPEC.md.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

export class CanonicalError extends Error {}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function str(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c === 0x08) out += '\\b';
    else if (c === 0x0c) out += '\\f';
    else if (c < 0x20) out += '\\u' + c.toString(16).padStart(4, '0');
    else out += ch;
  }
  return out + '"';
}

function write(v: unknown): string {
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isInteger(v)) throw new CanonicalError('floats are not allowed');
    if (!Number.isSafeInteger(v)) throw new CanonicalError('integer outside the safe range');
    return String(v);
  }
  if (typeof v === 'string') return str(v);
  if (Array.isArray(v)) return '[' + v.map(write).join(',') + ']';
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined);
    if (keys.some((k) => !/^[\x00-\x7f]*$/.test(k))) throw new CanonicalError('object keys must be ASCII');
    keys.sort(); // ASCII: UTF-16 order === code point order === byte order
    return '{' + keys.map((k) => str(k) + ':' + write(obj[k])).join(',') + '}';
  }
  throw new CanonicalError(`unsupported type ${typeof v}`);
}

export function canonical(value: Json | object): string {
  return write(value);
}

export function sha256Hex(text: string): string {
  return bytesToHex(sha256(utf8ToBytes(text)));
}
