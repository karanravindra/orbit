import type { createLocalDb } from "./local";
import type { createWorkerDb } from "./worker";

export type Db =
	| ReturnType<typeof createLocalDb>
	| ReturnType<typeof createWorkerDb>;
