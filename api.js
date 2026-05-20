
const SureshipBackend = (() => {
  const STORAGE_KEYS = {
    TOKEN: "sureshipJwtToken",
    SYNCED_ORDER_IDS: "sureshipSyncedOrderIds",
    LOGISTICS_OVERRIDES: "sureshipLogisticsOverridesJson",
    USER_LOGISTICS: "sureshipUserLogisticsJson",
    REMEMBERED_USERNAME: "sureshipRememberedUsername",
    REMEMBERED_PASSWORD: "sureshipRememberedPassword",
  };

  const API_BASE = "http://localhost:3500";
  const BOOKING_SOURCE = "amazonscrap";

  function storageGet(keys) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.get(keys, (result) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve(result);
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function storageSet(items) {
    return new Promise((resolve, reject) => {
      try {
        chrome.storage.local.set(items, () => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          resolve();
        });
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  function getApiBaseUrl() {
    return API_BASE.replace(/\/$/, "");
  }

  async function getToken() {
    const data = await storageGet([STORAGE_KEYS.TOKEN]);
    return String(data[STORAGE_KEYS.TOKEN] || "").trim();
  }

  function pickApiErrorMessage(data, text, fallback) {
    if (data && typeof data.message === "string" && data.message.trim()) {
      return data.message.trim();
    }
    if (data && typeof data.error === "string" && data.error.trim()) {
      return data.error.trim();
    }
    const raw = String(text || "").trim();
    if (raw) return raw;
    return fallback;
  }

  function explainUnauthorized(status, message, context = "api") {
    const m = String(message || "").trim();
    if (status !== 401 || !/^unauthorized$/i.test(m)) {
      return m || (status ? `HTTP ${status}` : "Request failed");
    }
    if (context === "login") {
      return "Wrong username or password, or account is inactive. Use the same Sureship username as the website (try all lowercase).";
    }
    return "Sureship rejected the request (401). Click Save again. If it repeats, reload the extension and check the backend is running on port 3500.";
  }

  async function setToken(token) {
    await storageSet({ [STORAGE_KEYS.TOKEN]: String(token || "") });
    console.log("[SureshipBackend] JWT stored in chrome.storage.local");
  }

  async function clearToken() {
    await storageSet({
      [STORAGE_KEYS.TOKEN]: "",
      [STORAGE_KEYS.USER_LOGISTICS]: "",
    });
    console.log("[SureshipBackend] JWT and user logistics cleared");
  }

  function decodeJwtPayload(token) {
    try {
      const part = String(token || "").trim().split(".")[1];
      if (!part) return null;
      const json = atob(part.replace(/-/g, "+").replace(/_/g, "/"));
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  /** True if JWT exists and is not past expiry (Sureship access token is ~2h). */
  async function isAccessTokenValid() {
    const token = await getToken();
    if (!token) return false;
    const payload = decodeJwtPayload(token);
    const exp = payload?.exp;
    if (typeof exp !== "number") return true;
    const skewMs = 60_000;
    return Date.now() < exp * 1000 - skewMs;
  }

  async function getRememberedCredentials() {
    const data = await storageGet([
      STORAGE_KEYS.REMEMBERED_USERNAME,
      STORAGE_KEYS.REMEMBERED_PASSWORD,
    ]);
    const username = String(data[STORAGE_KEYS.REMEMBERED_USERNAME] || "").trim();
    const password = String(data[STORAGE_KEYS.REMEMBERED_PASSWORD] || "");
    if (!username || !password) return null;
    return { username: username.toLowerCase(), password };
  }

  async function rememberCredentials(username, password) {
    const u = String(username || "").trim().toLowerCase();
    const p = String(password ?? "");
    if (!u || !p) return;
    await storageSet({
      [STORAGE_KEYS.REMEMBERED_USERNAME]: u,
      [STORAGE_KEYS.REMEMBERED_PASSWORD]: p,
    });
    console.log("[SureshipBackend] Saved username/password for next sessions (local only).");
  }

  async function clearRememberedCredentials() {
    await storageSet({
      [STORAGE_KEYS.REMEMBERED_USERNAME]: "",
      [STORAGE_KEYS.REMEMBERED_PASSWORD]: "",
    });
    console.log("[SureshipBackend] Cleared remembered credentials");
  }

  //warehouse and cusotemrcode logic here

  function buildLogisticsFromWarehouse(warehouse, customerCode) {
    const wh = warehouse || {};
    const code = Number(customerCode);
    const pickupLocation = {
      customer_code: code,
      name: String(wh.pickupName || wh.name || "").trim(),
      phone: String(wh.pickupPhone || wh.phone || "").trim(),
      address: String(wh.pickupAddress || wh.address || "").trim(),
      pinCode: String(wh.pickupPinCode || wh.pin || "").trim(),
      city: String(wh.pickupCity || wh.city || "").trim(),
      state: String(wh.pickupState || wh.state || "").trim(),
      country: String(wh.pickupCountry || wh.country || "India").trim(),
    };
    if (wh.id != null && !Number.isNaN(Number(wh.id))) {
      pickupLocation.warehouseId = Number(wh.id);
    }

    const returnBlock = {
      returnName: pickupLocation.name,
      returnPhone: pickupLocation.phone,
      returnAltPhone: String(wh.pickupAltPhone || wh.altPhone || "").trim(),
      returnEmail: String(wh.pickupEmail || wh.email || "").trim(),
      returnAddress: String(
        wh.returnpickupAddress || wh.returnAddress || pickupLocation.address
      ).trim(),
      returnPin: String(wh.returnpickupPinCode || wh.returnPin || pickupLocation.pinCode).trim(),
      returnCity: String(wh.returnpickupCity || wh.returnCity || pickupLocation.city).trim(),
      returnState: String(wh.returnpickupState || wh.returnState || pickupLocation.state).trim(),
      returnCountry: pickupLocation.country,
    };

    return { pickupLocation, returnBlock };
  }


  //this function is for fetching the warehouse form api 
  async function fetchAndStoreUserLogistics(token) {
    const jwt = decodeJwtPayload(token);
    const codes = jwt?.UserInfo?.codes;
    if (!Array.isArray(codes) || !codes.length) {
      throw new Error("Logged-in user has no customer code. Contact admin.");
    }
    const customerCode = Number(codes[0]);
    if (Number.isNaN(customerCode)) {
      throw new Error("Invalid customer code on user account.");
    }

    const apiBase = getApiBaseUrl();
    const url = `${apiBase}/warehouse/get_my_warehouses`;
    console.log("[SureshipBackend] POST", url, "customer_code:", customerCode);
    const authToken = String(token || "").trim();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const rawMsg = pickApiErrorMessage(data, text, `HTTP ${res.status}`);
      const msg = explainUnauthorized(res.status, rawMsg, "api");
      throw new Error(typeof msg === "string" ? msg : "Failed to load warehouses");
    }

    const warehouses = Array.isArray(data?.warehouses) ? data.warehouses : [];
    const warehouse = data?.defaultWarehouse || warehouses[0];
    if (!warehouse) {
      throw new Error("No warehouse configured for this user. Set a default warehouse in Sureship.");
    }

    const logistics = buildLogisticsFromWarehouse(warehouse, customerCode);
    await storageSet({ [STORAGE_KEYS.USER_LOGISTICS]: JSON.stringify(logistics) });
    console.log("[SureshipBackend] User logistics stored:", {
      customer_code: logistics.pickupLocation.customer_code,
      warehouseId: logistics.pickupLocation.warehouseId ?? null,
      name: logistics.pickupLocation.name,
    });
    return logistics;
  }

  async function getUserLogistics(options = {}) {
    const { refresh = false } = options;
    if (!refresh) {
      const data = await storageGet([STORAGE_KEYS.USER_LOGISTICS]);
      const raw = data[STORAGE_KEYS.USER_LOGISTICS];
      if (raw && typeof raw === "string") {
        try {
          const parsed = JSON.parse(raw);
          if (parsed?.pickupLocation && parsed?.returnBlock) {
            return parsed;
          }
        } catch {
          console.warn("[SureshipBackend] sureshipUserLogisticsJson invalid");
        }
      }
    }
    const token = await getToken();
    if (!token) {
      throw new Error("Not logged in: missing JWT. Login first.");
    }
    return fetchAndStoreUserLogistics(token);
  }

  async function getSyncedOrderIds() {
    const data = await storageGet([STORAGE_KEYS.SYNCED_ORDER_IDS]);
    const raw = data[STORAGE_KEYS.SYNCED_ORDER_IDS];
    if (!Array.isArray(raw)) return [];
    return raw.map((id) => String(id || "").trim()).filter(Boolean);
  }

  async function appendSyncedOrderIds(orderIds) {
    const existing = new Set(await getSyncedOrderIds());
    for (const id of orderIds) {
      const trimmed = String(id || "").trim();
      if (trimmed) existing.add(trimmed);
    }
    const next = Array.from(existing);
    await storageSet({ [STORAGE_KEYS.SYNCED_ORDER_IDS]: next });
    console.log("[SureshipBackend] Synced order IDs updated:", next.length, "total");
  }

  function normalizeOrderId(value) {
    const text = String(value || "");
    const match = text.match(/\d{3}-\d{7}-\d{7}/);
    return match ? match[0] : text.trim();
  }

  function parseMoney(value) {
    const text = String(value ?? "").replace(/[^\d.-]/g, "");
    const n = parseFloat(text);
    return Number.isFinite(n) ? n : 0;
  }

  function parseQuantity(value) {
    const n = parseInt(String(value ?? "").replace(/\D/g, ""), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  function formatOrderDateForApi(purchaseDate) {
    const raw = String(purchaseDate || "").trim();
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) {
      const d = new Date(parsed);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}/${m}/${day}`;
    }
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const day = String(now.getDate()).padStart(2, "0");
    return `${y}/${m}/${day}`;
  }

  async function getLogisticsOverrides() {
    try {
      const data = await storageGet([STORAGE_KEYS.LOGISTICS_OVERRIDES]);
      const raw = data[STORAGE_KEYS.LOGISTICS_OVERRIDES];
      if (!raw || typeof raw !== "string") {
        return { pickupLocation: null, returnBlock: null };
      }
      const o = JSON.parse(raw);
      return {
        pickupLocation: o && typeof o.pickupLocation === "object" ? o.pickupLocation : null,
        returnBlock: o && typeof o.returnBlock === "object" ? o.returnBlock : null,
      };
    } catch {
      console.warn("[SureshipBackend] sureshipLogisticsOverridesJson invalid, using default pickup/return");
      return { pickupLocation: null, returnBlock: null };
    }
  }

  /** Match full state / UT names often present on Amazon India ship-to. */
  const INDIAN_STATE_NAMES = [
    "Andhra Pradesh",
    "Arunachal Pradesh",
    "Assam",
    "Bihar",
    "Chhattisgarh",
    "Goa",
    "Gujarat",
    "Haryana",
    "Himachal Pradesh",
    "Jharkhand",
    "Karnataka",
    "Kerala",
    "Madhya Pradesh",
    "Maharashtra",
    "Manipur",
    "Meghalaya",
    "Mizoram",
    "Nagaland",
    "Odisha",
    "Punjab",
    "Rajasthan",
    "Sikkim",
    "Tamil Nadu",
    "Telangana",
    "Tripura",
    "Uttar Pradesh",
    "Uttarakhand",
    "West Bengal",
    "Delhi",
    "NCT of Delhi",
    "Jammu and Kashmir",
    "Ladakh",
    "Puducherry",
    "Andaman and Nicobar Islands",
    "Chandigarh",
    "Dadra and Nagar Haveli",
    "Daman and Diu",
    "Lakshadweep",
  ];

  function findIndianStateInText(text) {
    const hay = String(text || "");
    const sorted = [...INDIAN_STATE_NAMES].sort((a, b) => b.length - a.length);
    for (const s of sorted) {
      if (hay.toLowerCase().includes(s.toLowerCase())) {
        if (/^nct of delhi$/i.test(s)) return "Delhi";
        return s;
      }
    }
    const two = hay.match(/\b(DL|UP|MP|UK|HR|PB|RJ|GJ|MH|KA|KL|TN|TS|WB|BR|JH|OR|AS|NL|MN|TR|MZ|AR|SK|GA|HP|JK)\b/i);
    if (two) {
      const abbr = {
        DL: "Delhi",
        UP: "Uttar Pradesh",
        MP: "Madhya Pradesh",
        UK: "Uttarakhand",
        HR: "Haryana",
        PB: "Punjab",
        RJ: "Rajasthan",
        GJ: "Gujarat",
        MH: "Maharashtra",
        KA: "Karnataka",
        KL: "Kerala",
        TN: "Tamil Nadu",
        TS: "Telangana",
        WB: "West Bengal",
        BR: "Bihar",
        JH: "Jharkhand",
        OR: "Odisha",
        AS: "Assam",
        NL: "Nagaland",
        MN: "Manipur",
        TR: "Tripura",
        MZ: "Mizoram",
        AR: "Arunachal Pradesh",
        SK: "Sikkim",
        GA: "Goa",
        HP: "Himachal Pradesh",
        JK: "Jammu and Kashmir",
      };
      return abbr[two[1].toUpperCase()] || "";
    }
    return "";
  }

  /** Rough India PIN (first 3 digits) → state when address line omits state name. */
  function inferIndiaStateFromPin(pin6) {
    const p = String(pin6 || "").replace(/\D/g, "");
    if (p.length !== 6) return "";
    const pre = p.slice(0, 3);
    const map = {
      "110": "Delhi",
      "111": "Delhi",
      "112": "Delhi",
      "121": "Haryana",
      "122": "Haryana",
      "123": "Haryana",
      "124": "Haryana",
      "125": "Haryana",
      "126": "Haryana",
      "127": "Haryana",
      "128": "Haryana",
      "129": "Haryana",
      "130": "Haryana",
      "131": "Haryana",
      "132": "Haryana",
      "133": "Haryana",
      "134": "Haryana",
      "135": "Haryana",
      "136": "Haryana",
      "140": "Punjab",
      "141": "Punjab",
      "142": "Punjab",
      "143": "Punjab",
      "144": "Punjab",
      "145": "Punjab",
      "146": "Punjab",
      "147": "Punjab",
      "148": "Punjab",
      "151": "Punjab",
      "152": "Punjab",
      "160": "Chandigarh",
      "171": "Himachal Pradesh",
      "172": "Himachal Pradesh",
      "173": "Himachal Pradesh",
      "174": "Himachal Pradesh",
      "175": "Himachal Pradesh",
      "176": "Himachal Pradesh",
      "177": "Himachal Pradesh",
      "180": "Jammu and Kashmir",
      "181": "Jammu and Kashmir",
      "182": "Jammu and Kashmir",
      "190": "Jammu and Kashmir",
      "201": "Uttar Pradesh",
      "202": "Uttar Pradesh",
      "203": "Uttar Pradesh",
      "226": "Uttar Pradesh",
      "302": "Rajasthan",
      "303": "Rajasthan",
      "380": "Gujarat",
      "382": "Gujarat",
      "390": "Gujarat",
      "400": "Maharashtra",
      "401": "Maharashtra",
      "410": "Maharashtra",
      "411": "Maharashtra",
      "421": "Maharashtra",
      "440": "Maharashtra",
      "452": "Madhya Pradesh",
      "462": "Madhya Pradesh",
      "500": "Telangana",
      "501": "Telangana",
      "502": "Telangana",
      "560": "Karnataka",
      "562": "Karnataka",
      "600": "Tamil Nadu",
      "641": "Tamil Nadu",
      "682": "Kerala",
      "695": "Kerala",
      "700": "West Bengal",
      "711": "West Bengal",
      "713": "West Bengal",
      "721": "West Bengal",
      "734": "West Bengal",
      "737": "Sikkim",
      "751": "Odisha",
      "800": "Bihar",
      "834": "Jharkhand",
    };
    return map[pre] || "";
  }

  function extractIndianMobileFromText(text) {
    const t = String(text || "").replace(/\s+/g, " ");
    const candidates = [];
    const reIn = /(?:\+91[\s.-]*)?([6-9]\d{9})\b/g;
    let m;
    while ((m = reIn.exec(t)) !== null) {
      candidates.push(m[1].replace(/\D/g, "").slice(-10));
    }
    const re10 = /\b(\d{10})\b/g;
    while ((m = re10.exec(t)) !== null) {
      const d = m[1];
      if (/^[6-9]/.test(d)) candidates.push(d);
    }
    const uniq = [...new Set(candidates)];
    return uniq[0] || "";
  }

  function guessCountryFromAddress(text) {
    const t = String(text || "");
    if (/\bIndia\b/i.test(t)) return "India";
    if (/\bUnited States of America\b|\bUnited States\b|\bUSA\b/i.test(t)) return "United States";
    if (/\bUnited Kingdom\b|\bUK\b/i.test(t)) return "United Kingdom";
    if (/\bCanada\b/i.test(t)) return "Canada";
    return "";
  }

  function inferPaymentAndCod(rows) {
    const blob = rows
      .map((r) => [r.orderStatus, r.fulfillment, r.itemSubtotal].filter(Boolean).join(" "))
      .join(" ")
      .toLowerCase();
    const looksCod =
      /\bcod\b/.test(blob) ||
      /\bcash on delivery\b/.test(blob) ||
      /\bpay on delivery\b/.test(blob);
    const total = rows.reduce((sum, r) => sum + parseMoney(r.itemSubtotal), 0);
    const totalFromUnit = rows.reduce((sum, r) => {
      const qty = parseQuantity(r.quantity);
      return sum + parseMoney(r.unitPrice) * qty;
    }, 0);
    const amount = total > 0 ? total : totalFromUnit;
    if (looksCod) {
      return { paymentMode: "cod", codAmount: String(Number.isFinite(amount) ? amount : "") };
    }
    return { paymentMode: "prepaid", codAmount: "" };
  }

  function splitAddressBlob(addressText, buyerName) {
    const full = String(addressText || "").trim();
    const name = String(buyerName || "").trim();
    let rest = full;
    if (name && full.toLowerCase().startsWith(name.toLowerCase())) {
      rest = full.slice(name.length).replace(/^[\s,]+/, "").trim();
    }
    const pinMatch = rest.match(/\b(\d{6})\b/);
    let pinCode = pinMatch ? pinMatch[1] : "";
    if (!/^\d{6}$/.test(pinCode)) {
      const any = String(rest || full).match(/\b(\d{6})\b/g);
      if (any && any[0]) pinCode = any[0];
    }
    let city = "";
    let state = "";
    const parts = rest
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const secondLast = parts[parts.length - 2];
      if (pinCode && last.includes(pinCode)) {
        const beforePin = last.replace(pinCode, "").trim();
        const tokens = beforePin.split(/\s+/).filter(Boolean);
        if (tokens.length >= 2) {
          state = tokens.pop() || "";
          city = tokens.join(" ");
        } else if (tokens.length === 1) {
          city = tokens[0] || "";
        }
        if (!city && secondLast) city = secondLast;
      } else {
        city = secondLast || "";
        const statePin = last.split(/\s+/).filter(Boolean);
        state = statePin.length > 1 ? statePin.slice(0, -1).join(" ") : statePin[0] || "";
      }
    } else if (parts.length === 1 && pinCode) {
      const beforePin = parts[0].replace(pinCode, "").trim();
      const tokens = beforePin.split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        state = tokens.pop() || "";
        city = tokens.join(" ");
      } else if (tokens.length === 1) {
        city = tokens[0] || "";
      }
    }
    const guessed = guessCountryFromAddress(full);
    const country = guessed || (/\b\d{6}\b/.test(full) ? "India" : "");
    if (!state) {
      state = findIndianStateInText(full) || findIndianStateInText(rest);
    }
    if (!state && pinCode.length === 6) {
      state = inferIndiaStateFromPin(pinCode);
    }
    if (!city && state) {
      city = state;
    }
    return {
      address: rest || full,
      pinCode,
      city,
      state,
      country,
    };
  }

  function weightFromScrapedRows(rows) {
    const totalQty = rows.reduce((s, r) => s + parseQuantity(r.quantity), 0);
    const kg = Math.max(0.6, Math.min(30, totalQty * 0.2));
    return kg.toFixed(2);
  }

  function buildShipmentFromRows(orderId, rows, mergedReturnBlock) {
    const primary = rows[0] || {};
    const buyerName = String(primary.buyerName || "").trim();
    const shippingAddress = String(primary.shippingAddress || "").trim();
    const addr = splitAddressBlob(shippingAddress, buyerName);

    const invoiceValue = rows.reduce((sum, row) => {
      const qty = parseQuantity(row.quantity);
      const unit = parseMoney(row.unitPrice);
      return sum + unit * qty;
    }, 0);
    const totalFromSubtotal = rows.reduce((sum, r) => sum + parseMoney(r.itemSubtotal), 0);
    const totalAmount = invoiceValue > 0 ? invoiceValue : totalFromSubtotal;
    const { paymentMode, codAmount } = inferPaymentAndCod(rows);

    const orderItemIds = rows
      .map((r) => String(r.orderItemId || "").trim())
      .filter(Boolean);
    const clientRef = normalizeOrderId(orderId);

    const weightKg = weightFromScrapedRows(rows);
    const numBoxes = "1";

    const contentDetails = rows.map((row, index) => ({
      productId: index,
      productName: String(row.productName || "").trim() || "Item",
      quantity: parseQuantity(row.quantity),
      unitPrice: parseMoney(row.unitPrice),
      hsncode: String(row.asin || row.sku || "").trim(),
    }));

    const firstAsin = rows.map((r) => String(r.asin || "").trim()).find(Boolean) || "";

    const fullContactText = `${shippingAddress} ${buyerName}`.trim();
    let phone = String(primary.buyerPhone || "").trim() || extractIndianMobileFromText(fullContactText);
    if (!phone) {
      phone = String(mergedReturnBlock.returnPhone || "").trim();
      if (phone) {
        console.warn(
          "[SureshipBackend] Buyer phone not on Amazon page; using warehouse phone for mandatory field:",
          buyerName
        );
      }
    }

    let city = String(addr.city || "").trim();
    let state = String(addr.state || "").trim();
    if (!state) {
      state =
        findIndianStateInText(shippingAddress) ||
        findIndianStateInText(fullContactText) ||
        (addr.pinCode && addr.pinCode.length === 6 ? inferIndiaStateFromPin(addr.pinCode) : "") ||
        String(mergedReturnBlock.returnState || "").trim();
    }
    if (!city) {
      city =
        (addr.pinCode && addr.pinCode.length === 6 ? inferIndiaStateFromPin(addr.pinCode) : "") ||
        state ||
        String(mergedReturnBlock.returnCity || "").trim();
    }

    let pinCode = String(addr.pinCode || "").replace(/\D/g, "").slice(0, 6);
    if (!/^\d{6}$/.test(pinCode)) {
      pinCode = String(mergedReturnBlock.returnPin || "").replace(
        /\D/g,
        ""
      );
      if (/^\d{6}$/.test(pinCode)) {
        console.warn(
          "[SureshipBackend] No 6-digit PIN in Amazon ship-to; using warehouse PIN (fix address on Amazon if wrong):",
          buyerName
        );
      } else {
        pinCode = "";
      }
    }

    if (!state && /^\d{6}$/.test(pinCode)) {
      state =
        inferIndiaStateFromPin(pinCode) ||
        String(mergedReturnBlock.returnState || "").trim();
    }
    if (!city) {
      city =
        String(mergedReturnBlock.returnCity || "").trim() ||
        state ||
        "Locality pending";
    }

    return {
      orderId: normalizeOrderId(orderId),
      name: buyerName,
      phone,
      altPhone: String(primary.buyerAltPhone || "").trim(),
      email: String(primary.buyerEmail || "").trim(),
      address: addr.address,
      pinCode,
      city,
      state,
      country: addr.country || "India",
      ...mergedReturnBlock,
      paymentMode,
      packingType: "box",
      contentCategory: String(primary.fulfillment || primary.orderStatus || "").trim(),
      clientRefrenceNumber: clientRef,
      hsnCode: firstAsin,
      codAmount,
      invoiceValue: Number.isFinite(invoiceValue) ? invoiceValue : 0,
      invoiceNumber: "",
      orderDate: formatOrderDateForApi(primary.purchaseDate),
      totalAmount: Number.isFinite(totalAmount) ? totalAmount : 0,
      sellerAddress: String(primary.sellerAddress || "").trim(),
      sellerName: String(primary.sellerName || "").trim(),
      sellerInvoice: "",
      sellerGstIn: "",
      ewayBillNumber: "",
      weight: weightKg,
      shippingService: String(primary.shippingService || "").trim(),
      shippingServiceCategory: "b2c",
      riskType: "ownerRisk",
      addressType: String(primary.fulfillment || "").trim(),
      lsp: String(primary.shippingService || "").trim(),
      isSelfDrop: false,
      weightDetails: [
        {
          boxId: 0,
          docketNumber: orderItemIds[0] || "",
          numberOfBoxes: numBoxes,
          weightKg,
          lengthCm: "5",
          breadthCm: "7",
          heightCm: "6",
        },
      ],
      contentDetails,
      ShipmentDocument: [],
    };
  }

  function groupRowsByOrderId(rows) {
    const map = new Map();
    for (const row of rows) {
      const id = normalizeOrderId(row.orderId);
      if (!id) continue;
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(row);
    }
    return Array.from(map.entries()).map(([id, grouped]) => ({ orderId: id, rows: grouped }));
  }

  async function login(username, password) {
    const apiBase = getApiBaseUrl();
    const url = `${apiBase}/auth/login`;
    const user = String(username || "").trim().toLowerCase();
    const pass = String(password ?? "");
    console.log("[SureshipBackend] POST", url);
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ username: user, password: pass }),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const rawMsg = pickApiErrorMessage(data, text, `HTTP ${res.status}`);
      const msg = explainUnauthorized(res.status, rawMsg, "login");
      console.error("[SureshipBackend] Login failed:", res.status, msg);
      throw new Error(typeof msg === "string" ? msg : "Login failed");
    }
    const token = String(
      data?.accessToken ||
      data?.token ||
      data?.data?.accessToken ||
      data?.data?.token ||
      ""
    ).trim();
    if (!token) {
      console.error("[SureshipBackend] Login response missing token:", data);
      throw new Error("Login response did not include accessToken or token");
    }
    await setToken(token);
    const logistics = await fetchAndStoreUserLogistics(token);
    return { token, data, logistics };
  }

  async function createOrder(payload) {
    const apiBase = getApiBaseUrl();
    const token = await getToken();
    if (!token) {
      throw new Error("Not logged in: missing JWT. Login first.");
    }
    const url = `${apiBase}/booking/createOrder`;
    console.log("[SureshipBackend] POST", url, "shipments:", payload?.shipments?.length ?? 0);
    const authToken = String(token || "").trim();
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${authToken}`,
      },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    if (!res.ok) {
      const rawMsg = pickApiErrorMessage(data, text, `HTTP ${res.status}`);
      const msg =
        res.status === 401 ? explainUnauthorized(res.status, rawMsg, "api") : rawMsg;
      console.error("[SureshipBackend] createOrder failed:", res.status, msg);
      throw new Error(typeof msg === "string" ? msg : "createOrder failed");
    }
    console.log("[SureshipBackend] createOrder success:", res.status, data);
    return data;
  }

  function buildCreateOrderBody(shipments, pickupLocation) {
    return {
      shipments,
      pickupLocation,
      lspName: "",
      shippingServiceCategory: "b2c",
      source: BOOKING_SOURCE,
    };
  }

  /**
   * @param {Array<Record<string, unknown>>} exportRows - rows from buildExportRows / CSV pipeline
   */
  async function syncExportRowsToDb(exportRows) {
    if (!Array.isArray(exportRows) || !exportRows.length) {
      console.log("[SureshipBackend] sync skipped: no rows");
      return { synced: [], skipped: [], errors: [] };
    }
    const token = await getToken();
    if (!token) {
      console.warn("[SureshipBackend] sync skipped: not logged in");
      return { synced: [], skipped: [], errors: ["Not logged in"] };
    }

    let userLogistics;
    try {
      userLogistics = await getUserLogistics();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[SureshipBackend] sync skipped: user logistics unavailable:", message);
      return { synced: [], skipped: [], errors: [message] };
    }

    const overrides = await getLogisticsOverrides();
    const mergedReturn = { ...userLogistics.returnBlock, ...(overrides.returnBlock || {}) };
    const pickupLocation = { ...userLogistics.pickupLocation, ...(overrides.pickupLocation || {}) };

    const groups = groupRowsByOrderId(exportRows);
    const syncedIds = new Set(await getSyncedOrderIds());
    const toSend = [];
    const skipped = [];

    for (const { orderId, rows } of groups) {
      if (!orderId) continue;
      if (syncedIds.has(orderId)) {
        console.log("[SureshipBackend] skip duplicate orderId:", orderId);
        skipped.push(orderId);
        continue;
      }
      toSend.push(buildShipmentFromRows(orderId, rows, mergedReturn));
    }

    if (!toSend.length) {
      console.log("[SureshipBackend] nothing new to sync (all duplicates or empty)");
      return { synced: [], skipped, errors: [] };
    }

    const body = buildCreateOrderBody(toSend, pickupLocation);
    try {
      console.log(
        "[SureshipBackend] createOrder payload from scrape (first shipment keys):",
        Object.keys(toSend[0] || {})
      );
      await createOrder(body);
      const newIds = toSend.map((s) => s.orderId).filter(Boolean);
      await appendSyncedOrderIds(newIds);
      console.log("[SureshipBackend] synced order IDs:", newIds);
      return { synced: newIds, skipped, errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[SureshipBackend] sync failed:", message);
      return { synced: [], skipped, errors: [message] };
    }
  }

  async function updateAuthUi() {
    const token = await getToken();
    const el = document.getElementById("authState");
    if (el) {
      el.textContent = token ? "Logged in" : "Not logged in";
    }
    const header = document.getElementById("headerStatus");
    const headerText = document.getElementById("headerStatusText");
    if (header && headerText) {
      header.classList.toggle("offline", !token);
      headerText.textContent = token ? "Connected" : "Offline";
    }
  }

  return {
    STORAGE_KEYS,
    API_BASE: getApiBaseUrl(),
    getApiBaseUrl,
    getToken,
    setToken,
    clearToken,
    isAccessTokenValid,
    getRememberedCredentials,
    rememberCredentials,
    clearRememberedCredentials,
    getSyncedOrderIds,
    appendSyncedOrderIds,
    login,
    getUserLogistics,
    createOrder,
    syncExportRowsToDb,
    updateAuthUi,
    groupRowsByOrderId,
    buildCreateOrderBody,
  };
})();
