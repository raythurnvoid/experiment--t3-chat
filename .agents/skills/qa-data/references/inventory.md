# Dev Test Data Catalog

Deployment: `dev:grand-finch-267`. Last refresh: 2026-09-24, with the recipe in
[../SKILL.md](../SKILL.md#refresh-the-catalog). It counted about 9,300 live files and folders in
real workspaces (archived files not counted).

Paths are written `org/workspace:/path`. The Files route for a workspace is
`/w/<org>/<workspace>/files`.

Keep this file current. When you add a reusable file, add it to the right table. When you find a
row that is wrong, fix it. Add one line to the change log at the end.

## Workspaces

`reuse` means you may open, edit, move, copy, share, and comment on the files there. `read-only`
means look but do not change anything.

| Workspace | Reached by | Policy | Use it for |
| --- | --- | --- | --- |
| `chitchat-qa/xfer-qa-0914` | QA Edge profile (Ray) | reuse | Files UI, editors, copy and move, tree, many files, deep folders, shares. The main place for new Files test data. |
| `chitchat-qa/copy-qa-0922` | QA Edge profile | reuse | Copy checks. Almost empty. MCP and plugin-skill checks: Data Probe 0.3.0 is installed here with its `fixture` MCP server and `mcp-echo` skill, so every chat here gets the fixture tools. The `chitchat-qa` plugin policy allows `data-probe`. |
| `chitchat-qa/metadata-qa-0906` | QA Edge profile | reuse | Metadata checks. Chitchat and Council installed. |
| `chitchat-qa/home` | QA Edge profile; `qa.perm.member` is a member | reuse | Chitchat page and its transcript files. Uploads here run no plugin. |
| `qa-browser/home` | `qa.perm.owner` (owner), `qa.perm.viewer` (member) in a scratch browser | reuse | Permission refusals, second-user checks, search, web browser QA. Chitchat installed. Empty Video Player account `rd7nt1qt9segqprsarrwc7jnr58f9qkh` remains without file grants after its test uninstall. Its retained binding makes reinstall need service-account management. The QA Edge profile is **not** a member. |
| `qa-tmp-share/home` | `qa.perm.member` (owner) | reuse | Cross-org share checks. No plugin installations. Empty reusable Data Probe and GitHub Sources service accounts remain without file grants. |
| `personal/home` of each `qa.perm.*` account | that account | reuse | Almost empty. |
| `personal/home` (Ray) | QA Edge profile | reuse for QA folders only | Ray's main workspace. **Every upload here runs the image, pdf, video, and data-probe plugins**, so upload here only to test those plugins. Ray's own notes (`/tasks`, `/inbox`, `/todo.md`, `/README.md`) are read-only. |
| `personal/plugin-access-qa` | QA Edge profile | reuse | Plugin access settings. Created through the workspace dialog to check the Owner only default. Saved all three setup modes, then returned it to Owner only. No plugins; only the automatic `/README.md`. |
| `sybill-demo/demo` | QA Edge profile | read-only | Large realistic import: `/people` (about 9,700 files), `/companies` (1,000+ in one folder), `/emails`, `/meetings`, `/email-attachments` (Office files). About 10 GB stored. Use it for load, paging, and search on big data. |
| `sybill-demo/home` | QA Edge profile | reuse | Empty. |

Installed plugin source trees live in `GLOBAL`/`PLUGINS`. Plugin-owned Mounts belong to their installation's workspace. The old t3-chat mirror still uses `GLOBAL`/`GITHUB` until its reviewed cutover. These trees are read-only data.

## Accounts

| User id | Who | Notes |
| --- | --- | --- |
| `m577heygr826f2wgk6r30mk1vd8928q2` | Ray's own account. The QA Edge profile is signed in as it. | Never sign it out. |
| `m575qvj9kyabtdn9jef1dgw0js8ck2dq` | `qa.perm.owner` | Owns `qa-browser`. |
| `m572b1a4snqa1en3qqp1gfwwnn8cjxya` | `qa.perm.admin` | Personal org only. |
| `m57f7hajv2kgw3rxfnv9z4bagh8ckq06` | `qa.perm.member` | Owns `qa-tmp-share`, member of `chitchat-qa`. |
| `m572qhnpq7xw34askfcy6w97h18ck1f8` | `qa.perm.viewer` | `member` role in `qa-browser`. |
| `m570f2kgg8jq3qka7snprkpeks8cme94` | Extra `+clerk_test` account (2026-08-17) | Member of `chitchat-qa`. Not in `clerk-test-accounts.md`. |
| `m5754ckhv5yrt02vjf1dt2v4hd8cjsy4` | `import-qa-member` | Listed in `clerk-test-accounts.md`, but no `users` doc had this id on 2026-09-24. |
| 6 anonymous members | Old second-user runs | 2 in `qa-browser`, 4 in `chitchat-qa`. Their tokens are gone, so nobody can sign in as them. |
| 113 other anonymous users | Old headless runs | Each has only its own personal org. Not useful for tests. |

Sign-in steps for the `qa.perm.*` accounts are in
[clerk-test-accounts.md](../../app-playwriter-harness/references/clerk-test-accounts.md).

## What Do You Need?

### Text files

| Need | Use |
| --- | --- |
| Markdown, collaboration on | `chitchat-qa/xfer-qa-0914:/u18/dest.md`, `chitchat-qa/copy-qa-0922:/README.md`, `personal/home:/documents/notes.md` |
| Small Files permission check | `qa-browser/home:/qa-search-0905/tasks/public-task.md` and `/qa-search-0905/private/secret-task.md`. Saved API text is 52 bytes; the Yjs rich-text read is 53 bytes with final LF. The private folder stays restricted. Use the [scheduled Files recipe](../../app-playwriter-harness/references/plugin-backend-execution.md#scheduled-permission-checks) and restore shares after testing. |
| Markdown, collaboration off | `personal/home:/qa-noncollab/notes.md`, `chitchat-qa/xfer-qa-0914:/u23p/my-file.md` (and the rest of `/u23p`) |
| Long Markdown (scrolling) | `chitchat-qa/home:/qa-long-scroll.md` (about 50 KB). Read-only 97 KB files: `chitchat-qa/home:/chitchat-ad04c6c85ea7daf62a10960d/qa-rollover-1012299.md` |
| Markdown with frontmatter | `personal/home:/frontmatter-demo.md` |
| Medium Markdown with sections | `personal/home:/activity-ui-fixture.md` (about 1 KB) |
| Empty Markdown | `personal/home:/demo/mv-src.md`, `/demo/mv-target.md`, `/demo/cp-target.md` |
| `.txt` opened as rich text | `chitchat-qa/xfer-qa-0914:/g4-x/movable.txt`, `/g4-many/f00.txt` … `f59.txt` |
| Plain text (`plain_text` editor) | `personal/home:/qa-plan1-1788804917720/qa-plain.txt`, `qa-browser/home:/two-roots-qa-0921.txt` |
| HTML | `personal/home:/split-browser-click-check.html` (3 KB), `qa-browser/home:/privacy-browser-qa-0921.html`. Collaboration off: `personal/home:/qa-html-preview-1788973527253/qa-meeting-brief.html` |
| HTML for shared browser restart checks | `chitchat-qa/xfer-qa-0914:/browser-persistence-demo` (2026-09-27): `01-stateful-app.html` (page age, click counter, random page id, input, checklist, long list, fake 3 s boot), `02-second-page.html`, `03-esm-chart.html` (loads d3 from esm.sh and shows the load time), `notes.txt`, `README.md`. A new page id means the cloud browser restarted. |
| JSON | `personal/home:/qa-plain.json`. Large (79 KB, read-only): `personal/home:/meetings/15f1649a-d06c-4af3-be03-c5255c9180de/provider-transcript.json` |

### Stored files (uploads)

| Need | Use |
| --- | --- |
| PDF | `personal/home:/documents/config-matched-document.pdf`, `chitchat-qa/home:/r2-upload-sample.pdf` |
| PDF with its generated `.pdf.md` | `personal/home:/documents/config-matched-document.pdf` and `.pdf.md` next to it |
| PNG | `chitchat-qa/xfer-qa-0914:/u03/shapes.png`, `personal/home:/assets/` (13 pasted images) |
| PNG with its generated description | `personal/home:/images/config-matched-image.png` and `.description.md` |
| WebP | `personal/home:/tmp/generated/image-76eae624-5365-43b6-85ae-fc8a9030ee37.webp` |
| MP4 video | `chitchat-qa/xfer-qa-0914:/g4-media/speakers.mp4`, `personal/home:/assets/pasted-video-20260808-235459.mp4` |
| Video with transcript and summary | `personal/home:/speakers-activity-e2e.mp4` with `.transcript.md` and `.summary.md` (9 such sets at the root) |
| Audio | `personal/home:/meetings/15f1649a-d06c-4af3-be03-c5255c9180de/recording-audio.m4a` (read-only); two `.webm` files in `personal/home:/meetings/a610f275-3582-4c51-957f-4d37d1a9212b/` |
| Word, Excel, PowerPoint, CSV, XLS | `sybill-demo/demo:/email-attachments/` (35 docx, 10 xlsx, 6 pptx, 10 csv, 2 xls). Read-only. |
| Binary or no extension | `personal/home:/binary-qa-20260920-1546/empty` (0 B), `/binary-qa-20260920-1546/nested/opaque` |

### Folders

| Need | Use |
| --- | --- |
| Folder with about 60 files | `chitchat-qa/xfer-qa-0914:/g4-many`, `/u62-mu2qzdr5/src` |
| Folder with about 25 files | `chitchat-qa/xfer-qa-0914:/u16`, `/u16-q`, `/u42-other2` |
| Very big folder (read-only) | `sybill-demo/demo:/people` (about 9,700), `/companies` (1,000+). A three-file sample on 2026-09-29 had readable string `metadata.source` values. Check the current folder catalog before choosing other fields. |
| Big archive fixture (1,311 nodes) | `qa-browser/home`: `/protection-bulk-qa` (532 nodes, restricted, `qa.perm.viewer` has manage) plus the root folders `/copy-2` (104), `/copy-3` (208), `/copy-4` (416) and `/seed` (51). All active since 2026-09-25. Archive all five in one `archive_nodes` call to get one 1,311-node archive job, then restore that one operation. `/seed` alone finishes inline (no job). Empty archived `/seed` folders are left over from clash checks. The archived `/seed/f00/seed` (one operation, 3 nodes) holds `f00/r3-moved-0925.md`, a small text file with real text chunks, for checks that archived side docs follow a moved folder and for search polling during a job. Two empty archived folders, `/protection-bulk-qa/a3-inserted-during-archive-0925` and `/protection-bulk-qa/a3-inserted-during-apply-0925`, are left over from checks that a folder inserted during a job joins its operation. Build new big fixtures inside `/protection-bulk-qa`. |
| Deep path (22 levels) | `chitchat-qa/xfer-qa-0914:/g4-u15/d01/…/d20/keeper.txt` |
| Many small subfolders | `chitchat-qa/xfer-qa-0914:/u55/c0` … `c22`, each with `sibling.md` |
| Move and copy sources and targets | `personal/home:/demo` (`mv-src.md`, `mv-target.md`, `cp-target.md`, `/archive`), `personal/home:/tests` (`eval-*` files and folders) |
| Search: public and private | `qa-browser/home:/qa-search-0905` (`tasks/public-task.md`, `private/secret-task.md`, `v1.2/`). On 2026-09-29, the root and its three child folders were active. The private child was restricted, with no grants on it or the root. |
| Folder table sorts and columns | `qa-browser/home:/qa-sort-0924` is archived. It has 58 files and three folders, all archived; one child is restricted. Neither the root nor that child has grants. `/qa-sort-0924-r` is a separate archived restricted root with three archived files. It keeps one user read grant to `qa.perm.viewer`, who still has an active membership and the `member` role. Checked 2026-09-29. Restore through normal Files doors before reuse, then archive again. |
| More than 200 restricted children | `qa-browser/home:/qa-cap-0924` is archived with 203 archived restricted child folders. The root and every child have no grants. Checked 2026-09-29. Reuse this fixture for the shared-row cap instead of creating another large set. |
| Agent skills folder | `personal/home:/.agents/skills/meeting-brief` |
| Bash agent eval fixture | `personal/home:/bash-eval-smoothness-fixture-2026-07-25-a` ([bash-tool-agent-eval.md](../../app-playwriter-harness/references/bash-tool-agent-eval.md)) |
| Browser downloads | `personal/home:/.system/downloads`, `personal/home:/tmp/browser` |

### Write rules and shares

| Need | Use |
| --- | --- |
| Read-only file | `personal/home:/aaa-closing-qa-mu6ygix9.md`, `/aaa-closing-qa-dest-mu6ynzn5/aaa-closing-qa-mu6ygix9.md` |
| File with a user writer | `chitchat-qa/xfer-qa-0914:/u18/dest.md` |
| Folder a plugin service owns | `qa-browser/home:/chitchat`, `chitchat-qa/home:/chitchat-2eff489e` (read-only for tests) |
| Restricted (shared) scope roots | `chitchat-qa/xfer-qa-0914:/u34-dst-a/u34a/sub`, `/u34-dst-b/u34b/sub`, `/g4-media/speakers.mp4`, `/g4-media/shapes.png` |

### Plugin output (read-only)

| Need | Use |
| --- | --- |
| Meeting recordings with transcript and summary | `personal/home:/meetings` (about 44 files) |
| Chitchat transcripts | `chitchat-qa/home:/chitchat-ad04c6c85ea7daf62a10960d`, `qa-browser/home:/chitchat` ([chitchat.md](../../app-playwriter-harness/references/chitchat.md)) |
| External repo Mount | `personal/home:/.mounts/github/native-popovers`. GitHub Sources copies the public `raythurnvoid/react-native-popovers` repo. Its first copy has 70 text files. Use Bash to read it; it stays out of the Files sidebar. |

### Repo files for uploads

When a check must upload, use the small files in
`.agents/skills/app-playwriter-harness/assets/files/`: `qa-plain.*`, `qa-frontmatter-*.md`,
`qa-meeting-brief.html`, `r2-upload-*`, `shapes.png`, `speakers.mp4`, `speakers.wav`. Upload them
to a `chitchat-qa` workspace unless the check is about the upload plugins.

### Chats

`personal/home` already has about 410 chats. For an agent check where chat history does not
matter, continue a chat you already made for the same task instead of starting a new one.

Reuse `QA native-popovers mount 0928` in `personal/home` (`n17e1df2cqn1p6m8kkac9nq8d58f8674`) for this Mount's Bash checks. The saved first turn lists the Mount and reads its README without changing files.

Reuse `qa-browser/home` chat `n1708wzk8n9hnt2r9qm87jd1118f9g6z` as `qa.perm.owner` for
Mount isolation checks. Its saved Bash call found both plugin Mount paths absent.
Only the original Chitchat installation was present.

## Change Log

- 2026-09-24: first catalog from a full refresh.
- 2026-09-28: Data Probe 0.3.0 (MCP fixture) installed in `chitchat-qa/copy-qa-0922`.
- 2026-09-28: added `personal/plugin-access-qa` for plugin access settings. Keep it at Owner only after checks.
- 2026-09-28: added the native-popovers Mount and its saved read-only QA chat in `personal/home`.
- 2026-09-28: reused the two saved Files permission fixtures. Original files, shares, roles, policy and Chitchat installation are restored. Temporary Data Probe is uninstalled; its empty service account remains without grants.
- 2026-09-28: added the QA owner's reusable no-plugin Mount isolation chat in `qa-browser/home`.
- 2026-09-28: install-access check restored the original setup, policy, roles, accounts and Chitchat. Video Player is uninstalled; its empty account and binding remain.
- 2026-09-29: checked the search, folder-sort and 203-child cap fixtures, their archive state and grants, and both QA memberships. Sampled three readable `metadata.source` values in `/people`; changed no live data.
