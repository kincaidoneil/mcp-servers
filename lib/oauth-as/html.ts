// Minimal HTML error page for upstream-callback and consent-submit routes,
// where an OAuth error cannot be safely bounced back to the client.

export function htmlErrorPage(status: number, error: string, description: string): Response {
  const safeError = escapeHtml(error);
  const safeDescription = escapeHtml(description);
  return new Response(
    `<!doctype html><html><head><title>${safeError}</title></head><body><h1>${safeError}</h1><p>${safeDescription}</p></body></html>`,
    {
      status,
      headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
    },
  );
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
