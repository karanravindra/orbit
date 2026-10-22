import type { EmailMessage, EmailSender } from "./types";

export class ResendEmailSender implements EmailSender {
	constructor(
		private readonly apiKey: string,
		private readonly from: string,
		private readonly deliver: (
			url: string,
			init: RequestInit,
		) => Promise<Response> = fetch,
	) {}

	async send(message: EmailMessage): Promise<void> {
		const response = await this.deliver("https://api.resend.com/emails", {
			method: "POST",
			headers: {
				Authorization: `Bearer ${this.apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ from: this.from, ...message }),
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok) {
			// Provider response bodies can contain recipient details. Keep them out of logs.
			throw new Error(`Email delivery failed (Resend HTTP ${response.status})`);
		}
	}
}
