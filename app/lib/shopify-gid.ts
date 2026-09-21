/**
 * Turning an id from an untrusted caller into a Shopify GID.
 *
 * The two public readers disagree about what an id looks like, and both are
 * right. Liquid hands the theme block a bare number (`7241...`), because that
 * is what `product.id` is. A native app driving the Storefront API holds a
 * GID (`gid://shopify/Product/7241...`), because that is what the Storefront
 * API returns. Rather than make either side convert before it asks, both forms
 * are accepted here and normalised to the GID the database stores.
 *
 * No `.server` suffix and no imports: this is pure string handling, so the
 * tests can load it directly.
 */

/**
 * `null` for anything that is not one of the two accepted forms — including a
 * GID for the wrong resource type, which is how a collection id passed as a
 * product id gets caught instead of quietly matching nothing.
 */
export function toGid(resource: string, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;

  if (/^\d+$/.test(trimmed)) {
    return `gid://shopify/${resource}/${trimmed}`;
  }

  const match = /^gid:\/\/shopify\/([A-Za-z]+)\/(\d+)$/.exec(trimmed);
  if (match && match[1] === resource) {
    return `gid://shopify/${resource}/${match[2]}`;
  }

  return null;
}

/** The same, for a list: anything unparseable is dropped rather than failing
 * the whole request. A bad collection id should narrow the match, not break
 * the product page. */
export function toGids(resource: string, values: readonly string[]): string[] {
  return values
    .map((value) => toGid(resource, value))
    .filter((gid): gid is string => gid !== null);
}

/** Splits the theme block's comma-joined `collections` parameter. */
export function toGidsFromCsv(resource: string, value: string | null): string[] {
  if (!value) return [];
  return toGids(resource, value.split(","));
}

/** The numeric half of a GID, for the AJAX cart endpoints that want it. */
export function idFromGid(gid: string): string | null {
  const match = /^gid:\/\/shopify\/[A-Za-z]+\/(\d+)$/.exec(gid.trim());
  return match ? match[1] : null;
}
