import type { EmailMessage, EmailSender } from "./types";

// Development sender: prints the plain-text body instead of delivering it.
export class ConsoleEmailSender implements EmailSender {
	constructor(private readonly from: string) {}

	async send(message: EmailMessage): Promise<void> {
		console.info(
			[
				"--- email ---",
				`From: ${this.from}`,
				`To: ${message.to}`,
				`Subject: ${message.subject}`,
				"",
				message.text,
				"-------------",
			].join("\n"),
		);
	}
}
