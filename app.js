// ==========================================
// Настройки
// ==========================================

// Замените на адрес вашего сервера api.py (см. README)
const API_BASE_URL = "https://your-server.example.com";
const TON_CONNECT_MANIFEST_URL = `${window.location.origin}/tonconnect-manifest.json`;

const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();

const tonConnectUI = new TON_CONNECT_UI.TonConnectUI({
  manifestUrl: TON_CONNECT_MANIFEST_URL,
  buttonRootId: "ton-connect",
});

// ==========================================
// Утилиты
// ==========================================

function authHeader() {
  return { Authorization: `tma ${tg.initData}` };
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...authHeader(),
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail || `Ошибка запроса (${res.status})`);
  }

  return res.json();
}

function showView(name) {
  document.querySelectorAll(".view").forEach((el) => el.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
}

document.querySelectorAll("[data-back]").forEach((btn) => {
  btn.addEventListener("click", () => showView(btn.dataset.back));
});

// ==========================================
// Каталог
// ==========================================

const CATEGORIES = [
  { id: "stars", title: "Telegram Stars", emoji: "⭐", ready: true },
  { id: "premium", title: "Telegram Premium", emoji: "💎", ready: false },
  { id: "username", title: "Username", emoji: "🏷", ready: false },
  { id: "number", title: "Anonymous Number", emoji: "📱", ready: false },
  { id: "gift", title: "NFT Gift", emoji: "🎁", ready: false },
  { id: "account", title: "Telegram аккаунт", emoji: "📲", ready: false },
];

function renderCatalog() {
  const grid = document.getElementById("category-grid");
  grid.innerHTML = "";

  CATEGORIES.forEach((cat) => {
    const card = document.createElement("div");
    card.className = `category-card ${cat.ready ? "ready" : ""}`;
    card.innerHTML = `
      <div class="category-emoji">${cat.emoji}</div>
      <div class="category-title">${cat.title}</div>
      <div class="category-badge ${cat.ready ? "ready" : ""}">
        ${cat.ready ? "Доступно" : "Скоро"}
      </div>
    `;
    card.addEventListener("click", () => {
      if (cat.id === "stars") {
        showView("stars");
      } else {
        showView("soon");
      }
    });
    grid.appendChild(card);
  });
}

renderCatalog();
showView("catalog");

// ==========================================
// Покупка Stars
// ==========================================

let selectedQty = null;
let currentPrice = null;

const qtyGrid = document.getElementById("stars-qty-grid");
const usernameInput = document.getElementById("stars-username");
const priceBox = document.getElementById("stars-price-box");
const priceValue = document.getElementById("stars-price-value");
const buyBtn = document.getElementById("stars-buy-btn");

qtyGrid.addEventListener("click", async (e) => {
  const chip = e.target.closest(".qty-chip");
  if (!chip) return;

  qtyGrid.querySelectorAll(".qty-chip").forEach((c) => c.classList.remove("selected"));
  chip.classList.add("selected");

  selectedQty = Number(chip.dataset.qty);
  await refreshPrice();
});

async function refreshPrice() {
  if (!selectedQty) return;

  buyBtn.disabled = true;
  buyBtn.textContent = "Считаем цену…";

  try {
    const data = await api("/api/stars/price", {
      method: "POST",
      body: JSON.stringify({ quantity: selectedQty }),
    });

    currentPrice = data.price;
    priceValue.textContent = `${data.price} TON`;
    priceBox.classList.remove("hidden");
    updateBuyButton();
  } catch (err) {
    tg.showAlert(err.message);
    buyBtn.textContent = "Ошибка, попробуйте снова";
  }
}

function updateBuyButton() {
  const usernameOk = usernameInput.value.trim().length > 0;
  buyBtn.disabled = !(selectedQty && currentPrice && usernameOk);
  buyBtn.textContent = buyBtn.disabled
    ? "Выберите количество и введите username"
    : `Купить за ${currentPrice} TON`;
}

usernameInput.addEventListener("input", updateBuyButton);

buyBtn.addEventListener("click", async () => {
  const username = usernameInput.value.trim().replace(/^@/, "");
  if (!username || !selectedQty || !currentPrice) return;

  buyBtn.disabled = true;

  try {
    // 1. Создаём заказ на бэкенде — он спрашивает у MarketApp готовую транзакцию
    const order = await api("/api/stars/order", {
      method: "POST",
      body: JSON.stringify({
        quantity: selectedQty,
        recipient_username: username,
        price: currentPrice,
      }),
    });

    if (!tonConnectUI.connected) {
      await tonConnectUI.openModal();
      return; // пользователь нажмёт «Купить» ещё раз после подключения кошелька
    }

    // 2. Передаём транзакцию, которую вернул MarketApp, в TON Connect как есть
    showView("status");
    setStatus("Подтвердите оплату в кошельке…", "Не закрывайте это окно", true);

    await tonConnectUI.sendTransaction({
      validUntil: Math.floor(Date.now() / 1000) + 300,
      messages: [
        {
          address: order.transaction.address,
          amount: order.transaction.amount,
          payload: order.transaction.payload,
          stateInit: order.transaction.stateInit,
        },
      ],
    });

    // 3. Опрашиваем бэкенд, пока платёж не подтвердится в блокчейне
    await pollOrderStatus(order.payment_id);
  } catch (err) {
    showView("status");
    setStatus("Оплата не выполнена", err.message, false);
    document.getElementById("status-back-btn").classList.remove("hidden");
  }
});

async function pollOrderStatus(paymentId, attempt = 0) {
  if (attempt > 20) {
    setStatus("Не удалось подтвердить оплату", "Попробуйте позже или напишите в поддержку", false);
    document.getElementById("status-back-btn").classList.remove("hidden");
    return;
  }

  const data = await api(`/api/order/${paymentId}/status`);

  if (data.status === "PAID" || data.status === "DELIVERED") {
    setStatus("Оплата подтверждена ✅", `${data.product} — товар выдан`, false);
    document.getElementById("status-back-btn").classList.remove("hidden");
    tg.HapticFeedback.notificationOccurred("success");
    return;
  }

  setTimeout(() => pollOrderStatus(paymentId, attempt + 1), 3000);
}

function setStatus(title, text, showSpinner) {
  document.getElementById("status-title").textContent = title;
  document.getElementById("status-text").textContent = text;
  document.getElementById("status-spinner").classList.toggle("hidden", !showSpinner);
}

document.getElementById("status-back-btn").addEventListener("click", () => {
  document.getElementById("status-back-btn").classList.add("hidden");
  selectedQty = null;
  currentPrice = null;
  usernameInput.value = "";
  priceBox.classList.add("hidden");
  qtyGrid.querySelectorAll(".qty-chip").forEach((c) => c.classList.remove("selected"));
  showView("catalog");
});
