/**
 * Downloads Apple's App Store Connect OpenAPI specification and stores it,
 * minified and gzipped, at spec/openapi.json.gz for the endpoint search tools.
 *
 * Usage: npm run update-spec
 */
import { writeFile } from 'node:fs/promises';
import { gzipSync, inflateRawSync } from 'node:zlib';

const SPEC_URL =
  'https://developer.apple.com/sample-code/app-store-connect/app-store-connect-openapi-specification.zip';
const SPEC_ENTRY = 'openapi.oas.json';
const OUTPUT = new URL('../spec/openapi.json.gz', import.meta.url);

/** Extracts a single file from a zip archive using its central directory. */
function extractFromZip(zip: Buffer, entryName: string): Buffer {
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) throw new Error('Not a zip archive: end of central directory not found.');

  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount; i++) {
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localHeader = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);

    if (name === entryName) {
      const localNameLength = zip.readUInt16LE(localHeader + 26);
      const localExtraLength = zip.readUInt16LE(localHeader + 28);
      const start = localHeader + 30 + localNameLength + localExtraLength;
      const data = zip.subarray(start, start + compressedSize);
      if (method === 0) return data;
      if (method === 8) return inflateRawSync(data);
      throw new Error(`Unsupported zip compression method ${method}.`);
    }

    offset += 46 + nameLength + extraLength + commentLength;
  }

  throw new Error(`${entryName} not found in the downloaded archive.`);
}

const response = await fetch(SPEC_URL);
if (!response.ok) {
  throw new Error(`Download failed: ${response.status} ${response.statusText}`);
}

const zip = Buffer.from(await response.arrayBuffer());
const spec = JSON.parse(extractFromZip(zip, SPEC_ENTRY).toString('utf8'));
const operations = Object.values(spec.paths as Record<string, object>).reduce(
  (count, item) =>
    count +
    Object.keys(item).filter((key) => ['get', 'post', 'patch', 'delete', 'put'].includes(key))
      .length,
  0,
);

const gzipped = gzipSync(JSON.stringify(spec), { level: 9 });
await writeFile(OUTPUT, gzipped);

console.log(
  `Saved App Store Connect API ${spec.info.version} (${operations} operations) to spec/openapi.json.gz (${Math.round(gzipped.length / 1024)} KB).`,
);
