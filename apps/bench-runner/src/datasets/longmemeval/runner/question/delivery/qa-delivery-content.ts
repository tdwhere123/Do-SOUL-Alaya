export function normalizeQaDeliveryContent(content: string): string {
  return content.replace(/\s+/gu, " ").trim();
}
