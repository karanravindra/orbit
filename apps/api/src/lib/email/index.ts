import { env } from "../../env";
import { ConsoleEmailSender } from "./console";
import { MemoryEmailSender } from "./memory";
import type { EmailSender } from "./types";

export * from "./templates";
export type { EmailMessage, EmailSender } from "./types";
export { ConsoleEmailSender, MemoryEmailSender };

function createEmailSender(): EmailSender {
	switch (env.EMAIL_PROVIDER) {
		case "console":
			return new ConsoleEmailSender(env.EMAIL_FROM);
		case "memory":
			return new MemoryEmailSender();
	}
}

export const emailSender = createEmailSender();
