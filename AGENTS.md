# Product Add-ons — working notes

Read `README.md` first; it explains what the app does and why paid add-ons are
backed by real products. This file is only the things that are easy to get wrong.

Use the [Shopify AI Toolkit](https://shopify.dev/docs/apps/build/ai-toolkit) for
Shopify API and platform questions. If it is missing, install it in the agent
host per that page — do not add tooling to this repo.

## Before you commit

```sh
npm test && npm run lint && npx tsc --noEmit && npm run build
```

## Things that will bite

- **`app/lib/*.ts` must never import the database.** The group editor runs in
  the browser and imports `addon-schema.ts` and `money.ts`. Add a Prisma import
  to either and the build fails with "Server-only module referenced by client".
  Server-only helpers belong in `app/models/*.server.ts`.
- **Prices are integer cents.** `moneyToCents` returns `null` for anything
  unparseable, and the route turns that into `-1` so validation rejects it. Do
  not default it to `0` — that ships a free add-on.
- **Scope every query by `shop`.** Group ids are guessable cuids. `getGroup`,
  `deleteGroup` and `setGroupActive` all take the shop and filter on it; keep
  new queries doing the same, and prefer `deleteMany`/`updateMany` with a shop
  filter over `delete`/`update` by id.
- **Never `innerHTML` in the theme extension.** Add-on titles are merchant
  input fetched over the network. The block builds every node with
  `document.createElement` and `textContent` for that reason.
- **Do not delete a generated add-on product.** Archive it. Past orders
  reference it.
- **Sync failures are recorded, not thrown.** One bad add-on must not stop the
  other nine going live, and must never fail the merchant's save. The pattern is
  in `syncGroupOptions`.

## The API version is pinned in two places

`shopify.app.toml` (`[webhooks].api_version`) and `app/shopify.server.ts`
(`ApiVersion.January25`). Change both together, and re-check the GraphQL
mutation shapes in `addon-product.server.ts` — `productCreate` and
`productUpdate` take a `product:` argument on 2024-10 and later, not `input:`.

## Deploying changes to the app configuration

Webhook subscriptions, scopes and the app proxy in `shopify.app.toml` take
effect on `shopify app deploy`, not on save. Shopify's automated review reads
the deployed app version, so an undeployed change to the compliance webhooks
still fails the check.
