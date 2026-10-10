import { spyOn } from "bun:test";

// Preloaded by bunfig.toml. Stubs the two third-party APIs Better Auth calls so
// tests run offline and stay deterministic; everything else goes through.

// Passwords the stubbed Have I Been Pwned range API reports as breached.
export const BREACHED_PASSWORDS = [
	"correct-horse-battery-staple",
	"password123",
];

// A token the stubbed siteverify rejects, standing in for a bot.
export const FAILING_CAPTCHA_TOKEN = "XXXX.FAIL.TOKEN.XXXX";

// Cloudflare's documented Turnstile test secrets.
const TURNSTILE_ALWAYS_PASS_SECRET = "1x0000000000000000000000000000000AA";
const TURNSTILE_SITEVERIFY_URL =
	"https://challenges.cloudflare.com/turnstile/v0/siteverify";
const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

function sha1(value: string): string {
	return new Bun.CryptoHasher("sha1").update(value).digest("hex").toUpperCase();
}

const breachedHashes = BREACHED_PASSWORDS.map(sha1);

const realFetch = globalThis.fetch;

async function stubFetch(
	input: Parameters<typeof fetch>[0],
	init?: Parameters<typeof fetch>[1],
): Promise<Response> {
	const url = input instanceof Request ? input.url : String(input);

	if (url.startsWith(HIBP_RANGE_URL)) {
		const prefix = url.slice(HIBP_RANGE_URL.length).toUpperCase();
		const body = breachedHashes
			.filter((hash) => hash.startsWith(prefix))
			.map((hash) => `${hash.slice(5)}:42`)
			.join("\r\n");
		return new Response(body, { headers: { "Content-Type": "text/plain" } });
	}

	if (url === TURNSTILE_SITEVERIFY_URL) {
		const raw =
			init?.body ?? (input instanceof Request ? await input.text() : "{}");
		const { secret, response } = JSON.parse(String(raw)) as {
			secret?: string;
			response?: string;
		};
		// Mirrors Cloudflare: the always-pass secret accepts any token,
		// including the dummy token test site keys produce.
		if (secret !== TURNSTILE_ALWAYS_PASS_SECRET) {
			return Response.json({
				success: false,
				"error-codes": ["invalid-input-secret"],
			});
		}
		const success = !!response && response !== FAILING_CAPTCHA_TOKEN;
		return Response.json({
			success,
			"error-codes": success ? [] : ["invalid-input-response"],
		});
	}

	return realFetch(input, init);
}

spyOn(globalThis, "fetch").mockImplementation(
	Object.assign(stubFetch, { preconnect: realFetch.preconnect }),
);
