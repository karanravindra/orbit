import { AlertCircle, CheckCircle2, Inbox, LoaderCircle } from "lucide-react";
import {
	type ComponentProps,
	type FormEvent,
	type ReactNode,
	useId,
	useState,
} from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@/components/ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import {
	Empty,
	EmptyDescription,
	EmptyHeader,
	EmptyMedia,
	EmptyTitle,
} from "@/components/ui/empty";
import {
	Field,
	FieldDescription,
	FieldGroup,
	FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

export function ErrorMessage({ error }: { error: unknown }) {
	if (!error) return null;
	return (
		<Alert variant="destructive" role="alert">
			<AlertCircle />
			<AlertTitle>Unable to complete request</AlertTitle>
			<AlertDescription>
				{error instanceof Error ? error.message : String(error)}
			</AlertDescription>
		</Alert>
	);
}

export function Loading() {
	return (
		<div className="flex flex-col gap-4" role="status" aria-label="Loading">
			<Skeleton className="h-8 w-48" />
			<Skeleton className="h-40 w-full" />
			<span className="sr-only">Loading…</span>
		</div>
	);
}

export function PageHeading({
	title,
	description,
	action,
}: {
	title: string;
	description: string;
	action?: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-start justify-between gap-4">
			<div className="flex flex-col gap-2">
				<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
				<p className="text-sm text-muted-foreground">{description}</p>
			</div>
			{action}
		</div>
	);
}

export function Section({
	title,
	description,
	children,
	action,
}: {
	title: string;
	description?: string;
	children: ReactNode;
	action?: ReactNode;
}) {
	return (
		<Card>
			<CardHeader>
				<div className="flex flex-wrap items-start justify-between gap-3">
					<div className="flex flex-col gap-1">
						<CardTitle>{title}</CardTitle>
						{description && <CardDescription>{description}</CardDescription>}
					</div>
					{action}
				</div>
			</CardHeader>
			<CardContent>{children}</CardContent>
		</Card>
	);
}

export function NoData({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<Empty>
			<EmptyHeader>
				<EmptyMedia variant="icon">
					<Inbox />
				</EmptyMedia>
				<EmptyTitle>{title}</EmptyTitle>
				<EmptyDescription>{description}</EmptyDescription>
			</EmptyHeader>
		</Empty>
	);
}

export function TextField({
	label,
	description,
	...props
}: ComponentProps<typeof Input> & { label: string; description?: string }) {
	const id = useId();
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Input id={id} {...props} />
			{description && <FieldDescription>{description}</FieldDescription>}
		</Field>
	);
}

export function Choice({
	label,
	value,
	options,
	onChange,
	disabled,
	name,
}: {
	label: string;
	value: string;
	options: { value: string; label: string }[];
	onChange: (value: string) => void;
	disabled?: boolean;
	name?: string;
}) {
	const id = useId();
	return (
		<Field>
			<FieldLabel htmlFor={id}>{label}</FieldLabel>
			<Select
				name={name}
				value={value || null}
				items={options}
				onValueChange={(v) => v !== null && onChange(v)}
				disabled={disabled}
			>
				<SelectTrigger id={id} className="w-full">
					<SelectValue placeholder="Select an option" />
				</SelectTrigger>
				<SelectContent>
					<SelectGroup>
						{options.map((option) => (
							<SelectItem key={option.value} value={option.value}>
								{option.label}
							</SelectItem>
						))}
					</SelectGroup>
				</SelectContent>
			</Select>
		</Field>
	);
}

export function AsyncForm({
	onSubmit,
	children,
	submit = "Save changes",
	success = "Changes saved.",
	disabled = false,
	submitDisabled = false,
}: {
	onSubmit: (data: FormData) => Promise<unknown>;
	children: ReactNode;
	submit?: string;
	success?: string;
	disabled?: boolean;
	submitDisabled?: boolean;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>(null);
	const [saved, setSaved] = useState(false);
	async function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (pending || disabled || submitDisabled) return;
		const data = new FormData(event.currentTarget);
		setPending(true);
		setError(null);
		setSaved(false);
		try {
			await onSubmit(data);
			setSaved(true);
		} catch (error) {
			setError(error);
		} finally {
			setPending(false);
		}
	}
	return (
		<form onSubmit={handleSubmit}>
			<fieldset disabled={pending || disabled} className="min-w-0">
				<FieldGroup>
					{children}
					<ErrorMessage error={error} />
					{saved && success && (
						<Alert role="status">
							<CheckCircle2 />
							<AlertDescription>{success}</AlertDescription>
						</Alert>
					)}
					<Field>
						<Button
							type="submit"
							disabled={pending || disabled || submitDisabled}
						>
							{pending && (
								<LoaderCircle
									data-icon="inline-start"
									className="animate-spin"
								/>
							)}
							{submit}
						</Button>
					</Field>
				</FieldGroup>
			</fieldset>
		</form>
	);
}

export function ActionButton({
	action,
	children,
	...props
}: Omit<ComponentProps<typeof Button>, "onClick"> & {
	action: () => Promise<unknown>;
}) {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<unknown>(null);
	return (
		<div className="flex flex-col gap-2">
			<Button
				{...props}
				disabled={props.disabled || pending}
				onClick={async () => {
					setPending(true);
					setError(null);
					try {
						await action();
					} catch (error) {
						setError(error);
					} finally {
						setPending(false);
					}
				}}
			>
				{pending && (
					<LoaderCircle data-icon="inline-start" className="animate-spin" />
				)}
				{children}
			</Button>
			<ErrorMessage error={error} />
		</div>
	);
}

export function ConfirmAction({
	title,
	description,
	action,
	label,
	variant = "destructive",
	disabled,
}: {
	title: string;
	description: string;
	action: () => Promise<unknown>;
	label: string;
	variant?: "destructive" | "outline";
	disabled?: boolean;
}) {
	const [open, setOpen] = useState(false);
	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger
				render={<Button variant={variant} size="sm" disabled={disabled} />}
			>
				{label}
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<ActionButton
						variant={variant}
						action={async () => {
							await action();
							setOpen(false);
						}}
					>
						{label}
					</ActionButton>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function value(data: FormData, name: string) {
	return String(data.get(name) ?? "").trim();
}
export function password(data: FormData, name = "password") {
	return String(data.get(name) ?? "");
}
