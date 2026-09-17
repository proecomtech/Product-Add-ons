import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { useState } from "react";
import { Link, useFetcher, useLoaderData, useNavigate } from "@remix-run/react";
import {
  Badge,
  BlockStack,
  Banner,
  Button,
  Card,
  EmptyState,
  IndexTable,
  InlineStack,
  Modal,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import {
  deleteGroup,
  listGroups,
  parseStringArray,
  setGroupActive,
} from "../models/addon.server";
import {
  archiveAddonProducts,
  getShopSetting,
  refreshShopCurrency,
} from "../models/addon-product.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);

  const [groups, setting] = await Promise.all([
    listGroups(session.shop),
    refreshShopCurrency(admin, session.shop).catch(() =>
      getShopSetting(session.shop),
    ),
  ]);

  return {
    currencyCode: setting.currencyCode,
    groups: groups.map((group) => ({
      id: group.id,
      title: group.title,
      active: group.active,
      appliesTo: group.appliesTo,
      targetCount: parseStringArray(group.targets).length,
      optionCount: group.options.length,
      fieldCount: group.fields.length,
      // Only paid options can fail to sync; a field is just markup.
      syncErrors: group.options.filter((option) => option.syncError).length,
      pendingSync: group.options.filter((option) => !option.variantGid).length,
    })),
  };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent"));
  const id = String(formData.get("id"));

  if (intent === "toggle") {
    const active = formData.get("active") === "true";
    const ok = await setGroupActive(session.shop, id, active);
    return { ok, message: active ? "Group activated" : "Group paused" };
  }

  if (intent === "delete") {
    // Collect the backing products BEFORE the cascade removes the rows that
    // point at them, otherwise they are orphaned in the merchant's catalog.
    const groups = await listGroups(session.shop);
    const doomed = groups.find((group) => group.id === id);
    const productGids =
      doomed?.options
        .map((option) => option.productGid)
        .filter((gid): gid is string => Boolean(gid)) ?? [];

    const ok = await deleteGroup(session.shop, id);
    if (ok && productGids.length > 0) {
      await archiveAddonProducts(admin, productGids);
    }
    return { ok, message: "Group deleted" };
  }

  return { ok: false, message: "Unknown action" };
};

export default function GroupsIndex() {
  const { groups } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<typeof action>();
  const navigate = useNavigate();
  const busy = fetcher.state !== "idle";

  // Deliberately not window.confirm: the app runs in an embedded iframe where
  // native dialogs are unreliable and look nothing like the admin.
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    title: string;
  } | null>(null);

  const totalSyncErrors = groups.reduce(
    (sum, group) => sum + group.syncErrors,
    0,
  );

  return (
    <Page>
      <TitleBar title="Add-on groups">
        {/* App Bridge renders the title bar outside the app frame and only
            understands plain button/anchor children, so this cannot be a
            Remix <Link>. */}
        <button variant="primary" onClick={() => navigate("/app/groups/new")}>
          Create group
        </button>
      </TitleBar>

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {totalSyncErrors > 0 ? (
              <Banner tone="warning" title="Some add-ons are not live">
                <p>
                  {totalSyncErrors === 1
                    ? "One add-on could not be synced to Shopify and is hidden on the storefront."
                    : `${totalSyncErrors} add-ons could not be synced to Shopify and are hidden on the storefront.`}{" "}
                  Open the group to see why, then save it again to retry.
                </p>
              </Banner>
            ) : null}

            {groups.length === 0 ? (
              <Card>
                <EmptyState
                  heading="Sell add-ons with your products"
                  action={{ content: "Create group", url: "/app/groups/new" }}
                  image="https://cdn.shopify.com/s/files/1/0262/4071/2726/files/emptystate-files.png"
                >
                  <p>
                    A group is a set of paid add-ons — gift wrap, engraving, a
                    warranty — plus any personalization fields you want
                    customers to fill in. Pick which products it appears on, and
                    it shows up on those product pages.
                  </p>
                </EmptyState>
              </Card>
            ) : (
              <Card padding="0">
                <IndexTable
                  resourceName={{ singular: "group", plural: "groups" }}
                  itemCount={groups.length}
                  selectable={false}
                  headings={[
                    { title: "Group" },
                    { title: "Applies to" },
                    { title: "Add-ons" },
                    { title: "Fields" },
                    { title: "Status" },
                    { title: "" },
                  ]}
                >
                  {groups.map((group, index) => (
                    <IndexTable.Row
                      id={group.id}
                      key={group.id}
                      position={index}
                    >
                      <IndexTable.Cell>
                        <Link to={`/app/groups/${group.id}`}>
                          <Text as="span" fontWeight="semibold">
                            {group.title}
                          </Text>
                        </Link>
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <Text as="span" tone="subdued">
                          {describeTargeting(group.appliesTo, group.targetCount)}
                        </Text>
                      </IndexTable.Cell>
                      <IndexTable.Cell>{group.optionCount}</IndexTable.Cell>
                      <IndexTable.Cell>{group.fieldCount}</IndexTable.Cell>
                      <IndexTable.Cell>
                        <StatusBadge
                          active={group.active}
                          syncErrors={group.syncErrors}
                          pendingSync={group.pendingSync}
                        />
                      </IndexTable.Cell>
                      <IndexTable.Cell>
                        <InlineStack gap="200" align="end">
                          <Button
                            size="slim"
                            disabled={busy}
                            onClick={() =>
                              fetcher.submit(
                                {
                                  intent: "toggle",
                                  id: group.id,
                                  active: String(!group.active),
                                },
                                { method: "POST" },
                              )
                            }
                          >
                            {group.active ? "Pause" : "Activate"}
                          </Button>
                          <Button
                            size="slim"
                            tone="critical"
                            variant="plain"
                            disabled={busy}
                            onClick={() =>
                              setPendingDelete({
                                id: group.id,
                                title: group.title,
                              })
                            }
                          >
                            Delete
                          </Button>
                        </InlineStack>
                      </IndexTable.Cell>
                    </IndexTable.Row>
                  ))}
                </IndexTable>
              </Card>
            )}
          </BlockStack>
        </Layout.Section>

        <Layout.Section variant="oneThird">
          <Card>
            <BlockStack gap="300">
              <Text as="h2" variant="headingMd">
                Before this shows on your storefront
              </Text>
              <Text as="p" tone="subdued">
                Add-ons render through a theme app block. In your theme editor,
                open a product template, click <b>Add block</b> in the product
                information section, and add <b>Product add-ons</b>.
              </Text>
              <Text as="p" tone="subdued">
                Paid add-ons are charged by adding a hidden product to the cart,
                so each one is a real product in your catalog tagged{" "}
                <b>product-addons-hidden</b>. Exclude that tag from your search
                and collection templates to keep them out of the way.
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>

      <Modal
        open={pendingDelete !== null}
        onClose={() => setPendingDelete(null)}
        title={`Delete ${pendingDelete?.title ?? "group"}?`}
        primaryAction={{
          content: "Delete",
          destructive: true,
          loading: busy,
          onAction: () => {
            if (!pendingDelete) return;
            fetcher.submit(
              { intent: "delete", id: pendingDelete.id },
              { method: "POST" },
            );
            setPendingDelete(null);
          },
        }}
        secondaryActions={[
          { content: "Cancel", onAction: () => setPendingDelete(null) },
        ]}
      >
        <Modal.Section>
          <Text as="p">
            The group and its add-ons stop showing on your storefront
            immediately. The hidden products behind its paid add-ons are
            archived rather than deleted, so past orders that reference them
            keep working.
          </Text>
        </Modal.Section>
      </Modal>
    </Page>
  );
}

function StatusBadge({
  active,
  syncErrors,
  pendingSync,
}: {
  active: boolean;
  syncErrors: number;
  pendingSync: number;
}) {
  if (syncErrors > 0) return <Badge tone="warning">Sync failed</Badge>;
  if (!active) return <Badge>Paused</Badge>;
  if (pendingSync > 0) return <Badge tone="attention">Syncing</Badge>;
  return <Badge tone="success">Active</Badge>;
}

function describeTargeting(appliesTo: string, targetCount: number): string {
  if (appliesTo === "ALL") return "All products";
  const noun = appliesTo === "PRODUCTS" ? "product" : "collection";
  return `${targetCount} ${noun}${targetCount === 1 ? "" : "s"}`;
}
