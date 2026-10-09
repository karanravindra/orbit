import { defineRelations } from "drizzle-orm";
import * as schema from "./schema";
import { authRelations } from "./schema/auth";

// Main relations first so every table is inferred, then the per-module parts.
export const relations = { ...defineRelations(schema), ...authRelations };
