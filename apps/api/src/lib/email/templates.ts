import type { EmailMessage } from "./types";

type Template = Omit<EmailMessage, "to">;

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function otpTemplate({
	subject,
	intro,
	otp,
	expiresInMinutes,
}: {
	subject: string;
	intro: string;
	otp: string;
	expiresInMinutes: number;
}): Template {
	const outro = `The code expires in ${expiresInMinutes} minutes. If you didn't request it, you can ignore this email.`;
	return {
		subject,
		text: `${intro}\n\n${otp}\n\n${outro}`,
		html: `<p>${escapeHtml(intro)}</p><p style="font-size:24px;font-weight:bold;letter-spacing:4px">${escapeHtml(otp)}</p><p>${escapeHtml(outro)}</p>`,
	};
}

export function verificationOtpEmail(data: {
	otp: string;
	expiresInMinutes: number;
}): Template {
	return otpTemplate({
		subject: "Verify your email",
		intro: "Use this code to verify your email address:",
		...data,
	});
}

export function passwordResetOtpEmail(data: {
	otp: string;
	expiresInMinutes: number;
}): Template {
	return otpTemplate({
		subject: "Reset your password",
		intro: "Use this code to reset your password:",
		...data,
	});
}

export function organizationInvitationEmail({
	organizationName,
	inviterName,
	role,
	url,
	expiresInHours,
}: {
	organizationName: string;
	inviterName: string;
	role: string;
	url: string;
	expiresInHours: number;
}): Template {
	const intro = `${inviterName} invited you to join ${organizationName} as ${role}.`;
	const outro = `The invitation expires in ${expiresInHours} hours.`;
	return {
		subject: `Join ${organizationName} on Orbit`,
		text: `${intro}\n\nAccept the invitation: ${url}\n\n${outro}`,
		html: `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(url)}">Accept the invitation</a></p><p>${escapeHtml(outro)}</p>`,
	};
}
