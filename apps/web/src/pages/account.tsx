import { useQuery } from "@tanstack/react-query";
import { KeyRound, Monitor, ShieldCheck } from "lucide-react";
import { Link } from "react-router";
import { useApp } from "@/components/app-layout";
import {
	AsyncForm,
	ConfirmAction,
	ErrorMessage,
	Loading,
	PageHeading,
	password,
	Section,
	TextField,
	value,
} from "@/components/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FieldDescription } from "@/components/ui/field";
import { auth, result } from "@/lib/auth";
import { date, refresh } from "@/lib/query";

export function AccountPage() {
	const { session } = useApp();
	const sessions = useQuery({
		queryKey: ["sessions", session.user.id],
		queryFn: () => result(auth.listSessions()),
	});
	return (
		<>
			<PageHeading
				title="Profile & security"
				description="Your personal details, password, and signed-in devices."
			/>
			<div className="grid items-start gap-6 lg:grid-cols-2">
				<Section
					title="Your profile"
					description="The name people see in your workspaces."
				>
					<AsyncForm
						onSubmit={async (data) => {
							await result(
								auth.updateUser({
									name: value(data, "name"),
									image: value(data, "image") || null,
								}),
							);
							await auth.getSession({ query: { disableCookieCache: true } });
							await refresh();
						}}
					>
						<TextField
							label="Full name"
							name="name"
							defaultValue={session.user.name}
							required
							maxLength={100}
							autoComplete="name"
						/>
						<TextField
							label="Profile image URL"
							name="image"
							type="url"
							defaultValue={session.user.image || ""}
							placeholder="https://example.com/photo.jpg"
						/>
						<TextField
							label="Email address"
							value={session.user.email}
							readOnly
							description="Your verified sign-in address."
						/>
						<FieldDescription>
							<ShieldCheck className="mr-1 inline size-4" />
							Email verified · Joined {date(session.user.createdAt)}
						</FieldDescription>
					</AsyncForm>
				</Section>
				<Section
					title="Password"
					description="Changing your password signs out your other sessions."
				>
					<AsyncForm
						submit="Update password"
						success="Password updated. Your other sessions have been signed out."
						onSubmit={async (data) => {
							await result(
								auth.changePassword({
									currentPassword: password(data, "currentPassword"),
									newPassword: password(data),
									revokeOtherSessions: true,
								}),
							);
							await refresh();
						}}
					>
						<TextField
							label="Current password"
							type="password"
							name="currentPassword"
							autoComplete="current-password"
							required
						/>
						<TextField
							label="New password"
							type="password"
							name="password"
							autoComplete="new-password"
							minLength={8}
							maxLength={128}
							required
						/>
						<FieldDescription>
							<KeyRound className="mr-1 inline size-4" />
							Need to set a password, or forgot yours? Use an emailed reset
							code.
						</FieldDescription>
						<Button
							variant="outline"
							render={
								<Link
									to={`/forgot-password?email=${encodeURIComponent(session.user.email)}`}
								/>
							}
						>
							Reset password by email
						</Button>
					</AsyncForm>
				</Section>
			</div>
			<Section
				title="Active sessions"
				description="Review devices with access to your account."
				action={
					<ConfirmAction
						label="Sign out other sessions"
						title="Sign out other devices?"
						description="Your current session will stay signed in."
						action={async () => {
							await result(auth.revokeOtherSessions());
							await refresh();
						}}
					/>
				}
			>
				{sessions.isPending ? (
					<Loading />
				) : sessions.error ? (
					<ErrorMessage error={sessions.error} />
				) : (
					<div className="flex flex-col gap-3">
						{sessions.data?.map((item) => (
							<div
								key={item.id}
								className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-4"
							>
								<div className="flex min-w-0 items-start gap-3">
									<Monitor className="mt-1 size-5 shrink-0 text-muted-foreground" />
									<div className="min-w-0">
										<p
											className="max-w-lg truncate text-sm font-medium"
											title={item.userAgent || "Unknown device"}
										>
											{item.userAgent || "Unknown device"}
										</p>
										<p className="text-xs text-muted-foreground">
											{item.ipAddress || "IP unavailable"} · Created{" "}
											{date(item.createdAt)}
										</p>
										<p className="text-xs text-muted-foreground">
											Expires {date(item.expiresAt)}
										</p>
									</div>
								</div>
								{item.id === session.session.id ? (
									<Badge variant="secondary">This device</Badge>
								) : (
									<ConfirmAction
										label="Revoke"
										title="Sign out this device?"
										description="This session will lose access immediately."
										action={async () => {
											await result(auth.revokeSession({ token: item.token }));
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
