import { createLocalDb } from "@orbit/db/local";
import { createApp } from "./app";
import { createEmailSender } from "./email";
import { createAuth } from "./lib/auth";
import { parseEnv } from "./lib/env";

export const env = parseEnv(process.env);
export const db = createLocalDb(env.DATABASE_PATH);
export const emailSender = createEmailSender(env);
export const auth = createAuth({ db, env, emailSender });
export const app = createApp({ db, env, emailSender, auth });
