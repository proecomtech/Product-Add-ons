# Product Add-ons

A Shopify app that puts two things on a product page:

- **Paid add-ons** — gift wrap, engraving, a warranty, installation. The
  customer ticks one, and it arrives in the cart as its own line at its own
  price.
- **Personalization fields** — a monogram, a delivery date, a note. Free text,
  dropdowns, dates and checkboxes, carried to the order as line item properties
  on the product they belong to.

Both are configured together in an **add-on group**, which the merchant points
at all products, a list of products, or a list of collections.

> Built from Shopify's official Remix app template. Shopify now recommends the
> [React Router template](https://github.com/Shopify/shopify-app-template-react-router)
> for brand-new apps, since Remix v2 has merged into React Router v7. The Remix
> template is still supported; migrating later is a
> [documented path](https://github.com/Shopify/shopify-app-template-react-router/wiki/Upgrading-from-Remix).

## Running it

```sh
npm install
npm exec prisma migrate deploy   # also run for you by `shopify app dev`
shopify app config link          # connects this folder to your Partner app
npm run dev
```

`shopify app config link` is what fills in `client_id` and `application_url` in
`shopify.app.toml`. Until you run it, `shopify app dev` has no app to attach to.

**`[app_proxy].url` you have to set yourself.** It is not rewritten for you the
way `application_url` is: set it to your dev tunnel with `/proxy` on the end
while developing, and your deployed host in production, then
`shopify app deploy`. If the block renders nothing on a product page, check
this first.

Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | The pure rules — validation, targeting, price parsing |
| `npm run lint` | ESLint |
| `npm run build` | Production build |
| `npm run deploy` | `shopify app deploy` — also what registers the webhooks |

Two setup steps in the merchant's store are not optional, and the app's **Setup**
page walks through both: adding the theme app block to the product template, and
excluding the hidden add-on products from search.

## How a paid add-on gets charged

This is the part worth understanding before changing anything.

Shopify charges what the variant costs. An app that invented a price on the
product page would show one number and charge another at checkout. So each paid
add-on is backed by a **real product** in the merchant's catalog with a single
variant priced to match, and selecting the add-on puts that variant in the cart.
The price the customer sees is the price Shopify charges, because it is the same
variant.

That has consequences the code comments refer back to:

- **One product per add-on**, not one product with many variants. The cart line
  then reads "Gift wrap" rather than "Product Add-ons / Gift wrap", and two
  groups can both have a "Gift wrap" without colliding on a variant option
  value.
- **The products are `ACTIVE` and published to the Online Store.** They have to
  be: `/cart/add.js` refuses a variant whose product is draft or unpublished.
  They are kept out of sight by being in no collection and carrying the
  `product-addons-hidden` tag, which the merchant excludes from search.
- **Removing an add-on archives its product rather than deleting it.** Past
  orders reference it.
- **A failed sync is recorded, not thrown.** `AddonOption.syncError` holds the
  reason, the admin surfaces it, and the storefront hides any option without a
  variant instead of rendering a checkbox that fails on submit.

Personalization fields need none of this — they are line item properties, which
cost nothing and belong to the parent line.

## Layout

```
app/
  lib/
    addon-schema.ts          Group shape, validation, targeting rule. No database
                             import — the admin form bundles this for the browser.
    money.ts                 Cents <-> decimal string. Integers everywhere.
  models/
    addon.server.ts          Database access for groups
    addon-product.server.ts  The Admin API sync described above
  routes/
    app._index.tsx           Group list
    app.groups.$id.tsx       Group editor ("new" or an id)
    app.setup.tsx            Merchant setup instructions
    proxy.config[.]json.tsx  What the storefront block fetches
    webhooks.compliance.tsx  The three privacy webhooks
extensions/product-addons/   Theme app extension (the storefront half)
test/                        Tests for the pure rules
```

`app/lib/addon-schema.ts` exists because Remix will not bundle a module that
reaches Prisma for the browser, and the editor needs the same constants and
validation the server uses. `addon.server.ts` re-exports it so server code has a
single import.

## How the storefront half works

The theme app block renders nothing itself. It emits a container carrying the
product id and the product's collection ids — Liquid already knows both — and
`product-addons.js` fetches the matching groups from the app proxy at
`/apps/product-addons/config.json`. Passing the collection ids from Liquid is
what keeps that request to one indexed database read with no Admin API call on
the storefront path.

Adding to cart:

- **No paid add-on selected** — the script stays out of the way. Field values
  are mirrored into the form as hidden `properties[...]` inputs, and the theme's
  own add-to-cart submits them. Nothing is intercepted, so cart drawers keep
  working.
- **A paid add-on selected** — the script has to intercept, because a theme's
  form can only add one line. It posts the parent and its add-ons to
  `/cart/add.js` in one call, then hands control back to the theme.

Parent and add-on lines are tied together by a shared random token in the
hidden properties `_addon_group` / `_addon_for`. That token is what makes
"remove the shirt, lose its engraving" possible: on every page load the script
reads `/cart.js` and zeroes any add-on line whose parent is gone. It is done
that way because themes have no shared "the cart changed" event to hook.

The block's markup is built with DOM APIs rather than `innerHTML` throughout.
Add-on titles are merchant input arriving over the network, and `innerHTML`
would make the block a script injection point on every product page using it.

## Data model

`AddonGroup` has many `AddonOption` (paid) and `AddonField` (free), and belongs
to a shop. `ShopSetting` caches the shop's Online Store publication id and
currency.

SQLite has no enums, so `appliesTo`, `selection` and field `type` are strings
whose allowed values live in `app/lib/addon-schema.ts` and are enforced by
`validateGroup`. Everything that writes goes through `addon.server.ts`, so that
holds in one place. Swapping to Postgres for production is a provider change in
`prisma/schema.prisma` plus a fresh `prisma migrate dev`; nothing else depends
on SQLite.

Prices are integer cents. Never a float — `0.1 + 0.2` is how a cart subtotal
ends up a cent away from checkout.

## Scopes

| Scope | Why |
| --- | --- |
| `read_products` | Product and collection pickers, and resolving target names |
| `write_products` | Creating and pricing the product behind each paid add-on |
| `read_publications`, `write_publications` | Publishing those products to the Online Store, without which they cannot be added to a cart |

No customer data is stored, which is why the two customer privacy webhooks have
nothing to do; `shop/redact` deletes the shop's groups.
