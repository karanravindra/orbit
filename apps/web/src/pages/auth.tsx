import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import { ArrowLeft, ArrowUpRight, Orbit, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import {
	ActionButton,
	AsyncForm,
	ErrorMessage,
	Loading,
	password,
	TextField,
	value,
} from "@/components/shared";
import { ThemeToggle } from "@/components/theme";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";
import { auth, result } from "@/lib/auth";
import { queryClient } from "@/lib/query";

type Mode =
	| "sign-in"
	| "sign-up"
	| "verify-email"
	| "forgot-password"
	| "reset-password";
const copy: Record<
	Mode,
	{ title: string; description: string; submit: string }
> = {
	"sign-in": {
		title: "Welcome back",
		description: "Sign in to your Orbit workspace.",
		submit: "Sign in",
	},
	"sign-up": {
		title: "Create your account",
		description: "Your personal workspace starts here.",
		submit: "Create account",
	},
	"verify-email": {
		title: "Check your inbox",
		description:
			"Enter the verification code from your email. Codes expire in five minutes.",
		submit: "Verify email",
	},
	"forgot-password": {
		title: "Reset your password",
		description: "We’ll send a reset code if an account exists for this email.",
		submit: "Send reset code",
	},
	"reset-password": {
		title: "Choose a new password",
		description:
			"Use the code from your email to set your password. Codes expire in five minutes.",
		submit: "Reset password",
	},
};

export function safeNext(next: string | null) {
	return next?.startsWith("/") && !next.startsWith("//") && !next.includes("\\")
		? next
		: "/";
}

export function AuthPage({ mode }: { mode: Mode }) {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const next = safeNext(params.get("next"));
	const [email, setEmail] = useState(params.get("email") || "");
	const [token, setToken] = useState("");
	const [captchaError, setCaptchaError] = useState("");
	const turnstile = useRef<TurnstileInstance>(null);
	const session = auth.useSession();
	const captchaRequired =
		mode === "sign-in" || mode === "sign-up" || mode === "forgot-password";
	const siteKey =
		import.meta.env.VITE_TURNSTILE_SITE_KEY ||
		(import.meta.env.DEV ? "1x00000000000000000000AA" : "");
	const suffix = `?next=${encodeURIComponent(next)}`;
	const link = (path: string) =>
		`/${path}${suffix}&email=${encodeURIComponent(email)}`;
	function resetCaptcha() {
		setToken("");
		turnstile.current?.reset();
	}
	function captchaOptions() {
		if (!token) throw new Error("Complete the security check first.");
		return { headers: { "x-captcha-response": token } };
	}
	async function finish() {
		queryClient.clear();
		await session.refetch();
		navigate(next, { replace: true });
	}
	if (session.isPending)
		return (
			<div className="mx-auto max-w-md p-8">
				<Loading />
			</div>
		);
	if (session.data && (mode === "sign-in" || mode === "sign-up"))
		return <Navigate to={next} replace />;
	return (
		<div className="grid min-h-svh lg:grid-cols-2">
			<aside className="relative hidden flex-col justify-between overflow-hidden bg-sidebar p-12 lg:flex">
				<Link to="/" className="flex items-center gap-2 text-xl font-semibold">
					<Orbit className="size-7" />
					Orbit
				</Link>
				<div
					aria-hidden="true"
					className="pointer-events-none absolute inset-0 flex items-center justify-center"
				>
					<div className="size-[28rem] rounded-full border border-border">
						<div className="m-12 size-88 rounded-full border border-border">
							<div className="m-12 flex size-64 items-center justify-center rounded-full border border-border">
								<Orbit
									className="size-20 text-muted-foreground"
									strokeWidth={0.75}
								/>
							</div>
						</div>
					</div>
				</div>
				<div className="relative flex max-w-md flex-col gap-4">
					<p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">
						A place for your people
					</p>
					<h2 className="text-4xl font-medium tracking-tight">
						Your workspace.
						<br />
						Your team.
						<br />
						All in Orbit.
					</h2>
					<p className="text-sm leading-relaxed text-muted-foreground">
						Manage your account, bring people together, and give everyone the
						right access.
					</p>
				</div>
				<p className="relative flex items-center gap-2 text-xs text-muted-foreground">
					<ShieldCheck className="size-4" />
					Email-verified accounts. Workspace-level permissions.
				</p>
			</aside>
			<div className="flex flex-col">
				<header className="flex items-center justify-between p-6">
					<Link
						to="/"
						className="flex items-center gap-2 font-semibold lg:invisible"
					>
						<Orbit className="size-5" />
						Orbit
					</Link>
					<ThemeToggle />
				</header>
				<main className="flex flex-1 items-center justify-center px-5 py-12">
					<Card className="w-full max-w-sm">
						<CardHeader>
							<CardTitle>{copy[mode].title}</CardTitle>
							<CardDescription>{copy[mode].description}</CardDescription>
						</CardHeader>
						<CardContent>
							<AsyncForm
								key={mode}
								submit={copy[mode].submit}
								success=""
								submitDisabled={captchaRequired && !token}
								onSubmit={async (data) => {
									try {
										if (mode === "sign-up") {
											await result(
												auth.signUp.email({
													name: value(data, "name"),
													email,
													password: password(data),
													fetchOptions: captchaOptions(),
												}),
											);
											navigate(link("verify-email"));
										} else if (mode === "sign-in") {
											const response = await auth.signIn.email({
												email,
												password: password(data),
												fetchOptions: captchaOptions(),
											});
											if (response.error?.code === "EMAIL_NOT_VERIFIED") {
												navigate(link("verify-email"));
												return;
											}
											await result(Promise.resolve(response));
											await finish();
										} else if (mode === "verify-email") {
											await result(
												auth.emailOtp.verifyEmail({
													email,
													otp: value(data, "otp"),
												}),
											);
											await finish();
										} else if (mode === "forgot-password") {
											await result(
												auth.emailOtp.requestPasswordReset({
													email,
													fetchOptions: captchaOptions(),
												}),
											);
											navigate(link("reset-password"));
										} else {
											await result(
												auth.emailOtp.resetPassword({
													email,
													otp: value(data, "otp"),
													password: password(data),
												}),
											);
											await session.refetch();
											navigate(`/sign-in${suffix}&reset=1`, { replace: true });
										}
									} finally {
										if (captchaRequired) resetCaptcha();
									}
								}}
							>
								{mode === "sign-up" && (
									<TextField
										label="Full name"
										name="name"
										autoComplete="name"
										placeholder="Alex Morgan"
										required
										maxLength={100}
									/>
								)}
								<TextField
									label="Email address"
									name="email"
									type="email"
									autoComplete="email"
									placeholder="you@example.com"
									value={email}
									onChange={(e) => setEmail(e.target.value)}
									required
								/>
								{(mode === "sign-in" ||
									mode === "sign-up" ||
									mode === "reset-password") && (
									<TextField
										label={
											mode === "reset-password" ? "New password" : "Password"
										}
										name="password"
										type="password"
										autoComplete={
											mode === "sign-in" ? "current-password" : "new-password"
										}
										minLength={mode === "sign-in" ? undefined : 8}
										maxLength={128}
										required
										description={
											mode !== "sign-in"
												? "At least 8 characters. Known breached passwords are rejected."
												: undefined
										}
									/>
								)}
								{(mode === "verify-email" || mode === "reset-password") && (
									<TextField
										label="Email code"
										name="otp"
										inputMode="numeric"
										autoComplete="one-time-code"
										pattern="[0-9]{6}"
										minLength={6}
										maxLength={6}
										placeholder="000000"
										required
									/>
								)}
								{params.has("reset") && (
									<FieldDescription>
										Password reset. Sign in with your new password.
									</FieldDescription>
								)}
							</AsyncForm>
							{(captchaRequired || mode === "verify-email") && (
								<div className="mt-5 flex flex-col gap-3">
									{siteKey ? (
										<Turnstile
											ref={turnstile}
											siteKey={siteKey}
											options={{ theme: "auto", size: "flexible" }}
											onSuccess={(t) => {
												setToken(t);
												setCaptchaError("");
											}}
											onExpire={() => setToken("")}
											onError={() => {
												setToken("");
												setCaptchaError(
													"Security check failed. Retry the check or reload the page.",
												);
											}}
										/>
									) : (
										<ErrorMessage error="VITE_TURNSTILE_SITE_KEY must be configured to continue." />
									)}
									<ErrorMessage error={captchaError} />
									{mode === "verify-email" && (
										<ActionButton
											variant="outline"
											disabled={!token}
											action={async () => {
												try {
													await result(
														auth.emailOtp.sendVerificationOtp({
															email,
															type: "email-verification",
															fetchOptions: captchaOptions(),
														}),
													);
												} finally {
													resetCaptcha();
												}
											}}
										>
											Send a new verification code
										</ActionButton>
									)}
								</div>
							)}
						</CardContent>
						<CardFooter className="flex flex-col gap-3">
							{mode === "sign-in" && (
								<>
									<Link
										className="text-sm text-muted-foreground hover:text-foreground"
										to={link("forgot-password")}
									>
										Forgot your password?
									</Link>
									<p className="text-sm text-muted-foreground">
										New to Orbit?{" "}
										<Link
											className="font-medium text-foreground underline underline-offset-4"
											to={link("sign-up")}
										>
											Create an account{" "}
											<ArrowUpRight className="inline size-3" />
										</Link>
									</p>
								</>
							)}
							{mode === "sign-up" && (
								<p className="text-sm text-muted-foreground">
									Already have an account?{" "}
									<Link
										className="font-medium text-foreground underline underline-offset-4"
										to={link("sign-in")}
									>
										Sign in
									</Link>
								</p>
							)}
							{mode === "reset-password" && (
								<Button
									variant="link"
									render={<Link to={link("forgot-password")} />}
								>
									Request a new reset code
								</Button>
							)}
							{mode !== "sign-in" && mode !== "sign-up" && (
								<Button variant="ghost" render={<Link to={link("sign-in")} />}>
									<ArrowLeft data-icon="inline-start" />
									Back to sign in
								</Button>
							)}
						</CardFooter>
					</Card>
				</main>
				<footer className="p-6 text-center text-xs text-muted-foreground">
					Orbit · Account & workspace management
				</footer>
			</div>
		</div>
	);
}
