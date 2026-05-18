function getNodeText(root, selector) {
  const node = root.querySelector(selector);
  if (!node) {
    return "";
  }
  return node.innerText.trim().replace(/\s+/g, " ");
}

function parseLabelValue(blockText, label) {
  const regex = new RegExp(`${label}\\s*:\\s*([^\\n]+)`, "i");
  const match = blockText.match(regex);
  return match ? match[1].trim() : "";
}

function extractProductVariant(productName) {
  const match = productName.match(/\(([^)]+)\)\s*$/);
  return match ? match[1].trim() : "";
}

function scrapeAmazonOrders() {
  const table = document.querySelector(".myo-table-container #orders-table") ||
    document.querySelector("#orders-table");
  if (!table) {
    return {
      pageUrl: window.location.href,
      totalRows: 0,
      scrapedAt: new Date().toISOString(),
      error: "orders table not found",
      orders: [],
    };
  }

  const rows = Array.from(table.querySelectorAll("tbody tr"));

  const orders = rows.map((row, index) => {
    const orderInfoText = getNodeText(row, "td:nth-child(3)");
    const productInfoText = getNodeText(row, "td:nth-child(5)");
    const orderTypeText = getNodeText(row, "td:nth-child(7)");
    const statusText = getNodeText(row, "td:nth-child(8)");
    const productNameText = getNodeText(
      row,
      "td:nth-child(5) .myo-list-orders-product-name-cell a div"
    );
    const productVariant = extractProductVariant(productNameText);

    const actionButtons = Array.from(
      row.querySelectorAll("td:nth-child(9) .a-button-text")
    )
      .map((button) => button.innerText.trim())
      .filter(Boolean);

    const allCellText = Array.from(row.querySelectorAll("td")).map((cell) =>
      cell.innerText.trim().replace(/\s+/g, " ")
    );

    const selectorData = {
      orderDateRelative: {
        selector: "td:nth-child(2) .cell-body-title",
        value: getNodeText(row, "td:nth-child(2) .cell-body-title"),
      },
      orderDate: {
        selector: "td:nth-child(2) div:nth-child(2)",
        value: getNodeText(row, "td:nth-child(2) div:nth-child(2)"),
      },
      orderTime: {
        selector: "td:nth-child(2) div:nth-child(3)",
        value: getNodeText(row, "td:nth-child(2) div:nth-child(3)"),
      },
      orderId: {
        selector: "td:nth-child(3) .cell-body-title a",
        value:
          getNodeText(row, "td:nth-child(3) .cell-body-title a") ||
          (orderInfoText.match(/\d{3}-\d{7}-\d{7}/)?.[0] || ""),
      },
      orderLink: {
        selector: "td:nth-child(3) .cell-body-title a",
        value: row.querySelector("td:nth-child(3) .cell-body-title a")?.getAttribute("href") || "",
      },
      buyerName: {
        selector: "td:nth-child(3) [data-test-id='buyer-name-with-link']",
        value:
          getNodeText(row, "td:nth-child(3) [data-test-id='buyer-name-with-link']") ||
          parseLabelValue(orderInfoText, "Buyer name"),
      },
      fulfilmentMethod: {
        selector: "td:nth-child(3)",
        value: parseLabelValue(orderInfoText, "Fulfilment method"),
      },
      salesChannel: {
        selector: "td:nth-child(3)",
        value: parseLabelValue(orderInfoText, "Sales channel"),
      },
      productName: {
        selector: "td:nth-child(5) .myo-list-orders-product-name-cell a div",
        value: productNameText,
      },
      productVariant: {
        selector: "td:nth-child(5) .myo-list-orders-product-name-cell a div",
        value: productVariant,
      },
      productImage: {
        selector: "td:nth-child(4) img",
        value: row.querySelector("td:nth-child(4) img")?.src || "",
      },
      asin: {
        selector: "td:nth-child(5)",
        value: parseLabelValue(productInfoText, "ASIN"),
      },
      sku: {
        selector: "td:nth-child(5)",
        value: parseLabelValue(productInfoText, "SKU"),
      },
      quantity: {
        selector: "td:nth-child(5)",
        value: parseLabelValue(productInfoText, "Quantity"),
      },
      itemSubtotal: {
        selector: "td:nth-child(5)",
        value: parseLabelValue(productInfoText, "Item subtotal"),
      },
      orderType: {
        selector: "td:nth-child(7) .cell-body-title",
        value: getNodeText(row, "td:nth-child(7) .cell-body-title"),
      },
      shipByDate: {
        selector: "td:nth-child(7)",
        value: parseLabelValue(orderTypeText, "Ship by date"),
      },
      deliverByDate: {
        selector: "td:nth-child(7)",
        value: parseLabelValue(orderTypeText, "Deliver by date"),
      },
      orderStatus: {
        selector: "td:nth-child(8)",
        value: statusText,
      },
      orderStatusMain: {
        selector: "td:nth-child(8) .main-status",
        value: getNodeText(row, "td:nth-child(8) .main-status"),
      },
      orderStatusSecondary: {
        selector: "td:nth-child(8) .secondary-status",
        value: getNodeText(row, "td:nth-child(8) .secondary-status"),
      },
      instructionDetails: {
        selector: "td:nth-child(6)",
        value: getNodeText(row, "td:nth-child(6)"),
      },
      actions: {
        selector: "td:nth-child(9) .a-button-text",
        value: actionButtons.join(", "),
      },
      rawRowText: {
        selector: "tr",
        value: row.innerText.trim().replace(/\s+/g, " "),
      },
    };

    return {
      rowIndex: index + 1,
      orderDateRelative: selectorData.orderDateRelative.value,
      orderDate: selectorData.orderDate.value,
      orderTime: selectorData.orderTime.value,
      orderId: selectorData.orderId.value,
      orderLink: selectorData.orderLink.value,
      buyerName: selectorData.buyerName.value,
      fulfilmentMethod: selectorData.fulfilmentMethod.value,
      salesChannel: selectorData.salesChannel.value,
      productName: selectorData.productName.value,
      productVariant: selectorData.productVariant.value,
      productImage: selectorData.productImage.value,
      asin: selectorData.asin.value,
      sku: selectorData.sku.value,
      quantity: selectorData.quantity.value,
      itemSubtotal: selectorData.itemSubtotal.value,
      orderType: selectorData.orderType.value,
      shipByDate: selectorData.shipByDate.value,
      deliverByDate: selectorData.deliverByDate.value,
      orderStatus: selectorData.orderStatus.value,
      orderStatusMain: selectorData.orderStatusMain.value,
      orderStatusSecondary: selectorData.orderStatusSecondary.value,
      instructionDetails: selectorData.instructionDetails.value,
      actions: actionButtons,
      rawRowText: row.innerText.trim().replace(/\s+/g, " "),
      rawCells: allCellText,
      selectors: selectorData,
    };
  });

  return {
    pageUrl: window.location.href,
    tableSelector: "#orders-table > tbody > tr",
    totalRows: orders.length,
    scrapedAt: new Date().toISOString(),
    orders,
  };
}

function getTextBySelector(selector) {
  const node = document.querySelector(selector);
  return node ? node.innerText.trim().replace(/\s+/g, " ") : "";
}

function extractContactFromElement(root) {
  if (!root) {
    return { buyerPhone: "", buyerAltPhone: "", buyerEmail: "" };
  }
  const text = root.innerText.replace(/\s+/g, " ").trim();
  const emails = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  const email = emails[0] ? emails[0].trim() : "";
  const phoneCandidates = [];
  const inPhone = text.match(/(?:\+91[\s.-]*)?[6-9]\d{9}\b/g);
  if (inPhone) phoneCandidates.push(inPhone[0].replace(/\D/g, ""));
  const generic = text.match(/\b(\d{10,12})\b/g);
  if (generic) {
    for (const g of generic) {
      const d = g.replace(/\D/g, "");
      if (d.length >= 10 && d.length <= 12) phoneCandidates.push(d.slice(-10));
    }
  }
  const uniq = [...new Set(phoneCandidates.map((p) => (p.length > 10 ? p.slice(-10) : p)))];
  const buyerPhone = uniq[0] || "";
  const buyerAltPhone = uniq[1] || "";
  return { buyerPhone, buyerAltPhone, buyerEmail: email };
}

function scrapeOrderDetailsPage() {
  const orderId =
    getTextBySelector("[data-test-id='order-id-value']") ||
    (window.location.pathname.match(/\d{3}-\d{7}-\d{7}/)?.[0] || "");

  const shippingRoot =
    document.querySelector("[data-test-id='shipping-section-buyer-address']")?.closest(".a-box") ||
    document.querySelector("[data-test-id='shipping-section']") ||
    document.querySelector("#myo-order-details-ship-section");
  const contact = extractContactFromElement(shippingRoot);

  const detailLinks = Array.from(
    document.querySelectorAll(
      "a[href*='/orders-v3/order/'], a[href*='/easyship/schedule'], a[href*='/cancel-order']"
    )
  )
    .map((anchor) => ({
      label: anchor.innerText.trim().replace(/\s+/g, " ") || "Link",
      href: anchor.getAttribute("href") || "",
    }))
    .filter((link) => link.href);

  const shippingAddress = Array.from(
    document.querySelectorAll("[data-test-id='shipping-section-buyer-address'] span")
  )
    .map((span) => span.innerText.trim())
    .filter(Boolean)
    .join(", ");

  const sellerName =
    getTextBySelector("[data-test-id='myo-order-details-invoice-sold-by-value']") ||
    getTextBySelector("[data-test-id='myo-invoice-sold-by-value']") ||
    "";
  const sellerAddress =
    getTextBySelector("[data-test-id='myo-order-details-invoice-sold-by-address']") ||
    getTextBySelector("[data-test-id='myo-invoice-sold-by-address']") ||
    "";

  const itemRows = Array.from(document.querySelectorAll("table.a-keyvalue tbody tr")).map(
    (row, index) => {
      const productName = getNodeText(row, "td:nth-child(3) .myo-list-orders-product-name-cell a div");
      const asin = parseLabelValue(getNodeText(row, "td:nth-child(3)"), "ASIN");
      const sku = parseLabelValue(getNodeText(row, "td:nth-child(3)"), "SKU");
      const orderItemId = parseLabelValue(getNodeText(row, "td:nth-child(4)"), "Order Item ID");
      const unitPrice = getNodeText(row, "td:nth-child(6)");
      const quantity = getNodeText(row, "td:nth-child(5)");
      const status = getNodeText(row, "[data-test-id='item-status-label']");

      return {
        itemIndex: index + 1,
        status,
        productName,
        asin,
        sku,
        quantity,
        unitPrice,
        orderItemId,
        productImage: row.querySelector("td:nth-child(2) img")?.src || "",
      };
    }
  );

  return {
    pageType: "detail",
    pageUrl: window.location.href,
    scrapedAt: new Date().toISOString(),
    orderDetails: {
      orderId,
      shipBy: getTextBySelector("[data-test-id='order-summary-shipby-value']"),
      deliverBy: getTextBySelector("[data-test-id='order-summary-deliverby-value']"),
      purchaseDate: getTextBySelector("[data-test-id='order-summary-purchase-date-value']"),
      shippingService: getTextBySelector("[data-test-id='order-summary-shipping-service-value']"),
      fulfillment: getTextBySelector("[data-test-id='order-summary-fulfillment-channel-value']"),
      buyerName:
        getTextBySelector("[data-test-id='shipping-section-contact-buyer-value']") ||
        getTextBySelector("[data-test-id='buyer-name-with-link']"),
      buyerPhone: contact.buyerPhone,
      buyerAltPhone: contact.buyerAltPhone,
      buyerEmail: contact.buyerEmail,
      shippingAddress,
      sellerName,
      sellerAddress,
      links: detailLinks,
      items: itemRows,
    },
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action !== "SCRAPE_AMAZON_ORDERS") {
    return;
  }

  try {
    const isDetailPage = /\/orders-v3\/order\/\d{3}-\d{7}-\d{7}/.test(window.location.pathname);
    const payload = isDetailPage ? scrapeOrderDetailsPage() : scrapeAmazonOrders();
    sendResponse({ ok: true, data: payload });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error instanceof Error ? error.message : "Unknown scrape error",
    });
  }
});
