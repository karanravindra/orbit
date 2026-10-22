import type { Env } from "../lib/env";
import { ConsoleEmailSender } from "./console";
import { MemoryEmailSender } from "./memory";
import { ResendEmailSender } from "./resend";
import type { EmailSender } from "./types";

export * from "./templates";
export type { EmailMessage, EmailSender } from "./types";
export { ConsoleEmailSender, MemoryEmailSender, ResendEmailSender };

export function createEmailSender(env: Env): EmailSender {
	switch (env.EMAIL_PROVIDER) {
		case "console":
			return new ConsoleEmailSender(env.EMAIL_FROM);
		case "memory":
			return new MemoryEmailSender();
		case "resend":
			if (!env.RESEND_API_KEY) throw new Error("Resend requires an API key");
			return new ResendEmailSender(env.RESEND_API_KEY, env.EMAIL_FROM);
	}
}
