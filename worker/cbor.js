// =====================================================
// MINIMAL CBOR DECODER (RFC 8949)
//
// Decodes exactly the subset of CBOR that WebAuthn's
// attestationObject and COSE_Key structures use: unsigned/
// negative integers, byte strings, text strings, arrays, and
// maps — all definite-length (WebAuthn authenticators encode
// definite-length CBOR; indefinite-length ("streaming") items
// are not supported and will throw rather than silently
// misparse).
//
// Deliberately hand-written rather than an npm dependency —
// this Workers environment has no build step to bundle one in,
// and the subset needed is small and precisely bounded, which
// makes an independent, from-spec implementation more
// auditable than pulling in a general-purpose library's much
// larger surface. Verified in tests against byte sequences
// independently constructed (not just round-tripped through
// this same encoder) — see test/cbor.test.js.
// =====================================================

const MAJOR_UNSIGNED_INT = 0;
const MAJOR_NEGATIVE_INT = 1;
const MAJOR_BYTE_STRING = 2;
const MAJOR_TEXT_STRING = 3;
const MAJOR_ARRAY = 4;
const MAJOR_MAP = 5;

/**
 * Reads the "argument" of a CBOR initial byte: either the low 5 bits
 * directly (0-23), or a following 1/2/4/8-byte big-endian integer
 * (additional info 24/25/26/27). Returns {value, offset} with
 * offset advanced past whatever was consumed.
 */
function readArgument(bytes, offset, additionalInfo) {
  if (additionalInfo <= 23) return { value: additionalInfo, offset };
  if (additionalInfo === 24) return { value: bytes[offset], offset: offset + 1 };
  if (additionalInfo === 25) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 2);
    return { value: view.getUint16(0, false), offset: offset + 2 };
  }
  if (additionalInfo === 26) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 4);
    return { value: view.getUint32(0, false), offset: offset + 4 };
  }
  if (additionalInfo === 27) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 8);
    const value = view.getBigUint64(0, false);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR integer too large to represent safely");
    return { value: Number(value), offset: offset + 8 };
  }
  throw new Error(`unsupported CBOR additional info ${additionalInfo} (indefinite-length items are not supported)`);
}

/**
 * Decodes one CBOR item starting at `offset`. Returns {value, offset}
 * with offset advanced past the item. Recurses for arrays/maps.
 */
function decodeItem(bytes, offset) {
  if (offset >= bytes.length) throw new Error("unexpected end of CBOR input");

  const initialByte = bytes[offset];
  const majorType = initialByte >> 5;
  const additionalInfo = initialByte & 0x1f;
  const { value: argument, offset: afterArgument } = readArgument(bytes, offset + 1, additionalInfo);

  switch (majorType) {
    case MAJOR_UNSIGNED_INT:
      return { value: argument, offset: afterArgument };

    case MAJOR_NEGATIVE_INT:
      return { value: -1 - argument, offset: afterArgument };

    case MAJOR_BYTE_STRING: {
      const end = afterArgument + argument;
      if (end > bytes.length) throw new Error("CBOR byte string length exceeds available input");
      return { value: bytes.slice(afterArgument, end), offset: end };
    }

    case MAJOR_TEXT_STRING: {
      const end = afterArgument + argument;
      if (end > bytes.length) throw new Error("CBOR text string length exceeds available input");
      return { value: new TextDecoder().decode(bytes.slice(afterArgument, end)), offset: end };
    }

    case MAJOR_ARRAY: {
      let cursor = afterArgument;
      const items = [];
      for (let i = 0; i < argument; i++) {
        const decoded = decodeItem(bytes, cursor);
        items.push(decoded.value);
        cursor = decoded.offset;
      }
      return { value: items, offset: cursor };
    }

    case MAJOR_MAP: {
      let cursor = afterArgument;
      const map = new Map();
      for (let i = 0; i < argument; i++) {
        const key = decodeItem(bytes, cursor);
        cursor = key.offset;
        const val = decodeItem(bytes, cursor);
        cursor = val.offset;
        map.set(key.value, val.value);
      }
      return { value: map, offset: cursor };
    }

    default:
      throw new Error(`unsupported CBOR major type ${majorType}`);
  }
}

/** Decodes a single CBOR item from the start of `bytes` and returns just its value. */
export function decodeCbor(bytes) {
  return decodeItem(bytes, 0).value;
}

/**
 * Decodes a single CBOR item starting at `offset` and returns both
 * the value and how many bytes it consumed — used when more CBOR-
 * unrelated bytes follow in the same buffer (WebAuthn's authData:
 * a fixed binary prefix, THEN a CBOR-encoded COSE key).
 */
export function decodeCborAt(bytes, offset) {
  return decodeItem(bytes, offset);
}
