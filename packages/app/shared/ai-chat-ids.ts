// The chat model and mode ids, in their own file with no imports.
//
// `convex/schema.ts` needs these lists for its validators, and almost every Convex module imports the
// schema. `shared/ai-chat.ts` imports `file-quotes.ts`, which imports zod, so reading the lists from
// there made every module, including the file open path, load zod. Keep this file free of imports.

export const ai_chat_MODEL_IDS = ["gpt-6-luna", "deepseek-v4.1-flash"] as const;

export const ai_chat_MODE_IDS = ["agent", "ask"] as const;
