import type { LoaderFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import { getShopSetting } from "../models/addon-product.server";
import { groupsForProduct, parseStringArray } from "../models/addon.server";

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
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.public.appProxy(request);

  // No session means the app is not installed on this shop. Answer with an
  // empty config rather than an error: the block is embedded in the theme and
  // should render nothing, not a broken product page.
  if (!session) {
    return emptyConfig();
  }

  const url = new URL(request.url);
  const productParam = url.searchParams.get("product");
  if (!productParam || !/^\d+$/.test(productParam)) {
    return emptyConfig();
  }

  const productGid = `gid://shopify/Product/${productParam}`;
  const collectionGids = (url.searchParams.get("collections") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id))
    .map((id) => `gid://shopify/Collection/${id}`);

  const [groups, setting] = await Promise.all([
    groupsForProduct(session.shop, productGid, collectionGids),
    getShopSetting(session.shop),
  ]);

  const payload = {
    currency: setting.currencyCode,
    groups: groups
      .map((group) => ({
        id: group.id,
        heading: group.heading || group.title,
        selection: group.selection,
        options: group.options
          // An option with no variant cannot be added to a cart. Hiding it
          // beats rendering a checkbox that fails on submit.
          .filter((option) => Boolean(option.variantGid))
          .map((option) => ({
            id: option.id,
            title: option.title,
            description: option.description,
            priceCents: option.priceCents,
            // /cart/add.js takes the numeric variant id, not the GID.
            variantId: Number(option.variantGid!.split("/").pop()),
          })),
        fields: group.fields.map((field) => ({
          id: field.id,
          label: field.label,
          type: field.type,
          required: field.required,
          placeholder: field.placeholder,
          helpText: field.helpText,
          choices: parseStringArray(field.choices),
          maxLength: field.maxLength,
        })),
      }))
      // A group whose every paid option failed to sync and that has no fields
      // would render as an empty heading.
      .filter((group) => group.options.length > 0 || group.fields.length > 0),
  };

  return jsonResponse(payload);
};

function emptyConfig() {
  return jsonResponse({ currency: "USD", groups: [] });
}

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
