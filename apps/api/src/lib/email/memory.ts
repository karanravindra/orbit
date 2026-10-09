import type { EmailMessage, EmailSender } from "./types";

// Test sender: keeps every message so tests can read OTPs and links.
export class MemoryEmailSender implements EmailSender {
	readonly sent: EmailMessage[] = [];

	async send(message: EmailMessage): Promise<void> {
		this.sent.push(message);
	}

	// Most recent message sent to the given address, if any.
	latest(to: string): EmailMessage | undefined {
		const address = to.toLowerCase();
		return this.sent.findLast((message) => message.to === address);
	}
}
