import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { member, organization, team, user } from "@orbit/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import {
	cookiesFrom,
	createUserTracker,
	getSession,
	personalOrganization,
	request,
	type SignedInUser,
	signUpVerified,
	uniqueEmail,
} from "../../test-utils/helpers";

// Requires the orbit_test database with migrations applied (bun run test:migrate).
const users = createUserTracker();

afterAll(() => users.cleanup());

describe("personal organization", () => {
	let owner: SignedInUser;
	let orgId: string;

	beforeAll(async () => {
		owner = await signUpVerified(users.track(uniqueEmail("owner")), "Ada");
		orgId = (await personalOrganization(owner.id)).id;
	});

	test("is created at sign-up with the user as sole owner", async () => {
		const org = await personalOrganization(owner.id);
		expect(org.name).toBe("Ada's workspace");

		const members = await db
			.select()
			.from(member)
			.where(eq(member.organizationId, org.id));
		expect(members).toHaveLength(1);
		expect(members[0]).toMatchObject({ userId: owner.id, role: "owner" });

		// Teams are on, so the org gets its default team.
		const teams = await db
			.select()
			.from(team)
			.where(eq(team.organizationId, org.id));
		expect(teams).toHaveLength(1);
	});

	test("exists before the email is verified", async () => {
		const email = users.track(uniqueEmail());
		const res = await request("/sign-up/email", {
			body: { name: "Unverified", email, password: crypto.randomUUID() },
		});
		const { user: created } = (await res.json()) as { user: { id: string } };
		await personalOrganization(created.id);
	});

	test("is the active organization on new sessions", async () => {
		const session = await getSession(owner.cookie);
		expect(session?.session.activeOrganizationId).toBe(orgId);

		const signIn = await request("/sign-in/email", {
			body: { email: owner.email, password: owner.password },
		});
		expect(
			(await getSession(cookiesFrom(signIn)))?.session.activeOrganizationId,
		).toBe(orgId);
	});

	test("is recreated on the next sign-in if it went missing", async () => {
		const email = users.track(uniqueEmail());
		const healed = await signUpVerified(email);
		const lost = await personalOrganization(healed.id);
		await db.delete(organization).where(eq(organization.id, lost.id));

		const signIn = await request("/sign-in/email", {
			body: { email, password: healed.password },
		});
		expect(signIn.status).toBe(200);
		const recreated = await personalOrganization(healed.id);
		expect(recreated.id).not.toBe(lost.id);
		expect(
			(await getSession(cookiesFrom(signIn)))?.session.activeOrganizationId,
		).toBe(recreated.id);
	});

	test("users cannot create more organizations", async () => {
		const res = await request("/organization/create", {
			cookie: owner.cookie,
			body: { name: "Second", slug: `second-${crypto.randomUUID()}` },
		});
		expect(res.status).toBe(403);
	});

	test("cannot be deleted", async () => {
		const res = await request("/organization/delete", {
			cookie: owner.cookie,
			body: { organizationId: orgId },
		});
		expect(res.status).toBe(404);
		expect(await res.json()).toMatchObject({
			code: "ORGANIZATION_DELETION_DISABLED",
		});
		await personalOrganization(owner.id);
		expect((await getSession(owner.cookie))?.session.activeOrganizationId).toBe(
			orgId,
		);
	});

	test("cannot be left by its owner", async () => {
		const res = await request("/organization/leave", {
			cookie: owner.cookie,
			body: { organizationId: orgId },
		});
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			code: "CANNOT_LEAVE_PERSONAL_ORGANIZATION",
		});
	});

	test("cannot have its owner changed through the API", async () => {
		const res = await request("/organization/update", {
			cookie: owner.cookie,
			body: {
				organizationId: orgId,
				data: { name: "Renamed", personalOwnerId: "someone-else" },
			},
		});
		// personalOwnerId isn't an input field, so it's stripped from the body.
		expect(res.status).toBe(200);
		const org = await personalOrganization(owner.id);
		expect(org).toMatchObject({ id: orgId, name: "Renamed" });
	});

	test("is removed when its owner is deleted", async () => {
		const email = users.track(uniqueEmail());
		const doomed = await signUpVerified(email);
		const doomedOrg = await personalOrganization(doomed.id);
		await db.delete(user).where(eq(user.id, doomed.id));
		const rows = await db
			.select()
			.from(organization)
			.where(eq(organization.id, doomedOrg.id));
		expect(rows).toHaveLength(0);
	});
});
