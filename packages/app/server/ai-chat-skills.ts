import { Result } from "common/errors-as-values-utils.ts";
import { parseDocument } from "yaml";
import { z } from "zod";
import { files_get_utf8_byte_size } from "../shared/files.ts";

export const ai_chat_skills_LIMITS = {
	discovered: 100,
	frontmatter: 8 * 1024,
	descriptionCharacters: 1024,
	compatibilityCharacters: 500,
	skill: 64 * 1024,
	instruction: 32 * 1024,
	active: 64 * 1024,
	catalog: 32 * 1024,
} as const;

const FRONTMATTER_REGEX = /^---\n([\s\S]*?)\n---(?:\n|$)/u;
const SKILL_NAME_REGEX = /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u;
const WORKSPACE_SKILL_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const frontmatter_schema = z.object({
	name: z.string(),
	description: z.string(),
	license: z.string().optional(),
	compatibility: z.string().optional(),
	metadata: z.record(z.string(), z.string()).optional(),
	"allowed-tools": z.string().optional(),
});

/**
 * Parse catalog metadata only. Callers may pass a bounded prefix containing the YAML.
 * Repair messages omit parser output, which can contain source text.
 */
export function ai_chat_skills_parse(text: string, folderName: string) {
	const normalizedText = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
	const frontmatter = FRONTMATTER_REGEX.exec(normalizedText);
	if (!frontmatter) {
		return Result({
			_nay: { name: "invalid", message: "Start SKILL.md with YAML between two --- lines. Keep the YAML within 8 KiB." },
		});
	}
	if (files_get_utf8_byte_size(frontmatter[1]) > ai_chat_skills_LIMITS.frontmatter) {
		return Result({
			_nay: { name: "too_large", message: "Keep the skill's YAML at or below 8 KiB." },
		});
	}

	let fields: z.infer<typeof frontmatter_schema>;
	try {
		const document = parseDocument(frontmatter[1], {
			version: "1.2",
			schema: "core",
			resolveKnownTags: false,
			uniqueKeys: true,
		});
		if (document.errors.length > 0 || document.warnings.length > 0) {
			return Result({
				_nay: {
					name: "invalid",
					message: "Fix the skill's YAML, duplicate keys, or unsupported tags.",
				},
			});
		}
		const value: unknown = document.toJS({ maxAliasCount: 20 });
		const parsed = frontmatter_schema.safeParse(value);
		if (!parsed.success) {
			return Result({
				_nay: {
					name: "invalid",
					message: "Use text for name, description, optional fields, and every metadata value.",
				},
			});
		}
		fields = parsed.data;
	} catch {
		return Result({ _nay: { name: "invalid", message: "Simplify the skill's YAML and aliases." } });
	}

	if (
		[...fields.name].length > 64 ||
		!SKILL_NAME_REGEX.test(fields.name) ||
		fields.name !== fields.name.toLowerCase()
	) {
		return Result({
			_nay: { name: "invalid", message: "Use 1–64 lowercase letters or numbers in name, separated by single hyphens." },
		});
	}
	if (!WORKSPACE_SKILL_NAME_REGEX.test(fields.name)) {
		return Result({
			_nay: {
				name: "invalid",
				message:
					"This Unicode name is valid in Agent Skills, but workspace paths need an ASCII name. Rename the folder and update name.",
			},
		});
	}
	if (fields.name !== folderName) {
		return Result({
			_nay: { name: "invalid", message: "Make name match the skill folder name exactly." },
		});
	}
	if (
		fields.description.trim().length === 0 ||
		[...fields.description].length > ai_chat_skills_LIMITS.descriptionCharacters
	) {
		return Result({
			_nay: { name: "invalid", message: "Use a nonempty description of at most 1,024 characters." },
		});
	}
	if (
		fields.compatibility !== undefined &&
		(fields.compatibility.trim().length === 0 ||
			[...fields.compatibility].length > ai_chat_skills_LIMITS.compatibilityCharacters)
	) {
		return Result({
			_nay: {
				name: "invalid",
				message: "Use 1–500 characters for compatibility, or remove that field.",
			},
		});
	}

	return Result({
		_yay: {
			name: fields.name,
			description: fields.description,
		},
	});
}
