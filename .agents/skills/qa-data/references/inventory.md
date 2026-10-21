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
| `chitchat-qa/home` | QA Edge profile; `qa.perm.member` is a member | reuse | Chitchat page and its transcript files. Its plan has no file uploads (seen 2026-10-18). Agent chat has credits; `qa.perm.member` cannot restrict here, only the owner can. Empty GitHub Sources service account `rd7tqp8qb5vkfa0jvnp8kgjj398fbctd` remains without grants after both test uninstalls. Reinstall needs permission to manage this account. |
| `qa-browser/home` | `qa.perm.owner` (owner), `qa.perm.viewer` (member) in a scratch browser; `qa.perm.member` is also an active member (seen 2026-10-11) | reuse | Permission refusals, second-user checks, search, web browser QA. Chitchat installed. No credits and no file uploads: agent chat answers 402 and Copy of a file fails with "Insufficient funds" (seen 2026-10-18). Empty Video Player account `rd7nt1qt9segqprsarrwc7jnr58f9qkh` remains without file grants after its test uninstall. Its retained binding makes reinstall need service-account management. The QA Edge profile is **not** a member. |
| `qa-tmp-share/home` | `qa.perm.member` (owner) | reuse | Cross-org share checks. No plugin installations. Empty reusable Data Probe and GitHub Sources service accounts remain without file grants. |
| `f5-repro-org/home` | `qa.paid.owner` (owner) in a scratch browser | reuse | Checks that need a paid plan: uploads, images and videos, public pages with media, Save with credits. The owner account has a Pro plan (the plan is the acting account's, see the qa-data skill). Uploads, links, "Anyone on the web" and the Move door work, and no plugin runs were seen after uploads (2026-10-21). Root: `README.md`, `/public-image-qa`, and an archived restricted `f5-repro-0025`. |
| `personal/home` of each `qa.perm.*` account | that account | reuse | Almost empty. |
| `personal/home` (Ray) | QA Edge profile | reuse for QA folders only | Ray's main workspace. **Every upload here runs the image, pdf, video, and data-probe plugins**, so upload here only to test those plugins. Ray's own notes (`/tasks`, `/inbox`, `/todo.md`, `/README.md`) are read-only. |
| `personal/plugin-access-qa` | QA Edge profile | reuse | Plugin access settings; setup stays Owner only. Private GitHub Mount check is complete. The sample repo `raythurnvoid/bonobo-mounts-private-qa-20260929` stays private for reuse. Its test installation, copied files and token are removed; three runs and 18 API call records remain. Empty GitHub Sources account `rd7zqff8p0vvqc155ehk9n4s4x8fa15s` remains for reuse. Reinstall needs service-account management. Files still has only the automatic `/README.md`. |
| `sybill-demo/demo` | QA Edge profile | read-only | Large realistic import: `/people` (about 9,700 files), `/companies` (1,000+ in one folder), `/emails`, `/meetings`, `/email-attachments` (Office files). About 10 GB stored. Use it for load, paging, and search on big data. |
| `sybill-demo/home` | QA Edge profile | reuse | Empty. |

Installed plugin source trees live in `GLOBAL`/`PLUGINS`. Plugin-owned Mounts belong to their installation's workspace. The required app system source stays at `/.mounts/t3-chat` in `GLOBAL`/`GITHUB`, with daily system sync and normal chat read checks. These trees are read-only data.

## Accounts

| User id | Who | Notes |
| --- | --- | --- |
| `m577heygr826f2wgk6r30mk1vd8928q2` | Ray's own account. The QA Edge profile is signed in as it. | Never sign it out. |
| `m575qvj9kyabtdn9jef1dgw0js8ck2dq` | `qa.perm.owner` | Owns `qa-browser`. |
| `m572b1a4snqa1en3qqp1gfwwnn8cjxya` | `qa.perm.admin` | Personal org only. |
| `m57f7hajv2kgw3rxfnv9z4bagh8ckq06` | `qa.perm.member` | Owns `qa-tmp-share`, member of `chitchat-qa` and `qa-browser` (seen 2026-10-11). |
| `m572qhnpq7xw34askfcy6w97h18ck1f8` | `qa.perm.viewer` | `member` role in `qa-browser`. |
| `m570f2kgg8jq3qka7snprkpeks8cme94` | `ray-test-1+clerk_test@gmail.com` (2026-08-17) | Member of `chitchat-qa`, with credits. The second user for agent chat checks (see `clerk-test-accounts.md`). Not a member of `qa-browser`: a share there needs an invite first. |
| `m5754ckhv5yrt02vjf1dt2v4hd8cjsy4` | `import-qa-member` | Deleted: its `users` doc has `deletedAt` (seen 2026-10-21). |
| `m5774tmwzz27knb7mwbzjbn9t58gn6fx` | `qa.paid.owner` | Owns `f5-repro-org`. Seeded Pro plan (balance 11000 on 2026-10-21). The account for uploads and other paid checks. Also has its own `personal/home`. |
| 6 anonymous members | Old second-user runs | 2 in `qa-browser`, 4 in `chitchat-qa`. Their tokens are gone, so nobody can sign in as them. |
| 113 other anonymous users | Old headless runs | Each has only its own personal org. Not useful for tests. |

Sign-in steps for the `qa.perm.*` accounts are in
[clerk-test-accounts.md](../../app-playwriter-harness/references/clerk-test-accounts.md).

## What Do You Need?

### Text files

| Need | Use |
| --- | --- |
| Markdown, collaboration on | `chitchat-qa/xfer-qa-0914:/u18/dest.md`, `chitchat-qa/copy-qa-0922:/README.md`, `personal/home:/documents/notes.md` |
| Saved Bash text output | `chitchat-qa/xfer-qa-0914:/u18/file-type-private.md` (21 bytes, `File type private QA` plus a final newline). Despite its name, this file is saved and has no pending changes. Use it for stored-type and public read checks. |
| Saved plain text for type search | `chitchat-qa/xfer-qa-0914:/u18/type-find-private.txt` (14 bytes, `MIME index QA` plus a final newline; `text/plain;charset=utf-8`). It is saved and has no pending changes. Use it for indexed type search and public text/byte reads. |
| Markdown update with a code block | `chitchat-qa/xfer-qa-0914:/press-api-upload-qa/markdown-update-repro.md`. A `files/write-many` update over it used to add an empty line before the closing code fence. Fixed and checked live on 2026-10-21. Reuse it to check that code blocks keep their text through an update. |
| Small Markdown from root-create checks | `chitchat-qa/home:/new-file.md`, `/new-file-1.md` through `/new-file-15.md`. Each has the initial Welcome text and collaboration on. Reuse them for editor and rename checks. |
| File/folder module timing | In `chitchat-qa/home`, root paths `creation-perf-file_only-{folder_current,file_only}-01` through `-05`, and `creation-perf-{combined,combined_repeat}-{folder_current,folder_combined,file_combined}-01` through `-05`. The three file variants end in `.md`; all 15 have collaboration on. The 25 folders are empty. `/new-folder` is the real sidebar check. All 41 nodes passed exact id, path, parent, kind, and stored-type readback. Reuse these for read and editor checks. |
| Final creation transaction timing | In `chitchat-qa/home`, root paths `final-create-perf-20261004-{file_current,file_split,folder_current,folder_split}-1` through `-7`. The file paths end in `.md` and have the initial Welcome text with collaboration on. The 14 folders are empty. All 28 passed exact id, path, parent, kind, and stored-type readback. `/new-file-15.md` is the sidebar check of the temporary action and its lean final transaction (both removed since). |
| Files action timing | In `chitchat-qa/home`, `/qa-profile-20261005-file-a.md` and `-file-b.md` have Welcome text and collaboration on. `/qa-profile-20261005-folder-a` holds a Welcome file `qa-profile-20261005-file-a.md` and a later `new-folder` (seen 2026-10-20). It was used for the agent delete lock check, and its write rules are restored; `-folder-b` has no active children. Names, text, metadata, link and write rules are restored. A retains 15 active snapshots; B's old edit history was removed during the collaboration-off check. Reuse root `/new-file-16.md` through `/new-file-36.md` and empty `/new-folder-1` through `/new-folder-13`. New copy and upload outputs are archived. The October 8 refresh restored the original fixtures and archived all 43 new creation outputs, including `creation-profile-20261008-*`. See [the replay guide](../../app-playwriter-harness/references/files-profiling.md). |
| Small Files permission check | `qa-browser/home:/qa-search-0905/tasks/public-task.md` and `/qa-search-0905/private/secret-task.md`. Saved API text is 52 bytes; the Yjs rich-text read is 53 bytes with final LF. The private folder stays restricted. Use the [scheduled Files recipe](../../app-playwriter-harness/references/plugin-backend-execution.md#scheduled-permission-checks) and restore shares after testing. |
| Markdown, collaboration off | `personal/home:/qa/qa-noncollab/notes.md`, `chitchat-qa/xfer-qa-0914:/u23p/my-file.md` (and the rest of `/u23p`) |
| Long Markdown (scrolling) | `chitchat-qa/home:/qa-long-scroll.md` (about 50 KB). Read-only 97 KB files: `chitchat-qa/home:/chitchat-ad04c6c85ea7daf62a10960d/qa-rollover-1012299.md` |
| Markdown with frontmatter | `personal/home:/frontmatter-demo.md` |
| Markdown over 128 KB | `personal/home:/emails/qa-mail-big-email-2026-10-19.md` (220,514 bytes uploaded, 2026-10-19). An email-shaped file for the Mail page reader (Gmail plugin); it ends with `END-OF-BIG-EMAIL-MARKER`. Reuse it for any whole-file read over 128 KB. |
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
| Images on public link pages ("Anyone on the web") | `f5-repro-org/home:/public-image-qa`: `page.md` embeds `assets/shapes.png` (14,602 bytes); the restricted `private/` holds `secret.png` and `private-page.md`, which embeds both images. Everything is not public, with no links and no grants (2026-10-21). Turn on a link and "Anyone on the web" for a check, then turn both off again. |
| WebP | `personal/home:/tmp/generated/image-76eae624-5365-43b6-85ae-fc8a9030ee37.webp` |
| MP4 video | `chitchat-qa/xfer-qa-0914:/g4-media/speakers.mp4`, `personal/home:/assets/pasted-video-20260808-235459.mp4` |
| Video with transcript and summary | `personal/home:/speakers-activity-e2e.mp4` with `.transcript.md` and `.summary.md` (9 such sets at the root) |
| Audio | `personal/home:/meetings/15f1649a-d06c-4af3-be03-c5255c9180de/recording-audio.m4a` (read-only); two `.webm` files in `personal/home:/meetings/a610f275-3582-4c51-957f-4d37d1a9212b/` |
| Word, Excel, PowerPoint, CSV, XLS | `sybill-demo/demo:/email-attachments/` (35 docx, 10 xlsx, 6 pptx, 10 csv, 2 xls). Read-only. |
| Mixed small upload from a PC | `chitchat-qa/xfer-qa-0914:/press-api-upload-qa/upload-sample` (2026-10-21): `notes.md`, `readme.txt`, `data.json`, `table.csv`, `nested/config.yaml`, `shapes.png`, `added-later.md`. Sent by the `press-api` skill helper `upload`. Text files are editable, the YAML is `application/yaml`. Reuse it for public API list, read, and download checks. The saved helper key `press-api-skill-qa` (list, read, download, write) is for this workspace. |
| Binary or no extension | `personal/home:/binary-qa-20260920-1546/empty` (0 B), `/binary-qa-20260920-1546/nested/opaque` |
| Shared upload price | `chitchat-qa/home:/upload-rule-qa/upload-small.bin` (8 B, one cent) and `/upload-rule-qa/upload-20mib-plus-one.bin` (20,971,521 B, two cents). Both settled through the normal R2 event on 2026-10-03. Reuse these files for reads; upload again only when checking publication. |
| Exact 50 MiB upload price | `chitchat-qa/home:/upload-rule-qa/upload-50mib.bin` (52,428,800 B, three cents). The normal R2 event settled it on 2026-10-04. Replaying settlement kept the same asset, quota and single sandbox event. Reuse for reads; it was sent as a browser File through the Files sidebar input because the tool's native transfer limit is 50 MB. |

### Folders

| Need | Use |
| --- | --- |
| Folder with about 60 files | `chitchat-qa/xfer-qa-0914:/g4-many`, `/u62-mu2qzdr5/src` |
| Folder with about 25 files | `chitchat-qa/xfer-qa-0914:/u16`, `/u16-q`, `/u42-other2` |
| Public-link checks (31 archived nodes) | `chitchat-qa/xfer-qa-0914:/share-link-qa` and `/share-link-perf`. Saved rich text, plain text, binary files, unsafe-input cases, layouts and parser limits. Both roots and all children are archived. All nine task links are Off, and both task API keys are revoked. Checked 2026-10-01. Restore through Files before reuse, then create fresh links. |
| Very big folder (read-only) | `sybill-demo/demo:/people` (about 9,700), `/companies` (1,000+). A three-file sample on 2026-09-29 had readable string `metadata.source` values. Check the current folder catalog before choosing other fields. |
| Big archive fixture (1,311 nodes) | `qa-browser/home`: `/protection-bulk-qa` (532 nodes, restricted, `qa.perm.viewer` has manage) plus the root folders `/copy-2` (104), `/copy-3` (208), `/copy-4` (416) and `/seed` (51). All active since 2026-09-25. Archive all five in one `archive_nodes` call to get one 1,311-node archive job, then restore that one operation. `/seed` alone is a job too, because the Archive request stamps only the named items (since 2026-10-21). For an archive that finishes in the request, use the empty `/seed/f00` (0 active children). Empty archived `/seed` folders are left over from clash checks. The archived `/seed/f00/seed` (one operation, 3 nodes) holds `f00/r3-moved-0925.md`, a small text file with real text chunks, for checks that archived side docs follow a moved folder and for search polling during a job. Two empty archived folders, `/protection-bulk-qa/a3-inserted-during-archive-0925` and `/protection-bulk-qa/a3-inserted-during-apply-0925`, are left over from checks that a folder inserted during a job joins its operation. Build new big fixtures inside `/protection-bulk-qa`. Two different folders named `viewer-read-only` are shared with `qa.perm.viewer` (`v971ta77dma6j3yxk5aj1618v18f041e` inside `/protection-bulk-qa`, and `v972dhgcfhnyr2crs2etkw5aph8f0c6f` under parent `v9766dxq6xpfd7yhz8nafzqwfx8f01nw`), so the viewer's "Shared with you" group shows two rows with that name. This is expected, not a duplicate (checked 2026-10-11). |
| Deep path (22 levels) | `chitchat-qa/xfer-qa-0914:/g4-u15/d01/…/d20/keeper.txt` |
| Restore path boundary | `chitchat-qa/home:/restore-path-boundary` has ten empty folders, all archived together. Restore the root before reuse. Three nested names have 255 characters each. The deepest name has 228. The original child under `/p/z` has a path length of 1,023. The other deepest folder is under `/incoming`; `/p/y` is the empty name-clash target. Use Move Replace, then parent Archive and Restore Keep both to grow the separately archived child's path to 1,025. Restore must refuse it. Shorten the parent before restoring the child. All allowances are absent. Root ID `v97c81sdr17f1q1mxpjry5qq8h8g5wy4`; child ID `v9768xqx7zg2yq2jpn7hpz5ers8g4qa1`. Reuse these folders. |
| Many small subfolders | `chitchat-qa/xfer-qa-0914:/u55/c0` … `c22`, each with `sibling.md` |
| Move and copy sources and targets | `personal/home:/demo` (`mv-src.md`, `mv-target.md`, `cp-target.md`, `/archive`), `personal/home:/tests` (`eval-*` files and folders) |
| Search: public and private | `qa-browser/home:/qa-search-0905` (`tasks/public-task.md`, `private/secret-task.md`, `v1.2/`). On 2026-09-29, the root and its three child folders were active. The private child was restricted, with no grants on it or the root. |
| Folder table sorts and columns | `qa-browser/home:/qa-sort-0924` has 58 files and three folders; one child is restricted. Six rows have `metadata.rank`, and 55 lack it. All Updated values tie; Created values are unique. Neither the root nor the restricted child has grants. `/qa-sort-0924-r` is a separate restricted root with three files. It keeps one user read grant to `qa.perm.viewer`, who still has an active membership and the `member` role. After array-sort QA on 2026-09-29, both roots and all 61 + 3 children are archived again, with no saved-sort docs and unchanged ids, parents, paths and grants. Restore through normal Files doors before reuse, then archive again. On 2026-10-20 `/qa-sort-0924` was found active (not archived) and was left active after the archive and restore timing checks of 2026-10-21. |
| More than 200 restricted children | `qa-browser/home:/qa-cap-0924` is archived with 203 archived restricted child folders. The root and every child have no grants. Checked 2026-09-29. Reuse this fixture for the shared-row cap instead of creating another large set. |
| Agent skills folder | `personal/home:/.agents/skills/meeting-brief`, `personal/home:/.agents/skills/press-api` (app copy of the repo skill, written with text writes) |
| Bash agent eval fixture | `personal/home:/bash-eval-smoothness-fixture-2026-07-25-a` ([bash-tool-agent-eval.md](../../app-playwriter-harness/references/bash-tool-agent-eval.md)). Archived on 2026-10-18 by another task: the folder shows "This folder is archived" and lists no files. Restore it before you use it. For file open timing, `personal/home:/documents` has three Markdown files with text. |
| Browser downloads | `personal/home:/.system/downloads`, `personal/home:/tmp/browser` |

### Write rules and shares

| Need | Use |
| --- | --- |
| Read-only file | `personal/home:/aaa-closing-qa-mu6ygix9.md`, `/aaa-closing-qa-dest-mu6ynzn5/aaa-closing-qa-mu6ygix9.md` |
| File with a user writer | `chitchat-qa/xfer-qa-0914:/u18/dest.md` |
| Folder a plugin service owns | `qa-browser/home:/chitchat`, `chitchat-qa/home:/chitchat-2eff489e` (read-only for tests) |
| Restricted (shared) scope roots | `chitchat-qa/xfer-qa-0914:/u34-dst-a/u34a/sub`, `/u34-dst-b/u34b/sub`, `/g4-media/speakers.mp4`, `/g4-media/shapes.png` |
| Move path error below a locked folder | Archived: `qa-browser/home:/c2-move-limit` (`v975tb2hs4e1dn2zh78pc3ekg98ghawa`), empty folders with a locked child and a 785-character leaf path. Archived destination `v9779mbbm27n9tmcqgjt0bf4fh8gge4d` has a 255-character name; moving into it would make the leaf path 1,041 characters. Owner can open the child; viewer cannot. Both roots share one archive operation; restore them for reuse. One copied empty folder is inside the source. |

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

Human Messages checks reuse public channel `channels-qa` in `chitchat-qa/home`. It has a short root
and reply from the phase 1 backend check. Continue this channel for Messages UI checks.

Public `channels-page-qa` in the same workspace has 51 short plain messages, `Page check 1` through
`Page check 51`. Reuse it for the 50-message head and Load older checks. The existing paid QA
viewer can read it. Its channel id is `ts7qvkrkvmp8zs3y5nnqmmre7d8fjxaw`.

Public `channels-qa` has upload roots `v97rmx9836ygkwdx3rbpvsxxdx8fkptd` (8-byte binary) and
`v97vxsrhxk55b77g1da2250tm98fj3t2` (shapes.png and speakers.mp4). The binary's normal Files copy
is `/upload-small.bin`. Its temporary `thread-drop.bin` reply was deleted and its asset cleaned.
An unattached `paste-check.bin` has its normal 24-hour deadline; do not reuse it after expiry.

Root `v97h20zabbfd418wt1tpjehne58fmapp` in `channels-qa` has `Phase five native message`.
The native composer mentioned `qa.perm.viewer` and `/r2-upload-sample.pdf`. Reuse it for inbox
and search checks. The matching general PDF comment below uses the same mention primitive.

Root `v97jwwep6mbq0hrnpv0r91yagd8fnkyv` in the same paid public channel has
`Phase five attachment search`. It attaches the existing `/upload-small.bin` file and is by the
QA viewer. Reuse it for author, attachment and October 4 UTC date filters. It made no new upload.

Private `channels-upload-private-qa` in `chitchat-qa/home` is owner-only. It has one 8-byte upload
root `v97sj5r0ryz5bhgqxqb7txn1ch8fk53r`. The existing `qa.perm.viewer` account is also a member
of this paid workspace. It was added to and then removed from this private channel for access QA.
Reuse that account for paid upload read checks; it has no private channel access.

Two-account channel checks reuse `qa-browser/home`: public `channels-qa`, private
`channels-private-qa`, private `channels-owner-private-qa`, and the direct conversation between
`qa.perm.owner` and `qa.perm.viewer`. The viewer-named account is currently a workspace member.
The owner-private channel has native mention root `v97m6k6n5a24vt1b75vj4gvzyh8fmvd7`, with
`Phase five access search`, and broadcast reply `v97zcp06kgbwdxnpgk8g3e2gfn8fnhxs`. Viewer root
`v97m062qwz76q747vdztxrrz118fmxwj` has inline reply `v97mr4yy6zxcnnx42xb7mnp3rd8fntbt`.
Both accounts are members again; the owner is manager, the viewer is member with All notifications.
The viewer read these items. Reuse them for search, Activity, Threads and live access-loss checks.

UI checks also reuse public `channels-ui-qa` and private `channels-ui-private-qa` in that workspace.
The private channel allows resolve and has `Private UI title`, replies, a reaction, and a people
mention. Both QA accounts are members. The direct picker reuses the existing conversation.
The owner also joined the public UI channel. `qa.perm.member` is a workspace viewer here for
later non-participant checks.

Channel agent checks reuse chat `n178qh29w0n8sk7yjxjfky7d8n8fjnd8` in `chitchat-qa/home`.
Its Bash calls list channels and members, then read the saved root and reply in a UTC date range.
Its saved search turn checks author, attachments, UTC dates, text/JSON output, an exact Next page
command, `--workspace home`, and refusal of a foreign workspace URL. It used the real paid agent.

Public AI output reads reuse chat `n174yyeysbxqbzk9szcv77pz3x8g9281` in
`chitchat-qa/metadata-qa-0906`, owned by the QA Edge account. These existing outputs are ready
and have committed owners. Read their current `byteCount` and `sha256` before a check.

| Output id | Bytes | Use |
| --- | --- | --- |
| `ss7np2epc86qsdwm2t4c27pcwx8g84qs` | 65,696 | ASCII text. A 65,536-byte page leaves a second page of 160 bytes. |
| `ss7rkcp9pawte3wwk1f0kesxks8g9j2f` | 33,380 | Unicode text. A four-byte character starts at byte 33,311. Test offsets 33,311 through 33,314 with limit 4. |

Both passed complete public API reads with matching stored hashes on 2026-10-20.
Reuse them without sending another model request. Keep their content and ownership unchanged.

File comments reuse these saved files and roots. Open them in Files or Messages:

| File | Channel | Root | State |
| --- | --- | --- | --- |
| `qa-browser/home:/two-roots-qa-0921.txt` | `ts7zw3nfjr34thgt4mhz440mt98fk8q2` | `v97x2csrr5z067d4jwcph8r3zn8fjv0e` | General comment, one reply, resolved. Both QA accounts can read it. |
| `qa-browser/home:/two-roots-qa-0921.txt` | `ts7zw3nfjr34thgt4mhz440mt98fk8q2` | `v97p6fm4q6xe39y9vgrgejp7dx8fkvyh` | Closed tab check, open. Verified the unread badge and New marker in Code view. |
| `chitchat-qa/home:/r2-upload-sample.pdf` | `ts7wvnhvhnm0s4z86krf8jnta18fjd0x` | `v97xsqbsgnd1xd6vqgqqrbxwnd8fjbb8` | General PDF comment, open. |
| `chitchat-qa/home:/r2-upload-sample.pdf` | `ts7wvnhvhnm0s4z86krf8jnta18fjd0x` | `v97smz0hrfwmxsan9kkwven7bn8fk6xe` | Attachment-only comment with comment-paste.bin and comment-drop.bin, both 8 B. File access was restored to unrestricted, with no grants, public link or plugin binding. |
| `chitchat-qa/home:/r2-upload-sample.pdf` | `ts7wvnhvhnm0s4z86krf8jnta18fjd0x` | `v97xqsefpvggk9txp6pj6zdh0d8fmp75` | General comment with `Phase five native comment`. Native people and file mentions match the Messages fixture above. |
| `chitchat-qa/home:/upload-small.bin` | `ts7meayx1tx53k8apay3hecz2h8fng4e` | `v97gyfp8ga9pcbyyqxq48w90n98fnf3r`, `v97hwetp4tanme9eqtg8nm5yjx8fnasf` | Two first comments sent from two tabs. Both use this one file channel, with main sequences 1 and 2. The original 8-byte file is unchanged. |
| `personal/home:/qa/qa-noncollab/notes.md` | `ts7j6hbckx8vp8g6ae8hqr5kvd8fk0k7` | `v97vwh25wjkggr985jr5mfqnvd8fj6d7` | Saved mark on `Non collaborative`, open. |
| `personal/home:/documents/notes.md` | `ts7hpnwgb4j4m4a10t4j7y0vs98fj626` | `v97h3temt3e1kayr4p44np78jn8fkn77` | Saved collaborative mark on `MOVE-MARKER-4411`, open. |
| `personal/home:/documents/notes.md` | `ts7hpnwgb4j4m4a10t4j7y0vs98fj626` | `v97v7x28vby3kp4r4xp938tsgd8fk0v3` | Saved overlapping mark on `MOVE-MARKER-4411`, open. Public head stayed 1 while confirmation waited, then became 2. |
| `personal/home:/aaa-closing-qa-dest-mu6ynzn5/aaa-closing-qa-mu6ygix9.md` | `ts7qb663jk5y1myk2yn5v4nq0h8fk3k5` | `v97mek727ht4rfqhr3jk937kh98fkx5j` | General comment, resolved. The file stays read-only and its saved text stayed unchanged. |
| `qa-browser/home:/chitchat/general.md` | `ts7wtgbxq25qmthesbe4kr6ses8fjv35` | `v97hf5tv517vzbc1p2jgn0negn8fkwxv` | General comment quotes `general`, with `READONLY-QUOTE-COMMENT-Q1`. The quote and file link survived reload. The editor stays read-only. |

`qa-browser/home:/qa-search-0905/tasks/public-task.md` has an empty file channel
`ts7tf4pt69pnbm53ewrr43aae18fkpea`. Its failed anchor was discarded after the free account's
content save was refused. Reuse that file for save-refusal checks; do not count it as a saved anchor.

Public `channels-qa` in `qa-browser/home` has root `v97jpw71ze1ze0rvs8v8a7mzcx8fjakt`.
It quotes and mentions `/two-roots-qa-0921.txt`. The supported API sent this root. Restricting the
file hid its id, name, path and link from the other account, while keeping the selected text.
The file's original unrestricted scope and empty grant list were restored.

`personal/home` already has about 410 chats. For an agent check where chat history does not
matter, continue a chat you already made for the same task instead of starting a new one.

Reuse `QA paged message edit` in `chitchat-qa/home` (`n175v5tanrcx2363yz4478h0w58fn2nc`) for loading older history and editing or retrying messages more than 50 nodes behind the leaf. It has two long branches with 56 and 58 short fixture nodes.

Reuse `Move Folder QA Check` in `chitchat-qa/home` (`n1708nc8w74tp1gne8n8jxa7r98gcg8k`) for agent folder Move checks. Its pending rename was discarded. The saved empty folder remains at `/qa-profile-20261005-folder-a/new-folder`, with no metadata or pending changes.

Reuse `QA native-popovers mount 0928` in `personal/home` (`n17e1df2cqn1p6m8kkac9nq8d58f8674`) for this Mount's Bash checks. The saved first turn lists the Mount and reads its README without changing files.

Use saved chat `n174jx56n9dhr2eahg93prek198fba90` in `personal/home` as evidence for natural Mount discovery and later web search. It used GPT-6 Luna in Agent mode. Its first turn had no chat history or supplied path. Stored Bash calls read the README and `AGENTS.md`; the next turn used web search.

Reuse `personal/plugin-access-qa` chat `n17a115vdg1jsty4ey0r4v6vrx8fbv27` for private Mount checks. It read both sample files exactly, 148 bytes in total. After uninstall, the same read in the same shell failed with `No such file or directory`; `/.mounts/t3-chat/README.md` still read successfully.

Reuse `qa-browser/home` chat `n1708wzk8n9hnt2r9qm87jd1118f9g6z` as `qa.perm.owner` for
Mount isolation checks. Its saved Bash call found both plugin Mount paths absent.
Only the original Chitchat installation was present.

## Change Log

- 2026-10-16: saved one 14-byte plain text fixture after pending-aware type search checks. Public text and byte reads passed after Save. The test replacement of `/u18/dest.md` and move of `/u03` were discarded; original IDs, paths, types, assets and text are restored. No pending changes from this QA run remain. No new tenant or user.
- 2026-10-15: added one 21-byte Markdown file through Bash and Files Save. It was hidden from public reads while private, then readable after Save. Existing `/u18/dest.md` passed pending replacement, rename and delete checks; all three proposals were discarded and its saved content stayed unchanged. No new tenant or user.
- 2026-10-05: added reusable small Files action fixtures and 34 root creation fixtures. Native drag, Cut/Paste, rename, archive and text checks restored the baseline paths and content. All 92 recorded temporary copy/upload output nodes are archived, including three evening retry outputs. Bulk Copy had six partial failures in seven initial runs and failed in all three fresh retries. Sources are unchanged. No new tenant or user.
- 2026-10-04: checked the real agent search in its existing chat. Added two first comments on the existing binary file and one exact 50 MiB upload-price fixture. The upload charged three cents once; settlement replay changed nothing. No new tenant or user.
- 2026-10-04: added native private search, broadcast and inline-reply fixtures, and an existing-file attachment search root. Restored private membership and notification settings. No new tenant, user or upload.
- 2026-10-04: added one native Messages mention and one matching PDF comment. Both mention the existing QA viewer and PDF. No new tenant, user or file.
- 2026-10-04: added upload roots, one paid private channel, and two PDF comment uploads. Invited the existing QA viewer into the paid workspace. The file access check is restored; the temporary upload reply and its asset are removed. No new tenant or user.
- 2026-10-03: added two binary upload-price fixtures in `chitchat-qa/home`. An oversized test placeholder was removed by normal upload cleanup. No new tenant or user.
- 2026-10-03: added the saved read-only quote comment and public quote access fixture. The file restriction used for the access check is restored.
- 2026-10-03: added the reusable `channels-qa` human channel in `chitchat-qa/home`. No new tenant or user.
- 2026-10-03: added four reusable channels in `qa-browser/home` for two-account access and Messages checks.
- 2026-10-03: added two channels through the Messages UI in the same workspace. Reuse them for UI checks.
- 2026-10-03: added file-channel comments on the existing plain text, PDF and rich text fixtures above.

- 2026-09-24: first catalog from a full refresh.
- 2026-09-28: Data Probe 0.3.0 (MCP fixture) installed in `chitchat-qa/copy-qa-0922`.
- 2026-09-28: added `personal/plugin-access-qa` for plugin access settings. Keep it at Owner only after checks.
- 2026-09-28: added the native-popovers Mount and its saved read-only QA chat in `personal/home`.
- 2026-09-28: reused the two saved Files permission fixtures. Original files, shares, roles, policy and Chitchat installation are restored. Temporary Data Probe is uninstalled; its empty service account remains without grants.
- 2026-09-28: added the QA owner's reusable no-plugin Mount isolation chat in `qa-browser/home`.
- 2026-09-28: install-access check restored the original setup, policy, roles, accounts and Chitchat. Video Player is uninstalled; its empty account and binding remain.
- 2026-09-29: checked the search, folder-sort and 203-child cap fixtures, their archive state and grants, and both QA memberships. Sampled three readable `metadata.source` values in `/people`; changed no live data.
- 2026-09-29: reused both folder-sort fixtures for owner saves and reader local arrays. Reset to Name, removed saved-sort docs, and archived both roots and all 64 children again. Exact ids, parents, paths and grants match the backup. The 203-child cap fixture stayed archived and untouched.
- 2026-09-29: both Mounts test copies and their QA policy entry are removed. All five runs and 29 API call records remain. The empty GitHub Sources account stays for reuse.
- 2026-09-29: added the private GitHub fixture in `personal/plugin-access-qa`. Settings and self-grant survived reload. The main native-popovers Mount stayed fixed.
- 2026-09-29: private sync and exact two-file agent read passed. Test installation, copies, workspace secret and repo-only token are removed. Three runs and 18 API call records remain, with no history expiry, run tokens or temporary state. Added the saved private QA chat; the required app system source still reads after cleanup.
- 2026-10-01: archived all 31 public-link QA and performance nodes. Exact ids, parents, paths, owners and assets match the cleanup backup. All nine links are Off; both task keys return 401. Reused media and text fixtures are restored. Scratch accounts are signed out and their Chrome processes are closed. Local scratch-folder removal was blocked by automatic approval review; those folders remain outside the repo.
- 2026-10-04: added 15 small root Markdown files in `chitchat-qa/home` for creation timing. Five use the temporary split action. All loaded their Welcome text; the ten comparison files also passed a node id, path, parent, and stored text-kind readback.
- 2026-10-04: added 15 small Markdown files and 26 empty folders in `chitchat-qa/home` to compare the combined creation module. One batch had HMR and was repeated. Every node passed authenticated readback; the sidebar folder check used the temporary mutation and focused rename.
- 2026-10-04: added a reusable chat with 56- and 58-node branches. Older edits, failed sends, Retry, branch counts, and saved replies passed Playwriter checks.
- 2026-10-04: reused `/qa-sort-0924` as `qa.perm.owner` for the missing-metadata pages check. Restoring brought back both roots (one archive operation). One no-metadata file got `rank: "3"` and then empty metadata again. Both roots and all 64 children are archived again; ids, parents, paths, kinds, updaters and the one grant match the backup. Only `updatedAt` changed. No saved-sort docs.
- 2026-10-08: refreshed creation, root loading, folder expansion, and saved search timings in `chitchat-qa/home`. Original paths, canonical text, empty metadata, and the one-child folder are restored. All 43 new file/folder outputs are archived. Download stays deferred.
- 2026-10-09: checked New file snapshot preload in `chitchat-qa/home` with seven alternating off/on pairs, controlled access and fetch checks, protected sidebar modal, other views and navigation. All 35 new files and one new folder are archived. The owned folder default and child rule are restored. Original file A/B, README, folder A and its child passed final readback. No new active fixture remains. Download stays deferred.
- 2026-10-10: metadata catalog load gate in `chitchat-qa/metadata-qa-0906`. It wrote 225 small Markdown files under `/qa-load-catalog-2026-10-10` through `/api/v1/files/write-many`, then archived the whole folder through `files_nodes.archive_nodes`. The two task API keys are revoked. Catalog audit: 0 differences before and after cleanup. No new tenant or user.
- 2026-10-11: scale-fix live checks and write-many load re-run in `chitchat-qa/metadata-qa-0906`. It wrote 3,247 small Markdown files and minted 21 unused upload URLs under `/qa-scale-fixes-live-2026-10-11`, then archived the whole folder through `files_nodes.archive_nodes` (0 refused). The two task API keys are revoked (verify 401). No new tenant or user.
- 2026-10-11: overwrite-fix check in `chitchat-qa/metadata-qa-0906`. It wrote 30 small Markdown files under `/qa-overwrite-fix-2026-10-11` through `/api/v1/files/write-many` (20 created, 3 full overwrites, one mixed batch), checked `download-urls` limits, then archived the whole folder through `files_nodes.archive_nodes`. The task API key is revoked (verify 401). No new tenant or user.
- 2026-10-11: list cursor check in `chitchat-qa/metadata-qa-0906`. It wrote 3 small Markdown files under `/qa-cursor-check-2026-10-11`, then checked that `/api/v1/files/list` answers 400 `errorCode: "invalid_cursor"` for an edited cursor and for an old cursor after a Rename. The Rename passed a full path, so it made a `qa-cursor-check-2026-10-11` subfolder (the `rename_node` path is relative to the parent). The whole folder is archived through `files_nodes.archive_nodes`. The task API key is revoked (verify 401). No new tenant or user.
- 2026-10-11: Gallery dead-cursor restart check in `personal/home`. It renamed the empty folder `/qa/qa-cmp-empty-0924` to `qa-cmp-empty-0924-r` and back, and read files with a list-only task API key (revoked, verify 401). No files were written. No new tenant or user.
- 2026-10-11: scale-fix browser checks. Data Probe 0.4.1 is published, approved in the `chitchat-qa` plugin policy, and the `chitchat-qa/copy-qa-0922` install runs it with config `case: idle` and the owner's run-as-me consent. The temporary Data Probe service account grants are removed. Fixture folders `copy-qa-0922:/qa-probe-files-read-1011` and `metadata-qa-0906:/qa-restricted-keys-1011` are archived. No new tenant or user.
- 2026-10-11: live guest check in `qa-browser/home`. One-off fixtures, all removed: restricted folder `/qa-guest-check-2026-10-11` with two empty Markdown files (key `qa_band_20261011`) and root file `/qa-open-20261011.md` (key `qa_open_20261011`) are archived; the folder's read share is removed. `ray-test-1` was invited with a temporary custom role `QA guest 2026-10-11` (only `workspace.mcp.use`, so no workspace read); the account is removed again and the role is deleted. Kept: one guest chat `n17btn1ffegakhyfw54ysbdq1n8g2tfh` ("QA billing outbox 2026-10-11") in `chitchat-qa/home` with one turn. Three anonymous users from the scratch browsers are soft-deleted. No new tenant.
- 2026-10-18: C2 live checks in `qa-browser/home` passed for locked rows, name sort, guest root filters, Shared, Copy skips and Move with locked children. The viewer's member role and `/protection-bulk-qa` metadata are restored; the temporary guest role is deleted. The eight new empty folders are archived under the two roots above. Three task-created anonymous users are deleted. No existing tenant or account was removed.
- 2026-10-18: locked-item text checks. In `qa-browser/home`, `qa.perm.viewer` saw "You don't have access to this file" on an embed of a locked file and "Skipped: Permission denied" for a locked folder in the Copy dialog. Roots `/c2-ui-1018` and `/c2-ui-1018-dest` are archived; the viewer keeps one chat whose only message failed with 402. In `chitchat-qa/home`, `ray-test-1` saw "You don't have access to this file." on a View image card; root `/c2-view-image-1018` (restricted by the owner) is archived, and the one-turn chat stays. Six task-created anonymous users are deleted.
- 2026-10-19: uploaded one 220 KB Markdown file, `/emails/qa-mail-big-email-2026-10-19.md` in `personal/home`, for the Mail plugin big-email read check. No real email in that mailbox was over 30 KB. No grant or other data was added.
- 2026-10-21: `press-api` helper checks. In `chitchat-qa/xfer-qa-0914`, uploaded the 7-file `/press-api-upload-qa/upload-sample` set and wrote `markdown-update-repro.md`; the key `press-api-skill-qa` stays saved on Ray's PC. In `personal/home`, updated `/.agents/skills/press-api` with text writes only (no uploads); the install key is revoked (verify 401). No new tenant or user.
- 2026-10-20/21: archive and restore timing checks in `qa-browser/home` as the owner. `/copy-2`, `/copy-4` and `/qa-sort-0924` were archived and restored many times; each ends active with the same ids and paths. `/qa-sort-0924/j.json` got 9 metadata keys for a few minutes and then empty metadata again. No new file, tenant or user.
- 2026-10-21: archive-request timing (named items only) in `qa-browser/home` as the owner. `/qa-search-0905/tasks` (1 child), `/copy-2`, `/qa-sort-0924` and the empty `/seed/f00` were archived and restored 6 times each; each ends active with the same ids, paths and child counts. No new file, tenant or user.
- 2026-10-21: Restrict timing checks in `qa-browser/home` as the owner. The first 200 folders of `/copy-4` got the metadata key `qa-restrict-1021: x` for about an hour, then empty metadata again. `/copy-4` was restricted and unrestricted many times and ends open, with no grants and no links. Two catalog `check` rebuilds ran and were cleared. No new file, tenant or user.
- 2026-10-20: verified two existing AI tool outputs through the public API in `chitchat-qa/metadata-qa-0906`. Complete hashes, paging, four-byte text, EOF, range refusals, scope refusals, and revocation passed. Both temporary keys are revoked. No chat, output, or file was created or changed.
- 2026-10-21: "Anyone on the web" QA as `qa.paid.owner` in `f5-repro-org/home`. Added the `/public-image-qa` fixture (two folders, two PNG uploads, two Markdown pages) and kept it for reruns. All links and public switches are off again. Recorded `qa.paid.owner` and its Pro workspace; `qa-browser` still refuses uploads. An earlier run that day left the empty folders `qa-browser/home:/public-image-qa`, `/assets` and `/private` (not public, not restricted, no links). Three task-created anonymous users are deleted.
