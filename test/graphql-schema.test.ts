import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import { execute, parse, validate } from "graphql";

import {
  SCHEMA_FILE_HEADER,
  SCHEMA_SDL,
  addonGraphQLSchema,
} from "../app/graphql/schema.ts";

/**
 * The schema is a published contract: iOS and Android generate types from
 * schema.graphql, so a schema that only exists in the TypeScript source is a
 * schema the apps do not have. These tests are what makes forgetting
 * `npm run graphql:schema` a failing build instead of a mobile bug found
 * three weeks later.
 */
describe("graphql schema", () => {
  it("parses", () => {
    // buildSchema throws on invalid SDL, so reaching an assertion is the test.
    const schema = addonGraphQLSchema();
    assert.ok(schema.getQueryType(), "schema has a Query type");
  });

  it("is memoised", () => {
    assert.equal(addonGraphQLSchema(), addonGraphQLSchema());
  });

  it("matches the committed schema.graphql", () => {
    const committed = readFileSync(
      new URL("../schema.graphql", import.meta.url),
      "utf8",
    );

    // Line endings are normalised because git hands this file back as CRLF on
    // a Windows checkout. Comparing raw would fail for every developer on
    // Windows and pass on CI, which is the worst of both.
    const normalise = (text: string) => text.replace(/\r\n/g, "\n");

    assert.equal(
      normalise(committed),
      normalise(SCHEMA_FILE_HEADER + SCHEMA_SDL),
      "schema.graphql is out of date — run `npm run graphql:schema`",
    );
  });

  it("exposes both variant id forms, which is why mobile can build a cart", () => {
    const option = addonGraphQLSchema().getType("AddonOption");
    assert.ok(option && "getFields" in option);
    const fields = (option as { getFields: () => Record<string, unknown> }).getFields();
    assert.ok(fields.variantGid, "variantGid is exposed for the Storefront API");
    assert.ok(fields.variantId, "variantId is exposed for the AJAX cart");
  });
});

/**
 * `buildSchema` gives every field a default resolver that reads the matching
 * property off the value it is handed. That makes the projection in
 * addon-config.server.ts and the SDL a single contract held together by
 * nothing but matching names: rename a field on one side and the endpoint
 * quietly answers `null` instead of failing. This executes a full query
 * against the shape the route actually builds, so a rename breaks a test.
 */
describe("executing a query against the projection shape", () => {
  // Mirrors what proxy.graphql.tsx's resolver returns: buildAddonConfig's
  // output, with variantGid derived on top.
  const config = {
    currency: "USD",
    groups: [
      {
        id: "grp_1",
        heading: "Gift options",
        selection: "MULTI",
        options: [
          {
            id: "opt_1",
            title: "Gift wrap",
            description: "Recycled kraft paper",
            priceCents: 500,
            variantId: 99,
            variantGid: "gid://shopify/ProductVariant/99",
          },
        ],
        fields: [
          {
            id: "fld_1",
            label: "Gift message",
            type: "TEXTAREA",
            required: false,
            placeholder: "Up to 255 characters",
            helpText: null,
            choices: [],
            maxLength: 255,
          },
        ],
      },
    ],
  };

  const query = `
    query AddonConfig($productId: ID!, $collectionIds: [ID!]) {
      addonConfig(productId: $productId, collectionIds: $collectionIds) {
        currency
        groups {
          id
          heading
          selection
          options { id title description priceCents variantGid variantId }
          fields {
            id label type required placeholder helpText choices maxLength
          }
        }
      }
    }
  `;

  it("resolves every field the clients will ask for", async () => {
    const schema = addonGraphQLSchema();
    const document = parse(query);

    assert.deepEqual(
      validate(schema, document).map((error) => error.message),
      [],
      "the published query is valid against the published schema",
    );

    const result = await execute({
      schema,
      document,
      variableValues: { productId: "7241", collectionIds: ["1"] },
      rootValue: { addonConfig: () => config },
    });

    assert.equal(result.errors, undefined);

    const data = result.data as { addonConfig: typeof config };
    const group = data.addonConfig.groups[0];
    const option = group.options[0];
    const field = group.fields[0];

    assert.equal(data.addonConfig.currency, "USD");
    assert.equal(group.selection, "MULTI");
    assert.equal(option.priceCents, 500);
    assert.equal(field.type, "TEXTAREA");
    assert.equal(field.maxLength, 255);

    // Both id forms survive the ID serialisation, which is the whole point of
    // carrying them: the GID for a Storefront API cart, the number for
    // /cart/add.js. ID coerces to a string, so the number arrives as "99".
    assert.equal(option.variantGid, "gid://shopify/ProductVariant/99");
    assert.equal(option.variantId as unknown as string, "99");

    // Nothing resolved to null by accident.
    assert.equal(
      JSON.stringify(result.data).includes("null"),
      true,
      "helpText is genuinely null in this fixture",
    );
    assert.equal(option.description, "Recycled kraft paper");
  });
});
