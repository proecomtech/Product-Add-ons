import type { ActionFunctionArgs } from "@remix-run/node";

import { authenticate } from "../shopify.server";
import db from "../db.server";

/**
 * The three privacy webhooks every public app must answer.
 *
 * This app stores no customer data — add-on groups belong to the shop, and the
 * customer's choices live on the order in Shopify, not here. So the two
 * customer topics have nothing to return or erase and simply acknowledge.
 * shop/redact does have work to do: it means the shop uninstalled 48 hours ago
 * and its data must go.
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);

  switch (topic) {
    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      // Nothing stored against a customer. Acknowledging is the correct
      // response — Shopify only requires that the endpoint answer 200.
      break;

    case "SHOP_REDACT":
      // Cascades to the groups' options and fields. The hidden add-on products
      // are not touched: they live in the merchant's own catalog and are
      // referenced by their past orders.
      await db.addonGroup.deleteMany({ where: { shop } });
      await db.shopSetting.deleteMany({ where: { shop } });
      await db.session.deleteMany({ where: { shop } });
      break;

    default:
      // An unexpected topic on this endpoint is a configuration error, not a
      // request to act on.
      return new Response("Unhandled webhook topic", { status: 404 });
  }

  return new Response();
};
