import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { invitation, member } from "@orbit/db/schema";
import { eq } from "drizzle-orm";
import {
	createUserTracker,
	getSession,
	outbox,
	personalOrganization,
	request,
	type SignedInUser,
	signUpVerified,
	uniqueEmail,
} from "../../../test-utils/helpers";
import { db } from "../../db";
import { env } from "../../env";

// Requires the orbit_test database with migrations applied (bun run test:migrate).
const users = createUserTracker();

afterAll(() => users.cleanup());

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
			new URL(`/accept-invitation?id=${invitation.id}`, env.APP_URL).href,
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

	test("an owner invitation is refused as such even from a member", async () => {
		// The owner-role check runs before the inviter's role is checked.
		const res = await invite(alice, orgId, bob.email, "owner");
		expect(res.status).toBe(403);
		expect(await res.json()).toMatchObject({ code: "CANNOT_INVITE_AS_OWNER" });
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
