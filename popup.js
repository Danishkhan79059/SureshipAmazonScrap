const AMAZON_ORDERS_PREFIX = "https://sellercentral.amazon.in/orders-v3/";
const AMAZON_BASE_URL = "https://sellercentral.amazon.in";
const ORDER_DETAIL_URL_PREFIX = `${AMAZON_BASE_URL}/orders-v3/order/`;
let activeTabId = null;
/** Latest rows ready for POST /booking/createOrder (set after list scrape or detail view). */
let lastExportRowsForDb = [];

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

function setOrderCount(count) {
  const badge = byId("orderCount");
  if (badge) badge.textContent = String(count ?? 0);
}

function renderEmptyState(title, subtitle) {
  const view = byId("fieldView");
  if (!view) return;
  setOrderCount(0);
  view.innerHTML = `<div class="empty-state">
      <div class="empty-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
          <rect x="2" y="3" width="20" height="14" rx="2"/>
          <path d="M8 21h8M12 17v4"/>
        </svg>
      </div>
      <p>${escapeHtml(title || "No data yet")}</p>
      <span>${escapeHtml(subtitle || "Open Amazon Seller Central orders page")}</span>
    </div>`;
}

function showFieldMessage(text, isError) {
  const view = byId("fieldView");
  if (!view) return;
  view.innerHTML = `<div class="inline-message${isError ? " error" : ""}">${escapeHtml(text)}</div>`;
}

const TOAST_ICONS = {
  success: `<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5" stroke="currentColor"/></svg>`,
  warning: `<svg viewBox="0 0 24 24"><path d="M12 9v4M12 17h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" stroke="currentColor"/></svg>`,
  error: `<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" stroke="currentColor"/><path d="M15 9l-6 6M9 9l6 6" stroke="currentColor"/></svg>`,
};

let toastTimer = null;

function hideToast() {
  const overlay = byId("toastOverlay");
  if (!overlay) return;
  overlay.classList.remove("show");
  overlay.setAttribute("aria-hidden", "true");
  if (toastTimer) {
    clearTimeout(toastTimer);
    toastTimer = null;
  }
}

function showToast(title, message, type = "success") {
  const overlay = byId("toastOverlay");
  const icon = byId("toastIcon");
  const titleEl = byId("toastTitle");
  const messageEl = byId("toastMessage");
  if (!overlay || !titleEl || !messageEl) return;

  hideToast();

  const kind = type === "error" || type === "warning" ? type : "success";
  overlay.className = `toast-overlay ${kind}`;
  if (icon) icon.innerHTML = TOAST_ICONS[kind] || TOAST_ICONS.success;
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
    return {
      type: "success",
      title: "Saved successfully",
      message: `${synced} order(s) saved to database.`,
    };
  }
  if (synced > 0 && skipped > 0) {
    return {
      type: "warning",
      title: "Partially saved",
      message: `${synced} order(s) saved. ${skipped} duplicate(s) skipped.`,
    };
  }
  if (synced === 0 && skipped > 0) {
    return {
      type: "warning",
      title: "Already in database",
      message: `No new orders saved. ${skipped} duplicate order(s) were skipped.`,
    };
  }
  return {
    type: "warning",
    title: "Nothing to save",
    message: "No new orders were saved (empty or duplicate data).",
  };
}

function setStatus(text, sub, state = "idle") {
  const primary = byId("statusText") || byId("status");
  if (primary) primary.textContent = text;
  const subNode = byId("statusSub");
  if (subNode && sub !== undefined) subNode.textContent = sub;
  else if (subNode && text) subNode.textContent = text.length > 48 ? text.slice(0, 48) + "…" : "";
  setStatusBarState(state === "error" ? "error" : state === "busy" ? "busy" : "idle");
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function pickOrderId(text) {
  const source = String(text || "");
  const match = source.match(/\d{3}-\d{7}-\d{7}/);
  return match ? match[0] : source;
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
  const statusSecondary = statusInfo.includes(")")
    ? statusInfo.split(")").slice(1).join(")").trim()
    : "";

  return {
    rowIndex: order?.rowIndex ?? order?.index ?? "",
    orderId: order?.orderId ? pickOrderId(order.orderId) : pickOrderId(orderInfo),
    orderLink: order?.orderLink ?? order?.selectors?.orderLink?.value ?? "",
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
    orderStatusSecondary: order?.orderStatusSecondary ?? statusSecondary,
    shipByDate: order?.shipByDate ?? pickLabelValue(orderType, "Ship by date"),
    deliverByDate: order?.deliverByDate ?? pickLabelValue(orderType, "Deliver by date"),
  };
}

function buildOrderUrl(orderLink) {
  const value = String(orderLink || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("/")) return `${AMAZON_BASE_URL}${value}`;
  return `${AMAZON_BASE_URL}/${value}`;
}

function buildOrderDetailUrl(orderId) {
  const id = pickOrderId(orderId).trim();
  if (!/^\d{3}-\d{7}-\d{7}$/.test(id)) return "";
  return `${ORDER_DETAIL_URL_PREFIX}${id}`;
}

function openOrderLink(orderLink) {
  const url = buildOrderUrl(orderLink);
  if (!url || !activeTabId) return;
  chrome.tabs.update(activeTabId, { url });
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

function scrapeActiveTab(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { action: "SCRAPE_AMAZON_ORDERS" }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "Scrape failed."));
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

function toCsvValue(value) {
  const safe = String(value ?? "").replace(/"/g, '""');
  return `"${safe}"`;
}

function downloadCsvFile(filename, rows) {
  if (!rows.length) return;
  const headers = Object.keys(rows[0]);
  const csvBody = [
    headers.map(toCsvValue).join(","),
    ...rows.map((row) => headers.map((key) => toCsvValue(row[key])).join(",")),
  ].join("\n");

  const blob = new Blob([csvBody], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function getFilenameSuffixFromUrl(url) {
  const orderId = pickOrderId(url || "");
  if (/^\d{3}-\d{7}-\d{7}$/.test(orderId)) return orderId;
  return new Date().toISOString().replace(/[:.]/g, "-");
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

function refreshLastExportRowsFromDetailPayload(data) {
  const details = data?.orderDetails;
  if (!details) {
    lastExportRowsForDb = [];
    return;
  }
  lastExportRowsForDb = buildExportRows(detailStubFromOrderDetails(details, data.pageUrl), details, data.pageUrl || "");
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

function exportSingleDetailPage(payload) {
  const details = payload?.orderDetails;
  if (!details) {
    throw new Error("Order details not found on this page.");
  }

  const orderStub = {
    orderId: details.orderId || pickOrderId(payload?.pageUrl || ""),
    buyerName: details.buyerName || "",
    orderStatus: "",
    shipByDate: details.shipBy || "",
    deliverByDate: details.deliverBy || "",
    orderType: details.fulfillment || "",
    productName: "",
    asin: "",
    sku: "",
    quantity: "",
    itemSubtotal: "",
  };

  const rows = buildExportRows(orderStub, details, payload.pageUrl);
  const suffix = getFilenameSuffixFromUrl(payload.pageUrl || details.orderId || "");
  downloadCsvFile(`amazon-current-order-${suffix}.csv`, rows);
}

async function scrapeDetailsAndExport(orders) {
  if (!activeTabId) return [];
  const allRows = [];

  for (let index = 0; index < orders.length; index += 1) {
    const order = orders[index];
    const detailUrl = buildOrderDetailUrl(order.orderId);
    if (!detailUrl) continue;

    setStatus(`Opening order ${index + 1}/${orders.length}: ${order.orderId}`);
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

  if (allRows.length) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    downloadCsvFile(`amazon-order-details-${stamp}.csv`, allRows);
  }
  return allRows;
}

async function renderOrders(data) {
  const view = byId("fieldView");
  if (!view) return;

  const orders = (data?.orders || []).map(normalizeOrder);
  if (!orders.length) {
    renderEmptyState("No rows found", "Try another page or refresh");
    return;
  }

  setOrderCount(orders.length);
  view.innerHTML = `<div class="orders-scroll">${orders
    .map(
      (order) => `<div class="order-block">
        <h4>Order ${escapeHtml(order.rowIndex)}</h4>
        <div class="field-line"><b>Order ID:</b> ${escapeHtml(order.orderId)}</div>
        <div class="field-line"><b>Order Link:</b> ${escapeHtml(buildOrderUrl(order.orderLink))}</div>
        <div class="field-line"><b>Mapped Detail URL:</b> ${escapeHtml(buildOrderDetailUrl(order.orderId))}</div>
        <div class="field-line"><b>Buyer Name:</b> ${escapeHtml(order.buyerName)}</div>
        <div class="field-line"><b>Product Name:</b><br>${escapeHtml(order.productName)}</div>
        <div class="field-line"><b>ASIN:</b> ${escapeHtml(order.asin)}</div>
        <div class="field-line"><b>SKU:</b> ${escapeHtml(order.sku)}</div>
        <div class="field-line"><b>Quantity:</b> ${escapeHtml(order.quantity)}</div>
        <div class="field-line"><b>Subtotal:</b> ${escapeHtml(order.itemSubtotal)}</div>
        <div class="field-line"><b>Order Type:</b> ${escapeHtml(order.orderType)}</div>
        <div class="field-line"><b>Status:</b> ${escapeHtml(order.orderStatus)}</div>
        <div class="field-line"><b>Status Note:</b><br>${escapeHtml(order.orderStatusSecondary)}</div>
        <div class="field-line"><b>Ship By:</b> ${escapeHtml(order.shipByDate)}</div>
        <div class="field-line"><b>Deliver By:</b> ${escapeHtml(order.deliverByDate)}</div>
        <button class="open-order-btn" data-order-link="${escapeHtml(order.orderLink)}">Open This Order</button>
      </div>`
    )
    .join("")}</div>`;

  view.querySelectorAll(".open-order-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const href = button.getAttribute("data-order-link") || "";
      openOrderLink(href);
    });
  });

  setStatus("Processing orders", "Opening each order detail and exporting…", "busy");
  const exportRows = await scrapeDetailsAndExport(orders);
  lastExportRowsForDb = exportRows;
  setStatus("Done", "CSV downloaded — use Save to DB when ready");
}

async function downloadCurrentPageData() {
  try {
    setStatus("Downloading", "Reading current order detail page…", "busy");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      throw new Error("No active tab found.");
    }

    activeTabId = tab.id;
    if (!tab.url.includes("/orders-v3/order/")) {
      throw new Error("Open an Amazon order detail page first.");
    }

    const payload = await scrapeActiveTab(tab.id);
    if (payload?.pageType !== "detail") {
      throw new Error("Current page is not an order detail page.");
    }

    renderOrderDetails(payload);
    exportSingleDetailPage(payload);
    refreshLastExportRowsFromDetailPayload(payload);
    setOrderCount(1);
    setStatus("Done", "CSV downloaded — use Save to DB when ready");
  } catch (error) {
    setStatus("Download failed", error instanceof Error ? error.message : "Unknown error", "error");
    showFieldMessage(error instanceof Error ? error.message : "Unknown error", true);
  }
}

function renderOrderDetails(data) {
  const view = byId("fieldView");
  if (!view) return;

  const details = data?.orderDetails;
  if (!details) {
    renderEmptyState("Order details not found", "Open a valid order detail page");
    lastExportRowsForDb = [];
    return;
  }

  setOrderCount((details.items || []).length || 1);

  const linksHtml = (details.links || [])
    .map((link) => {
      const fullUrl = buildOrderUrl(link.href);
      return `<div class="field-line">
        <b>${escapeHtml(link.label)}:</b>
        <button class="open-order-btn" data-order-link="${escapeHtml(link.href)}">Open</button>
        <div>${escapeHtml(fullUrl)}</div>
      </div>`;
    })
    .join("");

  const itemsHtml = (details.items || [])
    .map(
      (item) => `<div class="order-block">
        <h4>Item ${escapeHtml(item.itemIndex)}</h4>
        <div class="field-line"><b>Status:</b> ${escapeHtml(item.status)}</div>
        <div class="field-line"><b>Product:</b> ${escapeHtml(item.productName)}</div>
        <div class="field-line"><b>ASIN:</b> ${escapeHtml(item.asin)}</div>
        <div class="field-line"><b>SKU:</b> ${escapeHtml(item.sku)}</div>
        <div class="field-line"><b>Qty:</b> ${escapeHtml(item.quantity)}</div>
        <div class="field-line"><b>Unit Price:</b> ${escapeHtml(item.unitPrice)}</div>
        <div class="field-line"><b>Order Item ID:</b> ${escapeHtml(item.orderItemId)}</div>
        <div class="field-line"><b>Image:</b> ${escapeHtml(item.productImage)}</div>
      </div>`
    )
    .join("");

  view.innerHTML = `<div class="order-block">
      <h4>Order Details</h4>
      <div class="field-line"><b>Order ID:</b> ${escapeHtml(details.orderId || "")}</div>
      <div class="field-line"><b>Ship By:</b> ${escapeHtml(details.shipBy || "")}</div>
      <div class="field-line"><b>Deliver By:</b> ${escapeHtml(details.deliverBy || "")}</div>
      <div class="field-line"><b>Purchase Date:</b> ${escapeHtml(details.purchaseDate || "")}</div>
      <div class="field-line"><b>Shipping Service:</b> ${escapeHtml(details.shippingService || "")}</div>
      <div class="field-line"><b>Fulfillment:</b> ${escapeHtml(details.fulfillment || "")}</div>
      <div class="field-line"><b>Buyer Name:</b> ${escapeHtml(details.buyerName || "")}</div>
      <div class="field-line"><b>Ship To:</b><br>${escapeHtml(details.shippingAddress || "")}</div>
      ${linksHtml}
    </div>
    ${itemsHtml || "<div class='field-line'>No items found.</div>"}`;

  view.querySelectorAll(".open-order-btn").forEach((button) => {
    button.addEventListener("click", () => {
      const href = button.getAttribute("data-order-link") || "";
      openOrderLink(href);
    });
  });

  refreshLastExportRowsFromDetailPayload(data);
}

async function handleSaveToDbClick() {
  if (!lastExportRowsForDb.length) {
    setStatus("Nothing to save", "Scrape orders first", "error");
    showToast(
      "No data to save",
      "Open Amazon orders page or an order detail page and scrape data first.",
      "error"
    );
    console.warn("[popup] save to DB: no lastExportRowsForDb");
    return;
  }
  try {
    setStatus("Saving", "POST /booking/createOrder…", "busy");
    const syncResult = await SureshipBackend.syncExportRowsToDb(lastExportRowsForDb);
    if (syncResult.errors?.length) {
      const errMsg = syncResult.errors[0] || "Unknown error";
      console.error("[popup] save to DB errors:", syncResult.errors);
      setStatus("Save failed", errMsg, "error");
      showToast("Save failed", errMsg, "error");
      return;
    }
    const toast = formatSaveDbResult(syncResult);
    setStatus(toast.title, toast.message, toast.type === "error" ? "error" : "idle");
    showToast(toast.title, toast.message, toast.type);
    console.log("[popup] save to DB:", syncResult);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : "Unknown error";
    console.error("[popup] save to DB:", err);
    setStatus("Save failed", errMsg, "error");
    showToast("Save failed", errMsg, "error");
  }
}

async function autoLoadOrders() {
  try {
    setStatus("Loading", "Scraping Amazon orders page…", "busy");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id || !tab.url) {
      throw new Error("No active tab found.");
    }
    activeTabId = tab.id;
    if (!tab.url.startsWith(AMAZON_ORDERS_PREFIX)) {
      throw new Error("Open Amazon orders page first.");
    }

    chrome.tabs.sendMessage(tab.id, { action: "SCRAPE_AMAZON_ORDERS" }, (response) => {
      if (chrome.runtime.lastError) {
        setStatus("Scrape failed", chrome.runtime.lastError.message || "Scrape failed.", "error");
        showFieldMessage(chrome.runtime.lastError.message || "Scrape failed.", true);
        return;
      }
      if (!response?.ok) {
        setStatus("Scrape failed", response?.error || "No response received.", "error");
        showFieldMessage(response?.error || "No response received.", true);
        return;
      }

      if (response.data?.pageType === "detail") {
        setOrderCount(1);
        setStatus("Ready", "Order detail captured — save to DB after login");
        renderOrderDetails(response.data);
      } else {
        setStatus("Loaded", `${response.data.totalRows} rows captured`);
        void renderOrders(response.data).catch((err) => {
          console.error("[popup] renderOrders failed:", err);
          setStatus("Render failed", err instanceof Error ? err.message : "Unknown", "error");
        });
      }
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Unknown error";
    setStatus("Unable to load", msg, "error");
    showFieldMessage(msg, true);
  }
}

function bindActionTile(id, handler) {
  const tile = byId(id);
  if (!tile) return;
  const run = () => void handler();
  tile.addEventListener("click", run);
  tile.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      run();
    }
  });
}

function bindPopupControls() {
  bindActionTile("downloadCurrentBtn", downloadCurrentPageData);
  bindActionTile("saveToDbBtn", handleSaveToDbClick);
  const refreshBtn = byId("refreshBtn");
  if (refreshBtn) refreshBtn.addEventListener("click", () => void autoLoadOrders());
}

function setAuthMessage(text, type) {
  const node = byId("authMessage");
  if (!node) return;
  node.textContent = text || "";
  node.classList.remove("success", "error");
  if (type) node.classList.add(type);
}

async function handleLoginClick() {
  const username = byId("loginUsername")?.value?.trim() || "";
  const password = byId("loginPassword")?.value || "";
  setAuthMessage("");
  if (!username || !password) {
    setAuthMessage("Enter username and password.", "error");
    return;
  }
  try {
    setStatus("Logging in", "Connecting to backend…", "busy");
    await SureshipBackend.login(username, password);
    await SureshipBackend.updateAuthUi();
    setAuthMessage("Login successful.", "success");
    setStatus("Logged in", "Token saved");
    console.log("[popup] Login OK");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Login failed";
    setAuthMessage(message, "error");
    setStatus("Login failed", message, "error");
    console.error("[popup] Login error:", error);
  }
}

async function handleLogoutClick() {
  try {
    await SureshipBackend.clearToken();
    await SureshipBackend.updateAuthUi();
    setAuthMessage("Logged out.", "success");
    setStatus("Logged out", "Token cleared");
    console.log("[popup] Logout OK");
  } catch (error) {
    console.error("[popup] Logout error:", error);
    setAuthMessage(error instanceof Error ? error.message : "Logout failed", "error");
  }
}

async function initAuthControls() {
  await SureshipBackend.updateAuthUi();
  const loginBtn = byId("loginBtn");
  const logoutBtn = byId("logoutBtn");
  if (loginBtn) loginBtn.addEventListener("click", () => void handleLoginClick());
  if (logoutBtn) logoutBtn.addEventListener("click", () => void handleLogoutClick());
}

function bootPopup() {
  initToast();
  void initAuthControls();
  bindPopupControls();
  autoLoadOrders();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", bootPopup);
} else {
  bootPopup();
}
