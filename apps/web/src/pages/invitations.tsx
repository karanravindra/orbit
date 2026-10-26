import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import {
	useActiveMember,
	useApp,
	useWorkspace,
	useWorkspacePermissions,
} from "@/components/app-layout";
import {
	ActionButton,
	AsyncForm,
	Choice,
	ConfirmAction,
	ErrorMessage,
	Loading,
	NoData,
	PageHeading,
	Section,
	TextField,
	value,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { auth, result } from "@/lib/auth";
import { date, queryClient, refresh } from "@/lib/query";
import { useRoles } from "./roles";

export function InvitationsPage() {
	const { session, workspace } = useApp();
	const org = useWorkspace();
	const ownMember = useActiveMember();
	const permissions = useWorkspacePermissions();
	const roles = useRoles(!!permissions.data?.roleRead);
	const [role, setRole] = useState("member");
	const [teamId, setTeamId] = useState("none");
	const ownRole = ownMember.data?.role || "";
	const manager = ownRole
		.split(",")
		.some((role) => ["owner", "admin"].includes(role.trim()));
	const sent = useQuery({
		queryKey: ["sent-invitations", workspace?.id],
		enabled: !!workspace,
		queryFn: () =>
			result(
				auth.organization.listInvitations({
					query: { organizationId: workspace?.id },
				}),
			),
	});
	const received = useQuery({
		queryKey: ["received-invitations", session.user.id],
		queryFn: () => result(auth.organization.listUserInvitations()),
	});
	return (
		<>
			<PageHeading
				title="Invitations"
				description="Invite people to your workspace and respond to invitations you receive."
			/>
			<Section
				title="Your invitations"
				description="Workspace invitations sent to your email address."
			>
				{received.isPending ? (
					<Loading />
				) : received.error ? (
					<ErrorMessage error={received.error} />
				) : !received.data?.length ? (
					<NoData
						title="You’re all caught up"
						description="New workspace invitations will appear here."
					/>
				) : (
					<div className="flex flex-col gap-3">
						{received.data.map((invitation) => (
							<div
								key={invitation.id}
								className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
							>
								<div>
									<p className="text-sm font-medium">
										{invitation.organizationName}
									</p>
									<p className="text-xs text-muted-foreground">
										{invitation.role} · Expires {date(invitation.expiresAt)}
									</p>
								</div>
								<div className="flex items-center gap-2">
									<Badge variant="outline">
										{new Date(invitation.expiresAt) <= new Date()
											? "expired"
											: invitation.status}
									</Badge>
									{invitation.status === "pending" &&
										new Date(invitation.expiresAt) > new Date() && (
											<Button
												variant="outline"
												render={
													<Link to={`/accept-invitation?id=${invitation.id}`} />
												}
											>
												Review invitation
											</Button>
										)}
								</div>
							</div>
						))}
					</div>
				)}
			</Section>
			{workspace && manager && (
				<Section
					title="Invite a member"
					description={`Send an invitation to ${workspace.name}. Invitations expire in 48 hours.`}
				>
					<AsyncForm
						submit="Send invitation"
						success="Invitation sent. They’ll receive a link by email."
						onSubmit={async (data) => {
							await result(
								auth.organization.inviteMember({
									organizationId: workspace.id,
									email: value(data, "email"),
									role,
									...(teamId !== "none" ? { teamId } : {}),
								}),
							);
							await refresh();
						}}
					>
						<TextField
							label="Email address"
							name="email"
							type="email"
							required
							placeholder="teammate@example.com"
						/>
						<Choice
							label="Role"
							value={role}
							onChange={setRole}
							options={[
								{ value: "member", label: "Member" },
								{ value: "admin", label: "Admin" },
								...(roles.data || []).map((role) => ({
									value: role.role,
									label: role.role,
								})),
							]}
						/>
						<Choice
							label="Team (optional)"
							value={teamId}
							onChange={setTeamId}
							options={[
								{ value: "none", label: "No team" },
								...(org.data?.teams || []).map((team) => ({
									value: team.id,
									label: team.name,
								})),
							]}
						/>
						<FieldDescription>
							The recipient must sign in with the invited email address. Only
							owners and admins can send invitations.
						</FieldDescription>
						<ErrorMessage error={roles.error} />
					</AsyncForm>
				</Section>
			)}
			{workspace && (
				<Section
					title="Workspace invitations"
					description="Sent invitations and their current status."
				>
					<ErrorMessage error={permissions.error} />
					{sent.isPending ? (
						<Loading />
					) : sent.error ? (
						<ErrorMessage error={sent.error} />
					) : !sent.data?.length ? (
						<NoData
							title="No invitations sent"
							description="Owners and admins can invite people by email."
						/>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead>Email</TableHead>
									<TableHead>Role</TableHead>
									<TableHead>Status</TableHead>
									<TableHead>Expires</TableHead>
									<TableHead className="text-right">Actions</TableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sent.data.map((invitation) => (
									<TableRow key={invitation.id}>
										<TableCell>{invitation.email}</TableCell>
										<TableCell>{invitation.role}</TableCell>
										<TableCell>
											<Badge variant="outline">
												{invitation.status === "pending" &&
												new Date(invitation.expiresAt) <= new Date()
													? "expired"
													: invitation.status}
											</Badge>
										</TableCell>
										<TableCell className="text-xs text-muted-foreground">
											{date(invitation.expiresAt)}
										</TableCell>
										<TableCell>
											<div className="flex justify-end gap-2">
												{invitation.status === "pending" && (
													<>
														{manager && (
															<ActionButton
																variant="outline"
																size="sm"
																action={async () => {
																	await result(
																		auth.organization.inviteMember({
																			organizationId: workspace.id,
																			email: invitation.email,
																			role: invitation.role,
																			resend: true,
																		}),
																	);
																	await refresh();
																}}
															>
																Resend
															</ActionButton>
														)}
														{permissions.data?.invitationCancel && (
															<ConfirmAction
																label="Cancel"
																title="Cancel this invitation?"
																description={`${invitation.email} won’t be able to use this invitation link.`}
																action={async () => {
																	await result(
																		auth.organization.cancelInvitation({
																			invitationId: invitation.id,
																		}),
																	);
																	await refresh();
																}}
															/>
														)}
													</>
												)}
											</div>
										</TableCell>
									</TableRow>
								))}
							</TableBody>
						</Table>
					)}
				</Section>
			)}
		</>
	);
}

export function InvitationPage() {
	const [params] = useSearchParams();
	const id = params.get("id");
	const navigate = useNavigate();
	const { session } = useApp();
	const invitation = useQuery({
		queryKey: ["invitation", id, session.user.id],
		enabled: !!id,
		queryFn: () =>
			result(auth.organization.getInvitation({ query: { id: id || "" } })),
	});
	return (
		<>
			<PageHeading
				title="Workspace invitation"
				description={`You’re signed in as ${session.user.email}.`}
			/>
			{!id ? (
				<ErrorMessage error="This invitation link is missing its ID." />
			) : invitation.isPending ? (
				<Loading />
			) : invitation.error ? (
				<>
					<ErrorMessage error={invitation.error} />
					<Section
						title="Can’t open this invitation?"
						description="The invitation may have expired, been cancelled, or been sent to another email address."
					>
						<ActionButton
							variant="outline"
							action={async () => {
								await result(auth.signOut());
								queryClient.clear();
								navigate(
									`/sign-in?next=${encodeURIComponent(`/accept-invitation?id=${id}`)}`,
								);
							}}
						>
							Sign in with another account
						</ActionButton>
					</Section>
				</>
			) : (
				<Section
					title={`Join ${invitation.data.organizationName}`}
					description={`${invitation.data.inviterEmail} invited you as ${invitation.data.role}.`}
				>
					<div className="flex flex-col gap-6">
						<p className="text-sm text-muted-foreground">
							Invitation expires {date(invitation.data.expiresAt)}. Accepting
							will switch you to this workspace.
						</p>
						<div className="flex flex-wrap gap-3">
							<ActionButton
								action={async () => {
									await result(
										auth.organization.acceptInvitation({ invitationId: id }),
									);
									await refresh();
									navigate("/", { replace: true });
								}}
							>
								Accept invitation
							</ActionButton>
							<ActionButton
								variant="outline"
								action={async () => {
									await result(
										auth.organization.rejectInvitation({ invitationId: id }),
									);
									await refresh();
									navigate("/settings/invitations", { replace: true });
								}}
							>
								Decline
							</ActionButton>
						</div>
					</div>
				</Section>
			)}
		</>
	);
}
