import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { invitation, member, organization, team, user } from "@orbit/db/schema";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import {
	cookiesFrom,
	createUserTracker,
	getSession,
	outbox,
	request,
	type SignedInUser,
	signUpVerified,
	uniqueEmail,
} from "./helpers";

// Requires the Postgres service from compose.yml with migrations applied.
const users = createUserTracker();

afterAll(() => users.cleanup());

async function personalOrganization(userId: string) {
	const [org] = await db
		.select()
		.from(organization)
		.where(eq(organization.personalOwnerId, userId));
	if (!org) throw new Error(`No personal organization for ${userId}`);
	return org;
}

async function invite(
	inviter: SignedInUser,
	organizationId: string,
	email: string,
	role: string | string[],
) {
	return request("/organization/invite-member", {
		cookie: inviter.cookie,
		body: { organizationId, email, role },
	});
}

// Accepts an invitation as `invitee`; returns their new member id.
async function accept(
	invitee: SignedInUser,
	invitationId: string,
): Promise<string> {
	const res = await request("/organization/accept-invitation", {
		cookie: invitee.cookie,
		body: { invitationId },
	});
	expect(res.status).toBe(200);
	return ((await res.json()) as { member: { id: string } }).member.id;
}

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

describe("invitations and roles", () => {
	let owner: SignedInUser;
	let alice: SignedInUser;
	let bob: SignedInUser;
	let orgId: string;
	let ownerMemberId: string;
	let aliceMemberId: string;
	let bobMemberId: string;

	beforeAll(async () => {
		owner = await signUpVerified(users.track(uniqueEmail("owner")), "Owner");
		alice = await signUpVerified(users.track(uniqueEmail("alice")), "Alice");
		bob = await signUpVerified(users.track(uniqueEmail("bob")), "Bob");
		orgId = (await personalOrganization(owner.id)).id;
		const [ownerMember] = await db
			.select()
			.from(member)
			.where(eq(member.organizationId, orgId));
		ownerMemberId = ownerMember?.id ?? "";
	});

	function updateRole(
		as: SignedInUser,
		memberId: string,
		role: string | string[],
	) {
		return request("/organization/update-member-role", {
			cookie: as.cookie,
			body: { organizationId: orgId, memberId, role },
		});
	}

	test("owner invites by email with a 48h link to the web app", async () => {
		const res = await invite(owner, orgId, alice.email, "member");
		expect(res.status).toBe(200);
		const invitation = (await res.json()) as { id: string; expiresAt: string };
		const hours =
			(new Date(invitation.expiresAt).getTime() - Date.now()) / 3_600_000;
		expect(hours).toBeGreaterThan(47.9);
		expect(hours).toBeLessThanOrEqual(48);

		const email = outbox.latest(alice.email);
		expect(email?.subject).toBe("Join Owner's workspace on Orbit");
		expect(email?.text).toContain(
			`http://localhost:5173/accept-invitation?id=${invitation.id}`,
		);

		aliceMemberId = await accept(alice, invitation.id);
	});

	test("members cannot invite", async () => {
		const res = await invite(alice, orgId, bob.email, "member");
		expect(res.status).toBe(403);
	});

	test("nobody can invite someone as owner", async () => {
		const res = await invite(owner, orgId, bob.email, "owner");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "CANNOT_INVITE_AS_OWNER" });

		// Better Auth also splits array elements on commas.
		const hidden = await invite(owner, orgId, bob.email, ["admin,owner"]);
		expect(hidden.status).toBe(403);
		expect(await hidden.json()).toMatchObject({
			code: "CANNOT_INVITE_AS_OWNER",
		});
	});

	test("an owner invitation can't be accepted", async () => {
		// Not creatable through the API; forced here to exercise the accept hook.
		const id = crypto.randomUUID();
		await db.insert(invitation).values({
			id,
			organizationId: orgId,
			email: bob.email,
			role: "owner",
			status: "pending",
			expiresAt: new Date(Date.now() + 3_600_000),
			createdAt: new Date(),
			inviterId: owner.id,
		});
		try {
			const res = await request("/organization/accept-invitation", {
				cookie: bob.cookie,
				body: { invitationId: id },
			});
			expect(res.status).toBe(403);
			expect(await res.json()).toMatchObject({ code: "CANNOT_ADD_OWNER" });
		} finally {
			await db.delete(invitation).where(eq(invitation.id, id));
		}
	});

	test("nobody can be promoted to owner", async () => {
		const res = await updateRole(owner, aliceMemberId, "owner");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			code: "CANNOT_ASSIGN_OWNER_ROLE",
		});
	});

	test("admins can invite", async () => {
		expect((await updateRole(owner, aliceMemberId, "admin")).status).toBe(200);

		const res = await invite(alice, orgId, bob.email, "member");
		expect(res.status).toBe(200);
		const { id } = (await res.json()) as { id: string };
		bobMemberId = await accept(bob, id);
	});

	test("accepting an invitation switches the active organization", async () => {
		expect((await getSession(bob.cookie))?.session.activeOrganizationId).toBe(
			orgId,
		);
	});

	test("admins cannot demote or remove the owner", async () => {
		const demote = await updateRole(alice, ownerMemberId, "member");
		expect(demote.status).toBe(403);

		const remove = await request("/organization/remove-member", {
			cookie: alice.cookie,
			body: { organizationId: orgId, memberIdOrEmail: owner.email },
		});
		expect(remove.status).toBe(400);
		expect(await remove.json()).toMatchObject({
			code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_AS_THE_ONLY_OWNER",
		});
	});

	test("the owner cannot demote themselves", async () => {
		const res = await updateRole(owner, ownerMemberId, "admin");
		expect(res.status).toBe(400);
		expect(await res.json()).toMatchObject({
			code: "YOU_CANNOT_LEAVE_THE_ORGANIZATION_WITHOUT_AN_OWNER",
		});
	});

	test("the personal owner stays protected even beside a second owner", async () => {
		// Not reachable through the API; forced here to exercise the hooks that
		// back up Better Auth's "only owner" checks.
		await db
			.update(member)
			.set({ role: "owner" })
			.where(eq(member.id, aliceMemberId));
		try {
			const demote = await updateRole(alice, ownerMemberId, "member");
			expect(demote.status).toBe(403);
			expect(await demote.json()).toMatchObject({
				code: "CANNOT_CHANGE_OWNER_ROLE",
			});

			const remove = await request("/organization/remove-member", {
				cookie: alice.cookie,
				body: { organizationId: orgId, memberIdOrEmail: owner.email },
			});
			expect(remove.status).toBe(403);
			expect(await remove.json()).toMatchObject({
				code: "CANNOT_REMOVE_OWNER",
			});

			const leave = await request("/organization/leave", {
				cookie: owner.cookie,
				body: { organizationId: orgId },
			});
			expect(leave.status).toBe(403);
			expect(await leave.json()).toMatchObject({
				code: "CANNOT_LEAVE_PERSONAL_ORGANIZATION",
			});
		} finally {
			await db
				.update(member)
				.set({ role: "admin" })
				.where(eq(member.id, aliceMemberId));
		}
	});

	test("admins can define custom roles, which still cannot invite", async () => {
		const created = await request("/organization/create-role", {
			cookie: alice.cookie,
			body: {
				organizationId: orgId,
				role: "recruiter",
				permission: { invitation: ["create"] },
			},
		});
		expect(created.status).toBe(200);
		expect((await updateRole(owner, bobMemberId, "recruiter")).status).toBe(
			200,
		);

		const res = await invite(bob, orgId, uniqueEmail(), "member");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			code: "ONLY_OWNERS_AND_ADMINS_CAN_INVITE",
		});
	});

	test("custom roles cannot invite by leaving out the organization", async () => {
		// An empty organizationId falls back to the active organization.
		await request("/organization/set-active", {
			cookie: bob.cookie,
			body: { organizationId: orgId },
		});
		const res = await invite(bob, "", uniqueEmail(), "member");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			code: "ONLY_OWNERS_AND_ADMINS_CAN_INVITE",
		});
	});

	test("custom roles cannot make anyone an admin", async () => {
		const created = await request("/organization/create-role", {
			cookie: alice.cookie,
			body: {
				organizationId: orgId,
				role: "people-ops",
				permission: { member: ["update"] },
			},
		});
		expect(created.status).toBe(200);
		expect((await updateRole(owner, bobMemberId, "people-ops")).status).toBe(
			200,
		);

		const res = await updateRole(bob, bobMemberId, "admin");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({
			code: "ONLY_OWNERS_AND_ADMINS_CAN_ASSIGN_ADMIN",
		});
		// Better Auth also splits array elements on commas.
		const hidden = await updateRole(bob, bobMemberId, ["member,admin"]);
		expect(hidden.status).toBe(403);
		expect(await hidden.json()).toMatchObject({
			code: "ONLY_OWNERS_AND_ADMINS_CAN_ASSIGN_ADMIN",
		});
		// They can still assign non-admin roles.
		expect((await updateRole(bob, bobMemberId, "member")).status).toBe(200);
	});

	test("invited members can leave", async () => {
		const res = await request("/organization/leave", {
			cookie: bob.cookie,
			body: { organizationId: orgId },
		});
		expect(res.status).toBe(200);
	});
});
