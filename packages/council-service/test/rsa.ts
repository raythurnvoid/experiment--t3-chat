// Test RSA keypair for webhook signature tests. Generated fresh per run — nothing here is a real
// provider key, and no fixture private key ever enters the repo.

export async function make_test_rsa() {
	const keyPair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);

	const spki = new Uint8Array(await crypto.subtle.exportKey("spki", keyPair.publicKey));
	let binary = "";
	for (const byte of spki) {
		binary += String.fromCharCode(byte);
	}
	const publicKeyPem = `-----BEGIN PUBLIC KEY-----\n${btoa(binary).replace(/(.{64})/gu, "$1\n")}\n-----END PUBLIC KEY-----`;

	const sign = async (bodyBytes: Uint8Array) => {
		const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keyPair.privateKey, bodyBytes);
		const bytes = new Uint8Array(signature);
		let signatureBinary = "";
		for (const byte of bytes) {
			signatureBinary += String.fromCharCode(byte);
		}
		return btoa(signatureBinary);
	};

	return { publicKeyPem, sign };
}
