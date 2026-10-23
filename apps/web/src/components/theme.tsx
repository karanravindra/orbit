import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";

export function ThemeToggle() {
	const [dark, setDark] = useState(() => {
		try {
			const stored = localStorage.getItem("orbit-theme");
			return stored
				? stored === "dark"
				: matchMedia("(prefers-color-scheme: dark)").matches;
		} catch {
			return false;
		}
	});
	useEffect(() => {
		document.documentElement.classList.toggle("dark", dark);
		try {
			localStorage.setItem("orbit-theme", dark ? "dark" : "light");
		} catch {
			/* Theme still works without storage. */
		}
	}, [dark]);
	return (
		<Button
			variant="ghost"
			size="icon"
			aria-label={dark ? "Use light theme" : "Use dark theme"}
			onClick={() => setDark(!dark)}
		>
			{dark ? <Sun /> : <Moon />}
		</Button>
	);
}
