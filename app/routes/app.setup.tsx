import type { LoaderFunctionArgs } from "@remix-run/node";
import { useLoaderData } from "@remix-run/react";
import {
  BlockStack,
  Box,
  Card,
  Layout,
  Link,
  List,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { ADDON_TAG } from "../models/addon-product.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  return { shop: session.shop, addonTag: ADDON_TAG };
};

/** The Liquid a merchant pastes into their search template. */
function searchSnippet(addonTag: string): string {
  return [
    "{%- for item in search.results -%}",
    `  {%- if item.tags contains '${addonTag}' -%}{%- continue -%}{%- endif -%}`,
    "  {%- comment -%} ...your existing result markup... {%- endcomment -%}",
    "{%- endfor -%}",
  ].join("\n");
}

export default function Setup() {
  const { shop, addonTag } = useLoaderData<typeof loader>();
  const themeEditorUrl = `https://${shop}/admin/themes/current/editor?template=product`;

  return (
    <Page>
      <TitleBar title="Setup" />
      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  1. Add the block to your product template
                </Text>
                <Text as="p">
                  Add-ons render through a theme app block, so you choose where
                  on the page they appear.
                </Text>
                <List type="number">
                  <List.Item>
                    Open the{" "}
                    <Link url={themeEditorUrl} target="_blank">
                      product template in your theme editor
                    </Link>
                    .
                  </List.Item>
                  <List.Item>
                    In the product information section, click{" "}
                    <b>Add block</b>.
                  </List.Item>
                  <List.Item>
                    Under <b>Apps</b>, choose <b>Product add-ons</b>.
                  </List.Item>
                  <List.Item>
                    Drag it directly above the add to cart button, then save.
                  </List.Item>
                </List>
                <Text as="p" tone="subdued">
                  The block renders nothing on products that no group targets,
                  so it is safe to leave in place on every product.
                </Text>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  2. Hide the add-on products from your storefront
                </Text>
                <Text as="p">
                  A paid add-on is charged by adding a real product to the cart
                  — that is what makes the price on the product page the price
                  checkout charges. Shopify will not let a draft or unpublished
                  product into a cart, so these have to be active and published
                  to the Online Store.
                </Text>
                <Text as="p">
                  They are in no collection, so they will not appear in your
                  navigation. To keep them out of search results too, every one
                  is tagged <b>{addonTag}</b>. Exclude it in your search
                  template:
                </Text>
                <Box
                  background="bg-surface-secondary"
                  padding="300"
                  borderRadius="200"
                  overflowX="scroll"
                >
                  <pre
                    style={{
                      margin: 0,
                      fontSize: "0.8125rem",
                      lineHeight: 1.5,
                      whiteSpace: "pre",
                    }}
                  >
                    <code>{searchSnippet(addonTag)}</code>
                  </pre>
                </Box>
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="300">
                <Text as="h2" variant="headingMd">
                  3. Check it on a product
                </Text>
                <List>
                  <List.Item>
                    Create a group, point it at a product, and save. Saving is
                    what creates the hidden products behind your paid add-ons.
                  </List.Item>
                  <List.Item>
                    Open that product on your storefront. Tick an add-on and add
                    to cart — the add-on arrives as its own cart line, tied to
                    the item it was bought for.
                  </List.Item>
                  <List.Item>
                    Removing the main item from the cart removes its add-ons
                    with it.
                  </List.Item>
                </List>
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
