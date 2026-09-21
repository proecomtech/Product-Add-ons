/**
 * What the app tells the outside world about a product's add-ons.
 *
 * Two public surfaces read this: the storefront theme block, over
 * `/apps/product-addons/config.json` (app/routes/proxy.config[.]json.tsx), and
 * native iOS/Android clients, over `/apps/product-addons/graphql`
 * (app/routes/proxy.graphql.tsx). The projection lives here so that a change
 * to what is public happens once. Two copies would eventually disagree about
 * which add-ons a product has, and the one that is wrong would be the one
 * nobody is looking at.
 *
 * Nothing here trusts its caller: ids arrive from a storefront page or a
 * mobile binary, so they are parsed into GIDs rather than interpolated.
 */

import { getShopSetting } from "./addon-product.server";
import { groupsForProduct, parseStringArray } from "./addon.server";

import type { FieldType, Selection } from "../lib/addon-schema";

export interface AddonConfigOption {
  id: string;
  title: string;
  description: string | null;
  priceCents: number;
  /**
   * The numeric variant id. `/cart/add.js` takes this form, not the GID.
   * GraphQL clients that build a cart through the Storefront API want the GID
   * instead — the resolver derives it from this.
   */
  variantId: number;
}

export interface AddonConfigField {
  id: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder: string | null;
  helpText: string | null;
  choices: string[];
  maxLength: number | null;
}

export interface AddonConfigGroup {
  id: string;
  heading: string;
  selection: Selection;
  options: AddonConfigOption[];
  fields: AddonConfigField[];
}

export interface AddonConfig {
  currency: string;
  groups: AddonConfigGroup[];
}

/**
 * The answer when there is nothing to show — an uninstalled shop, or a product
 * id that did not parse. Callers return this rather than an error: the
 * storefront block is embedded in someone's product page and should render
 * nothing, and a mobile client should get an empty list, not a failure to
 * handle.
 */
export function emptyAddonConfig(): AddonConfig {
  return { currency: "USD", groups: [] };
}

export async function buildAddonConfig(
  shop: string,
  productGid: string,
  collectionGids: string[],
): Promise<AddonConfig> {
  const [groups, setting] = await Promise.all([
    groupsForProduct(shop, productGid, collectionGids),
    getShopSetting(shop),
  ]);

  return {
    currency: setting.currencyCode,
    groups: groups
      .map((group) => ({
        id: group.id,
        heading: group.heading || group.title,
        selection: group.selection as Selection,
        options: group.options
          // An option with no variant cannot be added to a cart. Hiding it
          // beats rendering a checkbox that fails on submit.
          .filter((option) => Boolean(option.variantGid))
          .map((option) => ({
            id: option.id,
            title: option.title,
            description: option.description,
            priceCents: option.priceCents,
            variantId: Number(option.variantGid!.split("/").pop()),
          })),
        fields: group.fields.map((field) => ({
          id: field.id,
          label: field.label,
          type: field.type as FieldType,
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
}
