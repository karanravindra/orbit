import { QueryClientProvider } from "@tanstack/react-query";
import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./app";
import { TooltipProvider } from "./components/ui/tooltip";
import { queryClient } from "./lib/query";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing app root");
ReactDOM.createRoot(root).render(
	<React.StrictMode>
		<QueryClientProvider client={queryClient}>
			<TooltipProvider>
				<App />
			</TooltipProvider>
		</QueryClientProvider>
	</React.StrictMode>,
);
