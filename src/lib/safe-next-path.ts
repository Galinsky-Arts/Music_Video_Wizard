/** Only same-site relative paths are honored as post-auth destinations. */
export function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/app";
  return value;
}
