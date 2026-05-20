const AMAZON_ORDERS_PREFIX = "https://sellercentral.amazon.in/orders-v3/";
const AMAZON_BASE_URL = "https://sellercentral.amazon.in";
const ORDER_DETAIL_URL_PREFIX = `${AMAZON_BASE_URL}/orders-v3/order/`;

let activeTabId = null;
/** One shared in-flight login so Save + auto-login never collide with "return false". */
let loginFlightPromise = null;
let autoLoginTimer = null;

function byId(id) {
  return document.getElementById(id);
}

function setStatusBarState(state) {
  const bar = byId("statusBar");
  if (!bar) return;
  bar.classList.remove("busy", "error");
  if (state === "busy") bar.classList.add("busy");
  if (state === "error") bar.classList.add("error");
}

function setStatus(text, sub, state = "idle") {
  const primary = byId("statusText");
  if (primary) primary.textContent = text;
  const subNode = byId("statusSub");
  if (subNode && sub !== undefined) subNode.textContent = sub;
  setStatusBarState(state === "error" ? "error" : state === "busy" ? "busy" : "idle");
}

function setAuthMessage(text, type) {
  const node = byId("authMessage");
  if (!node) return;
  node.textContent = text || "";
  node.classList.remove("success", "error");
  if (type) node.classList.add(type);
}

function setSaveButtonDisabled(disabled) {
  const btn = byId("saveToDbBtn");
  if (btn) btn.disabled = Boolean(disabled);
}

function hideToast() {
  const overlay = byId("toastOverlay");
  if (!overlay) return;
  overlay.classList.remove("show");
  overlay.setAttribute("aria-hidden", "true");
}

function showToast(title, message) {
  const overlay = byId("toastOverlay");
  const titleEl = byId("toastTitle");
  const messageEl = byId("toastMessage");
  if (!overlay || !titleEl || !messageEl) return;
  hideToast();
  titleEl.textContent = title;
  messageEl.textContent = message;
  overlay.classList.add("show");
  overlay.setAttribute("aria-hidden", "false");
}

function initToast() {
  const overlay = byId("toastOverlay");
  const closeBtn = byId("toastCloseBtn");
  if (closeBtn) closeBtn.addEventListener("click", hideToast);
  if (overlay) {
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) hideToast();
    });
  }
}

function formatSaveDbResult(syncResult) {
  const synced = syncResult?.synced?.length ?? 0;
  const skipped = syncResult?.skipped?.length ?? 0;
  if (synced > 0 && skipped === 0) {
    return { title: "Saved successfully", message: `${synced} order(s) saved to database.` };
  }
  if (synced > 0 && skipped > 0) {
    return {
      title: "Partially saved",
      message: `${synced} order(s) saved. ${skipped} duplicate(s) skipped.`,
    };
  }
  if (synced === 0 && skipped > 0) {
    return {
      title: "Already in database",
      message: `No new orders. ${skipped} duplicate(s) skipped.`,
    };
  }
  return { title: "Nothing to save", message: "No new orders were saved." };
}

function pickOrderId(text) {
  const source = String(text || "");
  const match = source.match(/\d{3}-\d{7}-\d{7}/);
  return match ? match[0] : source.trim();
}

function pickLabelValue(text, label) {
  const source = String(text || "");
  const match = source.match(new RegExp(`${label}\\s*:\\s*([^\\n]+)`, "i"));
  return match ? match[1].trim() : "";
}

function normalizeOrder(order) {
  const raw = Array.isArray(order?.raw) ? order.raw : [];
  const orderInfo = raw[1] || "";
  const productInfo = raw[2] || "";
  const orderType = raw[3] || "";
  const statusInfo = raw[4] || "";

  return {
    orderId: order?.orderId ? pickOrderId(order.orderId) : pickOrderId(orderInfo),
    buyerName: order?.buyerName ?? order?.buyer ?? pickLabelValue(orderInfo, "Buyer name"),
    productName:
      order?.productName ??
      order?.skuOrAsin ??
      productInfo.split(" ASIN:")[0]?.trim() ??
      "",
    asin: order?.asin ?? pickLabelValue(productInfo, "ASIN"),
    sku: order?.sku ?? pickLabelValue(productInfo, "SKU"),
    quantity: order?.quantity ?? pickLabelValue(productInfo, "Quantity"),
    itemSubtotal: order?.itemSubtotal ?? pickLabelValue(productInfo, "Item subtotal"),
    orderType: order?.orderType ?? orderType.split(" Ship by date")[0]?.trim() ?? "",
    orderStatus: order?.orderStatus ?? order?.status ?? statusInfo,
    shipByDate: order?.shipByDate ?? pickLabelValue(orderType, "Ship by date"),
    deliverByDate: order?.deliverByDate ?? pickLabelValue(orderType, "Deliver by date"),
  };
}

function buildOrderDetailUrl(orderId) {
  const id = pickOrderId(orderId).trim();
  if (!/^\d{3}-\d{7}-\d{7}$/.test(id)) return "";
  return `${ORDER_DETAIL_URL_PREFIX}${id}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("Tab load timeout"));
    }, timeoutMs);

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve();
      }
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

/**
 * Ensures content.js is in the tab so sendMessage does not fail with
 * "Could not establish connection. Receiving end does not exist."
 */
async function ensureAmazonScraperContentScript(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: false },
      files: ["content.js"],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[popup] inject content.js:", msg);
    throw new Error(
      "Cannot run scraper on this tab. Open https://sellercentral.amazon.in orders (list or order detail) and try again."
    );
  }
}

async function scrapeActiveTab(tabId) {
  await ensureAmazonScraperContentScript(tabId);
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: "SCRAPE_AMAZON_ORDERS" }, (response) => {
      if (chrome.runtime.lastError) {
        const raw = chrome.runtime.lastError.message || "Scrape failed.";
        if (/Receiving end does not exist/i.test(raw)) {
          reject(
            new Error(
              "Scraper could not reach this page. Refresh the Amazon orders tab, then open this popup again."
            )
          );
          return;
        }
        reject(new Error(raw));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "No response received."));
        return;
      }
      resolve(response.data);
    });
  });
}

function detailStubFromOrderDetails(details, pageUrl) {
  return {
    orderId: details?.orderId || pickOrderId(pageUrl || ""),
    buyerName: details?.buyerName || "",
    orderStatus: "",
    shipByDate: details?.shipBy || "",
    deliverByDate: details?.deliverBy || "",
    orderType: details?.fulfillment || "",
    productName: "",
    asin: "",
    sku: "",
    quantity: "",
    itemSubtotal: "",
  };
}

function buildExportRows(order, details, detailPageUrl) {
  const items = Array.isArray(details?.items) ? details.items : [];
  const base = {
    buyerName: details?.buyerName || order.buyerName || "",
    buyerPhone: details?.buyerPhone || "",
    buyerAltPhone: details?.buyerAltPhone || "",
    buyerEmail: details?.buyerEmail || "",
    shipByDate: details?.shipBy || order.shipByDate || "",
    deliverByDate: details?.deliverBy || order.deliverByDate || "",
    purchaseDate: details?.purchaseDate || "",
    shippingService: details?.shippingService || "",
    fulfillment: details?.fulfillment || order.orderType || "",
    shippingAddress: details?.shippingAddress || "",
    sellerName: details?.sellerName || "",
    sellerAddress: details?.sellerAddress || "",
    pageUrl: detailPageUrl || "",
  };

  if (!items.length) {
    return [
      {
        orderId: order.orderId || "",
        detailUrl: buildOrderDetailUrl(order.orderId),
        ...base,
        orderStatus: order.orderStatus || "",
        productName: order.productName || "",
        asin: order.asin || "",
        sku: order.sku || "",
        quantity: order.quantity || "",
        unitPrice: "",
        itemSubtotal: order.itemSubtotal || "",
        orderItemId: "",
      },
    ];
  }

  return items.map((item) => ({
    orderId: order.orderId || "",
    detailUrl: buildOrderDetailUrl(order.orderId),
    ...base,
    orderStatus: item.status || order.orderStatus || "",
    productName: item.productName || order.productName || "",
    asin: item.asin || order.asin || "",
    sku: item.sku || order.sku || "",
    quantity: item.quantity || order.quantity || "",
    unitPrice: item.unitPrice || "",
    itemSubtotal: order.itemSubtotal || "",
    orderItemId: item.orderItemId || "",
  }));
}

async function scrapeDetailsForDb(orders) {
  if (!activeTabId) return [];
  const allRows = [];

  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    const detailUrl = buildOrderDetailUrl(order.orderId);
    if (!detailUrl) continue;

    setStatus("Scraping orders", `Order ${index + 1} of ${orders.length}…`, "busy");
    chrome.tabs.update(activeTabId, { url: detailUrl });
    await waitForTabComplete(activeTabId);
    await wait(1800);

    try {
      const detailPayload = await scrapeActiveTab(activeTabId);
      if (detailPayload?.pageType === "detail") {
        allRows.push(
          ...buildExportRows(order, detailPayload.orderDetails, detailPayload.pageUrl)
        );
      }
    } catch (error) {
      allRows.push(
        ...buildExportRows(order, null, detailUrl).map((row) => ({
          ...row,
          scrapeError: error instanceof Error ? error.message : "Unknown error",
        }))
      );
    }
  }

  return allRows;
}

async function getCredentialsForLogin() {
  let username = byId("loginUsername")?.value?.trim().toLowerCase() || "";
  let password = byId("loginPassword")?.value || "";
  const remembered = await SureshipBackend.getRememberedCredentials();
  if (!username && remembered?.username) username = remembered.username;
  if (!password && remembered?.password) password = remembered.password;
  return { username, password };
}

/** Prefill inputs from chrome.storage (only if fields are empty). */
async function restoreRememberedToForm() {
  const remembered = await SureshipBackend.getRememberedCredentials();
  if (!remembered) return;
  const uEl = byId("loginUsername");
  const pEl = byId("loginPassword");
  if (uEl && !String(uEl.value || "").trim()) uEl.value = remembered.username;
  if (pEl && !String(pEl.value || "").trim()) pEl.value = remembered.password;
}

async function handleClearSavedLogin() {
  try {
    await SureshipBackend.clearRememberedCredentials();
    await SureshipBackend.clearToken();
    const uEl = byId("loginUsername");
    const pEl = byId("loginPassword");
    if (uEl) uEl.value = "";
    if (pEl) pEl.value = "";
    setAuthMessage("Saved login cleared from this computer.", "success");
    setStatus("Ready", "Enter username and password again");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setAuthMessage(msg, "error");
    setStatus("Clear failed", msg, "error");
  }
}

/**
 * Sureship login using form fields or remembered credentials.
 * Concurrent calls share the same in-flight request.
 */
async function tryLoginFromForm(options = {}) {
  const { silent = false } = options;
  let { username, password } = await getCredentialsForLogin();
  if (!username || !password) return false;

  const uEl = byId("loginUsername");
  const pEl = byId("loginPassword");
  if (uEl && !String(uEl.value || "").trim()) uEl.value = username;
  if (pEl && !String(pEl.value || "").trim()) pEl.value = password;

  if (loginFlightPromise) {
    return loginFlightPromise;
  }

  loginFlightPromise = (async () => {
    if (!silent) setStatus("Logging in", "Sureship backend…", "busy");
    try {
      await SureshipBackend.login(username, password);
      await SureshipBackend.rememberCredentials(username, password);
      setAuthMessage("Logged in — you can click Save to DB.", "success");
      setStatus("Logged in", `Connected as ${username}`);
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setAuthMessage(msg, "error");
      if (!silent) setStatus("Login failed", msg, "error");
      return false;
    } finally {
      loginFlightPromise = null;
    }
  })();

  return loginFlightPromise;
}

function scheduleAutoLogin() {
  if (autoLoginTimer) clearTimeout(autoLoginTimer);
  autoLoginTimer = setTimeout(() => {
    autoLoginTimer = null;
    void (async () => {
      const { username, password } = await getCredentialsForLogin();
      if (username && password) void tryLoginFromForm({ silent: true });
    })();
  }, 1000);
}

async function scrapeExportRowsFromActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url) {
    throw new Error("No active tab found.");
  }
  if (!tab.url.includes("sellercentral.amazon.in/orders-v3")) {
    throw new Error("Open Amazon Seller Central orders page first.");
  }

  activeTabId = tab.id;
  const payload = await scrapeActiveTab(tab.id);

  if (payload?.pageType === "detail") {
    const details = payload.orderDetails;
    if (!details) throw new Error("Order details not found on this page.");
    const stub = detailStubFromOrderDetails(details, payload.pageUrl);
    return buildExportRows(stub, details, payload.pageUrl);
  }

  const orders = (payload?.orders || []).map(normalizeOrder).filter((o) => o.orderId);
  if (!orders.length) {
    throw new Error("No orders found on this page.");
  }

  setStatus("Scraping orders", `Found ${orders.length} order(s)…`, "busy");
  return scrapeDetailsForDb(orders);
}

async function handleSaveToDbClick() {
  if (autoLoginTimer) {
    clearTimeout(autoLoginTimer);
    autoLoginTimer = null;
  }

  if (!loginFlightPromise) {
    setAuthMessage("");
  }

  await restoreRememberedToForm();
  const { username, password } = await getCredentialsForLogin();
  if (!username || !password) {
    setAuthMessage("Enter username and password once. They stay saved on this computer.", "error");
    setStatus("Missing credentials", "Fill username and password", "error");
    return;
  }

  setSaveButtonDisabled(true);
  try {
    const sessionOk = await SureshipBackend.isAccessTokenValid();
    if (sessionOk) {
      setStatus("Using saved session", "Skipping login — scraping…", "busy");
    } else {
      if (loginFlightPromise) {
        setStatus("Please wait", "Login already in progress…", "busy");
      } else {
        setStatus("Logging in", "Sureship…", "busy");
      }
      const loginOk = await tryLoginFromForm({ silent: true });
      if (!loginOk) {
        const errText = byId("authMessage")?.textContent?.trim() || "Login failed";
        setStatus("Login failed", errText, "error");
        showToast("Login failed", errText);
        return;
      }
    }

    setStatus("Scraping", "Reading Amazon page…", "busy");
    const exportRows = await scrapeExportRowsFromActiveTab();
    if (!exportRows.length) {
      throw new Error("No order data scraped from the page.");
    }

    setStatus("Saving", "Writing orders to database…", "busy");
    const syncResult = await SureshipBackend.syncExportRowsToDb(exportRows);

    if (syncResult.errors?.length) {
      const errMsg = syncResult.errors[0] || "Unknown error";
      setAuthMessage(errMsg, "error");
      setStatus("Save failed", errMsg, "error");
      showToast("Save failed", errMsg);
      return;
    }

    const toast = formatSaveDbResult(syncResult);
    setAuthMessage(toast.message, "success");
    setStatus(toast.title, toast.message);
    showToast(toast.title, toast.message);
    console.log("[popup] save to DB:", syncResult);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    setAuthMessage(errMsg, "error");
    setStatus("Failed", errMsg, "error");
    showToast("Failed", errMsg);
    console.error("[popup] save to DB:", err);
  } finally {
    setSaveButtonDisabled(false);
  }
}

function bootPopup() {
  initToast();
  const saveBtn = byId("saveToDbBtn");
  if (saveBtn) saveBtn.addEventListener("click", () => void handleSaveToDbClick());

  const clearBtn = byId("clearSavedLoginBtn");
  if (clearBtn) clearBtn.addEventListener("click", () => void handleClearSavedLogin());

  const userEl = byId("loginUsername");
  const passEl = byId("loginPassword");
  if (userEl) {
    userEl.addEventListener("input", () => scheduleAutoLogin());
    userEl.addEventListener("change", () => scheduleAutoLogin());
  }
  if (passEl) {
    passEl.addEventListener("input", () => scheduleAutoLogin());
    passEl.addEventListener("blur", () => {
      const u = byId("loginUsername")?.value?.trim() || "";
      const p = byId("loginPassword")?.value || "";
      if (u && p) void tryLoginFromForm({ silent: true });
    });
    passEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleSaveToDbClick();
      }
    });
  }

  void (async () => {
    await restoreRememberedToForm();
    if (await SureshipBackend.isAccessTokenValid()) {
      const r = await SureshipBackend.getRememberedCredentials();
      const who = r?.username || byId("loginUsername")?.value?.trim() || "Sureship";
      setAuthMessage(
        "Session active — press Save to DB only until the token expires (~2 hours).",
        "success"
      );
      setStatus("Connected", `Logged in as ${who}`);
    } else {
      setStatus("Ready", "Enter credentials once — they are saved on this PC");
    }
  })();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootPopup);
} else {
  bootPopup();
}
