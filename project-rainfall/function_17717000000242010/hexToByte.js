/**
 * Checks if the string contains characters other than valid hex digits (0-9, a-f, A-F)
 */
function hasSpecialChar(hexStr) {
    return !/^[0-9a-fA-F]*$/.test(hexStr);
}

/**
 * Converts a hex string to a byte array (Uint8Array), matching the C# HexToByte logic
 * @param {string} hexStr - the hex string to convert
 * @returns {Uint8Array} the resulting byte array (empty if invalid hex chars found)
 */
function hexToByte(hexStr) {
    if (!hasSpecialChar(hexStr)) {
        const bArray = new Uint8Array(hexStr.length / 2);

        for (let i = 0; i < hexStr.length / 2; i++) {
            const firstNibble = parseInt(hexStr.substr(2 * i, 1), 16);
            const secondNibble = parseInt(hexStr.substr(2 * i + 1, 1), 16);

            const finalByte = secondNibble | (firstNibble << 4);

            bArray[i] = finalByte;
        }

        return bArray;
    }

    return new Uint8Array(0);
}

export { hexToByte };