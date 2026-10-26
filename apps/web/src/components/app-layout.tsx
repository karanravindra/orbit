import { useQuery } from "@tanstack/react-query";
import {
	Building2,
	ChevronDown,
	CircleUserRound,
	Home,
	LogOut,
	Orbit,
	Settings2,
	ShieldCheck,
} from "lucide-react";
import { createContext, useContext, useEffect, useState } from "react";
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

function Navigation() {
	const { session, workspace } = useApp();
	const orgs = auth.useListOrganizations();
	const location = useLocation();
	const navigate = useNavigate();
	const { setOpenMobile } = useSidebar();
	const [switchError, setSwitchError] = useState<unknown>(null);
	const [switching, setSwitching] = useState(false);
	const [userMenuOpen, setUserMenuOpen] = useState(false);
	const closeMobileNavigation = () => setOpenMobile(false);
	const selectWorkspace = async (id: string) => {
		setSwitching(true);
		setSwitchError(null);
		try {
			await result(auth.organization.setActive({ organizationId: id }));
			await refresh();
			navigate("/");
			setUserMenuOpen(false);
			closeMobileNavigation();
		} catch (error) {
			setSwitchError(error);
		} finally {
			setSwitching(false);
		}
	};
	return (
		<Sidebar>
			<SidebarHeader className="p-5">
				<Link to="/" className="flex items-center gap-2 text-xl font-semibold">
					<Orbit className="size-7" />
					Orbit
				</Link>
			</SidebarHeader>
			<SidebarContent>
				<SidebarGroup>
					<SidebarMenu>
						<SidebarMenuItem>
							<SidebarMenuButton
								isActive={location.pathname === "/"}
								render={<Link to="/" />}
								onClick={closeMobileNavigation}
							>
								<Home />
								<span>Overview</span>
							</SidebarMenuButton>
						</SidebarMenuItem>
					</SidebarMenu>
				</SidebarGroup>
			</SidebarContent>
			<SidebarFooter className="gap-3 p-5">
				<Separator />
				{userMenuOpen && (
					<div className="flex flex-col gap-3 rounded-lg border bg-background p-3 shadow-sm">
						<Choice
							label="Workspace"
							value={workspace?.id || ""}
							options={(orgs.data || []).map((org) => ({
								label: org.name,
								value: org.id,
							}))}
							disabled={switching}
							onChange={selectWorkspace}
						/>
						<ErrorMessage error={switchError} />
						<SidebarMenu>
							<SidebarMenuItem>
								<SidebarMenuButton
									render={<Link to="/settings" />}
									onClick={() => {
										setUserMenuOpen(false);
										closeMobileNavigation();
									}}
								>
									<Settings2 />
									<span>Settings</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							<SidebarMenuItem>
								<SidebarMenuButton
									render={<Link to="/account" />}
									onClick={() => {
										setUserMenuOpen(false);
										closeMobileNavigation();
									}}
								>
									<CircleUserRound />
									<span>Profile & security</span>
								</SidebarMenuButton>
							</SidebarMenuItem>
							{session.user.role === "admin" && (
								<SidebarMenuItem>
									<SidebarMenuButton
										render={<Link to="/admin" />}
										onClick={() => {
											setUserMenuOpen(false);
											closeMobileNavigation();
										}}
									>
										<ShieldCheck />
										<span>Platform admin</span>
									</SidebarMenuButton>
								</SidebarMenuItem>
							)}
						</SidebarMenu>
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
					</div>
				)}
				<button
					type="button"
					className="flex min-w-0 items-center gap-3 rounded-md p-2 text-left hover:bg-sidebar-accent"
					onClick={() => setUserMenuOpen((open) => !open)}
					aria-expanded={userMenuOpen}
				>
					<Avatar>
						{session.user.image && (
							<AvatarImage src={session.user.image} alt={session.user.name} />
						)}
						<AvatarFallback>{initials(session.user.name)}</AvatarFallback>
					</Avatar>
					<div className="min-w-0 flex-1">
						<p className="truncate text-sm font-medium">{session.user.name}</p>
						<p className="truncate text-xs text-muted-foreground">
							{workspace?.name || "Choose a workspace"}
						</p>
					</div>
					<ChevronDown className="size-4 shrink-0" />
				</button>
			</SidebarFooter>
		</Sidebar>
	);
}

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
