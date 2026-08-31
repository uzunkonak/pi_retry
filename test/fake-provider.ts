/**
 * Test-only extension: registers a provider pointed at the local fake server
 * started by `e2e.mjs`. Not part of the published package's extension list.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	const baseUrl = process.env.FAKE_PROVIDER_URL;
	if (!baseUrl) throw new Error("FAKE_PROVIDER_URL is not set");

	pi.registerProvider("ratelimit-test", {
		name: "Rate Limit Test",
		baseUrl,
		apiKey: "$FAKE_PROVIDER_KEY",
		api: "anthropic-messages",
		models: [
			{
				id: "fake-model",
				name: "Fake Model",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200_000,
				maxTokens: 4_096,
			},
		],
	});
}
