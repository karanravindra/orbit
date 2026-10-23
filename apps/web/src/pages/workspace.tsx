import {
	ArrowUpRight,
	Building2,
	Layers3,
	Mail,
	ShieldCheck,
	Users,
} from "lucide-react";
import { Link, useNavigate } from "react-router";
import {
	useApp,
	useWorkspace,
	useWorkspacePermissions,
} from "@/components/app-layout";
import {
	ActionButton,
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { auth, result } from "@/lib/auth";
import { date, refresh } from "@/lib/query";

export function MissingWorkspace() {
	return (
		<Section title="Choose a workspace">
			<NoData
				title="No active workspace"
				description="Choose a workspace in the sidebar. If your personal workspace is missing, signing in again retries its creation."
			/>
			<ActionButton
				variant="outline"
				action={async () => {
					await result(auth.signOut());
					window.location.assign("/sign-in");
				}}
			>
				Sign in again
			</ActionButton>
		</Section>
	);
}

export function OverviewPage() {
	const { session, workspace } = useApp();
	const org = useWorkspace();
	if (!workspace) return <MissingWorkspace />;
	if (org.isPending) return <Loading />;
	if (org.error) return <ErrorMessage error={org.error} />;
	const member = org.data.members.find((m) => m.userId === session.user.id);
	const cards = [
		{
			title: "People",
			description: "Manage workspace members and their access.",
			icon: Users,
			path: "/members",
			value: `${org.data.members.length}${org.data.members.length >= 100 ? "+" : ""} members`,
		},
		{
			title: "Teams",
			description: "Organize people into focused groups.",
			icon: Layers3,
			path: "/teams",
			value: `${org.data.teams?.length || 0} teams`,
		},
		{
			title: "Invitations",
			description: "Bring someone new into your workspace.",
			icon: Mail,
			path: "/invitations",
			value: `${org.data.invitations.filter((i) => i.status === "pending" && new Date(i.expiresAt) > new Date()).length} pending`,
		},
	];
	return (
		<>
			<PageHeading
				title={`Welcome, ${session.user.name.split(" ")[0]}`}
				description="A home for your people and workspace settings."
				action={
					<Badge variant="outline">
						<ShieldCheck data-icon="inline-start" />
						{member?.role || "Member"}
					</Badge>
				}
			/>
			<Section
				title={workspace.name}
				description={
					workspace.personalOwnerId === session.user.id
						? "Your personal workspace. Invite people to collaborate with you."
						: "A shared workspace you’ve joined by invitation."
				}
			>
				<div className="flex flex-wrap items-center gap-4">
					<div className="flex size-14 items-center justify-center rounded-xl bg-muted">
						<Building2 className="size-6 text-muted-foreground" />
					</div>
					<div className="flex-1">
						<p className="text-sm font-medium">{workspace.slug}</p>
						<p className="text-xs text-muted-foreground">
							Created {date(workspace.createdAt)}
						</p>
					</div>
					<Button variant="outline" render={<Link to="/workspace" />}>
						Workspace settings
						<ArrowUpRight data-icon="inline-end" />
					</Button>
				</div>
			</Section>
			<div className="grid gap-5 md:grid-cols-3">
				{cards.map((card) => (
					<Card key={card.path}>
						<CardHeader>
							<card.icon className="mb-4 size-5 text-muted-foreground" />
							<CardTitle>{card.title}</CardTitle>
							<CardDescription>{card.description}</CardDescription>
						</CardHeader>
						<CardContent>
							<p className="text-2xl font-semibold tracking-tight">
								{card.value}
							</p>
						</CardContent>
						<CardFooter>
							<Button
								variant="ghost"
								className="w-full justify-between"
								render={<Link to={card.path} />}
							>
								View {card.title.toLowerCase()}
								<ArrowUpRight data-icon="inline-end" />
							</Button>
						</CardFooter>
					</Card>
				))}
			</div>
			<Section
				title="Your account"
				description="Keep your profile and sign-in details up to date."
			>
				<div className="flex flex-wrap items-center justify-between gap-4">
					<div>
						<p className="text-sm font-medium">{session.user.email}</p>
						<p className="text-sm text-muted-foreground">
							Your email is verified.
						</p>
					</div>
					<Button variant="outline" render={<Link to="/account" />}>
						Profile & security
						<ArrowUpRight data-icon="inline-end" />
					</Button>
				</div>
			</Section>
		</>
	);
}

export function WorkspacePage() {
	const { session, workspace } = useApp();
	const permission = useWorkspacePermissions();
	const navigate = useNavigate();
	if (!workspace) return <MissingWorkspace />;
	return (
		<>
			<PageHeading
				title="Workspace settings"
				description="Manage this workspace’s name and identity."
			/>
			<ErrorMessage error={permission.error} />
			<Section
				title="Workspace details"
				description={
					permission.data?.update
						? "Changes are visible to everyone in this workspace."
						: "You need workspace update permission to make changes."
				}
			>
				<AsyncForm
					disabled={!permission.data?.update}
					onSubmit={async (data) => {
						await result(
							auth.organization.update({
								organizationId: workspace.id,
								data: {
									name: value(data, "name"),
									slug: value(data, "slug"),
									logo: value(data, "logo") || null,
								},
							}),
						);
						await refresh();
					}}
				>
					<TextField
						label="Workspace name"
						name="name"
						defaultValue={workspace.name}
						required
						maxLength={100}
					/>
					<TextField
						label="Slug"
						name="slug"
						defaultValue={workspace.slug}
						required
						pattern="[a-z0-9-]+"
						description="Lowercase letters, numbers, and hyphens."
					/>
					<TextField
						label="Logo URL"
						name="logo"
						type="url"
						defaultValue={workspace.logo || ""}
						placeholder="https://example.com/logo.png"
					/>
				</AsyncForm>
			</Section>
			{workspace.personalOwnerId === session.user.id ? (
				<Section
					title="Personal workspace"
					description="You are this workspace’s sole owner."
				>
					<p className="text-sm text-muted-foreground">
						Your personal workspace stays with your account. Ownership cannot be
						transferred, and you cannot leave or delete it.
					</p>
				</Section>
			) : (
				<Section
					title="Leave workspace"
					description="Leaving removes your membership and access to this workspace."
				>
					<ConfirmAction
						label="Leave workspace"
						title={`Leave ${workspace.name}?`}
						description="You’ll need another invitation to rejoin."
						action={async () => {
							await result(
								auth.organization.leave({ organizationId: workspace.id }),
							);
							const orgs = await result(auth.organization.list());
							const personal = orgs.find(
								(org) => org.personalOwnerId === session.user.id,
							);
							await result(
								auth.organization.setActive({
									organizationId: personal?.id || null,
								}),
							);
							await refresh();
							navigate("/");
						}}
					/>
				</Section>
			)}
		</>
	);
}
