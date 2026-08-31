import { Zip, ZipPassThrough } from 'fflate';

export type ArchiveEntry = {
  name: string;
  bytes: Uint8Array;
};

const MAX_ARCHIVE_ENTRIES = 501;
const MAX_ARCHIVE_ENTRY_BYTES = 4 * 1024 * 1024;
const MAX_ARCHIVE_TOTAL_BYTES = 160 * 1024 * 1024;
const MAX_ARCHIVE_NAME_BYTES = 512;
const unsafeArchiveNameCharacters = /[\u0000-\u001f\u007f\\:]/u;

function validatedArchiveName(value: string, seen: Set<string>) {
  const name = value.normalize('NFC');
  const segments = name.split('/');
  const invalid =
    !name ||
    name.startsWith('/') ||
    Buffer.byteLength(name, 'utf8') > MAX_ARCHIVE_NAME_BYTES ||
    unsafeArchiveNameCharacters.test(name) ||
    segments.some(
      (segment) =>
        !segment || segment === '.' || segment === '..' || segment.endsWith('.') || segment.endsWith(' '),
    );
  const collisionKey = name.toLowerCase();
  if (invalid || seen.has(collisionKey)) {
    throw new Error('CERTIFICATE_ARCHIVE_ENTRY_INVALID');
  }
  seen.add(collisionKey);
  return name;
}

function validatedArchiveBytes(bytes: Uint8Array, totalBytes: number) {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength < 1 ||
    bytes.byteLength > MAX_ARCHIVE_ENTRY_BYTES ||
    totalBytes + bytes.byteLength > MAX_ARCHIVE_TOTAL_BYTES
  ) {
    throw new Error('CERTIFICATE_ARCHIVE_BYTES_INVALID');
  }
  return totalBytes + bytes.byteLength;
}

function validatedEntries(entries: readonly ArchiveEntry[]) {
  if (entries.length < 1 || entries.length > MAX_ARCHIVE_ENTRIES) {
    throw new Error('CERTIFICATE_ARCHIVE_SIZE_INVALID');
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  return entries.map((entry) => {
    const name = validatedArchiveName(entry.name, seen);
    totalBytes = validatedArchiveBytes(entry.bytes, totalBytes);
    return { ...entry, name };
  });
}

export function createZipArchiveStream(
  entries: readonly ArchiveEntry[],
): ReadableStream<Uint8Array> {
  const normalizedEntries = validatedEntries(entries);
  let archive: Zip | null = null;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      archive = new Zip((error, chunk, final) => {
        if (error) {
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      for (const entry of normalizedEntries) {
        const file = new ZipPassThrough(entry.name);
        archive.add(file);
        file.push(entry.bytes, true);
      }
      archive.end();
    },
    cancel() {
      archive?.terminate();
      archive = null;
    },
  });
}

/** Adds entries as they are generated, so a large export is never assembled in one buffer. */
export function createStreamingZipArchive(
  entries: AsyncIterable<ArchiveEntry>,
): ReadableStream<Uint8Array> {
  let archive: Zip | null = null;
  let cancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const seen = new Set<string>();
      let count = 0;
      let totalBytes = 0;
      archive = new Zip((error, chunk, final) => {
        if (cancelled) return;
        if (error) {
          controller.error(error);
          return;
        }
        controller.enqueue(chunk);
        if (final) controller.close();
      });
      try {
        for await (const entry of entries) {
          if (cancelled) return;
          count += 1;
          if (count > MAX_ARCHIVE_ENTRIES) throw new Error('CERTIFICATE_ARCHIVE_SIZE_INVALID');
          const name = validatedArchiveName(entry.name, seen);
          totalBytes = validatedArchiveBytes(entry.bytes, totalBytes);
          const file = new ZipPassThrough(name);
          archive.add(file);
          file.push(entry.bytes, true);
        }
        if (count < 1) throw new Error('CERTIFICATE_ARCHIVE_SIZE_INVALID');
        archive.end();
      } catch (error) {
        archive?.terminate();
        archive = null;
        if (!cancelled) controller.error(error);
      }
    },
    cancel() {
      cancelled = true;
      archive?.terminate();
      archive = null;
    },
  });
}

export async function createZipArchive(entries: readonly ArchiveEntry[]): Promise<Uint8Array> {
  const reader = createZipArchiveStream(entries).getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    byteLength += value.byteLength;
  }
  const output = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
