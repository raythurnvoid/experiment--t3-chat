/**
 * The two inline scripts of the meeting room page, as plain strings.
 *
 * The room is one static HTML document served by the Worker at `GET /room`, so its behavior ships
 * as inline script text rather than as a bundled module. The strings avoid backticks and template
 * interpolation on purpose: they are embedded into a TypeScript template literal by `page.ts`, and
 * a stray backtick or dollar-brace would silently change the served bytes.
 *
 * Contract with the Worker (`/room/api/*`, all same-origin POST JSON):
 * - `POST /room/api/session` `{ticket}` and `POST /room/api/guest-session` `{...}` answer
 *   `{csrfToken, meeting, participant}` and set an httpOnly session cookie this script never sees.
 * - Every later call carries the `X-Council-Csrf` header. The token lives in a closure variable
 *   only — never in storage, never in a URL.
 * - Error bodies are `{message}`.
 */

/**
 * Runs in `<head>` before the RealtimeKit SDK script tag. It captures the one-time host ticket
 * from the URL fragment and erases the fragment immediately, so the ticket never sits in the
 * address bar, browser history, or a screenshot while the rest of the page loads. This protects
 * the URL surface only: until the main script consumes `window.__councilEntry`, any script running
 * in this page could still read the ticket. The page loads no third-party script except the
 * pinned, integrity-checked SDK bundle, and the ticket is single-use — the exchange right after
 * load spends it.
 */
export const council_room_boot_js = `
(function () {
	"use strict";
	var entry = { ticket: null };
	var hash = window.location.hash;
	if (hash && hash.length > 1) {
		entry.ticket = new URLSearchParams(hash.slice(1)).get("ticket");
		history.replaceState(null, "", window.location.pathname + window.location.search);
	}
	window.__councilEntry = entry;
})();
`;

/**
 * The main room script, placed at the end of `<body>`. See the module comment for the API
 * contract it speaks.
 */
export const council_room_client_js = `
(function () {
	"use strict";

	// The CSRF token stays in this closure. It is never written to storage or into a URL.
	var csrfToken = null;
	var bootGeneration = 0;

	var state = {
		meeting: null,
		participant: null,
		guestMeetingId: null,
		// One join attempt keeps one id across retries; changed inputs start a new attempt.
		joinAttempt: null,
		sdk: null,
		pollTimer: null,
		// Set once the meeting is over for this participant, so late events cannot reopen the UI.
		over: false,
	};

	function byId(id) {
		return document.getElementById(id);
	}

	var VIEW_IDS = ["view-loading", "view-guest", "view-lobby", "view-call", "view-ended", "view-error"];

	// Show one view and move focus to its heading, so keyboard and screen-reader users land on
	// the new content instead of staying on a control that just disappeared.
	function showView(viewId, focusId) {
		VIEW_IDS.forEach(function (candidate) {
			byId(candidate).hidden = candidate !== viewId;
		});
		if (focusId) {
			var target = byId(focusId);
			if (target) {
				target.focus();
			}
		}
	}

	function showFatal(message) {
		byId("error-message").textContent = message;
		showView("view-error", "error-heading");
	}

	function setText(id, text) {
		byId(id).textContent = text;
	}

	function setError(id, message) {
		var element = byId(id);
		if (message === null) {
			element.hidden = true;
			element.textContent = "";
		} else {
			element.hidden = false;
			element.textContent = message;
		}
	}

	function apiPost(path, body) {
		var headers = { "Content-Type": "application/json" };
		if (csrfToken !== null) {
			headers["X-Council-Csrf"] = csrfToken;
		}
		return fetch(path, {
			method: "POST",
			headers: headers,
			credentials: "same-origin",
			body: JSON.stringify(body),
		}).then(function (response) {
			if (response.ok) {
				return response.json();
			}
			return response
				.json()
				.catch(function () {
					return {};
				})
				.then(function (data) {
					var message =
						data && typeof data.message === "string" && data.message !== ""
							? data.message
							: "Request failed (" + response.status + ")";
					var error = new Error(message);
					error.status = response.status;
					throw error;
				});
		});
	}

	function errorText(error) {
		return error && typeof error.message === "string" && error.message !== ""
			? error.message
			: "Something went wrong.";
	}

	// #region session

	function adoptSession(session) {
		csrfToken = session.csrfToken;
		state.meeting = session.meeting;
		state.participant = session.participant;
		state.over = false;
		byId("join-button").disabled = false;
		renderLobby();
		showView("view-lobby", "lobby-heading");
	}

	function resetLiveCall() {
		stopPolling();
		// A local leave must set over first, or roomLeft paints Meeting ended on top of the new lobby.
		state.over = true;
		if (state.sdk) {
			var previousSdk = state.sdk;
			state.sdk = null;
			Promise.resolve(previousSdk.leave()).catch(function () {});
		}
	}

	function renderLobby() {
		var meeting = state.meeting || {};
		var participant = state.participant || {};
		var title = typeof meeting.title === "string" && meeting.title !== "" ? meeting.title : "Council meeting";
		setText("meeting-title", title);
		byId("meeting-title").hidden = false;
		setText("lobby-meeting", title);
		var displayName = typeof participant.displayName === "string" ? participant.displayName : "";
		setText("lobby-name", displayName);
		setText("lobby-role", participant.role === "host" ? "Host" : "Guest");
		// The host ticket creates a participant with no name. Collect it here before Join, so the
		// provider label is what they typed. Guests already typed a name on the join form.
		var hostNeedsName = participant.role === "host" && displayName === "";
		byId("host-name-field").hidden = !hostNeedsName;
		if (typeof meeting.deadlineAt === "number" && isFinite(meeting.deadlineAt)) {
			setText("lobby-deadline", "The room closes at " + new Date(meeting.deadlineAt).toLocaleString() + ".");
		} else {
			setText("lobby-deadline", "");
		}
		byId("host-controls").hidden = participant.role !== "host";
	}

	// #endregion session

	// #region guest form

	function submitGuestForm(event) {
		event.preventDefault();
		var codeInput = byId("guest-code");
		var nameInput = byId("guest-name");
		var emailInput = byId("guest-email");
		var code = codeInput.value.trim();
		var displayName = nameInput.value.trim();
		var email = emailInput.value.trim();

		codeInput.removeAttribute("aria-invalid");
		nameInput.removeAttribute("aria-invalid");
		if (code === "") {
			codeInput.setAttribute("aria-invalid", "true");
			setError("guest-error", "Enter the join code you were given.");
			codeInput.focus();
			return;
		}
		if (displayName === "") {
			nameInput.setAttribute("aria-invalid", "true");
			setError("guest-error", "Enter the name to show to other participants.");
			nameInput.focus();
			return;
		}
		setError("guest-error", null);

		// Retrying the same inputs reuses the same joinAttemptId, so the server can answer the
		// retry idempotently instead of spending another participant slot. Changed inputs are a
		// new attempt and get a new id.
		var attemptKey = code + "\\u0000" + displayName + "\\u0000" + email;
		if (state.joinAttempt === null || state.joinAttempt.key !== attemptKey) {
			state.joinAttempt = { key: attemptKey, id: crypto.randomUUID() };
		}

		var submitButton = byId("guest-submit");
		var generation = bootGeneration;
		submitButton.disabled = true;
		apiPost("/room/api/guest-session", {
			meetingId: state.guestMeetingId,
			code: code,
			displayName: displayName,
			email: email === "" ? null : email,
			joinAttemptId: state.joinAttempt.id,
		})
			.then(function (session) {
				if (generation !== bootGeneration) {
					return;
				}
				submitButton.disabled = false;
				adoptSession(session);
			})
			.catch(function (error) {
				if (generation !== bootGeneration) {
					return;
				}
				submitButton.disabled = false;
				setError("guest-error", errorText(error));
			});
	}

	// #endregion guest form

	// #region call

	function joinMeeting() {
		var generation = bootGeneration;
		var joinButton = byId("join-button");
		var joinBody = {};
		var hostNameField = byId("host-name-field");
		if (hostNameField && !hostNameField.hidden) {
			var nameInput = byId("host-name");
			var displayName = nameInput.value.trim();
			nameInput.removeAttribute("aria-invalid");
			if (displayName === "") {
				nameInput.setAttribute("aria-invalid", "true");
				setError("lobby-error", "Enter the name to show to other participants.");
				nameInput.focus();
				return;
			}
			joinBody.displayName = displayName;
		}
		joinButton.disabled = true;
		setError("lobby-error", null);
		apiPost("/room/api/join", joinBody)
			.then(function (data) {
				if (generation !== bootGeneration) {
					return null;
				}
				return startCall(data.authToken, generation);
			})
			.catch(function (error) {
				if (generation !== bootGeneration) {
					return;
				}
				// Leave any half-joined SDK before reporting failure, so a retry starts clean
				// instead of stacking a second live connection.
				if (state.sdk) {
					var failedSdk = state.sdk;
					state.sdk = null;
					Promise.resolve(failedSdk.leave()).catch(function () {});
				}
				joinButton.disabled = false;
				setError("lobby-error", errorText(error));
			});
	}

	function startCall(authToken, generation) {
		if (typeof RealtimeKitClient === "undefined") {
			throw new Error("The meeting software did not load. Reload the page and try again.");
		}
		return RealtimeKitClient.init({ authToken: authToken, defaults: { audio: true, video: false } })
			.then(function (sdk) {
				if (generation !== bootGeneration) {
					Promise.resolve(sdk.leave()).catch(function () {});
					return null;
				}
				state.sdk = sdk;
				return sdk.join().then(function () {
					return waitForRoomJoined(sdk);
				});
			})
			.then(function (roomJoined) {
				if (generation !== bootGeneration || roomJoined === null) {
					return null;
				}
				// join() can resolve while the participant is still in a waiting room and is never
				// recorded, so nothing counts as joined until self.roomJoined is really true.
				if (!roomJoined) {
					throw new Error("Could not enter the meeting room. Ask the host whether the meeting is open, then try again.");
				}
				// join() resolving does not mean the microphone publishes. Ask for audio explicitly;
				// a refusal keeps the participant in the call with the microphone off.
				if (state.sdk.self.audioEnabled) {
					return true;
				}
				return state.sdk.self.enableAudio().then(
					function () {
						return true;
					},
					function () {
						return false;
					}
				);
			})
			.then(function (micOn) {
				if (generation !== bootGeneration || micOn === null) {
					return;
				}
				wireCallEvents();
				renderParticipants();
				renderMicState();
				renderRecordingState();
				showView("view-call", "call-heading");
				// After renderMicState, so the plain "Microphone off." line does not overwrite this
				// guidance. A later audioUpdate replaces it once the microphone really changes.
				if (micOn === false) {
					setCallStatus("Microphone unavailable. Allow microphone access, then press Unmute microphone.");
				}
				startPolling();
			});
	}

	function waitForRoomJoined(sdk) {
		var deadline = Date.now() + 30000;
		return new Promise(function (resolve) {
			function check() {
				if (sdk.self.roomJoined) {
					resolve(true);
				} else if (Date.now() >= deadline) {
					resolve(false);
				} else {
					setTimeout(check, 500);
				}
			}
			check();
		});
	}

	function wireCallEvents() {
		var sdk = state.sdk;
		var joined = sdk.participants && sdk.participants.joined;
		if (joined && typeof joined.on === "function") {
			joined.on("participantJoined", renderParticipants);
			joined.on("participantLeft", renderParticipants);
		}
		if (sdk.self && typeof sdk.self.on === "function") {
			sdk.self.on("audioUpdate", renderMicState);
			// The provider removed this participant (host closed the meeting, session ended). A
			// deliberate local leave already set state.over first, so this only reports the rest.
			// A ticket swap nulls state.sdk before leave(); ignore that stale roomLeft so it cannot
			// paint Meeting ended on top of the new lobby.
			sdk.self.on("roomLeft", function () {
				if (state.sdk !== sdk) {
					return;
				}
				if (!state.over) {
					endLocally("The meeting has ended.");
				}
			});
		}
		if (sdk.recording && typeof sdk.recording.on === "function") {
			sdk.recording.on("recordingUpdate", renderRecordingState);
		}
	}

	function setCallStatus(message) {
		setText("call-status", message);
	}

	// Display names are typed by unverified strangers. They only ever land in textContent, never
	// in markup.
	function participantLabel(participant) {
		return participant && typeof participant.name === "string" && participant.name !== ""
			? participant.name
			: "Participant";
	}

	function renderParticipants() {
		var sdk = state.sdk;
		if (!sdk) {
			return;
		}
		var list = byId("participant-list");
		list.textContent = "";
		var labels = [participantLabel(sdk.self) + " (you)"];
		var seenIds = {};
		var selfId = sdk.self && sdk.self.id;
		if (typeof selfId === "string" && selfId !== "") {
			seenIds[selfId] = true;
		}
		var selfCustomId = sdk.self && (sdk.self.customParticipantId || sdk.self.custom_participant_id);
		if (typeof selfCustomId === "string" && selfCustomId !== "") {
			seenIds[selfCustomId] = true;
		}
		var joined = sdk.participants && sdk.participants.joined;
		if (joined && typeof joined.toArray === "function") {
			joined.toArray().forEach(function (participant) {
				var participantId = participant && participant.id;
				var customId = participant && (participant.customParticipantId || participant.custom_participant_id);
				if (typeof participantId === "string" && participantId !== "" && seenIds[participantId]) {
					return;
				}
				if (typeof customId === "string" && customId !== "" && seenIds[customId]) {
					return;
				}
				if (typeof participantId === "string" && participantId !== "") {
					seenIds[participantId] = true;
				}
				if (typeof customId === "string" && customId !== "") {
					seenIds[customId] = true;
				}
				labels.push(participantLabel(participant));
			});
		}
		labels.forEach(function (label) {
			var item = document.createElement("li");
			item.textContent = label;
			list.appendChild(item);
		});
		setText("participant-count", labels.length === 1 ? "1 participant" : labels.length + " participants");
	}

	function renderMicState() {
		var sdk = state.sdk;
		if (!sdk) {
			return;
		}
		var enabled = sdk.self.audioEnabled === true;
		setText("mute-button", enabled ? "Mute microphone" : "Unmute microphone");
		setCallStatus(enabled ? "Microphone on." : "Microphone off.");
	}

	function toggleMicrophone() {
		var sdk = state.sdk;
		if (!sdk) {
			return;
		}
		var action = sdk.self.audioEnabled ? sdk.self.disableAudio() : sdk.self.enableAudio();
		Promise.resolve(action).catch(function () {
			if (state.sdk === sdk) {
				setCallStatus("Microphone unavailable. Check the browser's microphone permission.");
			}
		});
	}

	function renderRecordingState() {
		var sdk = state.sdk;
		var recordingState = sdk && sdk.recording ? sdk.recording.recordingState : null;
		var active = recordingState === "RECORDING" || recordingState === "STARTING";
		byId("recording-indicator").hidden = !active;
	}

	// #endregion call

	// #region host controls

	// One inline confirm block serves both host actions; pendingHostAction says which one.
	var pendingHostAction = null;

	function openHostConfirm(action) {
		pendingHostAction = action;
		setText(
			"host-confirm-text",
			action === "start-recording"
				? "Start recording this meeting?"
				: "End the meeting for everyone?"
		);
		byId("host-confirm").hidden = false;
		byId("host-confirm-yes").focus();
	}

	function closeHostConfirm(refocusId) {
		pendingHostAction = null;
		byId("host-confirm").hidden = true;
		if (refocusId) {
			byId(refocusId).focus();
		}
	}

	function confirmHostAction() {
		var action = pendingHostAction;
		var generation = bootGeneration;
		closeHostConfirm(null);
		setError("host-error", null);
		if (action === "start-recording") {
			apiPost("/room/api/host/start-recording", {})
				.then(function () {
					if (generation !== bootGeneration) {
						return;
					}
					// The shared indicator flips on the SDK recordingUpdate event for everyone.
					setCallStatus("Recording is starting.");
					byId("start-recording-button").focus();
				})
				.catch(function (error) {
					if (generation !== bootGeneration) {
						return;
					}
					setError("host-error", errorText(error));
					byId("start-recording-button").focus();
				});
		} else if (action === "end-meeting") {
			apiPost("/room/api/host/close", {})
				.then(function () {
					if (generation !== bootGeneration) {
						return;
					}
					endLocally("You ended the meeting. Recording and transcript files appear on the Council page when they are ready.", generation);
				})
				.catch(function (error) {
					if (generation !== bootGeneration) {
						return;
					}
					setError("host-error", errorText(error));
					byId("end-meeting-button").focus();
				});
		}
	}

	// #endregion host controls

	// #region lifecycle

	function endLocally(message, generation) {
		var endingGeneration = typeof generation === "number" ? generation : bootGeneration;
		state.over = true;
		stopPolling();
		var sdk = state.sdk;
		var leavePromise =
			sdk && typeof sdk.leave === "function"
				? sdk.leave().catch(function () {})
				: Promise.resolve();
		leavePromise.then(function () {
			if (endingGeneration !== bootGeneration) {
				return;
			}
			byId("recording-indicator").hidden = true;
			setText("ended-message", message);
			showView("view-ended", "ended-heading");
		});
	}

	function startPolling() {
		stopPolling();
		state.pollTimer = setInterval(pollMeetingState, 10000);
	}

	function stopPolling() {
		if (state.pollTimer !== null) {
			clearInterval(state.pollTimer);
			state.pollTimer = null;
		}
	}

	function pollMeetingState() {
		var generation = bootGeneration;
		apiPost("/room/api/state", {})
			.then(function (data) {
				if (generation !== bootGeneration) {
					return;
				}
				var status =
					data && data.meeting && typeof data.meeting.status === "string"
						? data.meeting.status
						: data && typeof data.status === "string"
							? data.status
							: null;
				// The call only continues while the meeting is open. Closed, expired, processing, and
				// every later status all mean the same thing to a participant: the meeting is over.
				if (status !== null && status !== "open" && !state.over) {
					endLocally("The meeting has ended.", generation);
				}
			})
			.catch(function () {
				// A failed poll is retried by the next tick; the provider room keeps working meanwhile.
			});
	}

	// #endregion lifecycle

	function boot() {
		byId("guest-form").addEventListener("submit", submitGuestForm);
		byId("join-button").addEventListener("click", joinMeeting);
		byId("mute-button").addEventListener("click", toggleMicrophone);
		byId("leave-button").addEventListener("click", function () {
			endLocally("You left the meeting.");
		});
		byId("start-recording-button").addEventListener("click", function () {
			openHostConfirm("start-recording");
		});
		byId("end-meeting-button").addEventListener("click", function () {
			openHostConfirm("end-meeting");
		});
		byId("host-confirm-yes").addEventListener("click", confirmHostAction);
		byId("host-confirm-cancel").addEventListener("click", function () {
			closeHostConfirm(pendingHostAction === "start-recording" ? "start-recording-button" : "end-meeting-button");
		});

		// Tests boot this script more than once in one window. Replace the previous handler so
		// an older boot cannot steal a later ticket and erase the fragment first.
		if (typeof window.__councilOnHashChange === "function") {
			window.removeEventListener("hashchange", window.__councilOnHashChange);
		}
		window.__councilOnHashChange = function () {
			var pasted = captureTicketFromHash();
			if (pasted) {
				exchangeTicket(pasted);
			}
		};
		window.addEventListener("hashchange", window.__councilOnHashChange);

		var entry = window.__councilEntry || { ticket: null };
		delete window.__councilEntry;
		if (entry.ticket) {
			exchangeTicket(entry.ticket);
		} else {
			resumeOrGuest();
		}
	}

	function captureTicketFromHash() {
		var hash = window.location.hash;
		if (!hash || hash.length <= 1) {
			return null;
		}
		var ticket = new URLSearchParams(hash.slice(1)).get("ticket");
		history.replaceState(null, "", window.location.pathname + window.location.search);
		return ticket;
	}

	function exchangeTicket(ticket) {
		var generation = ++bootGeneration;
		resetLiveCall();
		apiPost("/room/api/session", { ticket: ticket })
			.then(function (session) {
				if (generation !== bootGeneration) {
					return;
				}
				adoptSession(session);
			})
			.catch(function (error) {
				if (generation !== bootGeneration) {
					return;
				}
				showFatal(errorText(error) + " Room links are single-use. Get a fresh room link from the Council page.");
			});
	}

	function resumeOrGuest() {
		// A live cookie means this tab already joined. Resume it (and mint a fresh CSRF) instead
		// of showing a new guest form that would mint a second joinAttemptId.
		var generation = ++bootGeneration;
		apiPost("/room/api/session", {})
			.then(function (session) {
				if (generation !== bootGeneration) {
					return;
				}
				adoptSession(session);
			})
			.catch(function () {
				if (generation !== bootGeneration) {
					return;
				}
				var meetingId = new URLSearchParams(window.location.search).get("m");
				if (meetingId !== null) {
					state.guestMeetingId = meetingId;
					showView("view-guest", "guest-heading");
				} else {
					showFatal("This is not a valid meeting link. Ask the meeting host for a new invite link.");
				}
			});
	}

	boot();
})();
`;
