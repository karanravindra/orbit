import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useApp, useWorkspacePermissions } from "@/components/app-layout";
import {
	AsyncForm,
	ConfirmAction,
	ErrorMessage,
	Loading,
	NoData,
	PageHeading,
	Section,
	TextField,
	value,
} from "@/components/shared";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { auth, result } from "@/lib/auth";
import { refresh } from "@/lib/query";
import { MissingWorkspace } from "./workspace";

const resources = {
	organization: ["update", "delete"],
	member: ["create", "update", "delete"],
	invitation: ["create", "cancel"],
	team: ["create", "update", "delete"],
	ac: ["create", "read", "update", "delete"],
} as const;

export function useRoles(enabled = true) {
	const { workspace } = useApp();
	return useQuery({
		queryKey: ["roles", workspace?.id],
		enabled: !!workspace && enabled,
		queryFn: () =>
			result(
				auth.organization.listRoles({
					query: { organizationId: workspace?.id },
				}),
			),
	});
}

type CustomRole = {
	id: string;
	role: string;
	permission: Record<string, string[]>;
};

function RoleEditor({
	existing,
	canDelete,
}: {
	existing?: CustomRole;
	canDelete?: boolean;
}) {
	const { workspace } = useApp();
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={<Button variant={existing ? "outline" : "default"} />}
			>
				{existing ? "Edit role" : "Create role"}
			</DialogTrigger>
			<DialogContent className="max-h-[85svh] overflow-y-auto">
				<DialogHeader>
					<DialogTitle>
						{existing ? `Edit ${existing.role}` : "Create a custom role"}
					</DialogTitle>
					<DialogDescription>
						Grant only the workspace permissions this role needs. You can grant
						permissions you hold yourself.
					</DialogDescription>
				</DialogHeader>
				<AsyncForm
					submit={existing ? "Save role" : "Create role"}
					onSubmit={async (data) => {
						const permission: Record<string, string[]> = {};
						for (const [resource, actions] of Object.entries(resources)) {
							const selected = actions.filter(
								(action) => data.get(`${resource}:${action}`) === "on",
							);
							if (selected.length) permission[resource] = selected;
						}
						if (existing)
							await result(
								auth.organization.updateRole({
									organizationId: workspace?.id,
									roleId: existing.id,
									data: { roleName: value(data, "role"), permission },
								}),
							);
						else
							await result(
								auth.organization.createRole({
									organizationId: workspace?.id,
									role: value(data, "role"),
									permission,
								}),
							);
						await refresh();
						setOpen(false);
					}}
				>
					<TextField
						label="Role name"
						name="role"
						defaultValue={existing?.role}
						required
						pattern="[a-z][a-z0-9_-]*"
						description="Lowercase letters, numbers, underscores, and hyphens. Built-in role names are reserved."
					/>
					{Object.entries(resources).map(([resource, actions]) => (
						<FieldSet key={resource}>
							<FieldLegend>
								{resource === "ac"
									? "Custom roles"
									: resource.charAt(0).toUpperCase() + resource.slice(1)}
							</FieldLegend>
							<FieldGroup>
								{actions.map((action) => (
									<Field key={action} orientation="horizontal">
										<Checkbox
											id={`permission-${resource}-${action}`}
											name={`${resource}:${action}`}
											defaultChecked={existing?.permission[resource]?.includes(
												action,
											)}
										/>
										<FieldLabel htmlFor={`permission-${resource}-${action}`}>
											{action}
										</FieldLabel>
									</Field>
								))}
							</FieldGroup>
						</FieldSet>
					))}
					<Alert>
						<AlertDescription>
							Custom roles cannot invite people or grant admin, even with the
							corresponding permissions. Personal workspace ownership and
							deletion restrictions always apply.
						</AlertDescription>
					</Alert>
				</AsyncForm>
				{existing && canDelete && (
					<ConfirmAction
						label="Delete role"
						title={`Delete ${existing.role}?`}
						description="Members assigned this role will lose its permissions."
						action={async () => {
							await result(
								auth.organization.deleteRole({
									organizationId: workspace?.id,
									roleId: existing.id,
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

export function RolesPage() {
	const { workspace } = useApp();
	const permissions = useWorkspacePermissions();
	const roles = useRoles(!!permissions.data?.roleRead);
	if (!workspace) return <MissingWorkspace />;
	return (
		<>
			<PageHeading
				title="Roles & permissions"
				description="Control what people can do in this workspace."
				action={permissions.data?.roleCreate && <RoleEditor />}
			/>
			<ErrorMessage error={permissions.error} />
			<Section
				title="Built-in roles"
				description="These roles are defined by Orbit and cannot be edited."
			>
				<div className="grid gap-4 md:grid-cols-3">
					{[
						{
							name: "Owner",
							description:
								"The personal workspace’s sole owner. Manages settings, members, invitations, teams, and roles. Ownership cannot be transferred.",
						},
						{
							name: "Admin",
							description:
								"Manages settings, members, invitations, teams, and custom roles. Cannot remove or demote the owner.",
						},
						{
							name: "Member",
							description:
								"Views workspace information and participates in teams. Cannot invite people or manage workspace access.",
						},
					].map((role) => (
						<div
							key={role.name}
							className="flex flex-col gap-3 rounded-lg border p-4"
						>
							<Badge variant="secondary">{role.name}</Badge>
							<p className="text-sm leading-relaxed text-muted-foreground">
								{role.description}
							</p>
						</div>
					))}
				</div>
			</Section>
			<Section
				title="Custom roles"
				description="Compose permissions for the way your workspace works."
			>
				{permissions.isPending ? (
					<Loading />
				) : !permissions.data?.roleRead ? (
					<NoData
						title="Role access required"
						description="You need permission to read custom roles in this workspace."
					/>
				) : roles.isPending ? (
					<Loading />
				) : roles.error ? (
					<ErrorMessage error={roles.error} />
				) : !roles.data?.length ? (
					<NoData
						title="No custom roles yet"
						description="Built-in roles are ready to use. Create a custom role when you need more specific access."
					/>
				) : (
					<div className="flex flex-col gap-4">
						{roles.data.map((role) => (
							<div
								key={role.id}
								className="flex flex-wrap items-center justify-between gap-4 rounded-lg border p-4"
							>
								<div className="flex flex-col gap-2">
									<p className="font-medium">{role.role}</p>
									<div className="flex flex-wrap gap-1">
										{Object.entries(role.permission).flatMap(
											([resource, actions]) =>
												actions.map((action) => (
													<Badge
														key={`${resource}:${action}`}
														variant="outline"
													>
														{resource}:{action}
													</Badge>
												)),
										)}
									</div>
								</div>
								{permissions.data?.roleUpdate && (
									<RoleEditor
										existing={role}
										canDelete={permissions.data.roleDelete}
									/>
								)}
								{!permissions.data?.roleUpdate &&
									permissions.data?.roleDelete && (
										<ConfirmAction
											label="Delete role"
											title={`Delete ${role.role}?`}
											description="Members assigned this role will lose its permissions."
											action={async () => {
												await result(
													auth.organization.deleteRole({
														organizationId: workspace.id,
														roleId: role.id,
													}),
												);
												await refresh();
											}}
										/>
									)}
							</div>
						))}
					</div>
				)}
			</Section>
		</>
	);
}
