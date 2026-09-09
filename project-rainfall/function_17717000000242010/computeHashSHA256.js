import crypto from "crypto";

// Variant A: Agar Key Hex Format mein hai (Most Common)
export function generateHashHexKey(message, secretKeyHex) {
    const keyBuffer = Buffer.from(secretKeyHex, "hex");
    const hmac = crypto.createHmac("sha256", keyBuffer);
    hmac.update(message, "utf8");
    return hmac.digest("base64");
}

// Variant B: Agar Key String/ASCII Format mein hai
export function generateHashStringKey(message, secretKeyString) {
    const hmac = crypto.createHmac("sha256", secretKeyString);
    hmac.update(message, "utf8");
    return hmac.digest("base64");
}



export function getExactHash(message, secretKey) {
    // Strictly matching C# ASCIIEncoding.GetBytes()
    const keyBuffer = Buffer.from(secretKey, "ascii");
    const hmac = crypto.createHmac("sha256", keyBuffer);

    // Strictly updating message in ASCII
    hmac.update(Buffer.from(message, "ascii"));

    return hmac.digest("base64");
}