// Mirror of worker/nodeva_worker/canonical.py. These two MUST agree byte for
// byte — a divergence rejects legitimate signed receipts, and the failure looks
// like a security error rather than a serialization bug, so it is exactly the
// kind of thing that burns a day. There is a cross-language test pinning them.

export class NonCanonicalValue extends Error {}

function check(value, path = '$') {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) {
      throw new NonCanonicalValue(
        `${path}: ${value} is not an integer; JSON.stringify(1.0) is "1" but ` +
        `Python emits "1.0". Use integer paise or epoch milliseconds.`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new NonCanonicalValue(`${path}: ${value} exceeds JS safe integer range`);
    }
    return;
  }
  if (Array.isArray(value)) { value.forEach((v, i) => check(v, `${path}[${i}]`)); return; }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) check(v, `${path}.${k}`);
    return;
  }
  throw new NonCanonicalValue(`${path}: unsupported type ${typeof value}`);
}

// Recursively sort keys. JSON.stringify preserves insertion order, so the sort
// has to happen on the structure, not the output.
function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(k => [k, sorted(value[k])]));
  }
  return value;
}

export function encode(body) {
  check(body);
  return Buffer.from(JSON.stringify(sorted(body)), 'utf8');
}
