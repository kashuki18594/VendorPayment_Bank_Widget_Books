import crypto from "crypto";

/**
 * Decrypts Base64 AES-GCM encrypted text, matching the C# BouncyCastle GcmBlockCipher output
 * (expects ciphertext + 16-byte tag appended together, then Base64 encoded).
 *
 * @param {string} encryptedText - Base64 encoded ciphertext+tag
 * @param {Buffer} key - 16 bytes (AES-128) or 32 bytes (AES-256)
 * @param {Buffer} iv  - typically 12 bytes for GCM
 * @returns {string} decrypted plain text
 */
export function decrypt(encryptedText, key, iv) {
    const algo = key.length === 32 ? "aes-256-gcm" : "aes-128-gcm";

    const encryptedBytes = Buffer.from(encryptedText, "base64");

    // Last 16 bytes are the auth tag, rest is actual ciphertext
    const tagLength = 16;
    const ciphertext = encryptedBytes.subarray(0, encryptedBytes.length - tagLength);
    const tag = encryptedBytes.subarray(encryptedBytes.length - tagLength);

    const decipher = crypto.createDecipheriv(algo, key, iv, {
        authTagLength: tagLength,
    });

    decipher.setAuthTag(tag);

    const decrypted = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
    ]);

    // Match C#'s TrimEnd("\r\n\0") behavior
    return decrypted.toString("utf8").replace(/[\r\n\0]+$/, "");
}


export function jsonEscape(s) {
    return "\"" + s.replace(/\\/g, "\\\\").replace(/"/g, "\\\"") + "\"";
}