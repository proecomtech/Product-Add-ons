/**
 * The shape of an add-on group, and the rules it has to satisfy.
 *
 * This file has no `.server` suffix and imports nothing from the database on
 * purpose: the group editor runs in the browser and needs these constants and
 * types, and Remix refuses to bundle a module that reaches Prisma. Keeping the
 * contract here means the admin form and the server validate against the same
 * definition instead of two that drift.
 */

export const APPLIES_TO = ["ALL", "PRODUCTS", "COLLECTIONS"] as const;
export const SELECTIONS = ["MULTI", "SINGLE"] as const;
export const FIELD_TYPES = [
  "TEXT",
  "TEXTAREA",
  "SELECT",
  "CHECKBOX",
  "DATE",
  "NUMBER",
] as const;

export type AppliesTo = (typeof APPLIES_TO)[number];
export type Selection = (typeof SELECTIONS)[number];
export type FieldType = (typeof FIELD_TYPES)[number];

/**
 * Shopify truncates a line item property value at 255 characters. Capping here
 * (and again in the storefront block) means the customer is told before they
 * submit, instead of finding half a monogram on the packing slip.
 */
export const PROPERTY_MAX_LENGTH = 255;

/** Guard rails so one group cannot make a product page unusable. */
export const MAX_OPTIONS_PER_GROUP = 50;
export const MAX_FIELDS_PER_GROUP = 25;

export interface OptionInput {
  id?: string;
  title: string;
  description?: string | null;
  priceCents: number;
  requiresShipping?: boolean;
  position?: number;
}

export interface FieldInput {
  id?: string;
  label: string;
  type: FieldType;
  required?: boolean;
  placeholder?: string | null;
  helpText?: string | null;
  choices?: string[];
  maxLength?: number | null;
  position?: number;
}

export interface GroupInput {
  title: string;
  heading?: string | null;
  active?: boolean;
  appliesTo: AppliesTo;
  targets: string[];
  selection: Selection;
  position?: number;
  options: OptionInput[];
  fields: FieldInput[];
}

/** Field-keyed validation errors, in the shape Polaris inline errors want. */
export type GroupErrors = Record<string, string>;

function isBlank(value: unknown): boolean {
  return typeof value !== "string" || value.trim().length === 0;
}

export function validateGroup(input: GroupInput): GroupErrors {
  const errors: GroupErrors = {};

  if (isBlank(input.title)) {
    errors.title = "Give the group a name so you can find it later.";
  }

  if (!APPLIES_TO.includes(input.appliesTo)) {
    errors.appliesTo = "Choose where this group applies.";
  } else if (input.appliesTo !== "ALL" && input.targets.length === 0) {
    errors.targets =
      input.appliesTo === "PRODUCTS"
        ? "Select at least one product, or apply the group to all products."
        : "Select at least one collection, or apply the group to all products.";
  }

  if (!SELECTIONS.includes(input.selection)) {
    errors.selection = "Choose how customers pick add-ons.";
  }

  if (input.options.length > MAX_OPTIONS_PER_GROUP) {
    errors.options = `A group can hold at most ${MAX_OPTIONS_PER_GROUP} add-ons.`;
  }
  if (input.fields.length > MAX_FIELDS_PER_GROUP) {
    errors.fields = `A group can hold at most ${MAX_FIELDS_PER_GROUP} fields.`;
  }

  input.options.forEach((option, index) => {
    if (isBlank(option.title)) {
      errors[`options.${index}.title`] = "Add-ons need a name.";
    }
    if (!Number.isInteger(option.priceCents) || option.priceCents < 0) {
      errors[`options.${index}.priceCents`] = "Enter a price of 0 or more.";
    }
  });

  input.fields.forEach((field, index) => {
    if (isBlank(field.label)) {
      errors[`fields.${index}.label`] = "Fields need a label.";
    }
    if (!FIELD_TYPES.includes(field.type)) {
      errors[`fields.${index}.type`] = "Choose a field type.";
    }
    if (field.type === "SELECT" && (field.choices ?? []).length === 0) {
      errors[`fields.${index}.choices`] = "A dropdown needs at least one choice.";
    }
    if (
      field.maxLength != null &&
      (!Number.isInteger(field.maxLength) ||
        field.maxLength < 1 ||
        field.maxLength > PROPERTY_MAX_LENGTH)
    ) {
      errors[`fields.${index}.maxLength`] =
        `Enter a limit between 1 and ${PROPERTY_MAX_LENGTH}.`;
    }
  });

  return errors;
}

/**
 * Whether a group should render on a given product.
 *
 * Split out from the database query so the rule can be tested on its own — it
 * is the one piece of logic that decides whether a merchant's targeting works,
 * and it is easy to get backwards.
 */
export function groupMatchesProduct(
  group: { appliesTo: string; targets: string },
  productGid: string,
  collectionGids: ReadonlySet<string>,
): boolean {
  if (group.appliesTo === "ALL") return true;

  const targets = parseStringArray(group.targets);
  if (group.appliesTo === "PRODUCTS") return targets.includes(productGid);
  if (group.appliesTo === "COLLECTIONS") {
    return targets.some((target) => collectionGids.has(target));
  }

  // An unrecognised mode is corrupt data. Showing nothing is the safe failure:
  // a missing add-on is a support ticket, an add-on on every product is a
  // pricing incident.
  return false;
}

/** Reads a JSON string column back as a string array, tolerating bad data. */
export function parseStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}
