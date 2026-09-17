import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
} from "@remix-run/node";
import { redirect } from "@remix-run/node";
import {
  useActionData,
  useLoaderData,
  useNavigate,
  useNavigation,
  useSearchParams,
  useSubmit,
} from "@remix-run/react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  Checkbox,
  ChoiceList,
  Divider,
  InlineGrid,
  InlineStack,
  Layout,
  Page,
  PageActions,
  Select,
  Text,
  TextField,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import { createGroup, getGroup, updateGroup } from "../models/addon.server";
// Constants, types and validation come from the schema module rather than the
// model: this component runs in the browser, and importing the model would
// pull Prisma into the client bundle.
import {
  parseStringArray,
  validateGroup,
  APPLIES_TO,
  FIELD_TYPES,
  MAX_FIELDS_PER_GROUP,
  MAX_OPTIONS_PER_GROUP,
  PROPERTY_MAX_LENGTH,
  SELECTIONS,
  type AppliesTo,
  type FieldType,
  type GroupErrors,
  type GroupInput,
  type Selection,
} from "../lib/addon-schema";
import {
  archiveAddonProducts,
  getShopSetting,
  syncGroupOptions,
} from "../models/addon-product.server";
import { centsToMoney, moneyToCents } from "../lib/money";

const NEW = "new";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id!;
  const setting = await getShopSetting(session.shop);

  if (id === NEW) {
    return {
      isNew: true,
      currencyCode: setting.currencyCode,
      group: blankGroup(),
      targetLabels: {} as Record<string, string>,
    };
  }

  const group = await getGroup(session.shop, id);
  if (!group) {
    throw new Response("Group not found", { status: 404 });
  }

  const targets = parseStringArray(group.targets);

  return {
    isNew: false,
    currencyCode: setting.currencyCode,
    group: {
      id: group.id,
      title: group.title,
      heading: group.heading ?? "",
      active: group.active,
      appliesTo: group.appliesTo as AppliesTo,
      targets,
      selection: group.selection as Selection,
      options: group.options.map((option) => ({
        id: option.id,
        title: option.title,
        description: option.description ?? "",
        price: centsToMoney(option.priceCents),
        requiresShipping: option.requiresShipping,
        syncError: option.syncError,
        live: Boolean(option.variantGid),
      })),
      fields: group.fields.map((field) => ({
        id: field.id,
        label: field.label,
        type: field.type as FieldType,
        required: field.required,
        placeholder: field.placeholder ?? "",
        helpText: field.helpText ?? "",
        // Stored as a JSON array, edited as one choice per line.
        choices: parseStringArray(field.choices).join("\n"),
        maxLength: field.maxLength == null ? "" : String(field.maxLength),
      })),
    },
    targetLabels: await lookupTargetLabels(admin, targets),
  };
};

/**
 * Resolves target GIDs to titles so the editor can list what is selected.
 *
 * Looked up live rather than stored alongside the GID: a merchant who renames
 * a collection should not see the old name here forever. Best effort — a
 * failure falls back to showing the raw id.
 */
async function lookupTargetLabels(
  admin: { graphql: (q: string, o?: any) => Promise<Response> },
  ids: string[],
): Promise<Record<string, string>> {
  if (ids.length === 0) return {};
  try {
    const response = await admin.graphql(
      `#graphql
        query AddonTargetTitles($ids: [ID!]!) {
          nodes(ids: $ids) {
            ... on Product { id title }
            ... on Collection { id title }
          }
        }`,
      { variables: { ids } },
    );
    const payload = await response.json();
    const labels: Record<string, string> = {};
    for (const node of payload.data?.nodes ?? []) {
      if (node?.id && node?.title) labels[node.id] = node.title;
    }
    return labels;
  } catch {
    return {};
  }
}

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id!;

  const formData = await request.formData();
  const raw = formData.get("payload");
  if (typeof raw !== "string") {
    return { errors: { form: "The form did not submit correctly." } };
  }

  let input: GroupInput;
  try {
    input = normalizeInput(JSON.parse(raw));
  } catch {
    return { errors: { form: "The form did not submit correctly." } };
  }

  const errors = validateGroup(input);
  if (Object.keys(errors).length > 0) {
    return { errors };
  }

  let groupId: string;
  let archived: string[] = [];

  if (id === NEW) {
    const created = await createGroup(session.shop, input);
    groupId = created.id;
  } else {
    // Snapshot the backing products of options the merchant is removing, so
    // they can be archived after the delete cascade has taken the rows away.
    const before = await getGroup(session.shop, id);
    if (!before) throw new Response("Group not found", { status: 404 });

    const keptIds = new Set(
      input.options
        .map((option) => option.id)
        .filter((value): value is string => Boolean(value)),
    );
    archived = before.options
      .filter((option) => !keptIds.has(option.id) && option.productGid)
      .map((option) => option.productGid!);

    const updated = await updateGroup(session.shop, id, input);
    if (!updated) throw new Response("Group not found", { status: 404 });
    groupId = updated.id;
  }

  if (archived.length > 0) {
    await archiveAddonProducts(admin, archived);
  }

  // Sync AFTER the save so a Shopify outage costs the merchant their add-ons
  // being live, not the edit they just made. Failures are recorded per option
  // and surfaced on the next render.
  const saved = await getGroup(session.shop, groupId);
  await syncGroupOptions(admin, session.shop, saved?.options ?? []);

  return redirect(`/app/groups/${groupId}?saved=1`);
};

/** Coerces the JSON payload into the shape the model layer validates. */
function normalizeInput(raw: any): GroupInput {
  const appliesTo: AppliesTo = APPLIES_TO.includes(raw?.appliesTo)
    ? raw.appliesTo
    : "ALL";
  const selection: Selection = SELECTIONS.includes(raw?.selection)
    ? raw.selection
    : "MULTI";

  return {
    title: String(raw?.title ?? ""),
    heading: raw?.heading ? String(raw.heading) : null,
    active: Boolean(raw?.active),
    appliesTo,
    // Targets only mean something for the mode they were picked in; dropping
    // them otherwise stops a stale product list from silently narrowing a
    // group the merchant has switched to "all products".
    targets:
      appliesTo === "ALL"
        ? []
        : (Array.isArray(raw?.targets) ? raw.targets : [])
            .filter((value: unknown) => typeof value === "string")
            .slice(0, 250),
    selection,
    options: (Array.isArray(raw?.options) ? raw.options : []).map(
      (option: any) => ({
        id: option?.id || undefined,
        title: String(option?.title ?? ""),
        description: option?.description ? String(option.description) : null,
        // The client sends a decimal string; -1 is deliberately out of range so
        // an unparseable price fails validation rather than becoming free.
        priceCents: moneyToCents(String(option?.price ?? "")) ?? -1,
        requiresShipping: Boolean(option?.requiresShipping),
      }),
    ),
    fields: (Array.isArray(raw?.fields) ? raw.fields : []).map((field: any) => {
      const type: FieldType = FIELD_TYPES.includes(field?.type)
        ? field.type
        : "TEXT";
      const maxLength = String(field?.maxLength ?? "").trim();
      return {
        id: field?.id || undefined,
        label: String(field?.label ?? ""),
        type,
        required: Boolean(field?.required),
        placeholder: field?.placeholder ? String(field.placeholder) : null,
        helpText: field?.helpText ? String(field.helpText) : null,
        choices:
          type === "SELECT"
            ? String(field?.choices ?? "")
                .split("\n")
                .map((choice) => choice.trim())
                .filter(Boolean)
            : [],
        maxLength: maxLength === "" ? null : Number(maxLength),
      };
    }),
  };
}

function blankGroup() {
  return {
    id: "",
    title: "",
    heading: "",
    active: true,
    appliesTo: "ALL" as AppliesTo,
    targets: [] as string[],
    selection: "MULTI" as Selection,
    options: [] as OptionRow[],
    fields: [] as FieldRow[],
  };
}

interface OptionRow {
  id?: string;
  title: string;
  description: string;
  price: string;
  requiresShipping: boolean;
  syncError?: string | null;
  live?: boolean;
}

interface FieldRow {
  id?: string;
  label: string;
  type: FieldType;
  required: boolean;
  placeholder: string;
  helpText: string;
  choices: string;
  maxLength: string;
}

const FIELD_TYPE_LABELS: Record<FieldType, string> = {
  TEXT: "Short text",
  TEXTAREA: "Long text",
  SELECT: "Dropdown",
  CHECKBOX: "Checkbox",
  DATE: "Date",
  NUMBER: "Number",
};

/**
 * The editor holds the merchant's unsaved edits in component state, which
 * React keeps across a navigation between two groups because it is the same
 * route. Keying on the id forces a remount, so opening group B never shows
 * group A's half-typed values — and so the redirect from /new to /:id after a
 * save picks up the saved record.
 */
export default function GroupEditorRoute() {
  const { group } = useLoaderData<typeof loader>();
  return <GroupEditor key={group.id || "new"} />;
}

function GroupEditor() {
  const { isNew, group, currencyCode, targetLabels } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const submit = useSubmit();
  const shopify = useAppBridge();
  const [searchParams, setSearchParams] = useSearchParams();

  const errors: GroupErrors = (actionData as any)?.errors ?? {};
  const saving = navigation.state === "submitting";

  const [title, setTitle] = useState(group.title);
  const [heading, setHeading] = useState(group.heading);
  const [active, setActive] = useState(group.active);
  const [appliesTo, setAppliesTo] = useState<AppliesTo>(group.appliesTo);
  const [targets, setTargets] = useState<string[]>(group.targets);
  const [selection, setSelection] = useState<Selection>(group.selection);
  const [options, setOptions] = useState<OptionRow[]>(group.options);
  const [fields, setFields] = useState<FieldRow[]>(group.fields);
  const [labels, setLabels] =
    useState<Record<string, string>>(targetLabels);

  // Toast on the redirect that follows a successful save.
  useEffect(() => {
    if (searchParams.get("saved") !== "1") return;
    shopify.toast.show("Group saved");
    searchParams.delete("saved");
    setSearchParams(searchParams, { replace: true });
  }, [searchParams, setSearchParams, shopify]);

  const failedOptions = options.filter((option) => option.syncError);

  const openPicker = useCallback(async () => {
    const type = appliesTo === "PRODUCTS" ? "product" : "collection";
    const picked = await shopify.resourcePicker({
      type,
      multiple: true,
      selectionIds: targets.map((id) => ({ id })),
    });
    // The picker resolves undefined when the merchant cancels — leave the
    // existing selection alone rather than clearing it.
    if (!picked) return;

    setTargets(picked.map((resource: any) => resource.id));
    setLabels((current) => {
      const next = { ...current };
      for (const resource of picked as any[]) {
        next[resource.id] = resource.title;
      }
      return next;
    });
  }, [appliesTo, shopify, targets]);

  const handleSave = useCallback(() => {
    const payload = {
      title,
      heading,
      active,
      appliesTo,
      targets,
      selection,
      options,
      fields,
    };
    submit({ payload: JSON.stringify(payload) }, { method: "POST" });
  }, [
    active,
    appliesTo,
    fields,
    heading,
    options,
    selection,
    submit,
    targets,
    title,
  ]);

  const currencySuffix = useMemo(() => currencyCode, [currencyCode]);

  return (
    <Page>
      <TitleBar title={isNew ? "New add-on group" : group.title || "Group"}>
        <button onClick={() => navigate("/app")}>Back</button>
        <button variant="primary" onClick={handleSave} disabled={saving}>
          Save
        </button>
      </TitleBar>

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            {errors.form ? (
              <Banner tone="critical">{errors.form}</Banner>
            ) : null}

            {failedOptions.length > 0 ? (
              <Banner tone="warning" title="Some add-ons are not live">
                <BlockStack gap="100">
                  {failedOptions.map((option, index) => (
                    <Text as="p" key={option.id ?? index}>
                      <b>{option.title}</b>: {option.syncError}
                    </Text>
                  ))}
                  <Text as="p">Saving the group again retries them.</Text>
                </BlockStack>
              </Banner>
            ) : null}

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Group
                </Text>
                <TextField
                  label="Internal name"
                  value={title}
                  onChange={setTitle}
                  autoComplete="off"
                  error={errors.title}
                  helpText="Only you see this. Use it to tell your groups apart."
                />
                <TextField
                  label="Heading shown to customers"
                  value={heading}
                  onChange={setHeading}
                  autoComplete="off"
                  placeholder={title || "Add-ons"}
                  helpText="Leave blank to use the internal name."
                />
                <Checkbox
                  label="Active"
                  checked={active}
                  onChange={setActive}
                  helpText="Paused groups stay configured but do not render on the storefront."
                />
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <Text as="h2" variant="headingMd">
                  Where it appears
                </Text>
                <ChoiceList
                  title="Show this group on"
                  titleHidden
                  choices={[
                    { label: "All products", value: "ALL" },
                    { label: "Specific products", value: "PRODUCTS" },
                    { label: "Products in specific collections", value: "COLLECTIONS" },
                  ]}
                  selected={[appliesTo]}
                  onChange={(selected) => {
                    const next = selected[0] as AppliesTo;
                    setAppliesTo(next);
                    // Selections made for products mean nothing for
                    // collections, so start the new mode empty.
                    if (next !== appliesTo) setTargets([]);
                  }}
                  error={errors.appliesTo}
                />

                {appliesTo !== "ALL" ? (
                  <BlockStack gap="200">
                    <InlineStack gap="300" blockAlign="center">
                      <Button onClick={openPicker}>
                        {targets.length === 0
                          ? `Select ${appliesTo === "PRODUCTS" ? "products" : "collections"}`
                          : "Change selection"}
                      </Button>
                      <Text as="span" tone="subdued">
                        {targets.length}{" "}
                        {appliesTo === "PRODUCTS" ? "product" : "collection"}
                        {targets.length === 1 ? "" : "s"} selected
                      </Text>
                    </InlineStack>
                    {errors.targets ? (
                      <Text as="p" tone="critical">
                        {errors.targets}
                      </Text>
                    ) : null}
                    {targets.length > 0 ? (
                      <Box
                        background="bg-surface-secondary"
                        padding="300"
                        borderRadius="200"
                      >
                        <BlockStack gap="100">
                          {targets.map((id) => (
                            <Text as="p" key={id} tone="subdued">
                              {labels[id] ?? id}
                            </Text>
                          ))}
                        </BlockStack>
                      </Box>
                    ) : null}
                  </BlockStack>
                ) : null}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Paid add-ons
                  </Text>
                  <Button
                    onClick={() =>
                      setOptions((current) => [
                        ...current,
                        {
                          title: "",
                          description: "",
                          price: "0.00",
                          requiresShipping: false,
                        },
                      ])
                    }
                    disabled={options.length >= MAX_OPTIONS_PER_GROUP}
                  >
                    Add an add-on
                  </Button>
                </InlineStack>

                <Text as="p" tone="subdued">
                  Each one is charged as its own cart line, so the price here is
                  exactly what checkout charges.
                </Text>

                {errors.options ? (
                  <Text as="p" tone="critical">
                    {errors.options}
                  </Text>
                ) : null}

                <Select
                  label="How customers choose"
                  options={[
                    { label: "Any number (checkboxes)", value: "MULTI" },
                    { label: "At most one (radio buttons)", value: "SINGLE" },
                  ]}
                  value={selection}
                  onChange={(value) => setSelection(value as Selection)}
                  error={errors.selection}
                />

                {options.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No paid add-ons yet. A group can also be fields only.
                  </Text>
                ) : null}

                {options.map((option, index) => (
                  <Box key={option.id ?? `new-${index}`}>
                    <Divider />
                    <Box paddingBlockStart="400">
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <InlineStack gap="200" blockAlign="center">
                            <Text as="h3" variant="headingSm">
                              Add-on {index + 1}
                            </Text>
                            {option.id && !option.live ? (
                              <Badge tone="attention">Not live</Badge>
                            ) : null}
                          </InlineStack>
                          <InlineStack gap="100">
                            <Button
                              variant="plain"
                              disabled={index === 0}
                              onClick={() =>
                                setOptions((c) => move(c, index, index - 1))
                              }
                              accessibilityLabel={`Move add-on ${index + 1} up`}
                            >
                              Up
                            </Button>
                            <Button
                              variant="plain"
                              disabled={index === options.length - 1}
                              onClick={() =>
                                setOptions((c) => move(c, index, index + 1))
                              }
                              accessibilityLabel={`Move add-on ${index + 1} down`}
                            >
                              Down
                            </Button>
                            <Button
                              variant="plain"
                              tone="critical"
                              onClick={() =>
                                setOptions((c) =>
                                  c.filter((_, i) => i !== index),
                                )
                              }
                            >
                              Remove
                            </Button>
                          </InlineStack>
                        </InlineStack>

                        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                          <TextField
                            label="Name"
                            value={option.title}
                            onChange={(value) =>
                              setOptions((c) =>
                                patch(c, index, { title: value }),
                              )
                            }
                            autoComplete="off"
                            error={errors[`options.${index}.title`]}
                          />
                          <TextField
                            label="Price"
                            value={option.price}
                            onChange={(value) =>
                              setOptions((c) =>
                                patch(c, index, { price: value }),
                              )
                            }
                            autoComplete="off"
                            inputMode="decimal"
                            suffix={currencySuffix}
                            error={errors[`options.${index}.priceCents`]}
                          />
                        </InlineGrid>

                        <TextField
                          label="Description"
                          value={option.description}
                          onChange={(value) =>
                            setOptions((c) =>
                              patch(c, index, { description: value }),
                            )
                          }
                          autoComplete="off"
                          multiline={2}
                          helpText="Shown under the add-on name on the product page."
                        />

                        <Checkbox
                          label="This add-on ships separately"
                          checked={option.requiresShipping}
                          onChange={(value) =>
                            setOptions((c) =>
                              patch(c, index, { requiresShipping: value }),
                            )
                          }
                          helpText="Leave off for gift wrap, engraving and anything else that travels with the main item — otherwise it adds its own shipping cost."
                        />
                      </BlockStack>
                    </Box>
                  </Box>
                ))}
              </BlockStack>
            </Card>

            <Card>
              <BlockStack gap="400">
                <InlineStack align="space-between" blockAlign="center">
                  <Text as="h2" variant="headingMd">
                    Personalization fields
                  </Text>
                  <Button
                    onClick={() =>
                      setFields((current) => [
                        ...current,
                        {
                          label: "",
                          type: "TEXT",
                          required: false,
                          placeholder: "",
                          helpText: "",
                          choices: "",
                          maxLength: "",
                        },
                      ])
                    }
                    disabled={fields.length >= MAX_FIELDS_PER_GROUP}
                  >
                    Add a field
                  </Button>
                </InlineStack>

                <Text as="p" tone="subdued">
                  Free inputs carried to the order as line item properties on the
                  main product. They never add a charge or a cart line.
                </Text>

                {errors.fields ? (
                  <Text as="p" tone="critical">
                    {errors.fields}
                  </Text>
                ) : null}

                {fields.length === 0 ? (
                  <Text as="p" tone="subdued">
                    No fields yet.
                  </Text>
                ) : null}

                {fields.map((field, index) => (
                  <Box key={field.id ?? `new-${index}`}>
                    <Divider />
                    <Box paddingBlockStart="400">
                      <BlockStack gap="300">
                        <InlineStack align="space-between" blockAlign="center">
                          <Text as="h3" variant="headingSm">
                            Field {index + 1}
                          </Text>
                          <InlineStack gap="100">
                            <Button
                              variant="plain"
                              disabled={index === 0}
                              onClick={() =>
                                setFields((c) => move(c, index, index - 1))
                              }
                              accessibilityLabel={`Move field ${index + 1} up`}
                            >
                              Up
                            </Button>
                            <Button
                              variant="plain"
                              disabled={index === fields.length - 1}
                              onClick={() =>
                                setFields((c) => move(c, index, index + 1))
                              }
                              accessibilityLabel={`Move field ${index + 1} down`}
                            >
                              Down
                            </Button>
                            <Button
                              variant="plain"
                              tone="critical"
                              onClick={() =>
                                setFields((c) => c.filter((_, i) => i !== index))
                              }
                            >
                              Remove
                            </Button>
                          </InlineStack>
                        </InlineStack>

                        <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                          <TextField
                            label="Label"
                            value={field.label}
                            onChange={(value) =>
                              setFields((c) => patch(c, index, { label: value }))
                            }
                            autoComplete="off"
                            error={errors[`fields.${index}.label`]}
                          />
                          <Select
                            label="Type"
                            options={FIELD_TYPES.map((type) => ({
                              label: FIELD_TYPE_LABELS[type],
                              value: type,
                            }))}
                            value={field.type}
                            onChange={(value) =>
                              setFields((c) =>
                                patch(c, index, { type: value as FieldType }),
                              )
                            }
                            error={errors[`fields.${index}.type`]}
                          />
                        </InlineGrid>

                        {field.type === "SELECT" ? (
                          <TextField
                            label="Choices"
                            value={field.choices}
                            onChange={(value) =>
                              setFields((c) =>
                                patch(c, index, { choices: value }),
                              )
                            }
                            autoComplete="off"
                            multiline={3}
                            helpText="One choice per line."
                            error={errors[`fields.${index}.choices`]}
                          />
                        ) : null}

                        {field.type === "TEXT" || field.type === "TEXTAREA" ? (
                          <InlineGrid columns={{ xs: 1, md: 2 }} gap="300">
                            <TextField
                              label="Placeholder"
                              value={field.placeholder}
                              onChange={(value) =>
                                setFields((c) =>
                                  patch(c, index, { placeholder: value }),
                                )
                              }
                              autoComplete="off"
                            />
                            <TextField
                              label="Character limit"
                              value={field.maxLength}
                              onChange={(value) =>
                                setFields((c) =>
                                  patch(c, index, { maxLength: value }),
                                )
                              }
                              autoComplete="off"
                              inputMode="numeric"
                              placeholder={String(PROPERTY_MAX_LENGTH)}
                              helpText={`Shopify caps a property at ${PROPERTY_MAX_LENGTH} characters.`}
                              error={errors[`fields.${index}.maxLength`]}
                            />
                          </InlineGrid>
                        ) : null}

                        <TextField
                          label="Help text"
                          value={field.helpText}
                          onChange={(value) =>
                            setFields((c) => patch(c, index, { helpText: value }))
                          }
                          autoComplete="off"
                        />

                        <Checkbox
                          label="Required"
                          checked={field.required}
                          onChange={(value) =>
                            setFields((c) => patch(c, index, { required: value }))
                          }
                          helpText="Customers cannot add to cart until this is filled in."
                        />
                      </BlockStack>
                    </Box>
                  </Box>
                ))}
              </BlockStack>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>

      <PageActions
        primaryAction={{
          content: "Save",
          onAction: handleSave,
          loading: saving,
        }}
        secondaryActions={[{ content: "Cancel", onAction: () => navigate("/app") }]}
      />
    </Page>
  );
}

/** Immutably merges a partial into one row of a list. */
function patch<T>(rows: T[], index: number, changes: Partial<T>): T[] {
  return rows.map((row, i) => (i === index ? { ...row, ...changes } : row));
}

/** Immutably moves one row of a list to another index. */
function move<T>(rows: T[], from: number, to: number): T[] {
  if (to < 0 || to >= rows.length) return rows;
  const next = [...rows];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}
