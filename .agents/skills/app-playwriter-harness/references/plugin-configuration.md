# Plugin Upload Configuration

Use this recipe for an installed plugin version whose manifest declares configuration and a `source.path` event filter.

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
