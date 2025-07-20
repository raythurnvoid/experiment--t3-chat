import { useState } from "react";
import reactLogo from "../assets/react.svg";
import viteLogo from "/vite.svg";
import { cn } from "@/lib/utils";

export const Route = createFileRoute({
	component: Index,
});

function Index() {
	const [count, setCount] = useState(0);

	return (
		<div className={cn("Home-content", "flex-1 overflow-auto p-8")}>
			<div className="container mx-auto">
				<iframe src="https://app.dev.sybill.ai/calls?tab=ym"></iframe>

				<div className="mb-8 flex items-center justify-center space-x-8">
					<a href="https://vite.dev" target="_blank" rel="noopener noreferrer">
						<img src={viteLogo} className="logo" alt="Vite logo" />
					</a>
					<a href="https://react.dev" target="_blank" rel="noopener noreferrer">
						<img src={reactLogo} className="logo react" alt="React logo" />
					</a>
				</div>

				<h1 className="mb-8 text-4xl font-bold">Vite + React</h1>

				<div className="card mx-auto mb-8 max-w-md rounded-lg bg-white p-6 shadow-lg dark:bg-gray-800">
					<button
						onClick={() => setCount((count) => count + 1)}
						className="rounded bg-blue-500 px-4 py-2 font-bold text-white transition-colors hover:bg-blue-600"
					>
						count is {count}
					</button>
					<p className="mt-4 text-gray-600 dark:text-gray-300">
						Edit <code className="rounded bg-gray-100 px-2 py-1 dark:bg-gray-700">src/routes/index.tsx</code> and save
						to test HMR
					</p>
				</div>

				<p className="read-the-docs mb-8 text-gray-500">Click on the Vite and React logos to learn more</p>

				<h2 className="text-3xl font-bold text-blue-600 underline">Hello world!</h2>
			</div>
		</div>
	);
}
