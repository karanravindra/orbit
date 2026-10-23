import { expect, type Page, test } from "@playwright/test";

const api = "http://127.0.0.1:3100";
const passphrase = "Orbit-E2E-passphrase-739!";

async function captcha(page: Page) {
	await page.route(
		"https://challenges.cloudflare.com/turnstile/v0/api.js*",
		(route) =>
			route.fulfill({
				contentType: "application/javascript",
				body: `window.turnstile = {
            ready: cb => cb(),
            render: (el, opts) => { window.__captcha = opts; setTimeout(() => opts.callback('test-token'), 0); return 'test-widget'; },
            reset: () => setTimeout(() => window.__captcha.callback('test-token'), 0),
            remove: () => {}, execute: () => {}, getResponse: () => 'test-token', isExpired: () => false
        }; window.onloadTurnstileCallback?.();`,
			}),
	);
}

async function createUser(
	page: Page,
	name: string,
	role: "user" | "admin" = "user",
) {
	const email = `${name.toLowerCase()}-${crypto.randomUUID()}@example.com`;
	const response = await page.request.post(`${api}/__test/user`, {
		data: { email, name, role },
	});
	expect(response.ok()).toBeTruthy();
	return email;
}

async function signIn(page: Page, email: string) {
	await captcha(page);
	await page.goto("/sign-in");
	await page.getByLabel("Email address").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(passphrase);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(page.getByRole("heading", { name: /^Welcome,/ })).toBeVisible();
}

test("sign-up, verification, profile, password reset, and session protection", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await captcha(page);
	const email = `signup-${crypto.randomUUID()}@example.com`;
	await page.goto("/sign-up");
	await page.getByLabel("Full name").fill("Alex Morgan");
	await page.getByLabel("Email address").fill(email);
	await page.getByLabel("Password", { exact: true }).fill(passphrase);
	await page
		.getByRole("button", { name: "Create account", exact: true })
		.click();
	await expect(page.getByText("Check your inbox")).toBeVisible();
	const mail = await (
		await page.request.get(
			`${api}/__test/email?to=${encodeURIComponent(email)}`,
		)
	).json();
	const code = mail.text.match(/\b\d{6}\b/)[0];
	await page
		.getByLabel("Email code")
		.fill(code === "000000" ? "111111" : "000000");
	await page.getByRole("button", { name: "Verify email", exact: true }).click();
	await expect(page.getByRole("alert")).toBeVisible();
	await page.getByLabel("Email code").fill(code);
	await page.getByRole("button", { name: "Verify email", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Welcome, Alex" }),
	).toBeVisible();
	await page
		.getByRole("link", { name: "Profile & security", exact: true })
		.click();
	await page.getByLabel("Full name").fill("Alex Updated");
	await page.getByRole("button", { name: "Save changes", exact: true }).click();
	await expect(page.getByText("Changes saved.")).toBeVisible();
	await expect(page.getByText("This device", { exact: true })).toBeVisible();
	await page.getByRole("button", { name: "Reset password by email" }).click();
	await page.getByRole("button", { name: "Send reset code" }).click();
	await expect(
		page.getByText("Choose a new password", { exact: true }),
	).toBeVisible();
	const resetMail = await (
		await page.request.get(
			`${api}/__test/email?to=${encodeURIComponent(email)}`,
		)
	).json();
	await page
		.getByLabel("Email code")
		.fill(resetMail.text.match(/\b\d{6}\b/)[0]);
	await page.getByLabel("New password").fill(`${passphrase}-new`);
	await page
		.getByRole("button", { name: "Reset password", exact: true })
		.click();
	await expect(page).toHaveURL(/\/sign-in/);
	await page.goto("/members");
	await expect(page).toHaveURL(/\/sign-in\?next=/);
	expect(errors).toEqual([]);
});

test("owner manages teams, roles, and invitations; invitee joins without management access", async ({
	page,
	browser,
}) => {
	const email = await createUser(page, "Owner");
	const invitee = await createUser(page, "Invitee");
	await signIn(page, email);
	await page.getByRole("link", { name: "Teams", exact: true }).click();
	await page.getByLabel("Team name").fill("Design");
	await page.getByRole("button", { name: "Create team", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Design", exact: true }),
	).toBeVisible();
	await page
		.getByRole("article")
		.filter({ has: page.getByRole("heading", { name: "Design", exact: true }) })
		.getByRole("button", { name: "Manage team" })
		.click();
	await page.getByRole("dialog").getByLabel("Member", { exact: true }).click();
	await page.getByRole("option", { name: `Owner (${email})` }).click();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Add to team" })
		.click();
	await expect(
		page.getByRole("dialog").getByText(email, { exact: true }),
	).toBeVisible();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Close", exact: true })
		.click();
	await page.getByRole("link", { name: "Roles & permissions" }).click();
	await page.getByRole("button", { name: "Create role", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Role name").fill("viewer");
	await dialog
		.getByRole("group", { name: "Custom roles", exact: true })
		.getByRole("checkbox", { name: "read", exact: true })
		.check();
	await dialog
		.getByRole("button", { name: "Create role", exact: true })
		.click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByText("viewer", { exact: true })).toBeVisible();
	await expect(page.getByText("ac:read", { exact: true })).toBeVisible();
	await page.getByRole("link", { name: "Invitations", exact: true }).click();
	await page.getByLabel("Email address").fill(invitee);
	await page
		.getByRole("button", { name: "Send invitation", exact: true })
		.click();
	await expect(
		page.getByText("Invitation sent. They’ll receive a link by email."),
	).toBeVisible();
	const mail = await (
		await page.request.get(
			`${api}/__test/email?to=${encodeURIComponent(invitee)}`,
		)
	).json();
	const invitationUrl = mail.text.match(
		/http:\/\/127\.0\.0\.1:5174\/accept-invitation\?id=\S+/,
	)[0];
	const context = await browser.newContext();
	const guest = await context.newPage();
	await captcha(guest);
	await guest.goto(invitationUrl);
	await expect(guest).toHaveURL(/\/sign-in\?next=/);
	await guest.getByLabel("Email address").fill(invitee);
	await guest.getByLabel("Password", { exact: true }).fill(passphrase);
	await guest.getByRole("button", { name: "Sign in", exact: true }).click();
	await expect(
		guest.getByRole("button", { name: "Accept invitation" }),
	).toBeVisible();
	await guest.getByRole("button", { name: "Accept invitation" }).click();
	await expect(
		guest.getByRole("heading", { name: "Welcome, Invitee" }),
	).toBeVisible();
	await page.getByRole("link", { name: "Members", exact: true }).click();
	const memberRow = page.getByRole("row").filter({ hasText: invitee });
	await memberRow.getByRole("button", { name: "Change roles" }).click();
	await page
		.getByRole("dialog")
		.getByRole("checkbox", { name: "viewer", exact: true })
		.check();
	await page
		.getByRole("dialog")
		.getByRole("button", { name: "Update roles" })
		.click();
	await expect(memberRow.getByText("viewer", { exact: true })).toBeVisible();
	await guest.reload();
	await guest.getByRole("link", { name: "Invitations", exact: true }).click();
	await expect(
		guest.getByRole("button", { name: "Send invitation" }),
	).toHaveCount(0);
	await guest
		.getByRole("link", { name: "Workspace settings", exact: true })
		.click();
	await expect(
		guest.getByRole("button", { name: "Save changes" }),
	).toBeDisabled();
	await expect(
		guest.getByRole("button", { name: "Leave workspace" }),
	).toBeVisible();
	await context.close();
});

test("platform admin can manage users, revoke sessions, and return from impersonation", async ({
	page,
	browser,
}) => {
	const admin = await createUser(page, "Administrator", "admin");
	const target = await createUser(page, "Managed");
	const targetContext = await browser.newContext();
	const targetPage = await targetContext.newPage();
	await signIn(targetPage, target);
	await signIn(page, admin);
	await page.getByRole("link", { name: "Platform admin", exact: true }).click();
	await page.getByLabel("Search users").fill(target);
	await page.getByRole("button", { name: "Manage", exact: true }).click();
	const dialog = page.getByRole("dialog");
	await dialog.getByLabel("Name", { exact: true }).fill("Managed Updated");
	await dialog
		.getByRole("button", { name: "Save changes", exact: true })
		.click();
	await expect(dialog.getByText("Changes saved.")).toBeVisible();
	await dialog.getByRole("button", { name: "Revoke all", exact: true }).click();
	await page
		.getByRole("dialog")
		.filter({
			has: page.getByText("Revoke all user sessions?", { exact: true }),
		})
		.getByRole("button", { name: "Revoke all", exact: true })
		.click();
	await targetPage.reload();
	await expect(targetPage).toHaveURL(/\/sign-in/);
	await targetContext.close();
	await dialog
		.getByRole("button", { name: "Impersonate for up to one hour" })
		.click();
	await expect(
		page.getByText("Impersonating Managed Updated", { exact: true }),
	).toBeVisible();
	await page
		.getByRole("button", { name: "Return to your admin account" })
		.click();
	await expect(
		page.getByRole("heading", { name: "Platform administration" }),
	).toBeVisible();
});

test("mobile navigation and theme toggle work", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	const email = await createUser(page, "Mobile");
	await signIn(page, email);
	await page.getByRole("button", { name: "Toggle Sidebar" }).click();
	await page.getByRole("link", { name: "Members", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "Members", exact: true }),
	).toBeVisible();
	await page.getByRole("button", { name: /Use (dark|light) theme/ }).click();
	await expect
		.poll(() => page.evaluate(() => localStorage.getItem("orbit-theme")))
		.toMatch(/dark|light/);
	expect(
		await page.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
	).toBeTruthy();
});
