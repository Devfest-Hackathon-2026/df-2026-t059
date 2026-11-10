import assert from "node:assert/strict";

export async function expectPageRedirect(response: Response, destination: string) {
  if ([303, 307, 308].includes(response.status)) {
    assert.equal(response.headers.get("location"), destination, `Redirect from ${response.url}`);
    return;
  }

  // Next.js can flush the loading UI before redirect(), then insert this meta tag.
  assert.equal(response.status, 200, `Expected a redirect from ${response.url}`);
  const html = await response.text();
  const target = html.match(/<meta id="__next-page-redirect" http-equiv="refresh" content="[01];url=([^"]*)"\s*\/?>/)?.[1];
  const escaped = destination.replaceAll("&", "&amp;").replaceAll('"', "&quot;")
    .replaceAll("'", "&#x27;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  assert.equal(target, escaped, `Streamed redirect from ${response.url}`);
}

export async function expectNotFoundPage(response: Response) {
  if (response.status === 404) return;

  // Once streaming starts, Next.js returns noindex and may let React render the 404 fallback.
  assert.equal(response.status, 200, `Expected a 404 page at ${response.url}`);
  const html = await response.text();
  assert.ok(/<meta name="robots" content="noindex"\s*\/?>/.test(html), `Missing noindex at ${response.url}`);
  assert.ok(
    /<h1 class="next-error-h1"[^>]*>404<\/h1>/.test(html)
      || /\$RX\("B:[^"]+","NEXT_HTTP_ERROR_FALLBACK;404"\)/.test(html),
    `Missing 404 fallback at ${response.url}`,
  );
}
