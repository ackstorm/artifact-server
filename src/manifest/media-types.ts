import path from "node:path";

const mediaTypesByExtension = new Map<string, string>([
  [".aac", "audio/aac"],
  [".avif", "image/avif"],
  [".avi", "video/x-msvideo"],
  [".bin", "application/octet-stream"],
  [".bmp", "image/bmp"],
  [".css", "text/css; charset=utf-8"],
  [".csv", "text/csv; charset=utf-8"],
  [".gif", "image/gif"],
  [".gz", "application/gzip"],
  [".htm", "text/html; charset=utf-8"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".m4a", "audio/mp4"],
  [".md", "text/markdown; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mov", "video/quicktime"],
  [".mp3", "audio/mpeg"],
  [".mp4", "video/mp4"],
  [".oga", "audio/ogg"],
  [".ogg", "audio/ogg"],
  [".ogv", "video/ogg"],
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".tar", "application/x-tar"],
  [".text", "text/plain; charset=utf-8"],
  [".txt", "text/plain; charset=utf-8"],
  [".wasm", "application/wasm"],
  [".wav", "audio/wav"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".xml", "application/xml; charset=utf-8"],
  [".zip", "application/zip"],
]);

/** Media type essences whose UTF-8 bytes are read and edited inline as text. */
const inlineTextMediaType =
  /^(text\/|application\/(json|xml|javascript|ecmascript)$|image\/svg\+xml$)|\+(json|xml)$/u;

/** Infer a deterministic browser media type from one file name. */
export function mediaTypeForPath(filePath: string): string {
  return mediaTypesByExtension.get(path.extname(filePath).toLowerCase())
    ?? "application/octet-stream";
}

/** Whether a declared media type is one whose bytes are handled inline as text. */
export function isInlineTextMediaType(mediaType: string): boolean {
  return inlineTextMediaType.test(
    mediaType.split(";", 1)[0]?.trim().toLowerCase() ?? "",
  );
}
