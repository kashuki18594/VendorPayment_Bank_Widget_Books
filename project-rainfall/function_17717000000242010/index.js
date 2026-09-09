import axios from 'axios';
import express from "express";
import catalyst from "zcatalyst-sdk-node";
import { hexToByte } from "./hexToByte.js";
import { generateHashStringKey, getExactHash } from "./computeHashSHA256.js";
import { encrypt } from "./encryptUtil.js";
import { decrypt, jsonEscape } from "./decrypt.js";

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
// 4. APP STATE  (widget persistence — replaces the widget's localStorage)
// ==========================================
// Requires a Data Store table "AppState" with columns:
//   StateKey    Varchar(255)  Unique, Mandatory
//   StateValue  Text          (JSON string)
//
//   GET  /appstate?key=<key>   -> { key, value }   (value is null when unset)
//   POST /appstate  { key, value }  -> { key, saved: true }   (value:null clears)
//
// Keys used by the widget:
//   indusindPaymentStatus   { [paymentId]: {...} }
//   indusindManualPayments  [ {...} ]
//   bankFilterSettings      { maker, authorizer, bank }

const APPSTATE_TABLE = "AppState";

async function findAppStateRow(catalystApp, key) {
    const safeKey = String(key).replace(/'/g, "''");
    const query =
        `SELECT ROWID, StateKey, StateValue FROM ${APPSTATE_TABLE} ` +
        `WHERE StateKey = '${safeKey}' LIMIT 1`;

    const rows = await catalystApp.zcql().executeZCQLQuery(query);
    if (!rows || !rows.length) return null;

    // ZCQL rows are namespaced by table name.
    return rows[0][APPSTATE_TABLE] || rows[0];
}

app.get("/appstate", async (req, res) => {
    const key = String(req.query.key || "").trim();
    if (!key) {
        return res.status(400).json({ status: "error", message: "Missing 'key' query parameter." });
    }

    try {
        const catalystApp = catalyst.initialize(req);
        const row = await findAppStateRow(catalystApp, key);

        let value = null;
        if (row && row.StateValue != null) {
            try { value = JSON.parse(row.StateValue); } catch (_) { value = null; }
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

    // `value` may be null on purpose (used to clear a key).
    const stateValue = JSON.stringify((req.body || {}).value ?? null);

    try {
        const catalystApp = catalyst.initialize(req);
        const table = catalystApp.datastore().table(APPSTATE_TABLE);

        const existing = await findAppStateRow(catalystApp, key);

        if (existing && existing.ROWID) {
            await table.updateRow({ ROWID: existing.ROWID, StateKey: key, StateValue: stateValue });
        } else {
            await table.insertRow({ StateKey: key, StateValue: stateValue });
        }

        res.status(200).json({ key, saved: true });
    } catch (error) {
        console.error("Error in POST /appstate:", error.message);
        res.status(500).json({ status: "error", message: error.message });
    }
});


export default app;