export function attachmentDisposition(fileName: string): string {
  const fallback = fileName.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/['()*]/g,
    character => "%" + character.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}
