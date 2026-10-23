import { useQuery } from "@tanstack/react-query";
import type { UserWithRole } from "better-auth/plugins/admin";
import { useState } from "react";
import { Navigate } from "react-router";
import { useApp } from "@/components/app-layout";
import {
	ActionButton,
	AsyncForm,
	Choice,
	ConfirmAction,
	ErrorMessage,
	Loading,
	NoData,
	PageHeading,
	password,
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

type AdminUser = UserWithRole;

function UserSessions({ userId }: { userId: string }) {
	const sessions = useQuery({
		queryKey: ["admin-sessions", userId],
		queryFn: () => result(auth.admin.listUserSessions({ userId })),
	});
	return (
		<Section
			title="User sessions"
			action={
				<ConfirmAction
					label="Revoke all"
					title="Revoke all user sessions?"
					description="The user will be signed out on every device."
					action={async () => {
						await result(auth.admin.revokeUserSessions({ userId }));
						await refresh();
					}}
				/>
			}
		>
			{sessions.isPending ? (
				<Loading />
			) : sessions.error ? (
				<ErrorMessage error={sessions.error} />
			) : !sessions.data.sessions.length ? (
				<NoData
					title="No active sessions"
					description="This user has no signed-in devices."
				/>
			) : (
				<div className="flex flex-col gap-3">
					{sessions.data.sessions.map((session) => (
						<div
							key={session.id}
							className="flex flex-wrap items-center justify-between gap-3"
						>
							<div className="min-w-0">
								<p
									className="max-w-xs truncate text-sm"
									title={session.userAgent || "Unknown device"}
								>
									{session.userAgent || "Unknown device"}
								</p>
								<p className="text-xs text-muted-foreground">
									{session.ipAddress || "IP unavailable"} · Expires{" "}
									{date(session.expiresAt)}
								</p>
							</div>
							<ActionButton
								variant="outline"
								size="sm"
								action={async () => {
									await result(
										auth.admin.revokeUserSession({
											sessionToken: session.token,
										}),
									);
									await refresh();
								}}
							>
								Revoke
							</ActionButton>
						</div>
					))}
				</div>
			)}
		</Section>
	);
}

function UserEditor({ user }: { user: AdminUser }) {
	const { session } = useApp();
	const [open, setOpen] = useState(false);
	const [role, setRole] = useState(user.role || "user");
	const [verified, setVerified] = useState(user.emailVerified ? "yes" : "no");
	const self = session.user.id === user.id;
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button size="sm" variant="outline" />}>
				Manage
			</DialogTrigger>
			<DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
				<DialogHeader>
					<DialogTitle>{user.name}</DialogTitle>
					<DialogDescription>
						{user.email} · Joined {date(user.createdAt)}
					</DialogDescription>
				</DialogHeader>
				<Section title="User details">
					<AsyncForm
						onSubmit={async (data) => {
							await result(
								auth.admin.updateUser({
									userId: user.id,
									data: {
										name: value(data, "name"),
										image: value(data, "image") || null,
										...(user.emailVerified !== (verified === "yes")
											? { emailVerified: verified === "yes" }
											: {}),
									},
								}),
							);
							await refresh();
						}}
					>
						<TextField
							label="Name"
							name="name"
							defaultValue={user.name}
							required
						/>
						<TextField
							label="Image URL"
							name="image"
							type="url"
							defaultValue={user.image || ""}
						/>
						<Choice
							label="Email verified"
							value={verified}
							onChange={setVerified}
							options={[
								{ value: "yes", label: "Verified" },
								{ value: "no", label: "Not verified" },
							]}
						/>
					</AsyncForm>
				</Section>
				<Section title="Email address">
					<AsyncForm
						submit="Update email"
						onSubmit={async (data) => {
							await result(
								auth.admin.updateUser({
									userId: user.id,
									data: { email: value(data, "email") },
								}),
							);
							await refresh();
						}}
					>
						<TextField
							label="Email"
							name="email"
							type="email"
							defaultValue={user.email}
							required
						/>
					</AsyncForm>
				</Section>
				<Section
					title="Platform role"
					description="Platform admins can manage users across Orbit. Workspace roles are separate."
				>
					<AsyncForm
						submit="Update platform role"
						onSubmit={async () => {
							await result(
								auth.admin.setRole({
									userId: user.id,
									role: role as "admin" | "user",
								}),
							);
							await refresh();
							if (self) window.location.reload();
						}}
					>
						<Choice
							label="Role"
							value={role}
							onChange={setRole}
							options={[
								{ value: "user", label: "User" },
								{ value: "admin", label: "Platform admin" },
							]}
						/>
					</AsyncForm>
				</Section>
				<Section title="Password">
					<AsyncForm
						submit="Set password"
						onSubmit={async (data) => {
							await result(
								auth.admin.setUserPassword({
									userId: user.id,
									newPassword: password(data),
								}),
							);
							await refresh();
						}}
					>
						<TextField
							label="New password"
							name="password"
							type="password"
							autoComplete="new-password"
							minLength={8}
							maxLength={128}
							required
						/>
					</AsyncForm>
				</Section>
				<UserSessions userId={user.id} />
				{!self && (
					<Section
						title="Access controls"
						description={
							user.banned
								? `Banned: ${user.banReason || "No reason supplied"}. Expires: ${date(user.banExpires)}`
								: "Suspend access or temporarily view Orbit as this user."
						}
					>
						<div className="flex flex-col gap-4">
							{user.banned ? (
								<ActionButton
									variant="outline"
									action={async () => {
										await result(auth.admin.unbanUser({ userId: user.id }));
										await refresh();
									}}
								>
									Unban user
								</ActionButton>
							) : (
								<AsyncForm
									submit="Ban user"
									success="User banned."
									onSubmit={async (data) => {
										const hours = value(data, "hours");
										await result(
											auth.admin.banUser({
												userId: user.id,
												banReason: value(data, "reason") || undefined,
												...(hours
													? { banExpiresIn: Number(hours) * 3600 }
													: {}),
											}),
										);
										await refresh();
									}}
								>
									<TextField label="Ban reason (optional)" name="reason" />
									<TextField
										label="Duration in hours (optional)"
										name="hours"
										type="number"
										min="1"
										step="1"
										description="Leave blank for a ban without an expiry."
									/>
								</AsyncForm>
							)}
							{user.role !== "admin" && (
								<ActionButton
									variant="outline"
									action={async () => {
										await result(
											auth.admin.impersonateUser({ userId: user.id }),
										);
										queryClient.clear();
										window.location.assign("/");
									}}
								>
									Impersonate for up to one hour
								</ActionButton>
							)}
							<ConfirmAction
								label="Delete user"
								title={`Delete ${user.name}?`}
								description="This permanently deletes the user and their personal workspace, including its memberships and teams."
								action={async () => {
									await result(auth.admin.removeUser({ userId: user.id }));
									await refresh();
									setOpen(false);
								}}
							/>
						</div>
					</Section>
				)}
			</DialogContent>
		</Dialog>
	);
}

function CreateUser() {
	const [open, setOpen] = useState(false);
	const [role, setRole] = useState("user");
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger render={<Button />}>Create user</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Create user</DialogTitle>
					<DialogDescription>
						Create an account and its personal workspace.
					</DialogDescription>
				</DialogHeader>
				<AsyncForm
					submit="Create user"
					onSubmit={async (data) => {
						await result(
							auth.admin.createUser({
								name: value(data, "name"),
								email: value(data, "email"),
								password: password(data),
								role: role as "user" | "admin",
							}),
						);
						await refresh();
						setOpen(false);
					}}
				>
					<TextField label="Name" name="name" autoComplete="off" required />
					<TextField
						label="Email"
						name="email"
						type="email"
						autoComplete="off"
						required
					/>
					<TextField
						label="Initial password"
						name="password"
						type="password"
						autoComplete="new-password"
						minLength={8}
						maxLength={128}
						required
					/>
					<Choice
						label="Platform role"
						value={role}
						onChange={setRole}
						options={[
							{ value: "user", label: "User" },
							{ value: "admin", label: "Platform admin" },
						]}
					/>
					<FieldDescription>
						The user must verify their email before signing in. They can request
						a verification code from the verification page.
					</FieldDescription>
				</AsyncForm>
			</DialogContent>
		</Dialog>
	);
}

export function AdminPage() {
	const { session } = useApp();
	const [page, setPage] = useState(0);
	const [search, setSearch] = useState("");
	const users = useQuery({
		queryKey: ["admin-users", page, search],
		enabled: session.user.role === "admin",
		queryFn: () =>
			result(
				auth.admin.listUsers({
					query: {
						limit: 25,
						offset: page * 25,
						searchValue: search || undefined,
						searchField: "email",
						searchOperator: "contains",
						sortBy: "createdAt",
						sortDirection: "desc",
					},
				}),
			),
	});
	if (session.user.role !== "admin") return <Navigate to="/" replace />;
	return (
		<>
			<PageHeading
				title="Platform administration"
				description="Manage Orbit users, sessions, and platform access."
				action={<CreateUser />}
			/>
			<Section
				title="Users"
				description="Search by email address and select a user to manage their account."
			>
				<div className="mb-5 max-w-sm">
					<TextField
						label="Search users"
						type="search"
						value={search}
						onChange={(event) => {
							setSearch(event.target.value);
							setPage(0);
						}}
						placeholder="Search by email…"
					/>
				</div>
				{users.isPending ? (
					<Loading />
				) : users.error ? (
					<ErrorMessage error={users.error} />
				) : !users.data.users.length ? (
					<NoData
						title="No users found"
						description="Try a different email search."
					/>
				) : (
					<Table>
						<TableHeader>
							<TableRow>
								<TableHead>User</TableHead>
								<TableHead>Platform role</TableHead>
								<TableHead>Status</TableHead>
								<TableHead>Created</TableHead>
								<TableHead className="text-right">Actions</TableHead>
							</TableRow>
						</TableHeader>
						<TableBody>
							{users.data.users.map((user) => (
								<TableRow key={user.id}>
									<TableCell>
										<p className="font-medium">{user.name}</p>
										<p className="text-xs text-muted-foreground">
											{user.email}
										</p>
									</TableCell>
									<TableCell>
										<Badge variant="secondary">{user.role || "user"}</Badge>
									</TableCell>
									<TableCell>
										<Badge variant={user.banned ? "destructive" : "outline"}>
											{user.banned
												? "Banned"
												: user.emailVerified
													? "Verified"
													: "Unverified"}
										</Badge>
									</TableCell>
									<TableCell className="text-xs text-muted-foreground">
										{date(user.createdAt)}
									</TableCell>
									<TableCell className="text-right">
										<UserEditor user={user} />
									</TableCell>
								</TableRow>
							))}
						</TableBody>
					</Table>
				)}
				<div className="mt-4 flex items-center justify-between gap-3">
					<p className="text-xs text-muted-foreground">
						{users.data?.total ?? "—"} users · Page {page + 1}
					</p>
					<div className="flex gap-2">
						<Button
							variant="outline"
							disabled={!page || users.isFetching}
							onClick={() => setPage(page - 1)}
						>
							Previous
						</Button>
						<Button
							variant="outline"
							disabled={
								!users.data ||
								(page + 1) * 25 >= users.data.total ||
								users.isFetching
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
