import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  idFromGid,
  toGid,
  toGids,
  toGidsFromCsv,
} from "../app/lib/shopify-gid.ts";

/**
 * Ids reach these functions from a storefront page and from a mobile binary,
 * neither of which the app controls. The interesting cases are the ones that
 * must NOT produce a GID: anything that did would be interpolated into a
 * database lookup, and a caller that can choose the resource type can ask
 * about rows that are not theirs to see.
 */
describe("toGid", () => {
  it("accepts a bare numeric id, which is what Liquid hands the theme block", () => {
    assert.equal(toGid("Product", "7241"), "gid://shopify/Product/7241");
  });

  it("accepts a GID, which is what the Storefront API hands a mobile app", () => {
    assert.equal(
      toGid("Product", "gid://shopify/Product/7241"),
      "gid://shopify/Product/7241",
    );
  });

  it("tolerates surrounding whitespace", () => {
    assert.equal(toGid("Product", "  7241 "), "gid://shopify/Product/7241");
  });

  it("rejects a GID for a different resource", () => {
    // A collection id passed as a product id is a client bug. Returning null
    // surfaces it, where building the wrong GID would silently match nothing.
    assert.equal(toGid("Product", "gid://shopify/Collection/7241"), null);
  });

  it("rejects ids that are not plain digits", () => {
    for (const value of [
      "",
      "   ",
      "abc",
      "72a41",
      "-1",
      "7241; DROP TABLE",
      "7241 OR 1=1",
      "gid://shopify/Product/abc",
      "gid://shopify/Product/7241/extra",
      "gid://evil/Product/7241",
      "../7241",
    ]) {
      assert.equal(toGid("Product", value), null, `should reject ${value}`);
    }
  });
});

describe("toGids", () => {
  it("drops the unparseable rather than failing the request", () => {
    // A bad collection id should narrow which groups match, not break the
    // product screen.
    assert.deepEqual(toGids("Collection", ["1", "nope", "2"]), [
      "gid://shopify/Collection/1",
      "gid://shopify/Collection/2",
    ]);
  });

  it("returns an empty list for an empty input", () => {
    assert.deepEqual(toGids("Collection", []), []);
  });
});

describe("toGidsFromCsv", () => {
  it("splits the theme block's comma-joined parameter", () => {
    assert.deepEqual(toGidsFromCsv("Collection", "1,2 , 3"), [
      "gid://shopify/Collection/1",
      "gid://shopify/Collection/2",
      "gid://shopify/Collection/3",
    ]);
  });

  it("treats a missing or empty parameter as no collections", () => {
    assert.deepEqual(toGidsFromCsv("Collection", null), []);
    assert.deepEqual(toGidsFromCsv("Collection", ""), []);
  });

  it("ignores the empty entries a trailing comma leaves behind", () => {
    assert.deepEqual(toGidsFromCsv("Collection", "1,,"), [
      "gid://shopify/Collection/1",
    ]);
  });
});

describe("idFromGid", () => {
  it("recovers the numeric id the AJAX cart needs", () => {
    assert.equal(idFromGid("gid://shopify/ProductVariant/99"), "99");
  });

  it("returns null for anything that is not a GID", () => {
    assert.equal(idFromGid("99"), null);
    assert.equal(idFromGid(""), null);
  });
});
