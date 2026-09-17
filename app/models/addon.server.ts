import prisma from "../db.server";
import {
  groupMatchesProduct,
  type FieldInput,
  type GroupInput,
  type OptionInput,
} from "../lib/addon-schema";

/**
 * Database access for add-on groups.
 *
 * The shape of a group and the rules it must satisfy live in
 * app/lib/addon-schema.ts, which the admin form imports too — Remix cannot
 * bundle this module for the browser because it reaches Prisma. Everything
 * that writes a group goes through here, so the string columns standing in for
 * enums (SQLite has none) are only ever written with validated values.
 */

// Re-exported so server code has one import for both halves.
export * from "../lib/addon-schema";

export async function listGroups(shop: string) {
  return prisma.addonGroup.findMany({
    where: { shop },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: {
      options: { orderBy: { position: "asc" } },
      fields: { orderBy: { position: "asc" } },
    },
  });
}

export async function getGroup(shop: string, id: string) {
  // `shop` is in the filter, not checked after the read: a group id from
  // another shop must come back as "not found", never as someone else's data.
  return prisma.addonGroup.findFirst({
    where: { id, shop },
    include: {
      options: { orderBy: { position: "asc" } },
      fields: { orderBy: { position: "asc" } },
    },
  });
}

export async function createGroup(shop: string, input: GroupInput) {
  return prisma.addonGroup.create({
    data: {
      shop,
      title: input.title.trim(),
      heading: input.heading?.trim() || null,
      active: input.active ?? true,
      appliesTo: input.appliesTo,
      targets: JSON.stringify(input.targets),
      selection: input.selection,
      position: input.position ?? 0,
      options: {
        create: input.options.map((option, index) => ({
          ...toOptionData(option),
          position: index,
        })),
      },
      fields: {
        create: input.fields.map((field, index) => ({
          ...toFieldData(field),
          position: index,
        })),
      },
    },
    include: { options: true, fields: true },
  });
}

/**
 * Replaces the group's options and fields wholesale rather than diffing them.
 *
 * Rows the merchant kept are matched by id and updated in place, so an option's
 * `variantGid` — the link to the variant that charges for it — survives an
 * edit. Rows they removed are deleted. Doing this in a transaction keeps a
 * half-applied edit off the storefront.
 */
export async function updateGroup(shop: string, id: string, input: GroupInput) {
  const existing = await prisma.addonGroup.findFirst({
    where: { id, shop },
    select: { id: true, position: true },
  });
  if (!existing) return null;

  const keptOptionIds = input.options
    .map((option) => option.id)
    .filter((value): value is string => Boolean(value));
  const keptFieldIds = input.fields
    .map((field) => field.id)
    .filter((value): value is string => Boolean(value));

  return prisma.$transaction(async (tx) => {
    await tx.addonOption.deleteMany({
      where: { groupId: id, id: { notIn: keptOptionIds } },
    });
    await tx.addonField.deleteMany({
      where: { groupId: id, id: { notIn: keptFieldIds } },
    });

    for (const [index, option] of input.options.entries()) {
      const data = { ...toOptionData(option), position: index };
      if (option.id) {
        // updateMany scoped to the group: an id belonging to another group
        // updates nothing rather than reassigning someone else's row.
        await tx.addonOption.updateMany({
          where: { id: option.id, groupId: id },
          data,
        });
      } else {
        await tx.addonOption.create({ data: { ...data, groupId: id } });
      }
    }

    for (const [index, field] of input.fields.entries()) {
      const data = { ...toFieldData(field), position: index };
      if (field.id) {
        await tx.addonField.updateMany({
          where: { id: field.id, groupId: id },
          data,
        });
      } else {
        await tx.addonField.create({ data: { ...data, groupId: id } });
      }
    }

    return tx.addonGroup.update({
      where: { id },
      data: {
        title: input.title.trim(),
        heading: input.heading?.trim() || null,
        active: input.active ?? true,
        appliesTo: input.appliesTo,
        targets: JSON.stringify(input.targets),
        selection: input.selection,
        position: input.position ?? existing.position,
      },
      include: { options: true, fields: true },
    });
  });
}

export async function deleteGroup(shop: string, id: string) {
  // deleteMany, not delete: it takes a `where` on shop and is a no-op rather
  // than a throw when the id belongs to someone else.
  const result = await prisma.addonGroup.deleteMany({ where: { id, shop } });
  return result.count > 0;
}

export async function setGroupActive(shop: string, id: string, active: boolean) {
  const result = await prisma.addonGroup.updateMany({
    where: { id, shop },
    data: { active },
  });
  return result.count > 0;
}

function toOptionData(option: OptionInput) {
  return {
    title: option.title.trim(),
    description: option.description?.trim() || null,
    priceCents: option.priceCents,
    requiresShipping: option.requiresShipping ?? false,
  };
}

function toFieldData(field: FieldInput) {
  return {
    label: field.label.trim(),
    type: field.type,
    required: field.required ?? false,
    placeholder: field.placeholder?.trim() || null,
    helpText: field.helpText?.trim() || null,
    choices: JSON.stringify(field.choices ?? []),
    maxLength: field.maxLength ?? null,
  };
}

/**
 * The groups that apply to one product, in render order.
 *
 * `collectionGids` comes from the theme — Liquid already knows the product's
 * collections — which keeps this a single database read with no Admin API call
 * on the storefront path.
 */
export async function groupsForProduct(
  shop: string,
  productGid: string,
  collectionGids: string[],
) {
  const groups = await prisma.addonGroup.findMany({
    where: { shop, active: true },
    orderBy: [{ position: "asc" }, { createdAt: "asc" }],
    include: {
      options: { orderBy: { position: "asc" } },
      fields: { orderBy: { position: "asc" } },
    },
  });

  const collections = new Set(collectionGids);

  return groups.filter((group) =>
    groupMatchesProduct(group, productGid, collections),
  );
}
