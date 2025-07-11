import { useState } from "react";
import reactLogo from "../assets/react.svg";
import viteLogo from "/vite.svg";

export const Route = createFileRoute({
	component: Index,
});

function Index() {
	const [count, setCount] = useState(0);

	return (
		<div className="container mx-auto px-4 py-8">
			<iframe src="https://app.dev.sybill.ai/calls?tab=ym"></iframe>

			<div className="flex justify-center items-center space-x-8 mb-8">
				<a href="https://vite.dev" target="_blank" rel="noopener noreferrer">
					<img src={viteLogo} className="logo" alt="Vite logo" />
				</a>
				<a href="https://react.dev" target="_blank" rel="noopener noreferrer">
					<img src={reactLogo} className="logo react" alt="React logo" />
				</a>
			</div>

			<h1 className="text-4xl font-bold mb-8">Vite + React</h1>

			<div className="card max-w-md mx-auto bg-white dark:bg-gray-800 rounded-lg shadow-lg p-6 mb-8">
				<button
					onClick={() => setCount((count) => count + 1)}
					className="bg-blue-500 hover:bg-blue-600 text-white font-bold py-2 px-4 rounded transition-colors"
				>
					count is {count}
				</button>
				<p className="mt-4 text-gray-600 dark:text-gray-300">
					Edit{" "}
					<code className="bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
						src/routes/index.tsx
					</code>{" "}
					and save to test HMR
				</p>
			</div>

			<p className="read-the-docs text-gray-500 mb-8">
				Click on the Vite and React logos to learn more
			</p>

			<h2 className="text-3xl font-bold underline text-blue-600">
				Hello world!
			</h2>
		</div>
	);
}
