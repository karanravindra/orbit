import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useApp, useWorkspacePermissions } from "@/components/app-layout";
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
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { auth, result } from "@/lib/auth";
import { date, refresh } from "@/lib/query";
import { useMembers } from "./members";
import { MissingWorkspace } from "./workspace";

function TeamDetails({
	team,
	canUpdate,
	canDelete,
	canAdd,
	canRemove,
}: {
	team: { id: string; name: string };
	canUpdate: boolean;
	canDelete: boolean;
	canAdd: boolean;
	canRemove: boolean;
}) {
	const { workspace } = useApp();
	const [open, setOpen] = useState(false);
	const [memberPage, setMemberPage] = useState(0);
	const [userId, setUserId] = useState("");
	const members = useMembers(memberPage);
	const teamMembers = useQuery({
		queryKey: ["team-members", team.id],
		enabled: open,
		queryFn: async () => {
			const entries = await result(
				auth.organization.listTeamMembers({ query: { teamId: team.id } }),
			);
			if (!entries.length) return [];
			const people = await result(
				auth.organization.listMembers({
					query: {
						organizationId: workspace?.id,
						limit: 100,
						sortBy: "createdAt",
						sortDirection: "asc",
					},
				}),
			);
			while (people.members.length < people.total) {
				const next = await result(
					auth.organization.listMembers({
						query: {
							organizationId: workspace?.id,
							limit: 100,
							offset: people.members.length,
							sortBy: "createdAt",
							sortDirection: "asc",
						},
					}),
				);
				if (!next.members.length) break;
				people.members.push(...next.members);
			}
			return entries.map((entry) => ({
				...entry,
				user: people.members.find((m) => m.userId === entry.userId)?.user,
			}));
		},
	});
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button variant="outline" />}>
				Manage team
			</DialogTrigger>
			<DialogContent className="max-h-[85svh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>{team.name}</DialogTitle>
					<DialogDescription>Team members and settings.</DialogDescription>
				</DialogHeader>
				{canUpdate && (
					<AsyncForm
						submit="Rename team"
						onSubmit={async (data) => {
							await result(
								auth.organization.updateTeam({
									teamId: team.id,
									data: { name: value(data, "name") },
								}),
							);
							await refresh();
						}}
					>
						<TextField
							label="Team name"
							name="name"
							defaultValue={team.name}
							required
						/>
					</AsyncForm>
				)}
				<Section title="Members">
					{teamMembers.isPending ? (
						<Loading />
					) : teamMembers.error ? (
						<ErrorMessage error={teamMembers.error} />
					) : !teamMembers.data?.length ? (
						<NoData
							title="This team has no members"
							description="Add workspace members to get started."
						/>
					) : (
						<div className="flex flex-col gap-3">
							{teamMembers.data.map((member) => (
								<div
									key={member.id}
									className="flex flex-wrap items-center justify-between gap-2"
								>
									<div>
										<p className="text-sm font-medium">
											{member.user?.name || member.userId}
										</p>
										<p className="text-xs text-muted-foreground">
											{member.user?.email}
										</p>
									</div>
									{canRemove && (
										<ActionButton
											variant="outline"
											size="sm"
											action={async () => {
												await result(
													auth.organization.removeTeamMember({
														teamId: team.id,
														userId: member.userId,
														organizationId: workspace?.id,
													}),
												);
												await refresh();
											}}
										>
											Remove
										</ActionButton>
									)}
								</div>
							))}
						</div>
					)}
				</Section>
				{canAdd && (
					<Section title="Add workspace member">
						<AsyncForm
							submit="Add to team"
							submitDisabled={!userId}
							onSubmit={async () => {
								await result(
									auth.organization.addTeamMember({
										teamId: team.id,
										userId,
										organizationId: workspace?.id,
									}),
								);
								setUserId("");
								await refresh();
							}}
						>
							<Choice
								label="Member"
								value={userId}
								onChange={setUserId}
								options={(members.data?.members || [])
									.filter(
										(m) =>
											!teamMembers.data?.some((tm) => tm.userId === m.userId),
									)
									.map((m) => ({
										value: m.userId,
										label: `${m.user.name} (${m.user.email})`,
									}))}
							/>
						</AsyncForm>
						<ErrorMessage error={members.error} />
						<div className="mt-3 flex items-center justify-between gap-2">
							<span className="text-xs text-muted-foreground">
								Member page {memberPage + 1}
							</span>
							<div className="flex gap-2">
								<Button
									variant="outline"
									size="sm"
									disabled={!memberPage}
									onClick={() => {
										setMemberPage(memberPage - 1);
										setUserId("");
									}}
								>
									Previous
								</Button>
								<Button
									variant="outline"
									size="sm"
									disabled={
										!members.data || (memberPage + 1) * 25 >= members.data.total
									}
									onClick={() => {
										setMemberPage(memberPage + 1);
										setUserId("");
									}}
								>
									Next
								</Button>
							</div>
						</div>
					</Section>
				)}
				{canDelete && (
					<ConfirmAction
						label="Delete team"
						title={`Delete ${team.name}?`}
						description="This removes the team and its memberships. Workspace memberships are kept."
						action={async () => {
							await result(
								auth.organization.removeTeam({
									teamId: team.id,
									organizationId: workspace?.id,
								}),
							);
							await refresh();
							setOpen(false);
						}}
					/>
				)}
			</DialogContent>
		</Dialog>
	);
}

export function TeamsPage() {
	const { workspace, session } = useApp();
	const permissions = useWorkspacePermissions();
	const teams = useQuery({
		queryKey: ["teams", workspace?.id],
		enabled: !!workspace,
		queryFn: () =>
			result(
				auth.organization.listTeams({
					query: { organizationId: workspace?.id },
				}),
			),
	});
	const mine = useQuery({
		queryKey: ["my-teams", workspace?.id, session.user.id],
		enabled: !!workspace,
		queryFn: () =>
			result(
				auth.organization.listUserTeams({
					query: { organizationId: workspace?.id },
				}),
			),
	});
	if (!workspace) return <MissingWorkspace />;
	return (
		<>
			<PageHeading
				title="Teams"
				description="Bring smaller groups together within your workspace."
			/>
			<ErrorMessage error={permissions.error || mine.error} />
			{permissions.data?.teamCreate && (
				<Section title="Create a team" description="Give your group a name.">
					<AsyncForm
						submit="Create team"
						success="Team created."
						onSubmit={async (data) => {
							await result(
								auth.organization.createTeam({
									organizationId: workspace.id,
									name: value(data, "name"),
								}),
							);
							await refresh();
						}}
					>
						<TextField
							label="Team name"
							name="name"
							placeholder="e.g. Design"
							required
							maxLength={100}
						/>
					</AsyncForm>
				</Section>
			)}
			<Section
				title="Workspace teams"
				description="Manage team membership or choose your active team."
			>
				{teams.isPending ? (
					<Loading />
				) : teams.error ? (
					<ErrorMessage error={teams.error} />
				) : !teams.data?.length ? (
					<NoData
						title="No teams yet"
						description="People with team creation permission can create a team."
					/>
				) : (
					<div className="grid gap-4 md:grid-cols-2">
						{teams.data.map((team) => (
							<article
								key={team.id}
								className="flex flex-col gap-4 rounded-lg border p-5"
							>
								<div className="flex items-start justify-between gap-2">
									<div>
										<h2 className="font-medium">{team.name}</h2>
										<p className="text-xs text-muted-foreground">
											Created {date(team.createdAt)}
										</p>
									</div>
									{session.session.activeTeamId === team.id && (
										<Badge variant="secondary">Active</Badge>
									)}
								</div>
								<div className="flex flex-wrap gap-2">
									<TeamDetails
										team={team}
										canUpdate={!!permissions.data?.teamUpdate}
										canDelete={!!permissions.data?.teamDelete}
										canAdd={!!permissions.data?.memberUpdate}
										canRemove={!!permissions.data?.memberDelete}
									/>
									{mine.data?.some((t) => t.id === team.id) &&
										session.session.activeTeamId !== team.id && (
											<ActionButton
												variant="outline"
												action={async () => {
													await result(
														auth.organization.setActiveTeam({
															teamId: team.id,
														}),
													);
													await refresh();
												}}
											>
												Set active
											</ActionButton>
										)}
								</div>
							</article>
						))}
					</div>
				)}
				{session.session.activeTeamId && (
					<div className="mt-4">
						<ActionButton
							variant="ghost"
							action={async () => {
								await result(auth.organization.setActiveTeam({ teamId: null }));
								await refresh();
							}}
						>
							Clear active team
						</ActionButton>
					</div>
				)}
			</Section>
		</>
	);
}
