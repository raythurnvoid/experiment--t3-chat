# Dev Test Data Catalog

Deployment: `dev:grand-finch-267`. Last refresh: 2026-09-24, with the recipe in
[../SKILL.md](../SKILL.md#refresh-the-catalog). It counted about 9,300 live files and folders in
real workspaces (archived files not counted).

Selective cleanup began on 2026-10-28 and passed two complete cleanup reads on 2026-10-29.
`qa-browser/home` and `f5-repro-org/home` were erased. Their entries below are historical,
not live fixtures. The owner's `personal`, `chitchat-qa`, and `sybill-demo` workspaces were kept.
`qa-tmp-share/home` was also kept. All Clerk accounts, auth and billing links were preserved,
along with four anonymous members of kept workspaces and their data. Read kept fixture state
before changing it; this cleanup check was not a fresh content catalog. Native Read-only owner,
recovery, bulk, Copy and Restore checks ran on 2026-10-29. See the exact checks and remaining
gaps in [Files QA](../../app-playwriter-harness/references/files.md#file-and-folder-read-only).

The separate Messages reset on 2026-10-29 erased all old human Messages channels, messages,
file comments and related state. It also removed current document comment marks. Ordinary Files,
saved file copies, file history and AI chats were preserved. Use the new Messages fixtures below;
older channel and comment IDs in saved AI chat output are stale.

Paths are written `org/workspace:/path`. The Files route for a workspace is
`/w/<org>/<workspace>/files`.

Keep this file current. When you add a reusable file, add it to the right table. When you find a
row that is wrong, fix it. Add one line to the change log at the end.

## Workspaces

`reuse` means you may open, edit, move, copy, share, and comment on the files there. `read-only`
means look but do not change anything.

| Workspace | Reached by | Policy | Use it for |
| --- | --- | --- | --- |
| `chitchat-qa/xfer-qa-0914` | QA Edge profile (owner) | reuse | Files UI, editors, copy and move, tree, many files, deep folders, shares. The main place for new Files test data. Gallery is installed (2026-10-22). |
| `chitchat-qa/copy-qa-0922` | QA Edge profile | reuse | Copy checks. Almost empty. MCP and plugin-skill checks: Data Probe 0.3.0 is installed here with its `fixture` MCP server and `mcp-echo` skill, so every chat here gets the fixture tools. The `chitchat-qa` plugin policy allows `data-probe`. |
| `chitchat-qa/metadata-qa-0906` | QA Edge profile | reuse | Metadata checks. Chitchat and Council installed. |
| `chitchat-qa/home` | QA Edge profile; `qa.perm.member` is a member | reuse | Chitchat page and its transcript files. Its plan has no file uploads (seen 2026-10-18). Agent chat has credits; `qa.perm.member` cannot restrict here, only the owner can. Empty GitHub Sources service account `rd7tqp8qb5vkfa0jvnp8kgjj398fbctd` remains without grants after both test uninstalls. Reinstall needs permission to manage this account. |
| `qa-browser/home` | Former `qa.perm.owner` workspace | retired | Erased in the 2026-10-28 cleanup. Do not use its old files, grants, channels or plugin setup. |
| `qa-tmp-share/home` | `qa.perm.member` (owner) | reuse | Cross-org share checks. No plugin installations. Empty reusable Data Probe and GitHub Sources service accounts remain without file grants. |
| `f5-repro-org/home` | Former `qa.paid.owner` workspace | retired | Content erased in the 2026-10-28 cleanup. The account, its default home and billing links were preserved. Read current billing before a paid check. |
| `personal/home` of each `qa.perm.*` account | that account | reuse | Almost empty. |
| `personal/home` (owner) | QA Edge profile | reuse for QA folders only | The owner's main workspace. **Every upload here runs the image, pdf, video, and data-probe plugins**, so upload here only to test those plugins. The owner's own notes (`/tasks`, `/inbox`, `/todo.md`, `/README.md`) are read-only. |
| `personal/plugin-access-qa` | QA Edge profile | reuse | Plugin access settings; setup stays Owner only. Private GitHub Mount check is complete. The sample repo `bonobo-mounts-private-qa-20260929` (owned by the repo owner's GitHub account) stays private for reuse. Its test installation, copied files and token are removed; three runs and 18 API call records remain. Empty GitHub Sources account `rd7zqff8p0vvqc155ehk9n4s4x8fa15s` remains for reuse. Reinstall needs service-account management. Files still has only the automatic `/README.md`. |
| `sybill-demo/demo` | QA Edge profile | read-only | Large realistic import: `/people` (about 9,700 files), `/companies` (1,000+ in one folder), `/emails`, `/meetings`, `/email-attachments` (Office files). About 10 GB stored. Use it for load, paging, and search on big data. |
| `sybill-demo/home` | QA Edge profile | reuse | Empty. |

Installed plugin source trees live in `GLOBAL`/`PLUGINS`. Plugin-owned Mounts belong to their installation's workspace. The required app system source stays at `/.mounts/t3-chat` in `GLOBAL`/`GITHUB`, with daily system sync and normal chat read checks. These trees are read-only data.

## Accounts

| User id | Who | Notes |
| --- | --- | --- |
| (not written here) | The owner's main account. The QA Edge profile is signed in as it. | Never sign it out. |
| `m575qvj9kyabtdn9jef1dgw0js8ck2dq` | `qa.perm.owner` | Account and default home preserved. Former `qa-browser` owner; that workspace was erased. |
| `m572b1a4snqa1en3qqp1gfwwnn8cjxya` | `qa.perm.admin` | Personal org only. |
| `m57f7hajv2kgw3rxfnv9z4bagh8ckq06` | `qa.perm.member` | Owns kept `qa-tmp-share/home`. Member of kept `chitchat-qa/home` and `xfer-qa-0914`. Read current roles, grants and credits before a check. |
| `m572qhnpq7xw34askfcy6w97h18ck1f8` | `qa.perm.viewer` | Member of kept `chitchat-qa/home`. Read its current role; the account name does not define it. |
| `m570f2kgg8jq3qka7snprkpeks8cme94` | `ray-test-1+clerk_test@gmail.com` (2026-08-17) | Member of kept `chitchat-qa/home`. Read current billing and membership before agent chat checks (see `clerk-test-accounts.md`). |
| `m5754ckhv5yrt02vjf1dt2v4hd8cjsy4` | `import-qa-member` | Deleted: its `users` doc has `deletedAt` (seen 2026-10-21). |
| `m5774tmwzz27knb7mwbzjbn9t58gn6fx` | `qa.paid.owner` | Account, default `personal/home` and billing links preserved. Former `f5-repro-org` owner. Read its current plan and credits before paid checks. |
| 4 anonymous members | Kept-workspace members | Preserved with their private data and home workspaces. Do not delete them as old QA leftovers or assume their sign-in state. |
| Other approved anonymous accounts | Old headless runs | Tombstoned by the selective cleanup. They are not sign-in fixtures. |

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
| Small Files permission check | Retired: `qa-browser/home:/qa-search-0905`. No kept fixture is claimed to have the same grants. |
| Markdown, collaboration off | `personal/home:/qa/qa-noncollab/notes.md`, `chitchat-qa/xfer-qa-0914:/u23p/my-file.md` (and the rest of `/u23p`) |
| Long Markdown (scrolling) | `chitchat-qa/home:/qa-long-scroll.md` (about 50 KB, one 49,000-character paragraph of repeated filler words, so it is not realistic prose for token counts). Read-only 97 KB files: `chitchat-qa/home:/chitchat-ad04c6c85ea7daf62a10960d/qa-rollover-1012299.md` |
| Markdown with frontmatter | `personal/home:/frontmatter-demo.md` |
| Markdown over 128 KB | `personal/home:/emails/qa-mail-big-email-2026-10-19.md` (220,514 bytes uploaded, 2026-10-19). An email-shaped file for the Mail page reader (Gmail plugin); it ends with `END-OF-BIG-EMAIL-MARKER`. Reuse it for any whole-file read over 128 KB. |
| Medium Markdown with sections | `personal/home:/activity-ui-fixture.md` (about 1 KB) |
| Empty Markdown | `personal/home:/demo/mv-src.md`, `/demo/mv-target.md`, `/demo/cp-target.md` |
| `.txt` opened as rich text | `chitchat-qa/xfer-qa-0914:/g4-x/movable.txt`, `/g4-many/f00.txt` … `f59.txt` |
| Plain text (`plain_text` editor) | `chitchat-qa/xfer-qa-0914:/press-api-upload-qa/upload-sample/qa-plain.json` (106 bytes, collaboration on). `personal/home:/qa-plan1-1788804917720/qa-plain.txt` was not found on 2026-10-21. The old `qa-browser` alternate was erased. |
| HTML | `personal/home:/split-browser-click-check.html` (3 KB). Collaboration off: `personal/home:/qa-html-preview-1788973527253/qa-meeting-brief.html`. The old `qa-browser` alternate was erased. |
| HTML for shared browser restart checks | `chitchat-qa/xfer-qa-0914:/browser-persistence-demo` (2026-09-27): `01-stateful-app.html` (page age, click counter, random page id, input, checklist, long list, fake 3 s boot), `02-second-page.html`, `03-esm-chart.html` (loads d3 from esm.sh and shows the load time), `notes.txt`, `README.md`. A new page id means the cloud browser restarted. |
| JSON | `chitchat-qa/xfer-qa-0914:/press-api-upload-qa/upload-sample/qa-plain.json` (`personal/home:/qa-plain.json` was not found on 2026-10-21). Large (79 KB, read-only): `personal/home:/meetings/15f1649a-d06c-4af3-be03-c5255c9180de/provider-transcript.json` |

### Stored files (uploads)

| Need | Use |
| --- | --- |
| PDF | `personal/home:/documents/config-matched-document.pdf`, `chitchat-qa/home:/r2-upload-sample.pdf` |
| PDF with its generated `.pdf.md` | `personal/home:/documents/config-matched-document.pdf` and `.pdf.md` next to it; `/documents/pdf-converter-check.pdf` and `/documents/pdf-converter-check-2.pdf`, each with its `.pdf.md` (same 23,219-byte PDF) |
| PNG | `chitchat-qa/xfer-qa-0914:/u03/shapes.png`, `personal/home:/assets/` (13 pasted images) |
| PNG with its generated description | `personal/home:/images/config-matched-image.png` and `.description.md` |
| PNG over 20 MB (image plugin refusal) | `personal/home:/qa-size-limit/qa-size-limit-22mb-16bit.png` (22,123,638 bytes, 2048×1800, 16-bit). Image 0.3.5 and later refuse it before any secret read, file, or OpenAI call. Rerun it with `plugins:run_installation_on_files` instead of uploading again. Next to it, `qa-size-limit-21mb.png` was sent at 2700×2730, but the Files sidebar resized it to 14,061,901 bytes, so its `.description.md` comes from a normal run. Added 2026-10-22. |
| Images on public link pages (the public flag) | Retired: `f5-repro-org/home:/public-image-qa` was erased. No replacement image/grant setup is claimed. |
| Retained text draft after image replacement | Retired: `f5-repro-org/home:/public-image-qa/retained-draft.md` was erased. For simple non-collaborative recovery, use kept `chitchat-qa/xfer-qa-0914:/u23p/my-file.md` after reading its current state. Two-tab Read-only recovery and Copy text passed on 2026-10-29; saved text, metadata and flag were restored. This does not replace the old image-replacement fixture. |
| WebP | `personal/home:/tmp/generated/image-76eae624-5365-43b6-85ae-fc8a9030ee37.webp` |
| MP4 video | `chitchat-qa/xfer-qa-0914:/g4-media/speakers.mp4`, `personal/home:/assets/pasted-video-20260808-235459.mp4` |
| Video with transcript and summary | `personal/home:/speakers-activity-e2e.mp4` with `.transcript.md` and `.summary.md` (9 such sets at the root); `personal/home:/assets/pasted-video-20260808-235459.mp4` (38 s, two speakers) |
| Audio | `personal/home:/meetings/15f1649a-d06c-4af3-be03-c5255c9180de/recording-audio.m4a` (read-only); two `.webm` files in `personal/home:/meetings/a610f275-3582-4c51-957f-4d37d1a9212b/` |
| Word, Excel, PowerPoint, CSV, XLS | `sybill-demo/demo:/email-attachments/` (35 docx, 10 xlsx, 6 pptx, 10 csv, 2 xls). Read-only. |
| Mixed small upload from a PC | `chitchat-qa/xfer-qa-0914:/press-api-upload-qa/upload-sample` (2026-10-21): `qa-plain.txt`, `qa-plain.json`, `qa-plain.csv`, `nested/qa-plain.yaml`, `r2-upload-markdown-sample.md`, `shapes.png`, `added-later.md` (names seen 2026-10-23). Sent by the `press-api` skill helper `upload`. Text files are editable, the YAML is `application/yaml`. Reuse it for public API list, read, and download checks. `added-later.md` (56 bytes, collaboration on) is a good rich-editor round-trip check: edit it in the browser, then read the saved text with the helper `call files/read`. The saved helper key `press-api-skill-qa` (list, read, download, write) is for this workspace. |
| Binary or no extension | `personal/home:/binary-qa-20260920-1546/empty` (0 B), `/binary-qa-20260920-1546/nested/opaque` |
| Shared upload price | `chitchat-qa/home:/upload-rule-qa/upload-small.bin` (8 B, one cent) and `/upload-rule-qa/upload-20mib-plus-one.bin` (20,971,521 B, two cents). Both settled through the normal R2 event on 2026-10-03. Reuse these files for reads; upload again only when checking publication. |
| Exact 50 MiB upload price | `chitchat-qa/home:/upload-rule-qa/upload-50mib.bin` (52,428,800 B, three cents). The normal R2 event settled it on 2026-10-04. Replaying settlement kept the same asset, quota and single sandbox event. Reuse for reads; it was sent as a browser File through the Files sidebar input because the tool's native transfer limit is 50 MB. |

### Folders

| Need | Use |
| --- | --- |
| Folder with about 60 files | `chitchat-qa/xfer-qa-0914:/g4-many`, `/u62-mu2qzdr5/src` |
| Folder with about 25 files | `chitchat-qa/xfer-qa-0914:/u16`, `/u16-q`, `/u42-other2` |
| Read-only QA branch and accepted upload | `chitchat-qa/xfer-qa-0914:/read-only-qa`, root `v9744tmq0scmh0y18gdb2xwjk58h6txa`. All five nodes are archived, with Read-only cleared. Children: `allowed` (`v979vtm9rgnw1jcprbhnq2vs3x8h7kfj`), `blocked` (`v97dncmmgskq9c9v8g1b5y99nx8h7gq0`), `blocked/private-child` (`v9762w00yp4vptxhn9f6z7sh558h68qt`), and `allowed/accepted-after-lock-1793273264776.txt` (`v9705a8yvevr1e3jtqah0p5fb18h7amy`, 35 bytes, collaborative plain text). Archive stamp: `85a529d9-2a6e-4e7d-ba79-6521b55c63d6`. The upload key is revoked. Restore before reuse and read current sharing and flags. |
| Selective Agent Copy output | `chitchat-qa/xfer-qa-0914:/read-only-qa-selective-copy-1793279`, root `v9702t0rhajy0yxr3gc62g6wq98h7eqz`. Native foreground `cp -R` made five drafts. Accepting only the text leaf saved this root, `allowed` (`v9762msw99tepn7w6qv5b0gc4h8h79v1`), and its text leaf (`v97a0w1h9syqzjrpx591ddc24s8h79kx`). The two unselected folders stayed private and were discarded. All three saved nodes are now archived with Read-only cleared; stamp `c2b89846-7bc4-4e22-bcb3-95594e0bf042`. No pending changes remain. |
| Read-only Copy outputs in home | Under `chitchat-qa/home:/qa-profile-20261005-folder-b`, folder copy `qa-profile-20261005-folder-a` (`v97dbqdye85swbdt235tv0fq1n8h62z5`) and its two children are archived. Separate file copy `qa-profile-20261005-file-a.md` (`v9776hda8m0r4vqc4bgjypm1ad8h6w49`) is also archived. It keeps ordered metadata `qa-copy-text: roundtrip`, `qa-copy-number: 17`, `qa-copy-flag: true`. The original source has empty metadata, Read-only false, and its original 53-byte text. |
| Public-link checks (31 archived nodes) | `chitchat-qa/xfer-qa-0914:/share-link-qa` and `/share-link-perf`. Saved rich text, plain text, binary files, unsafe-input cases, layouts and parser limits. Both roots and all children are archived. All nine task links are Off, and both task API keys are revoked. Checked 2026-10-01. Restore through Files before reuse, then create fresh links. |
| Very big folder (read-only) | `sybill-demo/demo:/people` (about 9,700), `/companies` (1,000+). A three-file sample on 2026-09-29 had readable string `metadata.source` values. Check the current folder catalog before choosing other fields. |
| Big archive fixture (1,311 nodes) | Retired: `qa-browser/home:/protection-bulk-qa`, `/copy-2`, `/copy-3`, `/copy-4` and `/seed` were erased. Kept `chitchat-qa/xfer-qa-0914:/g4-many` supports modest paging checks, not this old workload. |
| Deep path (22 levels) | `chitchat-qa/xfer-qa-0914:/g4-u15/d01/…/d20/keeper.txt` |
| Restore path boundary | `chitchat-qa/home:/restore-path-boundary` has ten empty folders, all archived together. Restore the root before reuse. Three nested names have 255 characters each. The deepest name has 228. The original child under `/p/z` has a path length of 1,023. The other deepest folder is under `/incoming`; `/p/y` is the empty name-clash target. Use Move Replace, then parent Archive and Restore Keep both to grow the separately archived child's path to 1,025. Restore must refuse it. Shorten the parent before restoring the child. All allowances are absent. Root ID `v97c81sdr17f1q1mxpjry5qq8h8g5wy4`; child ID `v9768xqx7zg2yq2jpn7hpz5ers8g4qa1`. Reuse these folders. |
| Public API restore (`files/restore`) | `chitchat-qa/copy-qa-0922:/restore-qa-1021` is archived (one delete) with three small Markdown files: `a.md`, `b.md`, and `b-2.md` (the Keep both copy from a clash check). Restore `/restore-qa-1021` with a personal key that has `files:list` and `files:write`, then delete it again. For a clash check, `mkdir /restore-qa-1021` first. Afterward rename that folder to `/restore-qa-occupant` and delete it, so only one deleted item has the fixture path (a second one makes restore refuse the path). Added 2026-10-21. |
| Public API Copy and Move | Retired: `f5-repro-org/home:/release-move-check.md` was erased. Pick a small kept source below and read its current state. |
| Many small subfolders | `chitchat-qa/xfer-qa-0914:/u55/c0` … `c22`, each with `sibling.md` |
| Move and copy sources and targets | `personal/home:/demo` (`mv-src.md`, `mv-target.md`, `cp-target.md`, `/archive`), `personal/home:/tests` (`eval-*` files and folders) |
| Search: public and private | Retired: `qa-browser/home:/qa-search-0905` was erased. Its old restriction and grant setup is not available. |
| Folder table sorts and columns | Retired: `qa-browser/home:/qa-sort-0924` and `/qa-sort-0924-r` were erased. No kept fixture is claimed to have the same sort ties or grants. |
| More than 200 restricted children | Retired: `qa-browser/home:/qa-cap-0924` was erased. Its 203-child shape is not available. |
| Agent skills folder | `personal/home:/.agents/skills/meeting-brief`, `personal/home:/.agents/skills/press-api` (app copy of the repo skill, written with text writes) |
| Bash agent eval fixture | `personal/home:/bash-eval-smoothness-fixture-2026-07-25-a` ([bash-tool-agent-eval.md](../../app-playwriter-harness/references/bash-tool-agent-eval.md)). Archived on 2026-10-18 by another task: the folder shows "This folder is archived" and lists no files. Restore it before you use it. For file open timing, `personal/home:/documents` has three Markdown files with text. |
| Browser downloads | `personal/home:/.system/downloads`, `personal/home:/tmp/browser` |

### Write rules and shares

| Need | Use |
| --- | --- |
| Read-only file | `personal/home:/aaa-closing-qa-mu6ygix9.md`, `/aaa-closing-qa-dest-mu6ynzn5/aaa-closing-qa-mu6ygix9.md` |
| Small editable-text flag fixture | `chitchat-qa/xfer-qa-0914:/u18/dest.md`. Read the current Read-only flag before testing; selected writers are no longer part of the design. Native flag QA is pending. |
| Folder a plugin service owns | `chitchat-qa/home:/chitchat-2eff489e` (read-only for tests). The old `qa-browser/home:/chitchat` choice was erased. |
| Restricted (shared) scope roots | `chitchat-qa/xfer-qa-0914:/u34-dst-a/u34a/sub`, `/u34-dst-b/u34b/sub`, `/g4-media/speakers.mp4`, `/g4-media/shapes.png` |
| Locked media rows for a plugin (Gallery) | `chitchat-qa/xfer-qa-0914:/g4-media/shapes.png` and `/g4-media/speakers.mp4` are locked for `qa.perm.member`, and `/g4-media` is readable, so a recursive `files/list` returns them as `locked: true`. Gallery 0.1.26 is installed in this workspace (`hx7k1ccsn7kqq2g8wb2jsyjjqs8grbzn`, workspace read grant) and `gallery` is on the `chitchat-qa` plugin allowlist (2026-10-22). Recipe: `plugin-gallery.md`. |
| Move path error below a locked folder | Retired: `qa-browser/home:/c2-move-limit` and its destination were erased. Kept `chitchat-qa/home:/restore-path-boundary` above tests a different Restore case. |

### Plugin output (read-only)

| Need | Use |
| --- | --- |
| Meeting recordings with transcript and summary | `personal/home:/meetings` (about 44 files) |
| Chitchat transcripts | `chitchat-qa/home:/chitchat-ad04c6c85ea7daf62a10960d` ([chitchat.md](../../app-playwriter-harness/references/chitchat.md)). The old `qa-browser/home:/chitchat` choice was erased. |
| External repo Mount | `personal/home:/.mounts/github/native-popovers`. GitHub Sources copies the public `<owner>/react-native-popovers` repo. Its first copy has 70 text files. Use Bash to read it; it stays out of the Files sidebar. |

### Repo files for uploads

When a check must upload, use the small files in
`.agents/skills/app-playwriter-harness/assets/files/`: `qa-plain.*`, `qa-frontmatter-*.md`,
`qa-meeting-brief.html`, `r2-upload-*`, `shapes.png`, `speakers.mp4`, `speakers.wav`. Upload them
to a `chitchat-qa` workspace unless the check is about the upload plugins.

### Chats

Human Messages checks reuse these fixtures in `chitchat-qa/home`, created after the 2026-10-29
reset. Organization ID: `gs7pjc3hzy2m10e1hj3vk0kzad8cm7tb`. Workspace ID:
`h57vccrf1r4j9q6ky0etf6v0gx8cm2kw`.

| Fixture | Channel ID | State and use |
| --- | --- | --- |
| Public `sidebar-qa-alpha` | `ts7rj0ydq4q0paxyhc54tq2kjd8h7rcj` | Named-channel order and whole-name prefix search. Created through the native dialog. |
| Public `sidebar-qa-zulu` | `ts7vzeyhyq3wchqsrchfpezp4s8h7k3g` | Archive and restore, Starred, and name order. Archived again after the retained-star restore check; the owner's star is retained. Archived Find shows `#sidebar-qa-zulu · Archived`. |
| Private `sidebar-qa-private` | `ts7tpt6fpa1gx616z8pktq3h918h7s89` | Owner and `qa.perm.member`. Mention root `v97wbdf2z2b8y8cw48yst50nmh8h7317` has `Sidebar QA mention`. Thread root `v97vekr47m0zg8tgbtp3p4hebn8h68nv` has `Sidebar QA thread` and a reply. Both roots remain live. Use for unread counts, Activity, Threads, and access loss/restore. |
| Owner/member DM | `ts7yv1kpbsqaq4zaj4e1brw93n8h7c8h` | Root `v97x5dncmfafw8znb2rncgwwbs8h7tga` has `Sidebar QA direct message` and a reply. Close and explicit URL reopen passed for `qa.perm.member`. It is open now (`hidden: false`, visibility revision 2). Reuse for Close, discovery, explicit reopen and reply behavior. |

The seeded member's exact Home membership is `h97w612te123z9485k4yrp648n8ed4cm`. Its private
channel membership is `v57g5zmsaw970z4nsmwa2jxp1s8h7h7d`; its DM membership is
`v57n7693yr3w0p9e03ty18rt618h78cb`. The temporary no-content role test restored the original
`member` assignment and kept these memberships. The temporary custom role was deleted.
Read current roles, members, stars and archive state before reuse.

Retired: the old `channels-qa`, `channels-page-qa`, `channels-upload-private-qa` and all earlier
human Messages fixtures were erased. Their old roots, replies, notifications and channel uploads
are not live fixtures. The old 51-message paging fixture is gone. Ordinary saved Files copies,
including `/upload-small.bin` and `/r2-upload-sample.pdf`, were preserved.

Channel agent checks reuse chat `n178qh29w0n8sk7yjxjfky7d8n8fjnd8` in `chitchat-qa/home`.
Its Bash calls list channels and members, then read the saved root and reply in a UTC date range.
Its saved search turn checks author, attachments, UTC dates, text/JSON output, an exact Next page
command, `--workspace home`, and refusal of a foreign workspace URL. It used the real paid agent.
The AI chat is preserved, but its old human channel, root and reply IDs were erased by the
Messages reset. Treat those saved outputs as history; use the new fixtures for another check.

Public AI output reads reuse chat `n174yyeysbxqbzk9szcv77pz3x8g9281` in
`chitchat-qa/metadata-qa-0906`, owned by the QA Edge account. These existing outputs are ready
and have committed owners. Read their current `byteCount` and `sha256` before a check.

| Output id | Bytes | Use |
| --- | --- | --- |
| `ss7np2epc86qsdwm2t4c27pcwx8g84qs` | 65,696 | ASCII text. A 65,536-byte page leaves a second page of 160 bytes. |
| `ss7rkcp9pawte3wwk1f0kesxks8g9j2f` | 33,380 | Unicode text. A four-byte character starts at byte 33,311. Test offsets 33,311 through 33,314 with limit 4. |

Both passed complete public API reads with matching stored hashes on 2026-10-20.
Reuse them without sending another model request. Keep their content and ownership unchanged.

Retired: all file-comment roots and file channels listed before 2026-10-29 were erased, including
the PDF and binary comments in `chitchat-qa/home`, collaborative and non-collaborative marks in
`personal/home`, and the resolved read-only quote. Their current document comment marks were
removed too. The ordinary Files and old saved versions remain in kept workspaces. The separate
2026-10-28 cleanup had already erased the `qa-browser/home` files and their comments.

File-comment checks reuse this new native fixture from 2026-10-29:

| File | Channel | Root | State |
| --- | --- | --- | --- |
| `chitchat-qa/home:/new-file.md` (`v974vdsy4egs8ge4ywhrgarpen8fjt4g`) | `ts7pj1aw7wt647557yscedqv718h62p3` | `v97yxmgg71r9c3cfrddc6q58k18h7cxx` | `Sidebar QA file comment`. General comment with no document mark. The saved Welcome text is unchanged. The owner follows the thread. The seeded member follows the file comments; the native button shows `Unfollow comments`. |

`personal/home` already has about 410 chats. For an agent check where chat history does not
matter, continue a chat you already made for the same task instead of starting a new one.

Reuse `QA workspace framing (on)` (`n1782ahb6cb83z87bb9sy7w0qs8gt8fw`) and `QA workspace framing (off)` (`n17451rkcfafmrf7a0swh1nqxd8gt71e`) in `personal/home` for system prompt checks. Each has one turn that asks about `MOVE-MARKER-4411` (in `/documents/notes.md`).

Reuse `QA paged message edit` in `chitchat-qa/home` (`n175v5tanrcx2363yz4478h0w58fn2nc`) for loading older history and editing or retrying messages more than 50 nodes behind the leaf. It has two long branches with 56 and 58 short fixture nodes.

Reuse `Move Folder QA Check` in `chitchat-qa/home` (`n1708nc8w74tp1gne8n8jxa7r98gcg8k`) for agent folder Move checks. Its pending rename was discarded. The saved empty folder remains at `/qa-profile-20261005-folder-a/new-folder`, with no metadata or pending changes.

Reuse `QA native-popovers mount 0928` in `personal/home` (`n17e1df2cqn1p6m8kkac9nq8d58f8674`) for this Mount's Bash checks. The saved first turn lists the Mount and reads its README without changing files.

Use saved chat `n174jx56n9dhr2eahg93prek198fba90` in `personal/home` as evidence for natural Mount discovery and later web search. It used GPT-6 Luna in Agent mode. Its first turn had no chat history or supplied path. Stored Bash calls read the README and `AGENTS.md`; the next turn used web search.

Reuse `personal/plugin-access-qa` chat `n17a115vdg1jsty4ey0r4v6vrx8fbv27` for private Mount checks. It read both sample files exactly, 148 bytes in total. After uninstall, the same read in the same shell failed with `No such file or directory`; `/.mounts/t3-chat/README.md` still read successfully.

Retired: `qa-browser/home` Mount isolation chat `n1708wzk8n9hnt2r9qm87jd1118f9g6z` was erased.
The kept personal-workspace Mount chats above test separate setups.

## Change Log

- 2026-10-31: Council access checks added three small meetings, kept after normal close. `personal/home`: `Council token room` (`65e4eb9c-ed79-452f-af8d-39b0abaf5207`). `chitchat-qa/metadata-qa-0906`: `Council approval room` (`12b6f0f7-e921-40af-8d5f-81e3fafeccac`) and `Council link room` (`af5870c4-e221-4f36-9501-27bbc38d8a67`). No recording was started. Reuse these for finished-room checks; testing admission needs a new open room. No new app user or tenant.
- 2026-10-29: reset all old human Messages and file-comment data, then added the four small sidebar fixtures and one native general comment on the existing `/new-file.md`. Old current comment marks were removed; ordinary Files, saved file copies, history and AI chats were preserved. The seeded member's role and memberships are restored after permission QA. Its DM is open after Close/reopen QA. Old human message IDs in saved AI output are stale. No new tenant or user.
- 2026-10-29: archived the new Read-only QA branch, its 35-byte accepted upload, and the three saved selective Copy nodes. Four test flags were cleared first. The two unselected Copy drafts were discarded; pending and active job counts are zero. The source Markdown file and `/u18/type-find-private.txt` keep their original text and metadata. `/u18` is editable again. The owner upload key is revoked. No new tenant or user.
- 2026-10-29: retired `qa-browser` and `f5-repro-org` fixtures after two complete cleanup reads. Kept scopes, all Clerk auth/billing links and four anonymous kept-space members were preserved. Old fixture results below remain history. Native Read-only checks and their gaps are recorded in Files QA.

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
- 2026-10-21: `press-api` helper checks. In `chitchat-qa/xfer-qa-0914`, uploaded the 7-file `/press-api-upload-qa/upload-sample` set and wrote `markdown-update-repro.md`; the key `press-api-skill-qa` stays saved on the dev PC. In `personal/home`, updated `/.agents/skills/press-api` with text writes only (no uploads); the install key is revoked (verify 401). No new tenant or user.
- 2026-10-20/21: archive and restore timing checks in `qa-browser/home` as the owner. `/copy-2`, `/copy-4` and `/qa-sort-0924` were archived and restored many times; each ends active with the same ids and paths. `/qa-sort-0924/j.json` got 9 metadata keys for a few minutes and then empty metadata again. No new file, tenant or user.
- 2026-10-21: archive-request timing (named items only) in `qa-browser/home` as the owner. `/qa-search-0905/tasks` (1 child), `/copy-2`, `/qa-sort-0924` and the empty `/seed/f00` were archived and restored 6 times each; each ends active with the same ids, paths and child counts. No new file, tenant or user.
- 2026-10-21: Restrict timing checks in `qa-browser/home` as the owner. The first 200 folders of `/copy-4` got the metadata key `qa-restrict-1021: x` for about an hour, then empty metadata again. `/copy-4` was restricted and unrestricted many times and ends open, with no grants and no links. Two catalog `check` rebuilds ran and were cleared. No new file, tenant or user.
- 2026-10-20: verified two existing AI tool outputs through the public API in `chitchat-qa/metadata-qa-0906`. Complete hashes, paging, four-byte text, EOF, range refusals, scope refusals, and revocation passed. Both temporary keys are revoked. No chat, output, or file was created or changed.
- 2026-10-21: "Anyone on the web" QA as `qa.paid.owner` in `f5-repro-org/home`. Added the `/public-image-qa` fixture (two folders, two PNG uploads, two Markdown pages) and kept it for reruns. All links and public switches are off again. Recorded `qa.paid.owner` and its Pro workspace; `qa-browser` still refuses uploads. An earlier run that day left the empty folders `qa-browser/home:/public-image-qa`, `/assets` and `/private` (not public, not restricted, no links). Three task-created anonymous users are deleted.
- 2026-10-21: API-key setup editor checks as `qa.perm.member` in `qa-tmp-share/home`. Two keys were created from a pasted setup, `setup-editor-qa-bound` (Data Probe account, `files:list`) and `setup-editor-qa-personal`. Both are revoked (verify 401). In `chitchat-qa/home` the same account only opened the dialog to check the bind refusal; nothing was created there. No file or grant was written. One task-created anonymous user is deleted.
- 2026-10-21: PDF converter checks in `personal/home`. Added `/documents/pdf-converter-check.pdf` and `-2.pdf` with their `.pdf.md`. Image and video runs on the existing `/images/config-matched-image.png` and `/assets/pasted-video-20260808-235459.mp4` first failed at the first secret read and wrote nothing. After the secrets were saved under Plugin secrets, reruns wrote a fresh `.description.md`, `.transcript.md` and `.summary.md` next to them. No new tenant or user.
- 2026-10-21: upload refusal text check as `qa.perm.owner` in `qa-browser/home` (headless session). A text upload showed "File uploads need a paid plan" and wrote no file. The headless session made one anonymous user (`m5743eav…`, 21:49 UTC) before sign-in. It was deleted on 2026-10-22 with `users:hard_delete_user_now` (`data_and_auth`).
- 2026-10-21: public API restore checks in `chitchat-qa/copy-qa-0922`. Added the archived `/restore-qa-1021` fixture (three small Markdown files). The task key `restore-qa-1021` is revoked (verify 401). No new tenant or user.
- 2026-10-22: restore clash checks (skip, Keep both) on `/restore-qa-1021` in `chitchat-qa/copy-qa-0922`. The fixture is back in the Trash. The empty clash folder is deleted as `/restore-qa-occupant`. The key `QA restore upload check` is revoked (verify 401). No new tenant or user.
- 2026-10-21: release checks as `qa.paid.owner` in `f5-repro-org/home`. Copy, Move, Delete, Restore and retries passed. The copied README is archived at `/release-move-check.md`; the original stayed unchanged. The key `release-20261021-check` is revoked (verify 401). One task-created anonymous user and its empty tenants are deleted.
- 2026-10-22: image size limit check in `personal/home`. Added `/qa-size-limit` with two PNG uploads (about one and two cents). The 16-bit PNG stayed 22,123,638 bytes, and image 0.3.5 refused it after only the activity start call. The other PNG was resized by the sidebar to 13.4 MiB and got a normal description. No new tenant or user.
- 2026-10-22: service-account key organize checks in `chitchat-qa/xfer-qa-0914` as the owner. Folder `/qa-sa-organize` (with `granted/`, restricted, and `outside/`, a few small Markdown files) is archived. Its service account `qa-organize-key` (`rd7nqezxpd1r3c2x2yhaxqmwph8gq6h4`) and its bound key are revoked (verify 401). The account keeps its two grants (workspace read, write on `granted`), which do nothing while it is revoked. No new tenant or user.
- 2026-10-22: service-account copy with `onConflict: "replace"` check in `chitchat-qa/xfer-qa-0914` as the owner. Folder `/qa-sa-copy-replace` (with `granted/`, restricted, holding `src.md` and `dst.md`) is archived. Its service account `qa-copy-replace-key` (`rd7ntwwmty6zw2xdrssjr3r7558gs4bv`) and its bound key are revoked (verify 401). The account keeps one write grant on `granted`, which does nothing while it is revoked. No new tenant or user.
- 2026-10-23: added two one-turn agent chats in `personal/home` for a system prompt check. No file, tenant or user.
