import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import {
	initials,
	useActiveMember,
	useApp,
	useWorkspacePermissions,
} from "@/components/app-layout";
import {
	AsyncForm,
	ConfirmAction,
	ErrorMessage,
	Loading,
	NoData,
	PageHeading,
	Section,
} from "@/components/shared";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Field,
	FieldGroup,
	FieldLabel,
	FieldLegend,
	FieldSet,
} from "@/components/ui/field";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table";
import { auth, result } from "@/lib/auth";
import { date, refresh } from "@/lib/query";
import { useRoles } from "./roles";
import { MissingWorkspace } from "./workspace";

export function useMembers(page = 0) {
	const { workspace } = useApp();
	return useQuery({
		queryKey: ["members", workspace?.id, page],
		enabled: !!workspace,
		queryFn: () =>
			result(
				auth.organization.listMembers({
					query: {
						organizationId: workspace?.id,
						limit: 25,
						offset: page * 25,
						sortBy: "createdAt",
						sortDirection: "asc",
					},
				}),
			),
	});
}

export function MemberRoleEditor({
	memberId,
	name,
	currentRole,
	manager,
}: {
	memberId: string;
	name: string;
	currentRole: string;
	manager: boolean;
}) {
	const { workspace } = useApp();
	const permissions = useWorkspacePermissions();
	const roles = useRoles(!!permissions.data?.roleRead);
	const [open, setOpen] = useState(false);
	const choices = [
		...new Set([
			"member",
			...(manager ? ["admin"] : []),
			...(roles.data || []).map((role) => role.role),
			...currentRole.split(",").map((r) => r.trim()),
		]),
	].filter((role) => role !== "owner");
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button variant="outline" size="sm" />}>
				Change roles
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Roles for {name}</DialogTitle>
					<DialogDescription>
						A member can hold multiple roles. The workspace owner is protected.
					</DialogDescription>
				</DialogHeader>
				<ErrorMessage error={roles.error} />
				<AsyncForm
					submit="Update roles"
					onSubmit={async (data) => {
						const selected = data.getAll("roles").map(String);
						if (!selected.length) throw new Error("Choose at least one role.");
						await result(
							auth.organization.updateMemberRole({
								organizationId: workspace?.id,
								memberId,
								role: selected,
							}),
						);
						await refresh();
						setOpen(false);
					}}
				>
					<FieldSet>
						<FieldLegend>Assigned roles</FieldLegend>
						<FieldGroup>
							{choices.map((role) => (
								<Field key={role} orientation="horizontal">
									<Checkbox
										id={`assign-${memberId}-${role}`}
										name="roles"
										value={role}
										defaultChecked={currentRole
											.split(",")
											.map((r) => r.trim())
											.includes(role)}
										disabled={role === "admin" && !manager}
									/>
									<FieldLabel htmlFor={`assign-${memberId}-${role}`}>
										{role}
									</FieldLabel>
								</Field>
							))}
						</FieldGroup>
					</FieldSet>
				</AsyncForm>
			</DialogContent>
		</Dialog>
	);
}

export function MembersPage() {
	const { workspace, session } = useApp();
	const [page, setPage] = useState(0);
	const members = useMembers(page);
	const ownMember = useActiveMember();
	const permissions = useWorkspacePermissions();
	const ownRole = ownMember.data?.role || "";
	const manager = ownRole
		.split(",")
		.some((role) => ["owner", "admin"].includes(role.trim()));
	if (!workspace) return <MissingWorkspace />;
	return (
		<>
			<PageHeading
				title="Members"
				description="The people who have access to this workspace."
				action={
					manager && (
						<Button render={<Link to="/invitations" />}>Invite a member</Button>
					)
				}
			/>
			<ErrorMessage error={permissions.error || ownMember.error} />
			<Section
				title="Workspace members"
				description={
					members.data
						? `${members.data.total} people in ${workspace.name}`
						: "Loading members"
				}
			>
				{members.isPending ? (
					<Loading />
				) : members.error ? (
					<ErrorMessage error={members.error} />
				) : !members.data.members.length ? (
					<NoData
						title="No members on this page"
						description="Go back to the previous page to view workspace members."
					/>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>Person</TableHead>
								<TableHead>Role</TableHead>
								<TableHead>Joined</TableHead>
								<TableHead className="text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{members.data.members.map((member) => (
								<TableRow key={member.id}>
									<TableCell>
										<div className="flex items-center gap-3">
											<Avatar>
												<AvatarFallback>
													{initials(member.user.name)}
												</AvatarFallback>
											</Avatar>
											<div>
												<p className="font-medium">
													{member.user.name}
													{member.userId === session.user.id && (
														<span className="ml-1 text-xs text-muted-foreground">
															(you)
														</span>
													)}
												</p>
												<p className="text-xs text-muted-foreground">
													{member.user.email}
												</p>
											</div>
										</div>
									</TableCell>
									<TableCell>
										<div className="flex flex-wrap gap-1">
											{member.role.split(",").map((role) => (
												<Badge key={role} variant="secondary">
													{role.trim()}
												</Badge>
											))}
										</div>
									</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										{date(member.createdAt)}
									</TableCell>
									<TableCell>
										<div className="flex justify-end gap-2">
											{member.userId !== workspace.personalOwnerId && (
												<>
													{permissions.data?.memberUpdate && (
														<MemberRoleEditor
															memberId={member.id}
															name={member.user.name}
															currentRole={member.role}
															manager={manager}
														/>
													)}
													{permissions.data?.memberDelete &&
														member.userId !== session.user.id && (
															<ConfirmAction
																label="Remove"
																title={`Remove ${member.user.name}?`}
																description="They will lose access to this workspace and its teams."
																action={async () => {
																	await result(
																		auth.organization.removeMember({
																			organizationId: workspace.id,
																			memberIdOrEmail: member.id,
																		}),
																	);
																	await refresh();
																}}
															/>
														)}
												</>
											)}
											{member.userId === workspace.personalOwnerId && (
												<span className="text-xs text-muted-foreground">
													Personal owner
												</span>
											)}
										</div>
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				<div className="mt-4 flex items-center justify-between gap-3">
					<p className="text-xs text-muted-foreground">Page {page + 1}</p>
					<div className="flex gap-2">
						<Button
							variant="outline"
							disabled={!page || members.isFetching}
							onClick={() => setPage(page - 1)}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							disabled={
								!members.data ||
								(page + 1) * 25 >= members.data.total ||
								members.isFetching
							}
							onClick={() => setPage(page + 1)}
						>
							Next
						</Button>
					</div>
				</div>
			</Section>
		</>
	);
}
