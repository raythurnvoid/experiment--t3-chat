---
name: chatgpt-image-generator
description: Generate, download, and inspect images through ChatGPT in the user's browser with Playwriter when no direct image-generation tool is callable. Use when you need image-model output — visual mockups, generated reference images, or image-model visual reports — but must use chatgpt.com as the image backend. This is the only image backend available in this repo; there is no native image tool.
---

# ChatGPT Image Generator

This agent has no native image-generation tool. When you need image-model output, this skill is the backend: drive ChatGPT through Playwriter, attach reference images when available, save the generated image locally, and inspect the downloaded file yourself before using it as a design reference or visual report.

The ChatGPT UI changes over time. The selectors below were verified on June 3, 2026. Always use Playwriter `snapshot()` or `getCleanHTML()` to confirm the current UI before relying on them.

## Browser Setup

This repo's Playwriter conventions (see `app-playwriter-harness/references/known-hazards.md`) apply here:

1. Read the `playwriter` skill first and follow its full documentation. The global `playwriter` command may not exist on this machine — use `pnpx playwriter`.
2. Create sessions from the repo root so the scoped Playwriter filesystem can read and write skill/artifact files. In this repo, run Playwriter through Vite Plus:

```powershell
$sessionOutput = & "$env:USERPROFILE\.vite-plus\bin\vp.exe" exec -- pnpx playwriter session new
$session = ($sessionOutput | Select-String -Pattern "Session (\d+) created").Matches.Groups[1].Value
if (-not $session) { $session = ($sessionOutput | Select-Object -Last 1).Trim() }
```

3. Choose the Edge profile explicitly. If multiple Edge profiles are reported, do not use the auto-selected one — pass `--browser profile:<key>`. ChatGPT is logged in under the user's normal browsing profile, which in this repo is the personal Edge profile `profile:909172d3ee56c25e` (the same profile that holds the app tabs). With both profiles connected, the Playwriter MCP fails with "Multiple extensions connected", so use the raw CLI with the explicit profile key for every session.
4. Always open ChatGPT in a fresh tab with `context.newPage()`.
   - Do this even when another `chatgpt.com` tab already exists.
   - Other agents or the user may be using existing ChatGPT tabs.
   - Fresh Playwriter sessions start with an empty `state` (`{}`) and a bare global `context` (the Playwright BrowserContext), not `state.context`. Bind the page yourself and store it as `state.page` for every later action.
5. Navigate to `https://chatgpt.com/` and observe the loaded page with `snapshot()`.
6. If ChatGPT shows a login wall, captcha, or account picker, ask the user to complete it in the browser before continuing.

In PowerShell, do not pass nontrivial JavaScript through `-e`. PowerShell mangles quotes, backticks (template literals), arrow functions, and object literals. Write the script to a temp file and run it with `-f`:

```powershell
$scriptPath = Join-Path $env:TEMP "chatgpt-image-step.js"
# write the JS to $scriptPath first, then:
& "$env:USERPROFILE\.vite-plus\bin\vp.exe" exec -- pnpx playwriter -s $session -f $scriptPath --timeout 200000
```

Use this pattern at the start of the workflow (inside the runner file):

```js
state.page = await context.newPage()
await state.page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded' })
await waitForPageLoad({ page: state.page, timeout: 10000 })
console.log('URL:', state.page.url())
console.log(await snapshot({ page: state.page, showDiffSinceLastCall: false }))
```

After ChatGPT creates a conversation URL, rebind to the exact page you created before later probes:

```js
const targetUrl = 'https://chatgpt.com/c/<conversation-id>'
state.page = context.pages().find((p) => p.url().startsWith(targetUrl))
if (!state.page) throw new Error('Exact ChatGPT page not found')
```

Rebind this way whenever another Playwriter-enabled tab is present and a scoped snapshot or locator appears to drift to the wrong page.

## Generate An Image

1. Open the plus menu from the composer:

```js
await state.page.getByTestId('composer-plus-btn').click()
```

Observed accessible label: `Add files and more`.

2. Select the `Create image` tool from the menu:

```js
await state.page.getByRole('menuitemradio', { name: 'Create image' }).click()
```

You must explicitly select `Create image` in this menu. This is the step that forces the model to return a generated image. If you skip it, ChatGPT answers the prompt with text instead, even when the prompt clearly asks for an image, and you get a written reply such as a `Verification Report Image` heading with no actual image to download.

In the ChatGPT composer plus menu, the relevant item is the `Create image` tool (a `menuitemradio` labeled `Create image`). Select it before submitting any prompt.

3. Confirm the composer changed into image mode.
   - The textbox remains `getByRole('textbox', { name: 'Chat with ChatGPT' })`.
   - The placeholder text changes to `Describe or edit an image`.
   - A selected tool chip appears as `role=button[name="Image, click to remove"]`.
   - The aspect ratio control appears as `Choose image aspect ratio`.

Do not submit the prompt until image mode is visibly active. If the selected tool chip, image placeholder, or aspect-ratio control is missing, open the plus menu again and select `Create image` again.

4. Fill the prompt and submit:

```js
await state.page.getByRole('textbox', { name: 'Chat with ChatGPT' }).fill(prompt)
await state.page.getByTestId('send-button').click()
```

Observed send control: `data-testid="send-button"` with accessible name `Send prompt`.

For visual verification reports, the prompt must begin with `Generate an image:` and explicitly say that the required output is a generated image report. Prompt wording alone is not enough; selecting `Create image` is still mandatory.

5. Wait for generation to finish.
   - During generation, ChatGPT shows `data-testid="stop-button"` with accessible name `Stop answering`.
   - Wait for that button to detach, then take a fresh snapshot.

```js
await state.page.getByTestId('stop-button').waitFor({ state: 'detached', timeout: 180000 })
console.log(await snapshot({ page: state.page, search: /Generated image|Download|Save|Edit image|Share/i, showDiffSinceLastCall: false }))
```

## Attach Reference Images

When the user asks ChatGPT to use an existing image as input, first resolve every reference image to an absolute local file path.

- If the user attached an image in chat and the local path is available, upload that exact file.
- If the user attached an inline image but no local file path is available to tools, say that Playwriter cannot upload the inline bitmap directly. Use the closest available browser screenshot only when that is acceptable for the task, and describe the visible inline image details in the prompt.
- If no suitable local file exists, ask the user for the file or create a browser screenshot of the relevant UI when the app can reproduce it (use `app-playwriter-harness` to screenshot the live app).

Upload files through the composer file input. Prefer `input[type="file"]` over clipboard paste.

```js
await state.page.locator('input[type="file"]').first().setInputFiles('C:/absolute/path/to/reference.png')
await state.page.waitForTimeout(1000)
console.log(await snapshot({ page: state.page, search: /uploaded|image|remove|Create image|Describe/i, showDiffSinceLastCall: false }))
```

If the file input is not present or the upload does not attach, open the plus menu and choose `Add photos & files`, then set the file input again:

```js
await state.page.getByTestId('composer-plus-btn').click()
await state.page.getByRole('menuitem', { name: /Add photos|files/i }).click()
await state.page.locator('input[type="file"]').first().setInputFiles('C:/absolute/path/to/reference.png')
```

After attaching the image, select `Create image` from the plus menu if image mode is not already active. Confirm the composer shows `Describe or edit an image` or an `Image, click to remove` chip before submitting the prompt.

For multiple variants from the same reference, prefer one fresh ChatGPT conversation per variant. Upload the same reference image for each conversation, submit a variant-specific prompt, and save each generated output separately.

## Download The Image

After generation, the assistant turn usually contains:

- `img alt="Generated image: <title>"`
- an image wrapper exposed as `role=button[name="Generated image: <title>"]`
- `data-testid="image-gen-overlay-left-actions"` with `Edit image`
- `data-testid="image-gen-overlay-right-actions"` with `Share this image`

Open the image wrapper to enter fullscreen mode. If the click reports a timeout, check whether the dialog opened before retrying.

```js
await state.page.getByRole('button', { name: /Generated image/i }).click()
```

The fullscreen dialog exposes:

- `role=button[name="Close fullscreen view"]`
- the image title
- `role=button[name="Select"]`
- `button[name="Aspect ratio"]`
- `role=button[name="Share"]`
- `role=button[name="Save"]`
- `button[name="Show more"]`
- `data-testid="fullscreen-shell-body"` with the final image

First try a normal browser download with the `Save` button:

```js
const path = require('node:path')
const outPath = path.resolve('tmp/design-ideation/<run-id>/generated-image.png')
const [download] = await Promise.all([
  state.page.waitForEvent('download', { timeout: 30000 }),
  state.page.getByRole('button', { name: 'Save' }).click(),
])
await download.saveAs(outPath)
```

If `download.saveAs()` fails because the relay temp file disappeared, or direct Node `fetch()` returns `403 Forbidden`, fetch the image inside the ChatGPT page context with session credentials and write the bytes locally:

```js
const result = await state.page.evaluate(async () => {
  const img = Array.from(document.querySelectorAll('img')).find((node) =>
    /Generated image/i.test(node.alt),
  )
  if (!img) throw new Error('Generated image not found')

  const response = await fetch(img.currentSrc || img.src, { credentials: 'include' })
  if (!response.ok) throw new Error(`Image fetch failed: ${response.status} ${response.statusText}`)

  const blob = await response.blob()
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onloadend = () => resolve(String(reader.result).split(',')[1])
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })

  return {
    alt: img.alt,
    width: img.naturalWidth,
    height: img.naturalHeight,
    type: blob.type,
    base64,
  }
})

const fs = require('node:fs')
const path = require('node:path')
const outPath = path.resolve('tmp/design-ideation/<run-id>/generated-image.png')
fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, Buffer.from(result.base64, 'base64'))
```

Save artifacts under the calling skill's repo-relative run folder, such as `tmp/design-ideation/<run-id>/` for ideation or `tmp/visual-verification/<run-id>/` for verification. Playwriter's Node sandbox and `download.saveAs()` need absolute paths; the session cwd is the repo root, so `path.resolve('tmp/.../file.png')` produces the correct absolute path. Do not create repo-root `artifacts/` folders by default.

## Inspect And Reuse

1. Open the downloaded image yourself with the Read tool (it renders images visually) and confirm the file is readable and matches the requested task.
2. If the output is wrong, re-prompt in the same ChatGPT conversation or start a fresh ChatGPT tab for a clean generation.
3. Record the saved image path for the user and for follow-up verifier/designer work.
4. Clean up any Playwriter listeners you add.

Do not close unrelated browser tabs. Only close a page you created when the user asks or when cleanup is clearly safe.

## Output Contract

When using this skill, return:

- ChatGPT conversation URL
- browser profile used (e.g. `profile:909172d3ee56c25e`)
- prompt submitted
- generated image path
- whether you inspected the image yourself
- download method used, such as `Save` download or page-context credential fetch
- any selector drift, login wall, captcha, or Playwriter issue encountered
