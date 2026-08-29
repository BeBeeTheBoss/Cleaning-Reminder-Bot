require("dotenv").config();
const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const http = require("http");

const bot = new TelegramBot(process.env.TELEGRAM_TOKEN, {
  polling: {
    params: {
      // Reactions are separate `message_reaction` updates. The bot only needs
      // new messages and caption edits for cleaning reports.
      allowed_updates: ["message", "edited_message"],
    },
  },
});

const FILE = "records.json";
const TIMEZONE = "Asia/Yangon";
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "gemma4:31b-cloud";
const OLLAMA_TIMEOUT_MS = 60_000;
const API_PORT = Number(process.env.API_PORT) || 3000;
const processingReports = new Set();

function getNetworkErrorDetails(error) {
  const cause = error.cause;
  return [error.message, cause?.code, cause?.message].filter(Boolean).join(" | ");
}

/** 👥 Teams */
const teams = {
  hardware: [
    "Wai Min Maung",
    "Mg Mg Myat Thin",
    "Min Htet Pyae Win",
    "Shein Htet",
    "Waiphone Myint(LT IT)",
    "Aung Kyaw"
  ],
  database: [
    "Kaung Myat Kyaw SD",
    "Khine Mar Htun HO_SD",
    "Zay Yar Phyoe Paing",
    "Nang Cherry HO SD",
    "Htaik Htaik"
  ],
  web: [
    "Wut Yee Phyo_HO-SD",
    "Thoon Shwe Yi Kyaw (SD - HO)",
    "Min Thu Kha",
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
  "Yamone Myo nyunt HO SD": "Yamone Myo Nyunt",
  "Nang Cherry HO SD": "Nang Cherry",
  "Waiphone Myint(LT IT)": "Waiphone Myint",
  "Wut Yee Phyo_HO-SD": "Wut Yee Phyo",
  "Aung Kyaw": "Aung Kyaw Myint"
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

/**
 * Ask Ollama to review whether a submitted photo shows a cleaned workspace.
 * The response is deliberately limited to JSON so it can be handled safely.
 */
async function verifyWorkspaceCleaning(photo) {
  const largestPhoto = photo[photo.length - 1];
  const fileLink = await bot.getFileLink(largestPhoto.file_id);
  let imageResponse;
  try {
    imageResponse = await fetch(fileLink, {
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
    });
  } catch (error) {
    throw new Error(`Telegram မှ ပုံဒေါင်းလုဒ်မရပါ: ${getNetworkErrorDetails(error)}`);
  }

  if (!imageResponse.ok) {
    throw new Error(`Telegram image download failed (${imageResponse.status})`);
  }

  const imageBase64 = Buffer.from(await imageResponse.arrayBuffer()).toString("base64");
  let ollamaResponse;
  try {
    ollamaResponse = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(OLLAMA_TIMEOUT_MS),
      body: JSON.stringify({
        model: OLLAMA_MODEL,
        stream: false,
        format: "json",
        images: [imageBase64],
        prompt:
          "You are reviewing a workplace-cleaning report photo. First decide whether the photo clearly shows an indoor office workspace (desk, work area, or surrounding floor). If it does not, set isWorkspace to false. Use a practical and lenient standard for normal work equipment: monitor, laptop, keyboard, mouse, work cables, calendar, notebook, and one water bottle are acceptable. A workspace does NOT need to look empty or perfectly arranged. However, before accepting, carefully scan the whole visible desk and floor, including under and beside monitors, for food/snack containers, cups, wrappers, food remains, dirty dishes, or rubbish. Any visible food or snack container, wrapper, food remains, dirty cup, or rubbish means hasFoodOrRubbish must be true and isClean must be false. Also reject major clutter, spills, many unrelated personal items, or visibly dirty/neglected desk or floor. Do not reject solely because cables are visible, work equipment is present, or items are not perfectly aligned. Give practical, short recommendations only when genuinely useful; recommendations may be empty when accepted. Write summary and every recommendation only in Burmese (Myanmar language), with no English. Return only JSON in this exact shape: {\"isWorkspace\":true|false,\"isClean\":true|false,\"hasFoodOrRubbish\":true|false,\"summary\":\"Burmese short assessment\",\"recommendations\":[\"Burmese recommendation\"]}. For a non-workspace photo, isClean must be false and recommend sending a clear workspace photo.",
      }),
    });
  } catch (error) {
    throw new Error(
      `Ollama server (${OLLAMA_URL}) သို့ ချိတ်ဆက်မရပါ: ${getNetworkErrorDetails(error)}`,
    );
  }

  if (!ollamaResponse.ok) {
    const details = await ollamaResponse.text();
    throw new Error(`Ollama request failed (${ollamaResponse.status}): ${details.slice(0, 300)}`);
  }

  const result = await ollamaResponse.json();
  const rawResponse =
    typeof result.response === "string" ? result.response.trim() : "";
  // Some models still wrap JSON in a Markdown fence or a short sentence even
  // when `format: "json"` is requested. Extract the JSON object safely.
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  let verdict;
  try {
    verdict = JSON.parse(jsonMatch ? jsonMatch[0] : rawResponse);
  } catch {
    const preview = rawResponse.replace(/\s+/g, " ").slice(0, 500);
    throw new Error(
      `Ollama returned invalid JSON${preview ? `: ${preview}` : " (empty response)"}`,
    );
  }

  if (
    typeof verdict.isWorkspace !== "boolean" ||
    typeof verdict.isClean !== "boolean" ||
    typeof verdict.hasFoodOrRubbish !== "boolean"
  ) {
    throw new Error("Ollama response did not include a valid workspace review");
  }

  return {
    isWorkspace: verdict.isWorkspace,
    // A detected food container or rubbish must never be accepted, even when
    // the model's general cleanliness assessment is inconsistent.
    isClean: verdict.isClean && !verdict.hasFoodOrRubbish,
    hasFoodOrRubbish: verdict.hasFoodOrRubbish,
    summary:
      typeof verdict.summary === "string" && verdict.summary.trim()
        ? verdict.summary.trim()
        : "ပုံကို စစ်ဆေးပြီးပါပြီ။",
    recommendations: Array.isArray(verdict.recommendations)
      ? verdict.recommendations
          .filter((item) => typeof item === "string" && item.trim())
          .map((item) => item.trim())
          .slice(0, 5)
      : [],
  };
}

function formatRecommendations(recommendations) {
  if (recommendations.length === 0) return "";
  return `\n\nအကြံပြုချက်များ\n${recommendations
    .map((item, index) => `${index + 1}. ${item}`)
    .join("\n")}`;
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

async function sendSummary(chatId) {
  const data = load();
  const today = getDateKey(new Date());
  const { text } = buildSummaryText(data, today);
  await bot.sendMessage(chatId, text, { parse_mode: "HTML" });
}

/** 📊 SUMMARY */
bot.onText(/\/summary/, async (msg) => {
  await sendSummary(msg.chat.id);
});

/** 🌐 SUMMARY API */
const apiServer = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json; charset=utf-8");

  if (req.method !== "POST" || req.url !== "/api/summary") {
    res.writeHead(404);
    res.end(JSON.stringify({ ok: false, error: "Not found" }));
    return;
  }

  let rawBody = "";
  req.on("data", (chunk) => {
    rawBody += chunk;
    if (rawBody.length > 10_000) req.destroy();
  });

  req.on("end", async () => {
    try {
      const body = JSON.parse(rawBody || "{}");
      const chatId = body.chatId ?? process.env.SUMMARY_CHAT_ID;

      if (!chatId || !/^-?\d+$/.test(String(chatId))) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "A valid chatId is required" }));
        return;
      }

      await sendSummary(chatId);
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, message: "Summary sent" }));
    } catch (error) {
      console.error("Summary API failed:", error.message);
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: "Failed to send summary" }));
    }
  });
});

apiServer.listen(API_PORT, () => {
  console.log(`Summary API listening on port ${API_PORT}`);
});

/** 📸 REPORT PROCESSOR */
async function processPhotoReport(msg) {
  const chatId = msg.chat.id;
  const reportKey = `${chatId}:${msg.message_id}`;

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

    // Telegram may deliver another update for the same message. Do not run AI
    // verification twice or create duplicate records for an accepted report.
    if (processingReports.has(reportKey)) return;

    const existingRecords = load();
    const alreadyRecorded = existingRecords.some(
      (record) =>
        String(record.sourceChatId) === String(chatId) &&
        record.sourceMessageId === msg.message_id,
    );
    if (alreadyRecorded) return;

    processingReports.add(reportKey);

    let verification;
    try {
      verification = await verifyWorkspaceCleaning(msg.photo);
    } catch (error) {
      console.error("Workspace image verification failed:", error.message);
      await bot.sendMessage(
        chatId,
        "⚠️ ပုံကို AI နဲ့စစ်ဆေးလို့မရသေးပါ။ ခဏနေရင် ပြန်ပို့ပေးပါနော်။",
        { reply_to_message_id: msg.message_id },
      );
      processingReports.delete(reportKey);
      return;
    }

    if (!verification.isWorkspace) {
      await bot.sendMessage(
        chatId,
        `😠 ဒီပုံက Workspace ပုံမဟုတ်သေးပါနော်။ Workspace နေရာကို ထင်ရှားစွာမြင်ရတဲ့ပုံ ထည့်ပြီး “workspace cleaning done” လို့ ပြန်ပို့ပေးပါ။\n\n${verification.summary}${formatRecommendations(verification.recommendations)}\n\nဒီပုံကို Record ထဲ မမှတ်ထားပါဘူး။`,
        { reply_to_message_id: msg.message_id },
      );
      processingReports.delete(reportKey);
      return;
    }

    if (!verification.isClean) {
      await bot.sendMessage(
        chatId,
        `😠 Workspace ကို သန့်ရှင်းပြီးကြောင်း အတည်မပြုနိုင်သေးပါနော်။ အောက်ကအချက်တွေကို ပြန်သန့်ရှင်းပြီး Workspace တစ်ခုလုံးထင်ရှားတဲ့ပုံနဲ့ ပြန်ပို့ပေးပါ။\n\n${verification.summary}${formatRecommendations(verification.recommendations)}\n\nဒီပုံကို Record ထဲ မမှတ်ထားပါဘူး။`,
        { reply_to_message_id: msg.message_id },
      );
      processingReports.delete(reportKey);
      return;
    }

    const team = getTeam(sender);
    const senderDisplayName = getDisplayName(sender);
    const records = load();

    records.push({
      sender,
      username,
      team,
      sourceChatId: chatId,
      sourceMessageId: msg.message_id,
      caption: normalizedCaption,
      date: new Date().toISOString(),
      aiVerified: true,
      aiReview: {
        summary: verification.summary,
        recommendations: verification.recommendations,
      },
    });

    save(records);
    processingReports.delete(reportKey);

    bot.sendMessage(
      chatId,
      `✅ ${team} team က ${senderDisplayName} ရေ၊ Workspace သန့်ရှင်းနေတာကို စစ်ဆေးပြီးပါပြီ။ Record ထဲလည်း မှတ်ပြီးပါပြီနော်။\n\n${verification.summary}${formatRecommendations(verification.recommendations)}`,
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

bot.on("polling_error", (error) => {
  console.error("Telegram polling error:", error.code, error.message);
});
