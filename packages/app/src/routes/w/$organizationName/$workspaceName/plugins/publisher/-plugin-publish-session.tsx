import "./-plugin-publish-confirmation-modal.css";

import { createContext, memo, use, useId, useRef, useState, type ReactNode, type RefObject } from "react";
import { toast } from "sonner";

import { MyButton } from "@/components/my-button.tsx";
import {
	MyInput,
	MyInputArea,
	MyInputBackground,
	MyInputBox,
	MyInputControl,
	MyInputLabel,
} from "@/components/my-input.tsx";
import {
	MyModal,
	MyModalCloseTrigger,
	MyModalDescription,
	MyModalFooter,
	MyModalHeader,
	MyModalHeading,
	MyModalPopover,
	MyModalScrollableArea,
} from "@/components/my-modal.tsx";
import { useFn } from "@/hooks/utils-hooks.ts";
import { app_convex, app_convex_api, type app_convex_Id } from "@/lib/app-convex-client.ts";

type PluginPublishSessionProvider_ClassNames =
	| "PluginPublishConfirmationModal"
	| "PluginPublishConfirmationModal-head"
	| "PluginPublishConfirmationModal-error";

type PluginPublishSessionPhase = "check_failed" | "checking" | "review" | "publishing";

type PluginManagementActionKind = "claim_repository" | "install" | "remove_repository" | "uninstall";

type PluginManagementAction = {
	version: number;
	kind: PluginManagementActionKind;
};

type PluginPublishSessionRequest = {
	repositoryId: app_convex_Id<"plugins_publisher_repositories">;
	repositoryLabel: string;
	triggerRef: RefObject<HTMLButtonElement | null>;
	onBusyChange?: (busy: boolean) => void;
	onSessionChange?: (active: boolean) => void;
	onPublished?: () => void;
};

type PluginPublishSession = PluginPublishSessionRequest & {
	version: number;
	workspaceKey: string | null;
	routeKey: string | null;
	phase: PluginPublishSessionPhase;
	sourceCommitSha: string;
	reviewedCommitSha: string;
	publishError?: string;
};

type PluginPublishSessionContextValue = {
	session: PluginPublishSession | null;
	managementAction: PluginManagementAction | null;
	start: (request: PluginPublishSessionRequest) => void;
	beginManagementAction: (kind: PluginManagementActionKind) => number | null;
	finishManagementAction: (version: number, options?: { repairFocusIfLost: boolean }) => void;
	setRouteFocusTarget: (target: HTMLElement | null, routeKey: string) => void;
	setWorkspaceFocusTarget: (target: HTMLElement | null, workspaceKey: string) => void;
};

const PluginPublishSessionContext = createContext<PluginPublishSessionContextValue | null>(null);

type PluginPublishSessionProvider_Props = {
	children: ReactNode;
};

const PluginPublishSessionProvider = Object.assign(
	memo(function PluginPublishSessionProvider(props: PluginPublishSessionProvider_Props) {
		const { children } = props;
		const cancelRef = useRef<HTMLButtonElement>(null);
		const dialogRef = useRef<HTMLDivElement>(null);
		const sessionVersionRef = useRef(0);
		const sessionRef = useRef<PluginPublishSession | null>(null);
		const managementActionVersionRef = useRef(0);
		const managementActionRef = useRef<PluginManagementAction | null>(null);
		const routeFocusTargetRef = useRef<{ target: HTMLElement; routeKey: string } | null>(null);
		const workspaceFocusTargetRef = useRef<{ target: HTMLElement; workspaceKey: string } | null>(null);
		const activePreflightRef = useRef<number | null>(null);
		const activePublishRef = useRef<number | null>(null);
		const errorId = useId();
		const [session, setSession] = useState<PluginPublishSession | null>(null);
		const [managementAction, setManagementAction] = useState<PluginManagementAction | null>(null);
		const [finalFocus, setFinalFocus] = useState<RefObject<HTMLButtonElement | null>>();
		const setRouteFocusTarget = useFn((target: HTMLElement | null, routeKey: string) => {
			if (target) {
				routeFocusTargetRef.current = { target, routeKey };
			} else if (routeFocusTargetRef.current?.routeKey === routeKey) {
				routeFocusTargetRef.current = null;
			}
		});
		const setWorkspaceFocusTarget = useFn((target: HTMLElement | null, workspaceKey: string) => {
			if (target) {
				workspaceFocusTargetRef.current = { target, workspaceKey };
			} else if (workspaceFocusTargetRef.current?.workspaceKey === workspaceKey) {
				workspaceFocusTargetRef.current = null;
			}
		});
		const beginManagementAction = useFn((kind: PluginManagementActionKind) => {
			if (sessionRef.current || managementActionRef.current) {
				return null;
			}

			managementActionVersionRef.current += 1;
			const next = { version: managementActionVersionRef.current, kind };
			managementActionRef.current = next;
			setManagementAction(next);
			return next.version;
		});
		const finishManagementAction = useFn((version: number, options?: { repairFocusIfLost: boolean }) => {
			if (managementActionRef.current?.version !== version) {
				return;
			}

			const sessionVersion = sessionVersionRef.current;
			managementActionRef.current = null;
			setManagementAction(null);
			if (!options?.repairFocusIfLost) {
				return;
			}

			requestAnimationFrame(() => {
				// Wait for the successful mutation's query update to remove the focused control and
				// for the current route to register its replacement focus target.
				requestAnimationFrame(() => {
					if (
						managementActionVersionRef.current !== version ||
						sessionVersionRef.current !== sessionVersion ||
						managementActionRef.current ||
						sessionRef.current ||
						document.activeElement !== document.body
					) {
						return;
					}

					const currentRoute = routeFocusTargetRef.current;
					const currentWorkspace = workspaceFocusTargetRef.current;
					const target = currentRoute?.target.isConnected
						? currentRoute.target
						: currentWorkspace?.target.isConnected
							? currentWorkspace.target
							: null;
					target?.focus();
				});
			});
		});

		const updateSession = useFn(
			(
				version: number,
				update: Partial<Pick<PluginPublishSession, "phase" | "sourceCommitSha" | "reviewedCommitSha" | "publishError">>,
			) => {
				const current = sessionRef.current;
				if (!current || current.version !== version) {
					return;
				}

				const next = { ...current, ...update };
				sessionRef.current = next;
				setSession(next);
			},
		);

		const close = useFn(() => {
			const current = sessionRef.current;
			if (!current || current.phase === "publishing") {
				return;
			}

			const focusedBeforeClose = document.activeElement instanceof HTMLElement ? document.activeElement : null;
			if (activePreflightRef.current === current.version) {
				activePreflightRef.current = null;
				current.onBusyChange?.(false);
			}
			sessionRef.current = null;
			setSession(null);
			current.onSessionChange?.(false);
			requestAnimationFrame(() => {
				// Wait until the modal has finished its own focus restore. A programmatic success
				// closes on a different timing path than Cancel.
				requestAnimationFrame(() => {
					if (sessionVersionRef.current !== current.version || sessionRef.current) {
						return;
					}

					const activeElement = document.activeElement;
					const currentRoute = routeFocusTargetRef.current;
					const currentWorkspace = workspaceFocusTargetRef.current;
					const routeChanged = current.routeKey !== (currentRoute?.routeKey ?? null);
					const workspaceChanged = current.workspaceKey !== (currentWorkspace?.workspaceKey ?? null);
					const locationChanged = routeChanged || workspaceChanged;
					const focusFell = activeElement === document.body || Boolean(activeElement?.closest('[role="dialog"]'));
					const focusedReusedTrigger = locationChanged && activeElement === current.triggerRef.current;

					// Keep an explicit destination focus. Ariakit may otherwise move it to a trigger
					// whose DOM node was reused after route parameters changed.
					if (!focusFell && !focusedReusedTrigger) {
						return;
					}
					if (
						focusedBeforeClose?.isConnected &&
						focusedBeforeClose !== document.body &&
						!focusedBeforeClose.closest('[role="dialog"]')
					) {
						focusedBeforeClose.focus();
						return;
					}
					if (!current.triggerRef.current?.isConnected || locationChanged) {
						const replacementTarget = workspaceChanged && !routeChanged
							? currentWorkspace?.target
							: currentRoute?.target.isConnected
								? currentRoute.target
								: currentWorkspace?.target;
						replacementTarget?.focus();
					}
				});
			});
		});
		const readCandidateHead = useFn((version: number, options?: { conflictMessage: string; busyAlready: boolean }) => {
			const current = sessionRef.current;
			if (!current || current.version !== version) {
				return;
			}

			activePreflightRef.current = version;
			if (!options?.busyAlready) {
				current.onBusyChange?.(true);
			}
			app_convex
				.action(app_convex_api.plugins.get_publish_candidate_head, { repositoryId: current.repositoryId })
				.then((result) => {
					if (activePreflightRef.current !== version) {
						return;
					}

					if (result._nay) {
						if (options) {
							// Keep the conflict visible, but never keep the old SHA labelled as current.
							updateSession(version, {
								phase: "check_failed",
								sourceCommitSha: "",
								reviewedCommitSha: "",
								publishError: `${options.conflictMessage}. Failed to read the new repository commit: ${result._nay.message}. Cancel and try again.`,
							});
							return;
						}

						toast.error(result._nay.message);
						close();
						return;
					}

					updateSession(version, {
						phase: "review",
						sourceCommitSha: result._yay.sourceCommitSha,
						reviewedCommitSha: "",
						publishError: options?.conflictMessage,
					});
				})
				.catch((error) => {
					if (activePreflightRef.current !== version) {
						return;
					}

					console.error("[PluginPublishSessionProvider.readCandidateHead] Failed to read repository HEAD:", {
						error,
						repositoryId: current.repositoryId,
					});
					if (options) {
						updateSession(version, {
							phase: "check_failed",
							sourceCommitSha: "",
							reviewedCommitSha: "",
							publishError: `${options.conflictMessage}. Failed to read the new repository commit. Cancel and try again.`,
						});
						return;
					}

					toast.error("Failed to read the repository commit");
					close();
				})
				.finally(() => {
					if (activePreflightRef.current !== version) {
						return;
					}

					activePreflightRef.current = null;
					current.onBusyChange?.(false);
				});
		});

		const start = useFn((request: PluginPublishSessionRequest) => {
			if (sessionRef.current || managementActionRef.current) {
				return;
			}

			sessionVersionRef.current += 1;
			const startedSession: PluginPublishSession = {
				...request,
				version: sessionVersionRef.current,
				workspaceKey: workspaceFocusTargetRef.current?.workspaceKey ?? null,
				routeKey: routeFocusTargetRef.current?.routeKey ?? null,
				phase: "checking",
				sourceCommitSha: "",
				reviewedCommitSha: "",
			};
			sessionRef.current = startedSession;
			setFinalFocus(request.triggerRef);
			setSession(startedSession);
			request.onSessionChange?.(true);
			readCandidateHead(startedSession.version);
		});

		const handlePublish = useFn(() => {
			const current = sessionRef.current;
			if (!current || current.phase === "publishing" || current.reviewedCommitSha !== current.sourceCommitSha) {
				return;
			}

			activePublishRef.current = current.version;
			dialogRef.current?.focus();
			updateSession(current.version, { phase: "publishing", publishError: undefined });
			current.onBusyChange?.(true);
			app_convex
				.action(app_convex_api.plugins.publish_version, {
					repositoryId: current.repositoryId,
					expectedSourceCommitSha: current.reviewedCommitSha,
				})
				.then((result) => {
					if (activePublishRef.current !== current.version) {
						return;
					}

					if (result._nay) {
						if (result._nay.name === "conflict") {
							// Keep one busy interval while replacing the stale reviewed SHA with a fresh HEAD.
							activePublishRef.current = null;
							updateSession(current.version, {
								phase: "checking",
								sourceCommitSha: "",
								reviewedCommitSha: "",
								publishError: result._nay.message,
							});
							readCandidateHead(current.version, {
								conflictMessage: result._nay.message,
								busyAlready: true,
							});
							return;
						}

						updateSession(current.version, { phase: "review", publishError: result._nay.message });
						return;
					}

					activePublishRef.current = null;
					current.onBusyChange?.(false);
					toast.success(`Published commit ${result._yay.sourceCommitSha.slice(0, 8)}`);
					updateSession(current.version, { phase: "review" });
					close();
					current.onPublished?.();
				})
				.catch((error) => {
					if (activePublishRef.current !== current.version) {
						return;
					}

					console.error("[PluginPublishSessionProvider.handlePublish] Failed to publish plugin:", {
						error,
						repositoryId: current.repositoryId,
					});
					updateSession(current.version, { phase: "review", publishError: "Failed to publish plugin" });
				})
				.finally(() => {
					if (activePublishRef.current !== current.version) {
						return;
					}

					activePublishRef.current = null;
					current.onBusyChange?.(false);
				});
		});

		const validationMessage =
			session?.reviewedCommitSha.length === 0 || session?.reviewedCommitSha === session?.sourceCommitSha
				? undefined
				: "Paste the reviewed commit SHA shown above";
		const visibleError = validationMessage ?? session?.publishError;
		const checking = session?.phase === "checking";
		const checkFailed = session?.phase === "check_failed";
		const publishing = session?.phase === "publishing";

		return (
			<PluginPublishSessionContext.Provider
				value={{
					session,
					managementAction,
					start,
					beginManagementAction,
					finishManagementAction,
					setRouteFocusTarget,
					setWorkspaceFocusTarget,
				}}
			>
				{children}
				<MyModal open={Boolean(session)} setOpen={(open) => !open && close()}>
					<MyModalPopover
						ref={dialogRef}
						className={"PluginPublishConfirmationModal" satisfies PluginPublishSessionProvider_ClassNames}
						tabIndex={-1}
						initialFocus={cancelRef}
						finalFocus={finalFocus}
						hideOnEscape={!publishing}
						hideOnInteractOutside={(event) => {
							if (!publishing) {
								return true;
							}

							// A backdrop click can focus the page body even when Ariakit keeps the dialog open.
							event.preventDefault();
							dialogRef.current?.focus();
							return false;
						}}
					>
						<MyModalHeader>
							<div>
								<MyModalHeading>Publish {session?.repositoryLabel}</MyModalHeading>
								<MyModalDescription>
									{checking
										? "Reading the current default-branch commit."
										: checkFailed
											? "The current default-branch commit could not be read."
											: "Paste the commit SHA that completed review. Publishing stops if the repository moved."}
								</MyModalDescription>
							</div>
						</MyModalHeader>
						{checking || checkFailed ? (
							<MyModalScrollableArea>
								{checking ? (
									<p role="status" aria-live="polite">
										Checking repository commit...
									</p>
								) : null}
								{visibleError ? (
									<p
										id={errorId}
										className={"PluginPublishConfirmationModal-error" satisfies PluginPublishSessionProvider_ClassNames}
										role="alert"
									>
										{visibleError}
									</p>
								) : null}
							</MyModalScrollableArea>
						) : (
							<MyModalScrollableArea>
								<p>Current default-branch HEAD</p>
								<code
									className={"PluginPublishConfirmationModal-head" satisfies PluginPublishSessionProvider_ClassNames}
								>
									{session?.sourceCommitSha}
								</code>
								<MyInput displayValidationMessage={validationMessage} layout="stacked">
									<MyInputLabel>Reviewed commit SHA</MyInputLabel>
									<MyInputBackground />
									<MyInputArea>
										<MyInputControl
											value={session?.reviewedCommitSha ?? ""}
											disabled={publishing}
											validationMessage={validationMessage}
											aria-describedby={visibleError ? errorId : undefined}
											pattern="[0-9a-f]{40}"
											minLength={40}
											maxLength={40}
											required
											autoComplete="off"
											spellCheck={false}
											onChange={(event) => {
												if (!session) {
													return;
												}
												updateSession(session.version, {
													reviewedCommitSha: event.currentTarget.value,
													publishError: undefined,
												});
											}}
										/>
									</MyInputArea>
									<MyInputBox />
								</MyInput>
								{visibleError ? (
									<p
										id={errorId}
										className={"PluginPublishConfirmationModal-error" satisfies PluginPublishSessionProvider_ClassNames}
										role="alert"
									>
										{visibleError}
									</p>
								) : null}
							</MyModalScrollableArea>
						)}
						<MyModalFooter>
							<MyButton ref={cancelRef} variant="outline" disabled={publishing} onClick={close}>
								Cancel
							</MyButton>
							{checking || checkFailed ? null : (
								<MyButton
									disabled={publishing || session?.reviewedCommitSha !== session?.sourceCommitSha}
									onClick={handlePublish}
								>
									{publishing ? "Publishing..." : "Publish reviewed commit"}
								</MyButton>
							)}
						</MyModalFooter>
						<MyModalCloseTrigger disabled={publishing} />
					</MyModalPopover>
				</MyModal>
			</PluginPublishSessionContext.Provider>
		);
	}),
	{
		useContext: function useContext() {
			const value = use(PluginPublishSessionContext);
			if (!value) {
				throw new Error("PluginPublishSessionProvider.useContext must be used within PluginPublishSessionProvider");
			}
			return value;
		},
	},
);

export { PluginPublishSessionProvider };
