import type { LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import {
  buildAddonConfig,
  emptyAddonConfig,
} from "../models/addon-config.server";
import { toGid, toGidsFromCsv } from "../lib/shopify-gid";

/**
 * The storefront block's data source.
 *
 * Reached from the storefront as
 *   /apps/product-addons/config.json?product=<id>&collections=<id,id>
 * which Shopify forwards here with a signed query string that
 * `authenticate.public.appProxy` verifies. An unsigned or tampered request
 * throws before any database read.
 *
 * The theme sends the product's collection ids because Liquid already knows
 * them — that keeps this endpoint to one indexed database read, with no Admin
 * API call on the hot storefront path.
 *
 * The response body is built by addon-config.server.ts, shared with the
 * GraphQL endpoint that native clients use (app/routes/proxy.graphql.tsx).
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  // No session means the app is not installed on this shop. Answer with an
  // empty config rather than an error: the block is embedded in the theme and
  // should render nothing, not a broken product page.
  if (!session) {
    return jsonResponse(emptyAddonConfig());
  }

  const url = new URL(request.url);
  const productGid = toGid("Product", url.searchParams.get("product") ?? "");
  if (!productGid) {
    return jsonResponse(emptyAddonConfig());
  }

  const payload = await buildAddonConfig(
    session.shop,
    productGid,
    toGidsFromCsv("Collection", url.searchParams.get("collections")),
  );

  return jsonResponse(payload);
};

function jsonResponse(payload: unknown) {
  return new Response(JSON.stringify(payload), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Not cached: a merchant who edits a group expects the product page to
      // reflect it on the next load, which is the reason this is a proxy call
      // rather than a metafield baked into the theme.
      "Cache-Control": "no-store",
    },
  });
}
