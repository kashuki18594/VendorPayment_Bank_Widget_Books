import axios from 'axios';
import express from "express";
import { hexToByte } from "./hexToByte.js";
import { generateHashStringKey, getExactHash } from "./computeHashSHA256.js";
import { encrypt } from "./encryptUtil.js";
import { decrypt, jsonEscape } from "./decrypt.js";
import { LISTS, queryItems, findByTitle, upsertByTitle, deleteItem } from "./sharepoint.js";


const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true })); 

// ==========================================
// 1. CENTRALIZED CONFIGURATION
// ==========================================
// Best Practice: Move these to a .env file later (e.g., process.env.BASE_URL)
const CONFIG = {
    // /batchapi/TransactionPosting
    BASE_URL: "https://indusapi.indusind.bank.in/indusapi/prod",
    CLIENT_ID: "f770cca251d8252d20310c305d976481",
    CLIENT_SECRET: "ff40c323a29d24513a7f01334309e729",
    HASH_SECRET_STRING: "21652A21B1DAA796DDC510D0CB6DD5909609A91A313AC50ADCF098BE93B80135",
    KEY_BYTES: hexToByte("21652A21B1DAA796DDC510D0CB6DD5909609A91A313AC50ADCF098BE93B80135"),
    IV_BYTES: hexToByte("C384C443786D04111216CE4D5D27F5DB")
};


// 5454fc831b0784884076b1f9c4095994
// f3810d7603416d520c22d7e2095c2bbe
// D4564BCB4357A9277237E2BF9F83BC84E38D66AD81857633398A64E107751AE2
// EAB8176C0AAADA8F637CF769FFE11F6C

// ==========================================
// 2. DYNAMIC HELPER FUNCTION
// ==========================================
/**
 * Handles encryption, hashing, API calling, and decryption for any bank endpoint.
 * @param {string} endpoint - The specific API path (e.g., "/batch/beneficiaryrequest/V1")
 * @param {object} requestData - The raw JSON body from the client
 */
async function processBankRequest(endpoint, requestData) {
    // 1. Prepare Data
    const plainJson = JSON.stringify(requestData);
    
    // 2. Encrypt & Hash
    const encryptedData = encrypt(plainJson, CONFIG.KEY_BYTES, CONFIG.IV_BYTES);
    const hash = getExactHash(plainJson, CONFIG.HASH_SECRET_STRING);

    // 3. Build Bank Payload
    const bankPayload = {
        RequestMsg: encryptedData,
        RequestHash: hash
    };

    // 4. Make API Call to Bank
    const response = await axios.post(
        `${CONFIG.BASE_URL}${endpoint}`,
        bankPayload, // Axios automatically stringifies objects if Content-Type is application/json
        {
            headers: {
                "IBL-Client-Id": CONFIG.CLIENT_ID,
                "IBL-Client-Secret": CONFIG.CLIENT_SECRET,
                "Content-Type": "application/json",
            },
        }
    );

    // 5. Decrypt Bank Response
    const responseData = response.data.responseMsg;
    const decryptedData = decrypt(responseData, CONFIG.KEY_BYTES, CONFIG.IV_BYTES);
    const jsonEscapes = jsonEscape(decryptedData);

    // 6. Return Structured Result
    return {
        status: "success",
        data: encryptedData,
        payload: requestData,
        plainJson: plainJson,
        hash: hash,
        bankPayload: bankPayload,
        response: response.data,
        responseData: responseData,
        jsonEscapes: jsonEscapes,
    };
}

// ==========================================
// 3. EXPRESS ROUTES
// ==========================================

app.post("/beneficiaryrequest", async (req, res) => {
    try {
        // Pass specific endpoint path dynamically
        const result = await processBankRequest("/batchapi/BeneficiaryRequest", req.body);
        res.status(200).json(result);
    } catch (error) {
        console.error("Error in /beneficiaryrequest:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post("/beneficiaryenquiry", async (req, res) => {
    try {
        // Pass specific endpoint path dynamically
        const result = await processBankRequest("/batchapi/BeneficiaryEnquiry", req.body);
        res.status(200).json(result);
    } catch (error) {
        console.error("Error in /beneficiaryenquiry:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});
app.post("/transactionenquiry", async (req, res) => {
    try {
        // Pass specific endpoint path dynamically
        const result = await processBankRequest("/batchapi/TransactionEnquiry", req.body);
        res.status(200).json(result);
    } catch (error) {
        console.error("Error in /transactionenquiry:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post("/transactionposting", async (req, res) => {
    try {
        // Pass specific endpoint path dynamically
        const result = await processBankRequest("/batchapi/TransactionPosting", req.body);
        res.status(200).json(result);
    } catch (error) {
        console.error("Error in /transactionposting:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// ==========================================
// 4. APP STATE  (widget persistence — stored in SharePoint list "AppState")
// ==========================================
// SharePoint list "AppState" (auto-created on first use, see sharepoint.js):
//   Title       Single line of text  — the state key
//   StateValue  Multiple lines (plain) — JSON string
//
//   GET  /appstate?key=<key>   -> { key, value }   (value is null when unset)
//   POST /appstate  { key, value }  -> { key, saved: true }   (value:null clears)
//
// Keys used by the widget:
//   indusindPaymentStatus   { [paymentId]: {...} }
//   indusindManualPayments  [ {...} ]
//   bankFilterSettings      { maker, authorizer, bank }
//   indusindTrackedPayments [ {...} ]

const APPSTATE_MAX_CHARS = 63000;

app.get("/appstate", async (req, res) => {
    const key = String(req.query.key || "").trim();
    if (!key) {
        return res.status(400).json({ status: "error", message: "Missing 'key' query parameter." });
    }

    try {
        const item = await findByTitle(LISTS.AppState, key);
        const raw = item?.fields?.StateValue;

        let value = null;
        if (raw != null) {
            try { value = JSON.parse(raw); } catch (_) { value = null; }
        }

        res.status(200).json({ key, value });
    } catch (error) {
        console.error("Error in GET /appstate:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post("/appstate", async (req, res) => {
    const key = String((req.body || {}).key || "").trim();
    if (!key) {
        return res.status(400).json({ status: "error", message: "Missing 'key' in body." });
    }

    if (key.length > 255) {
        return res.status(400).json({ status: "error", message: "'key' must be 255 characters or fewer." });
    }

    // `value` may be null on purpose (used to clear a key).
    const stateValue = JSON.stringify((req.body || {}).value ?? null);

    // SharePoint plain multi-line text holds at most 63,999 characters.
    if (stateValue.length > APPSTATE_MAX_CHARS) {
        return res.status(413).json({
            status: "error",
            message: `Value for '${key}' is ${stateValue.length} characters; the limit is ${APPSTATE_MAX_CHARS}.`
        });
    }

    try {
        await upsertByTitle(LISTS.AppState, key, { StateValue: stateValue });
        res.status(200).json({ key, saved: true });
    } catch (error) {
        console.error("Error in POST /appstate:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

// ==========================================
// 5. PAID PAYMENTS  (SharePoint list "PaidPayments" — expires 1 day after being marked Paid)
// ==========================================
// SharePoint list "PaidPayments" (auto-created on first use, see sharepoint.js):
//   Title = "<Source>:<PaymentId>" (unique key), Source, PaymentId, PaymentNumber,
//   VendorName, Amount, UTR, PaidAt (ISO), ExpireAt (Number, epoch SECONDS)
//
// SharePoint has no native TTL, so expiry is enforced here: GET only returns
// rows whose ExpireAt is in the future, and deletes the expired ones it sees.
//
//   POST /paidpayments          { source, paymentId, paymentNumber, vendorName, amount, utr }
//   GET  /paidpayments?source=  -> { status, source, items: [...] }
//   POST /paidpayments/delete   { source, paymentId }   (explicit early delete)

const PAID_TTL_SECONDS = 24 * 60 * 60; // 1 day
const PAID_FIELDS = ["Source", "PaymentId", "PaymentNumber", "VendorName", "Amount", "UTR", "PaidAt", "ExpireAt"];
const paidKey = (source, paymentId) => `${source}:${paymentId}`;

app.post("/paidpayments", async (req, res) => {
    const body = req.body || {};
    const source = String(body.source || "").trim();
    const paymentId = String(body.paymentId || "").trim();

    if (!source || !paymentId) {
        return res.status(400).json({ status: "error", message: "Missing 'source' or 'paymentId'." });
    }

    const paidAt = new Date().toISOString();
    const expireAt = Math.floor(Date.now() / 1000) + PAID_TTL_SECONDS;

    try {
        await upsertByTitle(LISTS.PaidPayments, paidKey(source, paymentId), {
            Source: source,
            PaymentId: paymentId,
            PaymentNumber: String(body.paymentNumber || ""),
            VendorName: String(body.vendorName || ""),
            Amount: String(body.amount ?? ""),
            UTR: String(body.utr || ""),
            PaidAt: paidAt,
            ExpireAt: expireAt
        });

        res.status(200).json({ status: "success", source, paymentId, paidAt, expireAt });
    } catch (error) {
        console.error("Error in POST /paidpayments:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.get("/paidpayments", async (req, res) => {
    const source = String(req.query.source || "").trim();

    if (!source) {
        return res.status(400).json({ status: "error", message: "Missing 'source' query parameter." });
    }

    try {
        const rows = await queryItems(LISTS.PaidPayments, `fields/Source eq '${source.replace(/'/g, "''")}'`);
        const now = Math.floor(Date.now() / 1000);

        const live = [];
        const expired = [];
        for (const row of rows) {
            (Number(row.fields?.ExpireAt) > now ? live : expired).push(row);
        }

        // Housekeeping in place of a native TTL; a failure here must not fail the read.
        await Promise.allSettled(expired.map(row => deleteItem(LISTS.PaidPayments, row.id)));

        const items = live.map(row =>
            Object.fromEntries(PAID_FIELDS.map(f => [f, row.fields?.[f] ?? ""]))
        );

        res.status(200).json({ status: "success", source, items });
    } catch (error) {
        console.error("Error in GET /paidpayments:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});

app.post("/paidpayments/delete", async (req, res) => {
    const body = req.body || {};
    const source = String(body.source || "").trim();
    const paymentId = String(body.paymentId || "").trim();

    if (!source || !paymentId) {
        return res.status(400).json({ status: "error", message: "Missing 'source' or 'paymentId'." });
    }

    try {
        const item = await findByTitle(LISTS.PaidPayments, paidKey(source, paymentId));
        if (item) await deleteItem(LISTS.PaidPayments, item.id);

        res.status(200).json({ status: "success", source, paymentId, deleted: true });
    } catch (error) {
        console.error("Error in POST /paidpayments/delete:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});


export default app;
