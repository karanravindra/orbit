export interface EmailMessage {
	to: string;
	subject: string;
	text: string;
	html: string;
}

// Transport-agnostic sender. Implementations own the "from" address, so
// callers only describe the message.
export interface EmailSender {
	send(message: EmailMessage): Promise<void>;
}
