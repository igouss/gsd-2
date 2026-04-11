export type TokenProvider = "anthropic" | "openai" | "google" | "mistral" | "bedrock" | "unknown";

const CHARS_PER_TOKEN_BY_PROVIDER: Record<TokenProvider, number> = {
	anthropic: 3.5,
	openai: 4.0,
	google: 4.0,
	mistral: 3.8,
	bedrock: 3.5,
	unknown: 4.0,
};

export function getCharsPerToken(provider: TokenProvider): number {
	return CHARS_PER_TOKEN_BY_PROVIDER[provider] ?? CHARS_PER_TOKEN_BY_PROVIDER.unknown;
}
