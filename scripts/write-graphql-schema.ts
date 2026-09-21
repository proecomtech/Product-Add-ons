/**
 * Writes the SDL in app/graphql/schema.ts out to schema.graphql at the
 * repository root — the file the iOS and Android clients generate their types
 * from.
 *
 * Run `npm run graphql:schema` after changing the schema. If you forget,
 * test/graphql-schema.test.ts fails rather than letting the client teams
 * build against a stale copy.
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { SCHEMA_FILE_HEADER, SCHEMA_SDL } from "../app/graphql/schema.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "schema.graphql");

writeFileSync(target, SCHEMA_FILE_HEADER + SCHEMA_SDL, "utf8");
console.log(`Wrote ${target}`);
