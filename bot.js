require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, { polling: true });

const FILE = "records.json";
const TIMEZONE = "Asia/Yangon";

/** 👥 Teams */
const teams = {
  hardware: [
    "Wai Min Maung",
    "Mg Mg Myat Thin",
    "Min Htet Pyae Win",
    "Shein Htet",
    "Waiphone Myint(LT IT)"
  ],
  database: [
    "Kaung Myat Kyaw SD",
    "Khine Mar Htun HO_SD",
    "Zay Yar Phyoe Paing",
    "Ash",
    "nang cherry",
  ],
  web: [
    "Wut Yee Phyo",
    "Thoon Shwe Yi Kyaw (SD - HO)",
    "Hnin Su Wai",
    "Thinzar Nwe",
    "BeBee",
    "Aung Chan Nyein",
  ],
};

/** 🪪 Display name overrides (telegram name -> shown name) */
const displayNames = {
  BeBee: "Aung Zay Zay Phyo",
  "Thoon Shwe Yi Kyaw (SD - HO)": "Thoon Shwe Yi Kyaw",
  "Kaung Myat Kyaw SD": "Kaung Myat Kyaw",
  "Khine Mar Htun HO_SD": "Khine Mar Htun",
  Ash: "Yamone Myo Nyunt",
  "nang cherry": "Nang Cherry",
  "Waiphone Myint(LT IT)": "Waiphone Myint",
};

/** 📦 Load */
function load() {
  if (!fs.existsSync(FILE)) return [];
  return JSON.parse(fs.readFileSync(FILE));
}

/** 💾 Save */
function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

/** 🧠 Find team */
function getTeam(name) {
  for (const [team, members] of Object.entries(teams)) {
    if (members.includes(name)) return team;
  }
  return "unknown";
}

function getDisplayName(name) {
  return displayNames[name] || name;
}

function getDateKey(date) {
  return date.toLocaleDateString("en-GB", { timeZone: TIMEZONE });
}

function buildSummaryText(records, dateKey) {
  const todayRecords = records.filter(
    (r) => getDateKey(new Date(r.date)) === dateKey,
  );
  const doneSenders = new Set(todayRecords.map((r) => r.sender));

  const nameWidth = 22;
  const teamWidth = 10;
  const formatRow = (name, team, status) =>
    `${name.padEnd(nameWidth, " ")} | ${team.padEnd(teamWidth, " ")} | ${status}`;

  let table = "";
  table += `${"Name".padEnd(nameWidth, " ")} | ${"Team".padEnd(teamWidth, " ")} | Status\n`;
  table += `${"-".repeat(nameWidth)}-|-${"-".repeat(teamWidth)}-|----------\n`;

  let allCompleted = true;
  for (const [team, members] of Object.entries(teams)) {
    members.forEach((member) => {
      const isDone = doneSenders.has(member);
      const status = isDone ? "✅ Done" : "❌ Not Cleaned";
      if (!isDone) allCompleted = false;
      table += `${formatRow(getDisplayName(member), team.toUpperCase(), status)}\n`;
    });

    if (team.toUpperCase() !== "WEB") {
      table += "\n";
    }
  }

  let text = "";
  text += `📅 Date: <b>${dateKey}</b>\n\n`;
  text += "📊 <b>Weekly Cleaning Report</b>\n";
  text += `<pre>${table}</pre>`;
  text += allCompleted
    ? "🎉 အကုန်လုံးသန့်ရှင်းရေးလုပ်ပြီးသွားကြပါပြီအမ @wahaung_92"
    : "⏳ သန့်ရှင်းရေးမလုပ်ရသေးတဲ့သူတွေကျန်ပါသေးတယ်အမ";

  return { text, allCompleted };
}

/** 📊 SUMMARY */
bot.onText(/\/summary/, (msg) => {
  const chatId = msg.chat.id;
  const data = load();
  const today = getDateKey(new Date());
  const { text } = buildSummaryText(data, today);
  bot.sendMessage(chatId, text, { parse_mode: "HTML" });
});

/** 📸 REPORT PROCESSOR */
function processPhotoReport(msg) {
  const chatId = msg.chat.id;

  const sender =
    `${msg.from.first_name || ""}${msg.from.last_name ? " " + msg.from.last_name : ""}`.trim();

  const username = msg.from.username || null;

  /** ignore summary command (important fix) */
  if (msg.text && msg.text.startsWith("/")) return;

  /** 📸 Photo report only */
  if (msg.photo && msg.caption) {
    const caption = msg.caption.trim();
    const normalizedCaption = caption.toLowerCase().replace(/\s+/g, " ");
    const isReport = normalizedCaption === "workspace cleaning done";

    if (!isReport) return;

    const team = getTeam(sender);
    const senderDisplayName = getDisplayName(sender);
    const records = load();

    records.push({
      sender,
      username,
      team,
      caption: normalizedCaption,
      date: new Date().toISOString(),
    });

    save(records);

    bot.sendMessage(
      chatId,
      `အခုလိုသန့်ရှင်းရေးလုပ်ပေးတဲ့အတွက်ကျေးဇူးတင်ပါတယ် ${team} team က ${senderDisplayName} ရေ သန့်ရှင်းပြီးကြောင်းလည်းမှတ်ထားလိုက်ပါပြီနော်`,
      {
        reply_to_message_id: msg.message_id,
      },
    );

    const today = getDateKey(new Date());
    const { text, allCompleted } = buildSummaryText(records, today);

    if (allCompleted) {
      setTimeout(() => {
        bot.sendMessage(chatId, text, { parse_mode: "HTML" });
      }, 1000);
    }
    return;
  }

  /** 💬 fallback */
  //   if (msg.text) {
  //     return bot.sendMessage(chatId, "📩 Send photo + caption report to save");
  //   }

  //   bot.sendMessage(chatId, "Message received 👍");
}

/** 📸 REPORT HANDLERS */
bot.on("photo", processPhotoReport);
bot.on("edited_message_caption", processPhotoReport);
