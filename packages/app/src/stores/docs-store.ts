import { createContext, use } from "react";

// Document Navigation Context for communication between sidebar and main content
export interface DocumentNavigationContextType {
	selectedDocId: string | null;
	navigateToDocument: (docId: string | null) => void;
}

export const DocumentNavigationContext = createContext<DocumentNavigationContextType | null>(null);

export const useDocumentNavigation = () => {
	const context = use(DocumentNavigationContext);
	if (!context) {
		throw new Error("useDocumentNavigation must be used within DocumentNavigationProvider");
	}
	return context;
};

// Document data structure
export interface DocData {
	id: string;
	title: string;
	url: string;
	type: "document" | "placeholder";
	content: string;
}

// Helper function to create room ID from document ID
export const createRoomId = (orgId: string, projectId: string, docId: string | null): string => {
	return docId ? `${orgId}:${projectId}:${docId}` : `${orgId}:${projectId}:docs-default`;
};

// Helper function to validate if a document type should trigger navigation
export const shouldNavigateToDocument = (itemType: string): boolean => {
	return itemType === "document"; // All items are documents now, except placeholders
};

// Helper function to get document content by ID
export const getDocumentContent = (docId: string | null): string => {
	if (!docId) return `<h1>Welcome</h1><p>Select a document from the sidebar to start editing.</p>`;

	// Document content mapping - matches the content from sidebar tree data
	const documentContent: Record<string, string> = {
		root: `<h1>Documentation</h1><p>Welcome to our docs.</p>`,
		"getting-started": `<h1>Getting Started</h1><p>Quick setup guide.</p>`,
		introduction: `<h1>Introduction</h1><p>Platform overview and key concepts.</p>`,
		installation: `<h1>Installation</h1><p>Setup instructions and requirements.</p>`,
		"quick-start": `<h1>Quick Start</h1><p>Get up and running in minutes.</p>`,
		"user-guide": `<h1>User Guide</h1><p>Complete feature walkthrough.</p>`,
		dashboard: `<h1>Dashboard</h1><p>Overview of your workspace.</p>`,
		projects: `<h1>Projects</h1><p>Managing and organizing projects.</p>`,
		collaboration: `<h1>Collaboration</h1><p>Working together effectively.</p>`,
		sharing: `<h1>Sharing</h1><p>Share documents and set permissions.</p>`,
		comments: `<h1>Comments</h1><p>Review and feedback system.</p>`,
		"real-time": `<h1>Real-time Editing</h1><p>Live collaboration features.</p>`,
		api: `<h1>API Reference</h1><p>Developer documentation.</p>`,
		authentication: `<h1>Authentication</h1><p>API security and access.</p>`,
		endpoints: `<h1>Endpoints</h1><p>REST API reference.</p>`,
		webhooks: `<h1>Webhooks</h1><p>Event notifications setup.</p>`,
		examples: `<h1>Examples</h1><p>Code samples and tutorials.</p>`,
		javascript: `<h1>JavaScript</h1><p>JS SDK examples.</p>`,
		python: `<h1>Python</h1><p>Python SDK examples.</p>`,
		curl: `<h1>cURL</h1><p>Command line examples.</p>`,
		tutorials: `<h1>Tutorials</h1><p>Step-by-step guides.</p>`,
		"basic-setup": `<h1>Basic Setup</h1><p>First-time configuration.</p>`,
		"advanced-features": `<h1>Advanced Features</h1><p>Power user capabilities.</p>`,
		integrations: `<h1>Integrations</h1><p>Third-party connections.</p>`,
		troubleshooting: `<h1>Troubleshooting</h1><p>Common problems and solutions.</p>`,
		"common-issues": `<h1>Common Issues</h1><p>Frequently encountered problems.</p>`,
		performance: `<h1>Performance</h1><p>Optimization tips and tricks.</p>`,
		support: `<h1>Support</h1><p>Getting help and assistance.</p>`,
	};

	return documentContent[docId] || `<h1>${docId}</h1><p>Start writing your content here...</p>`;
};
