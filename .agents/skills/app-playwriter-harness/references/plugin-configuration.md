# Plugin Configuration

Use these recipes for plugin access, upload filters, and scheduled Mounts.

## Setup and management access

1. Reuse the seeded owner and actual Member in the [QA catalog](../../qa-data/references/inventory.md). Pin their active membership, tenant, and current role. Save the original setup, policy, existing installation B, and complete account/ACL pages.
2. In `Plugin setup access`, save each `Who can install plugins` choice. Read the exact stored mode/list as the owner after every save. The Member's query hides that list. Save native snapshots too: Owner only and empty Selected refuse Install; Selected Member role, Everybody, and Selected Member user offer it.
3. For a fresh published fixture with no running backend, accept Install as the Member with `Create an empty account` and no file grants. Confirm the new installation A and its direct installer grant. The Member must manage A while B's native controls and public management data stay absent.
4. Send B's unchanged access settings and require `Permission denied`. Remove the Member from A's selected users with native `Save plugin access`. Require A's controls to disappear and its public access query to return null. Send the same empty Selected settings again and require `Permission denied`.
5. As owner, uninstall only recorded A, remove only its checked temporary policy entry, and restore the original setup. Compare B, roles, policy/MCP fields, original accounts, and complete ACL pages. Require a final restore read. Stop on an unrelated change.

Space management writes by at least 15 seconds. A rate limit does not prove refusal. Retained bindings need service-account management on reinstall; do not change roles or look up hidden bindings to bypass that check. Run-as consent is separate. Scroll the setup panel into view before checking hit targets.

## Save a folder policy

1. Open `/w/:organizationName/:workspaceName/plugins/:pluginName` and wait for the installed badge.
2. Find the Monaco editor by its accessible name `Plugin configuration YAML`.
3. Replace the editor value with the full YAML document. For example:

```yaml
triggers:
  files.upload.completed:
    folders:
      - /meetings
```

4. Click `Save configuration`. Wait for the announced `Configuration saved` status.
5. In `Access & automation`, confirm the trigger summary shows the saved paths.

Check keyboard access too: focus the editor and press Tab. Focus must leave the editor without changing YAML. After an edit, Tab should reach `Save configuration`.

Use `/` to match every folder. Use `folders: []` to stop automatic upload runs. A configured folder also matches its descendants, but not sibling prefixes. Matching is case-sensitive.

## Error and persistence checks

- Save invalid YAML and confirm the error is announced while the invalid editor text stays visible.
- Reload after a successful save. Confirm Monaco and the trigger summary still show the saved policy.
- Reinstall or make a compatible upgrade without uninstalling. Confirm the policy remains unchanged. An upgrade whose new filters reject the stored YAML must fail without changing the installation.
- Gallery does not declare configuration, so its detail page must not show the Configuration section.

## Matched and unmatched uploads

1. Record the plugin detail page's recent runs.
2. Upload a supported fixture outside the configured folders. Confirm no new automatic run or generated sibling appears.
3. Upload the same fixture inside a configured folder. Confirm one `files.upload.completed` run appears for that exact path and reaches `succeeded`.
4. Verify the generated output for image, video, or PDF plugins using `references/image-plugin-description.md`, `references/video-plugin-transcription.md`, or the PDF sibling recipe in `references/files.md`.

Manual runs are a separate action and intentionally ignore this automatic-upload filter.

## Scheduled Mounts

1. Use the installed plugin's normal configuration form. The install or update modal has a textarea named `Configuration YAML`; the details page uses Monaco named `Plugin configuration YAML`. Use the Monaco replacement recipe in [known-hazards.md](known-hazards.md). Multiline keyboard replacement can change YAML indentation.
2. In the install form, select an active run user with a valid direct grant. For `Me`, accept the needed scopes and the signed-out run checkbox. A manager cannot grant another user's consent.
3. Save and read back the installation, schedule, grant and Mounts through the public queries. Check the exact workspace, source commit and installed version. Do not print tokens or secrets.
4. Let the normal scheduler finish the full scan and copy chain. Check every run's result, actor and grant. A successful scan alone does not prove publication. The Mount must have the expected revision, file count and bytes, with no staging copy.
5. To check a later natural timer, temporarily save a 15-minute interval and record its next due time. Until that later run finishes, do not save, enable, reassign, or press `Run now`: those actions can make the plugin due immediately. Check that the later root was created after the saved due time. An unchanged repo must keep its publication time, count and byte usage.
6. Restore the daily interval, 1440 minutes, through the normal save form. Read it back. Temporary QA changes must not leave frequent runs enabled.

Reuse the public native-popovers Mount and chat listed in the [QA data catalog](../../qa-data/references/inventory.md). Mounts stay out of the Files sidebar.

## Private GitHub source

1. Use a small fake private repo and a separate QA installation. Keep the public native-popovers settings fixed. Choose a distinct mount name and pin the sample commit in `ref`.
2. Use a fine-grained token with Contents read for only that repo. In `Manage secrets`, use `Workspace secrets`, name `GITHUB_TOKEN`, and the normal Save action. If the user explicitly asks you to issue and save it, create a fresh token through GitHub's normal UI. Keep its newly shown value in Playwriter memory and transfer it directly into the password field. Read back only the saved secret name, then clear the value from memory. Never print it, write it to a file, inspect an existing token, or copy the broad GitHub CLI credential into the plugin.
3. After reload, read `configurationYaml` through `plugins.list_installations` for the exact QA membership. The details editor is Monaco, so its textbox does not support `inputValue()`.
4. Check the run calls and published Mount, not only the run's success label. A denied head request can return 404 and be skipped in a successful scan. That does not prove a private download. Require the pinned revision, exact fake file bytes, and an agent read. The call ledger can prove the archive redirect and ZIP response; it records no headers. Review `archive_response` at the installed source commit and run its private ZIP tests to check that only the GitHub API receives the token. The codeload request must have no token.
5. After the check, uninstall only the recorded QA installation through its normal UI. Delete only the test token you created. Confirm the installation, copied files and workspace secret are gone. Keep finished history and confirm the required `/.mounts/t3-chat` system source is still readable.

## Run permissions and assignment

An ordinary member can open `My run permissions` without plugin management access.
Check the actual workspace role before testing a refusal. A test account's name is not its role.

Changing scope checkboxes clears the signed-out run acknowledgement. Check it again
before `Save my run permissions`. A manager selects another user only after that user
has saved their own grant. Scope the assignment picker to `.RoutePluginsSchedule`;
hidden install dialogs also contain a `Run as` picker.

Read back the exact selected user, grant and owner payer. Revoke consent as that same
user. Confirm the user leaves the complete eligible list and the assignment needs repair.
Regrant or leave/rejoin must create fresh consent; an old ID must still refuse. Older
finished history keeps its original actor and grant IDs.

Put the native click and its readback in separate short Playwriter calls. The click can
return before the Convex mutation finishes. Check the status and current grant before
retrying. A first read that still shows the grant does not prove revocation failed.

## Mount reads and disabling

1. In Agent mode, ask for one read-only Bash call. Pin the same shell name in every prompt. Read the stored tool part as well as the visible result. Compare the README lines with the mounted Git revision.
2. Name the expected positive check before disabling: the exact mounted README is readable, with exit code 0 and no stderr.
3. Disable through the plugin page. Repeat the same read in the same saved chat and shell. The positive check must fail on exit code 1 with `No such file or directory`. Confirm that the stored copy and finished history remain.
4. Enable through the normal form and repeat the positive read. Read back the enabled status and daily interval. A new self-grant may be created; old run history must retain its original grant IDs.
5. Try `touch` on a new QA filename inside the Mount. Expect exit code 1 and the read-only mount error. Check that the filename is absent and the published counts stay unchanged.

Focus a button and read `document.activeElement` before pressing Enter. A prior click or focus move can leave a checkbox active. Always verify the saved result; an open enable form does not mean the plugin was enabled.
