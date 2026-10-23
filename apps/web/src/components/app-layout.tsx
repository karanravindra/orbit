import { useQuery } from "@tanstack/react-query";
import {
	Building2,
	CircleUserRound,
	Home,
	Layers3,
	LogOut,
	Mail,
	Orbit,
	Settings2,
	ShieldCheck,
	Users,
} from "lucide-react";
import { createContext, useContext, useEffect } from "react";
import { Link, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import {
	ActionButton,
	Choice,
	ErrorMessage,
	Loading,
} from "@/components/shared";
import { ThemeToggle } from "@/components/theme";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
	Sidebar,
	SidebarContent,
	SidebarFooter,
	SidebarGroup,
	SidebarGroupLabel,
	SidebarHeader,
	SidebarInset,
	SidebarMenu,
	SidebarMenuButton,
	SidebarMenuItem,
	SidebarProvider,
	SidebarTrigger,
	useSidebar,
} from "@/components/ui/sidebar";
import { auth, result, type Session, type Workspace } from "@/lib/auth";
import { queryClient, refresh } from "@/lib/query";

const workspaceContext = createContext<{
	session: Session;
	workspace: Workspace | null;
} | null>(null);
export function useApp() {
	const ctx = useContext(workspaceContext);
	if (!ctx) throw new Error("App context missing");
	return ctx;
}

export function AppLayout() {
	const session = auth.useSession();
	const location = useLocation();
	if (session.isPending)
		return (
			<div className="mx-auto max-w-3xl p-8">
				<Loading />
			</div>
		);
	if (session.error)
		return (
			<div className="mx-auto flex max-w-lg flex-col gap-4 p-8">
				<ErrorMessage error={session.error.message} />
				<ActionButton action={() => session.refetch()}>
					Retry connection
				</ActionButton>
			</div>
		);
	if (!session.data)
		return (
			<Navigate
				to={`/sign-in?next=${encodeURIComponent(location.pathname + location.search)}`}
				replace
			/>
		);
	return <SignedInLayout session={session.data} />;
}

function SignedInLayout({ session }: { session: Session }) {
	const orgs = auth.useListOrganizations();
	const activeId = session.session.activeOrganizationId;
	// Invitation acceptance changes the active workspace without invalidating
	// Better Auth's organization-list store.
	const refetchOrganizations = orgs.refetch;
	useEffect(() => {
		if (activeId) refetchOrganizations();
	}, [activeId, refetchOrganizations]);
	const workspace = orgs.data?.find((org) => org.id === activeId) ?? null;
	const navigate = useNavigate();
	return (
		<workspaceContext.Provider value={{ session, workspace }}>
			<SidebarProvider>
				<Navigation />
				<SidebarInset>
					<header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b px-4 md:px-8">
						<div className="flex min-w-0 items-center gap-3">
							<SidebarTrigger />
							<Separator orientation="vertical" className="h-4" />
							<Building2 className="size-4 shrink-0 text-muted-foreground" />
							<span className="truncate text-sm">
								{workspace?.name || "Your account"}
							</span>
							{workspace?.personalOwnerId === session.user.id && (
								<Badge variant="secondary">Personal</Badge>
							)}
						</div>
						<ThemeToggle />
					</header>
					<div
						id="main-content"
						className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 p-4 md:p-8 lg:p-10"
					>
						{session.session.impersonatedBy && (
							<Alert>
								<ShieldCheck />
								<AlertTitle>Impersonating {session.user.name}</AlertTitle>
								<AlertDescription>
									<p>This session lasts up to one hour.</p>
									<ActionButton
										variant="outline"
										action={async () => {
											await result(auth.admin.stopImpersonating());
											queryClient.clear();
											await auth.getSession({
												query: { disableCookieCache: true },
											});
											navigate("/admin");
											window.location.reload();
										}}
									>
										Return to your admin account
									</ActionButton>
								</AlertDescription>
							</Alert>
						)}
						{orgs.error && <ErrorMessage error={orgs.error.message} />}
						{orgs.isPending ? (
							<Loading />
						) : (
							<Outlet key={activeId || "account"} />
						)}
					</div>
					<footer className="flex items-center justify-between border-t px-4 py-4 text-xs text-muted-foreground md:px-8">
						<span>Orbit</span>
						<span>Account & workspace</span>
					</footer>
				</SidebarInset>
			</SidebarProvider>
		</workspaceContext.Provider>
	);
}

const workspaceLinks = [
	{ path: "/", label: "Overview", icon: Home },
	{ path: "/members", label: "Members", icon: Users },
	{ path: "/invitations", label: "Invitations", icon: Mail },
	{ path: "/teams", label: "Teams", icon: Layers3 },
	{ path: "/roles", label: "Roles & permissions", icon: ShieldCheck },
	{ path: "/workspace", label: "Workspace settings", icon: Settings2 },
];

function Navigation() {
	const { session, workspace } = useApp();
	const orgs = auth.useListOrganizations();
	const location = useLocation();
	const navigate = useNavigate();
	const { setOpenMobile } = useSidebar();
	const [switchError, setSwitchError] = useState<unknown>(null);
	const [switching, setSwitching] = useState(false);
	return (
		<Sidebar>
			<SidebarHeader className="gap-6 p-5">
				<Link to="/" className="flex items-center gap-2 text-xl font-semibold">
					<Orbit className="size-7" />
					Orbit
				</Link>
				<Choice
					label="Workspace"
					value={workspace?.id || ""}
					options={(orgs.data || []).map((org) => ({
						label: org.name,
						value: org.id,
					}))}
					disabled={switching}
					onChange={async (id) => {
						setSwitching(true);
						setSwitchError(null);
						try {
							await result(auth.organization.setActive({ organizationId: id }));
							await refresh();
							navigate("/");
							setOpenMobile(false);
						} catch (error) {
							setSwitchError(error);
						} finally {
							setSwitching(false);
						}
					}}
				/>
				<ErrorMessage error={switchError} />
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarGroupLabel>Workspace</SidebarGroupLabel>
					<SidebarMenu>
						{workspaceLinks.map((item) => (
							<SidebarMenuItem key={item.path}>
								<SidebarMenuButton
									isActive={location.pathname === item.path}
									render={<Link to={item.path} />}
									onClick={() => setOpenMobile(false)}
								>
									<item.icon />
									<span>{item.label}</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						))}
					</SidebarMenu>
				</SidebarGroup>
				<SidebarGroup>
					<SidebarGroupLabel>Account</SidebarGroupLabel>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton
								isActive={location.pathname === "/account"}
								render={<Link to="/account" />}
								onClick={() => setOpenMobile(false)}
							>
								<CircleUserRound />
								<span>Profile & security</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
						{session.user.role === "admin" && (
							<SidebarMenuItem>
								<SidebarMenuButton
									isActive={location.pathname === "/admin"}
									render={<Link to="/admin" />}
									onClick={() => setOpenMobile(false)}
								>
									<ShieldCheck />
									<span>Platform admin</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
						)}
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter className="gap-4 p-5">
				<Separator />
				<div className="flex min-w-0 items-center gap-3">
					<Avatar>
						{session.user.image && (
							<AvatarImage src={session.user.image} alt={session.user.name} />
						)}
						<AvatarFallback>{initials(session.user.name)}</AvatarFallback>
					</Avatar>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium">{session.user.name}</p>
						<p className="truncate text-xs text-muted-foreground">
							{session.user.email}
						</p>
					</div>
				</div>
				<ActionButton
					variant="outline"
					action={async () => {
						await result(auth.signOut());
						queryClient.clear();
						navigate("/sign-in", { replace: true });
					}}
				>
					<LogOut data-icon="inline-start" />
					Sign out
				</ActionButton>
			</SidebarFooter>
		</Sidebar>
	);
}

import { useState } from "react";
export function initials(name: string) {
	return name
		.split(" ")
		.map((n) => n[0])
		.join("")
		.slice(0, 2)
		.toUpperCase();
}

export function useWorkspacePermissions() {
	const { workspace, session } = useApp();
	return useQuery({
		queryKey: ["permissions", workspace?.id, session.user.id],
		enabled: !!workspace,
		queryFn: async () => {
			const check = async (
				permissions: Parameters<
					typeof auth.organization.hasPermission
				>[0]["permissions"],
			) =>
				(
					await result(
						auth.organization.hasPermission({
							organizationId: workspace?.id,
							permissions,
						}),
					)
				).success;
			const [
				update,
				memberUpdate,
				memberDelete,
				invitationCancel,
				teamCreate,
				teamUpdate,
				teamDelete,
				roleRead,
				roleCreate,
				roleUpdate,
				roleDelete,
			] = await Promise.all([
				check({ organization: ["update"] }),
				check({ member: ["update"] }),
				check({ member: ["delete"] }),
				check({ invitation: ["cancel"] }),
				check({ team: ["create"] }),
				check({ team: ["update"] }),
				check({ team: ["delete"] }),
				check({ ac: ["read"] }),
				check({ ac: ["create"] }),
				check({ ac: ["update"] }),
				check({ ac: ["delete"] }),
			]);
			return {
				update,
				memberUpdate,
				memberDelete,
				invitationCancel,
				teamCreate,
				teamUpdate,
				teamDelete,
				roleRead,
				roleCreate,
				roleUpdate,
				roleDelete,
			};
		},
	});
}

export function useWorkspace() {
	const { workspace } = useApp();
	return useQuery({
		queryKey: ["workspace", workspace?.id],
		enabled: !!workspace,
		queryFn: () =>
			result(
				auth.organization.getFullOrganization({
					query: { organizationId: workspace?.id },
				}),
			),
	});
}

export function useActiveMember() {
	const { workspace, session } = useApp();
	return useQuery({
		queryKey: ["active-member", workspace?.id, session.user.id],
		enabled: !!workspace,
		queryFn: () => result(auth.organization.getActiveMember()),
	});
}
