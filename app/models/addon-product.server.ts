import prisma from "../db.server";
import { centsToMoney } from "../lib/money";

/**
 * Keeps each paid add-on backed by a real, purchasable Shopify product.
 *
 * WHY A PRODUCT AT ALL
 * --------------------
 * Shopify charges what the variant costs. If the app invented a price on the
 * product page, the storefront would show one number and checkout would charge
 * another. So every paid add-on gets its own hidden product with a single
 * variant priced to match, and selecting the add-on puts that variant in the
 * cart as its own line. The price the customer sees IS the price Shopify
 * charges, because it is the same variant.
 *
 * WHY ONE PRODUCT PER ADD-ON, NOT ONE PRODUCT WITH MANY VARIANTS
 * --------------------------------------------------------------
 * Two reasons. The cart line reads "Gift wrap" instead of
 * "Product Add-ons / Gift wrap". And variant option values have to be unique
 * within a product, so two groups could not each have a "Gift wrap" without
 * the app mangling one of the names.
 *
 * WHY THE PRODUCTS ARE ACTIVE AND PUBLISHED
 * -----------------------------------------
 * /cart/add.js refuses a variant whose product is draft or unpublished from the
 * Online Store, so these cannot be hidden that way. They are kept out of sight
 * instead by being in no collection, carrying the ADDON_TAG, and having a
 * handle prefix — see hideFromStorefront() notes in the README. Merchants
 * should exclude `tag:product-addons-hidden` from their search and collection
 * templates.
 */

type AdminClient = {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
};

/** Tag every generated product carries, so they can be filtered out in bulk. */
export const ADDON_TAG = "product-addons-hidden";

const ADDON_VENDOR = "Product Add-ons";
const ADDON_PRODUCT_TYPE = "Add-on";

interface UserError {
  field?: string[] | null;
  message: string;
}

/** Turns GraphQL transport errors and userErrors into one thrown Error. */
function assertNoErrors(
  payload: { data?: unknown; errors?: unknown },
  userErrors: UserError[] | undefined,
  what: string,
): void {
  if (payload.errors) {
    throw new Error(`${what}: ${JSON.stringify(payload.errors)}`);
  }
  if (userErrors && userErrors.length > 0) {
    throw new Error(
      `${what}: ${userErrors.map((error) => error.message).join("; ")}`,
    );
  }
}

export async function getShopSetting(shop: string) {
  return prisma.shopSetting.upsert({
    where: { shop },
    create: { shop },
    update: {},
  });
}

/**
 * The shop's Online Store publication GID, cached after the first lookup
 * because it never changes for a shop.
 */
async function onlineStorePublicationId(
  admin: AdminClient,
  shop: string,
): Promise<string> {
  const setting = await getShopSetting(shop);
  if (setting.onlineStorePublicationId) {
    return setting.onlineStorePublicationId;
  }

  const response = await admin.graphql(
    `#graphql
      query AddonOnlineStorePublication {
        publications(first: 25) {
          nodes { id name }
        }
      }`,
  );
  const payload = await response.json();
  assertNoErrors(payload, undefined, "Reading publications");

  const nodes: Array<{ id: string; name: string }> =
    payload.data?.publications?.nodes ?? [];
  const onlineStore =
    nodes.find((node) => node.name === "Online Store") ?? nodes[0];

  if (!onlineStore) {
    throw new Error(
      "This shop has no Online Store sales channel, so add-ons cannot be added to a cart.",
    );
  }

  await prisma.shopSetting.update({
    where: { shop },
    data: { onlineStorePublicationId: onlineStore.id },
  });
  return onlineStore.id;
}

/** Refreshes the cached shop currency. Best effort: never throws. */
export async function refreshShopCurrency(admin: AdminClient, shop: string) {
  const setting = await getShopSetting(shop);
  try {
    const response = await admin.graphql(
      `#graphql
        query AddonShopCurrency {
          shop { currencyCode }
        }`,
    );
    const payload = await response.json();
    const currencyCode = payload.data?.shop?.currencyCode;
    if (currencyCode && currencyCode !== setting.currencyCode) {
      return prisma.shopSetting.update({
        where: { shop },
        data: { currencyCode },
      });
    }
  } catch {
    // A currency symbol is cosmetic; keep the cached value rather than
    // failing the page load over it.
  }
  return setting;
}

interface SyncableOption {
  id: string;
  title: string;
  description: string | null;
  priceCents: number;
  requiresShipping: boolean;
  productGid: string | null;
  variantGid: string | null;
}

/**
 * Brings every paid option in a group in line with its backing product,
 * creating what is missing and updating what drifted.
 *
 * Each option is synced independently and its own failure is recorded in
 * `syncError` rather than thrown, so one bad add-on cannot stop the other
 * nine from going live. Returns the number that failed.
 */
export async function syncGroupOptions(
  admin: AdminClient,
  shop: string,
  options: SyncableOption[],
): Promise<{ synced: number; failed: number }> {
  if (options.length === 0) return { synced: 0, failed: 0 };

  let publicationId: string;
  try {
    publicationId = await onlineStorePublicationId(admin, shop);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await prisma.addonOption.updateMany({
      where: { id: { in: options.map((option) => option.id) } },
      data: { syncError: message },
    });
    return { synced: 0, failed: options.length };
  }

  let synced = 0;
  let failed = 0;

  for (const option of options) {
    try {
      let result: { productGid: string; variantGid: string };
      if (option.productGid) {
        try {
          result = await updateAddonProduct(admin, option);
        } catch (error) {
          if (!(error instanceof ProductMissingError)) throw error;
          // The merchant deleted the generated product. Forget the dead GID
          // and build a replacement in the same pass, so the add-on is live
          // again without them having to guess that a second save is needed.
          result = await createAddonProduct(
            admin,
            { ...option, productGid: null, variantGid: null },
            publicationId,
          );
        }
      } else {
        result = await createAddonProduct(admin, option, publicationId);
      }
      const { productGid, variantGid } = result;

      await prisma.addonOption.update({
        where: { id: option.id },
        data: { productGid, variantGid, syncError: null },
      });
      synced += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await prisma.addonOption.update({
        where: { id: option.id },
        data: { syncError: message },
      });
      failed += 1;
    }
  }

  return { synced, failed };
}

async function createAddonProduct(
  admin: AdminClient,
  option: SyncableOption,
  publicationId: string,
): Promise<{ productGid: string; variantGid: string }> {
  const response = await admin.graphql(
    `#graphql
      mutation AddonProductCreate($product: ProductCreateInput!) {
        productCreate(product: $product) {
          product {
            id
            variants(first: 1) { nodes { id } }
          }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        product: {
          title: option.title,
          descriptionHtml: option.description ?? "",
          vendor: ADDON_VENDOR,
          productType: ADDON_PRODUCT_TYPE,
          tags: [ADDON_TAG],
          status: "ACTIVE",
        },
      },
    },
  );
  const payload = await response.json();
  assertNoErrors(
    payload,
    payload.data?.productCreate?.userErrors,
    `Creating the product for "${option.title}"`,
  );

  const productGid: string | undefined = payload.data?.productCreate?.product?.id;
  const variantGid: string | undefined =
    payload.data?.productCreate?.product?.variants?.nodes?.[0]?.id;

  if (!productGid || !variantGid) {
    throw new Error(
      `Creating the product for "${option.title}": Shopify returned no product.`,
    );
  }

  await updateAddonVariant(admin, productGid, variantGid, option);
  await publishAddonProduct(admin, productGid, publicationId);

  return { productGid, variantGid };
}

async function updateAddonProduct(
  admin: AdminClient,
  option: SyncableOption,
): Promise<{ productGid: string; variantGid: string }> {
  const productGid = option.productGid!;

  const response = await admin.graphql(
    `#graphql
      mutation AddonProductUpdate($product: ProductUpdateInput!) {
        productUpdate(product: $product) {
          product {
            id
            variants(first: 1) { nodes { id } }
          }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        product: {
          id: productGid,
          title: option.title,
          descriptionHtml: option.description ?? "",
        },
      },
    },
  );
  const payload = await response.json();

  // A merchant can delete the generated product by hand. Shopify answers that
  // with a userError on the id rather than a transport error, which is the
  // signal to rebuild it. Deliberately NOT keyed off `payload.errors` — a
  // throttle or a network blip also lands there, and treating those as
  // "missing" would create a duplicate product on every retry.
  const userErrors: UserError[] =
    payload.data?.productUpdate?.userErrors ?? [];
  const productMissing =
    payload.data?.productUpdate?.product == null &&
    userErrors.some((error) => /exist|not found|invalid id/i.test(error.message));
  if (productMissing) {
    throw new ProductMissingError(option.id);
  }
  assertNoErrors(
    payload,
    payload.data?.productUpdate?.userErrors,
    `Updating the product for "${option.title}"`,
  );

  const variantGid: string =
    payload.data?.productUpdate?.product?.variants?.nodes?.[0]?.id ??
    option.variantGid;

  if (!variantGid) {
    throw new Error(
      `Updating the product for "${option.title}": it has no variant.`,
    );
  }

  await updateAddonVariant(admin, productGid, variantGid, option);
  return { productGid, variantGid };
}

/** Thrown when the backing product has been deleted out from under the app. */
export class ProductMissingError extends Error {
  constructor(public optionId: string) {
    super(
      "The product behind this add-on was deleted in Shopify. Save the group again to recreate it.",
    );
    this.name = "ProductMissingError";
  }
}

async function updateAddonVariant(
  admin: AdminClient,
  productGid: string,
  variantGid: string,
  option: SyncableOption,
): Promise<void> {
  const response = await admin.graphql(
    `#graphql
      mutation AddonVariantUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id price }
          userErrors { field message }
        }
      }`,
    {
      variables: {
        productId: productGid,
        variants: [
          {
            id: variantGid,
            price: centsToMoney(option.priceCents),
            taxable: true,
            // Not tracked, so an add-on never goes "out of stock" and never
            // needs an inventory record topping up.
            inventoryItem: {
              tracked: false,
              requiresShipping: option.requiresShipping,
            },
          },
        ],
      },
    },
  );
  const payload = await response.json();
  assertNoErrors(
    payload,
    payload.data?.productVariantsBulkUpdate?.userErrors,
    `Pricing "${option.title}"`,
  );
}

async function publishAddonProduct(
  admin: AdminClient,
  productGid: string,
  publicationId: string,
): Promise<void> {
  const response = await admin.graphql(
    `#graphql
      mutation AddonProductPublish($id: ID!, $input: [PublicationInput!]!) {
        publishablePublish(id: $id, input: $input) {
          userErrors { field message }
        }
      }`,
    { variables: { id: productGid, input: [{ publicationId }] } },
  );
  const payload = await response.json();
  assertNoErrors(
    payload,
    payload.data?.publishablePublish?.userErrors,
    "Publishing the add-on to the Online Store",
  );
}

/**
 * Archives the products behind add-ons the merchant removed.
 *
 * Archived rather than deleted on purpose: past orders reference these
 * products, and deleting one turns the line on an old order into an orphan.
 * Best effort — a failure here leaves a stray archived-able product, which is
 * untidy but harmless, and must not fail the merchant's save.
 */
export async function archiveAddonProducts(
  admin: AdminClient,
  productGids: string[],
): Promise<void> {
  for (const productGid of productGids) {
    try {
      const response = await admin.graphql(
        `#graphql
          mutation AddonProductArchive($product: ProductUpdateInput!) {
            productUpdate(product: $product) {
              product { id }
              userErrors { field message }
            }
          }`,
        { variables: { product: { id: productGid, status: "ARCHIVED" } } },
      );
      await response.json();
    } catch {
      // Intentionally swallowed; see the note above.
    }
  }
}
