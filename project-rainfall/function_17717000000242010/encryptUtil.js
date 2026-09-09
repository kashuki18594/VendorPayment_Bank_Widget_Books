import crypto from "crypto";

/**
 * Encrypts plain text to Base64 AES-GCM, matching C# BouncyCastle GcmBlockCipher output
 * (appends ciphertext + 16-byte tag together, then Base64 encodes).
 *
 * @param {string} plainText - Plain text to encrypt
 * @param {Buffer} key - 16 bytes (AES-128) or 32 bytes (AES-256)
 * @param {Buffer} iv  - typically 12 bytes for GCM
 * @returns {string} Base64 encoded ciphertext+tag
 */
export function encrypt(plainText, key, iv) {
    // Key size ke hisab se automatically AES-128 ya AES-256 choose karega
    const algo = key.length === 32 ? "aes-256-gcm" : "aes-128-gcm";

    const cipher = crypto.createCipheriv(algo, key, iv, {
        authTagLength: 16,
    });

    const encrypted = Buffer.concat([
        cipher.update(plainText, "utf8"),
        cipher.final(),
    ]);

    // BouncyCastle cipher.DoFinal me auth tag ciphertext ke aage juda hota hai
    const tag = cipher.getAuthTag();

    // Encrypted bytes + 16-byte tag ko combine karke Base64 bana rahe hain
    return Buffer.concat([encrypted, tag]).toString("base64");
}
