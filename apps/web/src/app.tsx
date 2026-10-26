import { BrowserRouter, Navigate, Route, Routes } from "react-router";
import { AppLayout } from "@/components/app-layout";
import { AccountPage } from "@/pages/account";
import { AdminPage } from "@/pages/admin";
import { AuthPage } from "@/pages/auth";
import { InvitationPage, InvitationsPage } from "@/pages/invitations";
import { MembersPage } from "@/pages/members";
import { RolesPage } from "@/pages/roles";
import { TeamsPage } from "@/pages/teams";
import { OverviewPage, WorkspacePage } from "@/pages/workspace";

export function App() {
	return (
		<BrowserRouter>
			<Routes>
				<Route path="/sign-in" element={<AuthPage mode="sign-in" />} />
				<Route path="/sign-up" element={<AuthPage mode="sign-up" />} />
				<Route
					path="/verify-email"
					element={<AuthPage mode="verify-email" />}
				/>
				<Route
					path="/forgot-password"
					element={<AuthPage mode="forgot-password" />}
				/>
				<Route
					path="/reset-password"
					element={<AuthPage mode="reset-password" />}
				/>
				<Route element={<AppLayout />}>
					<Route index element={<OverviewPage />} />
					<Route path="settings" element={<WorkspacePage />} />
					<Route path="settings/members" element={<MembersPage />} />
					<Route path="settings/invitations" element={<InvitationsPage />} />
					<Route path="accept-invitation" element={<InvitationPage />} />
					<Route path="settings/teams" element={<TeamsPage />} />
					<Route path="settings/roles" element={<RolesPage />} />
					<Route path="account" element={<AccountPage />} />
					<Route path="admin" element={<AdminPage />} />
				</Route>
				<Route path="*" element={<Navigate to="/" replace />} />
			</Routes>
		</BrowserRouter>
	);
}
