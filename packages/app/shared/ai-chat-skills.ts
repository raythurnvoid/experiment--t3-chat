import { Result } from "common/errors-as-values-utils.ts";
import { parseDocument } from "yaml";
import { z } from "zod";
import { files_get_utf8_byte_size } from "./files.ts";

export const ai_chat_skills_LIMITS = {
	selected: 8,
	discovered: 100,
	frontmatter: 8 * 1024,
	descriptionCharacters: 1024,
	compatibilityCharacters: 500,
	skill: 64 * 1024,
	instruction: 16 * 1024,
	active: 64 * 1024,
	catalog: 32 * 1024,
	resource: 64 * 1024,
	resourcesPerSkill: 200,
	resourcesPerTurn: 1000,
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
 * Strict loading is an app choice. The Agent Skills host guide permits more tolerant loading.
 * Repair messages never include the YAML value or parser output, which can contain private text.
 */
export function ai_chat_skills_parse(text: string, folderName: string) {
	if (files_get_utf8_byte_size(text) > ai_chat_skills_LIMITS.skill) {
		return Result({ _nay: { name: "too_large", message: "Keep SKILL.md at or below 64 KiB, then save it again." } });
	}
	const normalizedText = text.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
	const frontmatter = FRONTMATTER_REGEX.exec(normalizedText);
	if (!frontmatter) {
		return Result({
			_nay: { name: "invalid", message: "Start SKILL.md with YAML between two --- lines, then save it again." },
		});
	}
	if (files_get_utf8_byte_size(frontmatter[1]) > ai_chat_skills_LIMITS.frontmatter) {
		return Result({
			_nay: { name: "too_large", message: "Keep the skill's YAML at or below 8 KiB, then save it again." },
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
					message: "Fix the skill's YAML, duplicate keys, or unsupported tags, then save it again.",
				},
			});
		}
		const value: unknown = document.toJS({ maxAliasCount: 20 });
		const parsed = frontmatter_schema.safeParse(value);
		if (!parsed.success) {
			return Result({
				_nay: {
					name: "invalid",
					message: "Use text for name, description, optional fields, and every metadata value, then save again.",
				},
			});
		}
		fields = parsed.data;
	} catch {
		return Result({ _nay: { name: "invalid", message: "Simplify the skill's YAML and aliases, then save it again." } });
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
			_nay: { name: "invalid", message: "Make name match the skill folder name exactly, then save it again." },
		});
	}
	if (fields.description.trim().length === 0 || [...fields.description].length > ai_chat_skills_LIMITS.descriptionCharacters) {
		return Result({
			_nay: { name: "invalid", message: "Use a nonempty description of at most 1,024 characters, then save again." },
		});
	}
	if (
		fields.compatibility !== undefined &&
		(fields.compatibility.trim().length === 0 || [...fields.compatibility].length > ai_chat_skills_LIMITS.compatibilityCharacters)
	) {
		return Result({
			_nay: {
				name: "invalid",
				message: "Use 1–500 characters for compatibility, or remove that field, then save again.",
			},
		});
	}

	return Result({
		_yay: {
			name: fields.name,
			description: fields.description,
			body: normalizedText.slice(frontmatter[0].length),
			...(fields.license !== undefined ? { license: fields.license } : {}),
			...(fields.compatibility !== undefined ? { compatibility: fields.compatibility } : {}),
			...(fields.metadata !== undefined ? { metadata: fields.metadata } : {}),
			...(fields["allowed-tools"] !== undefined ? { allowedTools: fields["allowed-tools"] } : {}),
		},
	});
}

export function ai_chat_skills_catalog(entries: {
	skillId: string;
	path: string;
	name: string;
	description: string;
	compatibility?: string;
	scriptStatus?: "supported" | "unsupported";
	status: "available" | "invalid" | "updating" | "unavailable" | "too_large";
	message?: string;
}[]) {
	const serialized = entries.map(({ skillId, path, name, description, compatibility, scriptStatus, status, message }) => ({
		skillId, path, name, description, compatibility, scriptStatus,
		status: status === "available" ? "available" : "invalid", message,
	}));
	const text = JSON.stringify(serialized);
	let bytes = files_get_utf8_byte_size(text);
	for (const [index, entry] of entries.entries()) {
		if (entry.status !== "updating") continue;
		// The query cannot reconstruct saved metadata. Reserve its maximum JSON size until ready.
		// A control character takes six bytes in JSON, more than any UTF-8 code point.
		const reserved = {
			...serialized[index],
			description: "\0".repeat(ai_chat_skills_LIMITS.descriptionCharacters),
			compatibility: "\0".repeat(ai_chat_skills_LIMITS.compatibilityCharacters),
			scriptStatus: "unsupported", status: "available", message: undefined,
		};
		bytes += files_get_utf8_byte_size(JSON.stringify(reserved)) - files_get_utf8_byte_size(JSON.stringify(serialized[index]));
	}
	return { text, bytes };
}
