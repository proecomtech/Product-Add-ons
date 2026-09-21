import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { GraphQLError, execute, parse, validate, specifiedRules } from "graphql";

import { authenticate } from "../shopify.server";
import { addonGraphQLSchema } from "../graphql/schema";
import {
  buildAddonConfig,
  emptyAddonConfig,
  type AddonConfig,
} from "../models/addon-config.server";
import { toGid, toGids } from "../lib/shopify-gid";

/**
 * The GraphQL endpoint native iOS and Android clients read add-ons from.
 *
 * Reached from a mobile app as
 *   POST https://<shop-domain>/apps/product-addons/graphql
 * which Shopify signs and forwards here, exactly as it does for the theme
 * block's JSON endpoint. That is the whole reason this lives behind the proxy
 * rather than on the app's own host: `authenticate.public.appProxy` verifies a
 * signature Shopify produced, so there is no token for the app to issue, store
 * or rotate, and nothing secret to ship inside a binary that anyone can
 * unpack. A mobile client needs only the shop's domain, which it already has.
 *
 * The schema is read-only and three levels deep, so the usual public-endpoint
 * defences — depth limits, cost analysis, persisted queries — have nothing to
 * defend against here. Introspection stays on: the schema is published to the
 * client teams as schema.graphql anyway, so disabling it would hide nothing.
 */

/** Shape of a GraphQL POST body, before it has been trusted. */
interface GraphQLRequestBody {
  query?: unknown;
  variables?: unknown;
  operationName?: unknown;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method !== "POST") {
    return errorResponse("Use POST to send a GraphQL query.", 405);
  }

  const { session } = await authenticate.public.appProxy(request);

  let body: GraphQLRequestBody;
  try {
    body = (await request.json()) as GraphQLRequestBody;
  } catch {
    return errorResponse("Request body is not valid JSON.", 400);
  }

  // A JSON array here is query batching. Rejecting it explicitly beats
  // reading `.query` off an array and reporting a confusing parse error.
  if (Array.isArray(body) || body === null || typeof body !== "object") {
    return errorResponse("Send a single GraphQL operation as a JSON object.", 400);
  }

  const { query, variables, operationName } = body;
  if (typeof query !== "string" || query.trim() === "") {
    return errorResponse("Missing the `query` field.", 400);
  }
  if (variables != null && typeof variables !== "object") {
    return errorResponse("`variables` must be an object.", 400);
  }
  if (operationName != null && typeof operationName !== "string") {
    return errorResponse("`operationName` must be a string.", 400);
  }

  const schema = addonGraphQLSchema();

  let document;
  try {
    document = parse(query);
  } catch (error) {
    return graphQLErrorResponse(error, 400);
  }

  const validationErrors = validate(schema, document, specifiedRules);
  if (validationErrors.length > 0) {
    // 400, not 200: the query is malformed against the schema, which is a
    // client bug worth surfacing loudly during mobile development.
    return jsonResponse({ errors: validationErrors.map(formatError) }, 400);
  }

  const result = await execute({
    schema,
    document,
    operationName: operationName ?? undefined,
    variableValues: (variables as Record<string, unknown> | null) ?? undefined,
    // No session means the app is not installed on this shop. Resolvers answer
    // with an empty configuration in that case rather than throwing, for the
    // same reason the JSON endpoint does.
    rootValue: resolvers(session?.shop ?? null),
  });

  return jsonResponse(
    {
      ...(result.data !== undefined ? { data: result.data } : {}),
      ...(result.errors ? { errors: result.errors.map(formatError) } : {}),
    },
    200,
  );
};

/**
 * A GET reaches the browser, a crawler, or a developer checking the URL by
 * hand — never the mobile client, which posts. Answering with a plain
 * explanation is friendlier than the 405 that a missing loader would produce,
 * and cheaper than supporting queries over the query string.
 */
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.public.appProxy(request);
  return errorResponse(
    "Send GraphQL queries as POST with a JSON body: { \"query\": \"...\" }.",
    405,
  );
};

interface AddonConfigArgs {
  productId: string;
  collectionIds?: string[] | null;
}

/**
 * Root resolvers. `buildSchema` gives every field a default resolver that
 * reads the matching property, so only the root query needs writing — the
 * projection in addon-config.server.ts already names its fields to match the
 * schema.
 */
function resolvers(shop: string | null) {
  return {
    addonConfig: async ({
      productId,
      collectionIds,
    }: AddonConfigArgs): Promise<AddonConfig> => {
      if (!shop) return emptyAddonConfig();

      const productGid = toGid("Product", productId);
      if (!productGid) return emptyAddonConfig();

      const config = await buildAddonConfig(
        shop,
        productGid,
        toGids("Collection", collectionIds ?? []),
      );

      // `variantGid` is derived rather than stored so the JSON endpoint's
      // payload stays exactly as the theme block expects it.
      return {
        ...config,
        groups: config.groups.map((group) => ({
          ...group,
          options: group.options.map((option) => ({
            ...option,
            variantGid: `gid://shopify/ProductVariant/${option.variantId}`,
          })),
        })),
      };
    },
  };
}

function formatError(error: GraphQLError | Error) {
  if (error instanceof GraphQLError) {
    const formatted = error.toJSON();
    // `extensions` can carry the stack in development. Strip it: this response
    // goes to a storefront visitor's phone.
    const { extensions: _extensions, ...safe } = formatted;
    return safe;
  }
  return { message: error.message };
}

function graphQLErrorResponse(error: unknown, status: number) {
  const message =
    error instanceof GraphQLError
      ? error.message
      : "The query could not be parsed.";
  return jsonResponse({ errors: [{ message }] }, status);
}

function errorResponse(message: string, status: number) {
  return jsonResponse({ errors: [{ message }] }, status);
}

function jsonResponse(payload: unknown, status: number) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      // Same reasoning as the JSON endpoint: a merchant who edits a group
      // expects the next request to reflect it.
      "Cache-Control": "no-store",
    },
  });
}
