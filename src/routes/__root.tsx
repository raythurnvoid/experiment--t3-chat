import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

export const Route = createRootRoute({
	component: () => (
		<>
			<div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 dark:from-gray-900 dark:to-gray-800 flex flex-col h-full">
				<nav className="bg-white/80 backdrop-blur-sm shadow-sm border-b border-gray-200 dark:bg-gray-900/80 dark:border-gray-700 sticky top-0 z-50">
					<div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
						<div className="flex justify-between h-16">
							<div className="flex items-center space-x-8">
								<Link
									to="/"
									className="text-xl font-bold bg-gradient-to-r from-blue-600 to-purple-600 bg-clip-text text-transparent hover:from-blue-700 hover:to-purple-700 transition-all duration-200"
								>
									AI Chat App
								</Link>
								<div className="hidden sm:flex space-x-1">
									<Link
										to="/"
										className="relative px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all duration-200 [&.active]:text-blue-600 [&.active]:bg-blue-50 dark:[&.active]:text-blue-400 dark:[&.active]:bg-blue-900/20"
									>
										Home
									</Link>
									<Link
										to="/chat"
										className="relative px-4 py-2 rounded-lg text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 transition-all duration-200 [&.active]:text-blue-600 [&.active]:bg-blue-50 dark:[&.active]:text-blue-400 dark:[&.active]:bg-blue-900/20"
									>
										Chat
									</Link>
								</div>
							</div>
						</div>
					</div>
				</nav>
				<main className="flex flex-col flex-1">
					<Outlet />
				</main>
			</div>
			<TanStackRouterDevtools />
		</>
	),
});
