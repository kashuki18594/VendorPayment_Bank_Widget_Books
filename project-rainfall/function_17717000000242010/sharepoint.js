import axios from "axios";

// ==========================================
// SharePoint Lists storage (Microsoft Graph, app-only / client credentials)
// ==========================================
// Required env variables (catalyst-config.json -> deployment.env_variables):
//   SP_TENANT_ID       Azure AD (Entra) tenant id
//   SP_CLIENT_ID       App registration client id
//   SP_CLIENT_SECRET   App registration client secret
//   SP_SITE_HOSTNAME   e.g. "wpsindia.sharepoint.com"
//   SP_SITE_PATH       e.g. "/sites/BankBook"
//
// One-time setup (site, lists, app registration, secret): run
//   BankBook/scripts/create-sharepoint-site.ps1
// The app gets Graph "Sites.Selected" + write on that one site only, so the
// lists must already exist (the script creates them). ensureList() below only
// auto-creates them if the app was instead given Sites.Manage.All.

const GRAPH = "https://graph.microsoft.com/v1.0";

const SP = {
    TENANT_ID: process.env.SP_TENANT_ID,
    CLIENT_ID: process.env.SP_CLIENT_ID,
    CLIENT_SECRET: process.env.SP_CLIENT_SECRET,
    SITE_HOSTNAME: process.env.SP_SITE_HOSTNAME,
    SITE_PATH: process.env.SP_SITE_PATH
};

// List schemas. "Title" is the built-in column and is used as the lookup key.
export const LISTS = {
    AppState: {
        name: "AppState",
        columns: [
            { name: "StateValue", text: { allowMultipleLines: true, textType: "plain", linesForEditing: 6 } }
        ]
    },
    PaidPayments: {
        name: "PaidPayments",
        columns: [
            { name: "Source", text: {}, indexed: true },
            { name: "PaymentId", text: {} },
            { name: "PaymentNumber", text: {} },
            { name: "VendorName", text: {} },
            { name: "Amount", text: {} },
            { name: "UTR", text: {} },
            { name: "PaidAt", text: {} },
            { name: "ExpireAt", number: {} }
        ]
    }
};

// ---- Token + site id (cached per warm container) ----
let tokenCache = { token: null, expiresAt: 0 };
let siteIdCache = null;
const ensuredLists = new Set();

function assertConfigured() {
    const missing = Object.entries(SP).filter(([, v]) => !v).map(([k]) => `SP_${k}`);
    if (missing.length) {
        throw new Error(`SharePoint is not configured. Missing env: ${missing.join(", ")}`);
    }
}

async function getToken() {
    if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60_000) {
        return tokenCache.token;
    }
    assertConfigured();

    const form = new URLSearchParams({
        grant_type: "client_credentials",
        client_id: SP.CLIENT_ID,
        client_secret: SP.CLIENT_SECRET,
        scope: "https://graph.microsoft.com/.default"
    });

    const { data } = await axios.post(
        `https://login.microsoftonline.com/${SP.TENANT_ID}/oauth2/v2.0/token`,
        form.toString(),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return tokenCache.token;
}

async function graph(method, path, body) {
    const token = await getToken();
    try {
        const { data } = await axios({
            method,
            url: path.startsWith("http") ? path : `${GRAPH}${path}`,
            data: body,
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
                // Allows $filter on columns that are not indexed (small lists).
                Prefer: "HonorNonIndexedQueriesWarningMayFailRandomly"
            }
        });
        return data;
    } catch (error) {
        // Surface Graph's own error message instead of a bare "Request failed with status code 4xx".
        const graphMsg = error.response?.data?.error?.message;
        const err = new Error(graphMsg ? `SharePoint: ${graphMsg}` : error.message);
        err.status = error.response?.status;
        throw err;
    }
}

async function getSiteId() {
    if (siteIdCache) return siteIdCache;
    assertConfigured();
    const path = SP.SITE_PATH.startsWith("/") ? SP.SITE_PATH : `/${SP.SITE_PATH}`;
    const site = await graph("get", `/sites/${SP.SITE_HOSTNAME}:${path}`);
    siteIdCache = site.id;
    return siteIdCache;
}

// Creates the list (with its columns) the first time it's used, if missing.
async function ensureList(def) {
    if (ensuredLists.has(def.name)) return;
    const siteId = await getSiteId();
    try {
        await graph("get", `/sites/${siteId}/lists/${def.name}`);
    } catch (error) {
        if (error.status !== 404) throw error;
        await graph("post", `/sites/${siteId}/lists`, {
            displayName: def.name,
            columns: def.columns,
            list: { template: "genericList" }
        });
    }
    ensuredLists.add(def.name);
}

const odataQuote = (v) => `'${String(v).replace(/'/g, "''")}'`;

async function listUrl(def) {
    await ensureList(def);
    return `/sites/${await getSiteId()}/lists/${def.name}/items`;
}

// ---- Generic item helpers ----

/** Returns all items matching an OData filter on fields (follows paging). */
export async function queryItems(def, filter) {
    const base = await listUrl(def);
    let url = `${base}?$expand=fields&$top=999` + (filter ? `&$filter=${encodeURIComponent(filter)}` : "");
    const items = [];
    while (url) {
        const page = await graph("get", url);
        items.push(...(page.value || []));
        url = page["@odata.nextLink"] || null;
    }
    return items;
}

/** Finds a single item by its Title key, or null. */
export async function findByTitle(def, title) {
    const items = await queryItems(def, `fields/Title eq ${odataQuote(title)}`);
    return items[0] || null;
}

const isConflict = (error) =>
    error.status === 409 || error.status === 412 || /etag|unique|duplicate|has changed/i.test(error.message);

/**
 * Inserts or updates the item whose Title equals `title`.
 * Retries when a concurrent write to the same row wins first (last write wins).
 */
export async function upsertByTitle(def, title, fields) {
    for (let attempt = 1; ; attempt++) {
        try {
            return await upsertOnce(def, title, fields);
        } catch (error) {
            if (attempt >= 4 || !isConflict(error)) throw error;
            await new Promise(r => setTimeout(r, 150 * attempt + Math.random() * 150));
        }
    }
}

async function upsertOnce(def, title, fields) {
    const base = await listUrl(def);
    const existing = await findByTitle(def, title);
    if (existing) {
        await graph("patch", `${base}/${existing.id}/fields`, fields);
        return;
    }
    try {
        await graph("post", base, { fields: { Title: title, ...fields } });
    } catch (error) {
        // Title is unique: a concurrent request created the row first.
        // Rethrow as a conflict; the retry loop above then updates that row.
        if (isConflict(error)) error.status = error.status || 409;
        throw error;
    }
}

export async function deleteItem(def, itemId) {
    const base = await listUrl(def);
    await graph("delete", `${base}/${itemId}`);
}
