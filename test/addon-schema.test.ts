import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  groupMatchesProduct,
  parseStringArray,
  validateGroup,
  PROPERTY_MAX_LENGTH,
  type GroupInput,
} from "../app/lib/addon-schema.ts";
import { centsToMoney, formatMoney, moneyToCents } from "../app/lib/money.ts";

/**
 * Covers the pure rules — what a valid group is, which products a group lands
 * on, and how prices convert. These are the parts where a quiet mistake is
 * expensive: a bad price reaches checkout, and bad targeting puts a paid add-on
 * on the wrong product.
 */

function group(overrides: Partial<GroupInput> = {}): GroupInput {
  return {
    title: "Gift options",
    appliesTo: "ALL",
    targets: [],
    selection: "MULTI",
    options: [],
    fields: [],
    ...overrides,
  };
}

describe("moneyToCents", () => {
  it("parses the formats a merchant actually types", () => {
    assert.equal(moneyToCents("4"), 400);
    assert.equal(moneyToCents("4.5"), 450);
    assert.equal(moneyToCents("4.50"), 450);
    assert.equal(moneyToCents(" 12.99 "), 1299);
    assert.equal(moneyToCents("0"), 0);
  });

  it("accepts the comma decimal separator", () => {
    assert.equal(moneyToCents("4,50"), 450);
  });

  it("rejects anything that is not a price", () => {
    for (const bad of ["", "abc", "-1", "1.234", "1.2.3", "$4", "1e3"]) {
      assert.equal(moneyToCents(bad), null, `expected ${bad} to be rejected`);
    }
  });

  it("round-trips through centsToMoney without drifting", () => {
    for (const cents of [0, 1, 99, 100, 450, 1299, 100000]) {
      assert.equal(moneyToCents(centsToMoney(cents)), cents);
    }
  });

  it("does not lose a cent to floating point", () => {
    // 0.1 + 0.2 territory: these are the values that produce 449 if the
    // conversion multiplies without rounding.
    assert.equal(moneyToCents("4.49"), 449);
    assert.equal(moneyToCents("1.15"), 115);
    assert.equal(moneyToCents("8.29"), 829);
  });
});

describe("formatMoney", () => {
  it("falls back readably on an unknown currency", () => {
    assert.equal(formatMoney(450, "NOTACURRENCY"), "4.50 NOTACURRENCY");
  });
});

describe("validateGroup", () => {
  it("accepts a minimal group", () => {
    assert.deepEqual(validateGroup(group()), {});
  });

  it("requires a title", () => {
    assert.ok(validateGroup(group({ title: "   " })).title);
  });

  it("requires targets once targeting is narrowed", () => {
    assert.ok(
      validateGroup(group({ appliesTo: "PRODUCTS", targets: [] })).targets,
    );
    assert.ok(
      validateGroup(group({ appliesTo: "COLLECTIONS", targets: [] })).targets,
    );
    assert.equal(
      validateGroup(
        group({ appliesTo: "PRODUCTS", targets: ["gid://shopify/Product/1"] }),
      ).targets,
      undefined,
    );
  });

  it("rejects an unparseable price", () => {
    // The route turns a price it cannot parse into -1 rather than 0, so that
    // a typo fails here instead of silently shipping a free add-on.
    const errors = validateGroup(
      group({ options: [{ title: "Gift wrap", priceCents: -1 }] }),
    );
    assert.ok(errors["options.0.priceCents"]);
  });

  it("allows a free add-on", () => {
    const errors = validateGroup(
      group({ options: [{ title: "Gift note", priceCents: 0 }] }),
    );
    assert.deepEqual(errors, {});
  });

  it("names the offending row so the form can mark it", () => {
    const errors = validateGroup(
      group({
        options: [
          { title: "Gift wrap", priceCents: 400 },
          { title: "", priceCents: 400 },
        ],
      }),
    );
    assert.ok(errors["options.1.title"]);
    assert.equal(errors["options.0.title"], undefined);
  });

  it("requires choices on a dropdown only", () => {
    assert.ok(
      validateGroup(
        group({ fields: [{ label: "Size", type: "SELECT", choices: [] }] }),
      )["fields.0.choices"],
    );
    assert.equal(
      validateGroup(
        group({ fields: [{ label: "Monogram", type: "TEXT", choices: [] }] }),
      )["fields.0.choices"],
      undefined,
    );
  });

  it("keeps a character limit inside what Shopify will store", () => {
    assert.ok(
      validateGroup(
        group({
          fields: [
            {
              label: "Note",
              type: "TEXT",
              maxLength: PROPERTY_MAX_LENGTH + 1,
            },
          ],
        }),
      )["fields.0.maxLength"],
    );
    assert.equal(
      validateGroup(
        group({
          fields: [
            { label: "Note", type: "TEXT", maxLength: PROPERTY_MAX_LENGTH },
          ],
        }),
      )["fields.0.maxLength"],
      undefined,
    );
  });
});

describe("groupMatchesProduct", () => {
  const product = "gid://shopify/Product/1";
  const other = "gid://shopify/Product/2";
  const inCollections = new Set(["gid://shopify/Collection/10"]);

  it("matches every product when scoped to ALL", () => {
    assert.equal(
      groupMatchesProduct({ appliesTo: "ALL", targets: "[]" }, product, new Set()),
      true,
    );
  });

  it("matches only the listed products", () => {
    const g = { appliesTo: "PRODUCTS", targets: JSON.stringify([product]) };
    assert.equal(groupMatchesProduct(g, product, new Set()), true);
    assert.equal(groupMatchesProduct(g, other, new Set()), false);
  });

  it("matches a product in any listed collection", () => {
    const g = {
      appliesTo: "COLLECTIONS",
      targets: JSON.stringify([
        "gid://shopify/Collection/10",
        "gid://shopify/Collection/11",
      ]),
    };
    assert.equal(groupMatchesProduct(g, product, inCollections), true);
    assert.equal(groupMatchesProduct(g, product, new Set()), false);
  });

  it("does not confuse a product id with a collection id", () => {
    // Both are numeric ids; only the GID prefix keeps product 10 from matching
    // a group targeting collection 10.
    const g = {
      appliesTo: "COLLECTIONS",
      targets: JSON.stringify(["gid://shopify/Product/10"]),
    };
    assert.equal(groupMatchesProduct(g, product, inCollections), false);
  });

  it("shows nothing when the mode is corrupt", () => {
    assert.equal(
      groupMatchesProduct({ appliesTo: "WHATEVER", targets: "[]" }, product, new Set()),
      false,
    );
  });
});

describe("parseStringArray", () => {
  it("survives whatever is in the column", () => {
    assert.deepEqual(parseStringArray('["a","b"]'), ["a", "b"]);
    assert.deepEqual(parseStringArray("[]"), []);
    assert.deepEqual(parseStringArray("not json"), []);
    assert.deepEqual(parseStringArray('{"a":1}'), []);
    assert.deepEqual(parseStringArray('["a",1,null,"b"]'), ["a", "b"]);
  });
});
