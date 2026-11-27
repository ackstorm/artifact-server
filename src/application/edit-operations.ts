import {createHash} from "node:crypto";

import {Effect} from "effect";

import {type BlobStorageFailure, InvalidEdit} from "../core/errors.js";
import type {CanonicalManifest, ManifestEntry} from "../core/model.js";
import type {StoredBlob} from "../core/ports.js";
import {
  maximumDeclaredFiles,
  maximumEditTextBytes,
  maximumInlineTextFileBytes,
} from "../core/publishing-limits.js";
import type {
  DeclaredManifestFile,
  ManifestInput,
} from "../manifest/create-manifest.js";
import {
  isInlineTextMediaType,
  mediaTypeForPath,
} from "../manifest/media-types.js";

/** One text replacement; `oldText` must occur exactly once at that point. */
export interface TextReplacement {
  readonly newText: string;
  readonly oldText: string;
}

/** One step of an edit commit, applied in order to the base version's files. */
export type EditOperation =
  | {
    readonly edits: readonly TextReplacement[];
    readonly kind: "replace";
    readonly path: string;
  }
  | {
    readonly kind: "write";
    readonly mediaType?: string | undefined;
    readonly path: string;
    readonly text: string;
  }
  | {readonly kind: "delete"; readonly path: string}
  | {readonly from: string; readonly kind: "rename"; readonly to: string};

/** Bytes an edit produced; they are stored before the version commits. */
export interface EditedBlob extends StoredBlob {
  readonly bytes: Uint8Array<ArrayBuffer>;
}

/** The manifest input and the new bytes one edit derives from its base. */
export interface AppliedEdit {
  readonly blobs: readonly EditedBlob[];
  readonly manifest: ManifestInput;
}

interface WorkingFile {
  /** Bytes written by this edit; null while the file keeps its stored blob. */
  readonly bytes: Uint8Array<ArrayBuffer> | null;
  readonly file: DeclaredManifestFile;
}

type BlobReader = (
  blob: StoredBlob,
) => Effect.Effect<Uint8Array, BlobStorageFailure>;

/** Apply edit operations in order to a base manifest, all or nothing. */
export const applyEditOperations = Effect.fnUntraced(function*(
  base: CanonicalManifest,
  operations: readonly EditOperation[],
  readBytes: BlobReader,
): Effect.fn.Return<AppliedEdit, InvalidEdit | BlobStorageFailure> {
  const textBytes = operations.reduce(
    (total, operation) => total + inlineTextBytes(operation),
    0,
  );
  if (textBytes > maximumEditTextBytes) {
    return yield* new InvalidEdit({
      message:
        `The edit carries ${textBytes} bytes of text; one edit carries at most ${maximumEditTextBytes}. Publish whole files through artifact_create_upload.`,
    });
  }
  const files = new Map<string, WorkingFile>(
    base.entries.map((entry) => [entry.path, {bytes: null, file: declared(entry)}]),
  );
  let entryPath = base.entryPath;
  for (const operation of operations) {
    switch (operation.kind) {
      case "replace": {
        const current = yield* existing(files, operation.path);
        let text = yield* decodedText(current, readBytes);
        for (const edit of operation.edits) {
          const count = occurrences(text, edit.oldText);
          if (count !== 1) {
            return yield* new InvalidEdit({
              message:
                `oldText occurs ${count === 0 ? "0 times" : "more than once"} in ${operation.path}; it must occur exactly once. Include more surrounding text.`,
            });
          }
          const at = text.indexOf(edit.oldText);
          text = `${text.slice(0, at)}${edit.newText}${text.slice(at + edit.oldText.length)}`;
        }
        files.set(
          operation.path,
          yield* textFile(operation.path, current.file.mediaType, text),
        );
        break;
      }
      case "write":
        files.set(
          operation.path,
          yield* textFile(
            operation.path,
            operation.mediaType ?? mediaTypeForPath(operation.path),
            operation.text,
          ),
        );
        break;
      case "delete":
        yield* existing(files, operation.path);
        files.delete(operation.path);
        break;
      case "rename": {
        const moved = yield* existing(files, operation.from);
        if (files.has(operation.to)) {
          return yield* new InvalidEdit({
            message: `${operation.to} already exists; delete it first or choose another path.`,
          });
        }
        files.delete(operation.from);
        files.set(operation.to, {...moved, file: {...moved.file, path: operation.to}});
        if (entryPath === operation.from) entryPath = operation.to;
        break;
      }
    }
  }
  if (files.size > maximumDeclaredFiles) {
    return yield* new InvalidEdit({
      message: `The edit leaves ${files.size} files; a version holds at most ${maximumDeclaredFiles}.`,
    });
  }
  const working = [...files.values()];
  return {
    blobs: working.flatMap(({bytes, file}) =>
      bytes === null ? [] : [{bytes, sha256: file.sha256, size: file.size}]
    ),
    manifest: {
      entryPath,
      files: working.map(({file}) => file),
      routingMode: base.routingMode,
    },
  };
});

function declared(entry: ManifestEntry): DeclaredManifestFile {
  return {
    mediaType: entry.mediaType,
    path: entry.path,
    sha256: entry.sha256,
    size: entry.size,
  };
}

function existing(
  files: ReadonlyMap<string, WorkingFile>,
  path: string,
): Effect.Effect<WorkingFile, InvalidEdit> {
  const found = files.get(path);
  return found === undefined
    ? new InvalidEdit({message: `${path} is not a file of this version.`})
    : Effect.succeed(found);
}

const decodedText = Effect.fnUntraced(function*(
  current: WorkingFile,
  readBytes: BlobReader,
): Effect.fn.Return<string, InvalidEdit | BlobStorageFailure> {
  const {file} = current;
  if (
    !isInlineTextMediaType(file.mediaType) ||
    file.size > maximumInlineTextFileBytes
  ) {
    return yield* new InvalidEdit({
      message:
        `${file.path} is ${file.mediaType} of ${file.size} bytes; replace edits only UTF-8 text files up to ${maximumInlineTextFileBytes} bytes.`,
    });
  }
  const bytes = current.bytes ?? (yield* readBytes(file));
  // ignoreBOM keeps a leading byte order mark in the text, so it re-encodes unchanged.
  return yield* Effect.try({
    try: () => new TextDecoder("utf-8", {fatal: true, ignoreBOM: true}).decode(bytes),
    catch: () => new InvalidEdit({message: `${file.path} is not valid UTF-8 text.`}),
  });
});

const textFile = Effect.fnUntraced(function*(
  path: string,
  mediaType: string,
  text: string,
): Effect.fn.Return<WorkingFile, InvalidEdit> {
  if (!isInlineTextMediaType(mediaType)) {
    return yield* new InvalidEdit({
      message:
        `${path} would be ${mediaType}; edits write only text media types. Pass a text mediaType.`,
    });
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength > maximumInlineTextFileBytes) {
    return yield* new InvalidEdit({
      message:
        `${path} would be ${bytes.byteLength} bytes; an edited file holds at most ${maximumInlineTextFileBytes}.`,
    });
  }
  return {
    bytes,
    file: {
      mediaType,
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.byteLength,
    },
  };
});

// Counts up to 2: one match is enough to apply and a second to refuse.
function occurrences(text: string, needle: string): number {
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1 && count < 2; at = text.indexOf(needle, at + 1)) {
    count += 1;
  }
  return count;
}

function inlineTextBytes(operation: EditOperation): number {
  switch (operation.kind) {
    case "replace":
      return operation.edits.reduce(
        (total, edit) =>
          total + Buffer.byteLength(edit.oldText) + Buffer.byteLength(edit.newText),
        0,
      );
    case "write":
      return Buffer.byteLength(operation.text);
    default:
      return 0;
  }
}
