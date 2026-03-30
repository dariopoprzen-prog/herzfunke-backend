// ===== BOT INTEGRATION MODULE =====
// Datei: bot.js
// Binde deinen eigenen KI-Bot hier ein

const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

// ============================================================
// 🔧 KONFIGURATION – hier deine Bot-API eintragen
// ============================================================
const BOT_CONFIG = {
  // Deine Bot API URL – z.B. 'https://mein-bot.example.com/chat'
  apiUrl: process.env.BOT_API_URL || 'https://dein-bot.example.com/api/chat',

  // API Key falls nötig
  apiKey: process.env.BOT_API_KEY || '',

  // Wie lange warten bevor Bot antwortet (ms) – wirkt natürlicher
  typingDelay: 1500,

  // System-Prompt: Wie soll sich der Bot verhalten?
  systemPrompt: `Du bist eine freundliche, charmante Gesprächspartnerin auf einer Dating-Plattform namens Herzfunke. Dein Name ist Seite Geld.
Dein Ziel ist es, echte, interessante Gespräche zu führen.
- Antworte immer auf Deutsch
- Halte Antworten kurz (1-3 Sätze)
- Stelle Gegenfragen um das Gespräch am Laufen zu halten
- Sei warm, offen und authentisch
- Vermeide generische Antworten`,
};
// ============================================================

/**
 * Ruft deinen Bot auf und gibt die Antwort zurück.
 * 
 * @param {Array} history - Bisheriger Chatverlauf [{role, text, senderName}]
 * @param {string} lastMessage - Die letzte Nachricht des Nutzers
 * @param {Object} botProfile - Profil des Bot-Users {name, age, bio}
 * @param {Object} userProfile - Profil des Nutzers {name, age, bio}
 * @returns {Promise<string>} - Antwort-Text des Bots
 */
async function getBotReply(history, lastMessage, botProfile, userProfile) {
  try {
    // Chat-Verlauf für die API formatieren
    const formattedHistory = history.slice(-10).map(msg => ({
      role: msg.isBot ? 'assistant' : 'user',
      content: msg.text,
    }));

    // ============================================================
    // 🔌 API AUFRUF – passe dies an deine Bot-API an
    // ============================================================
    const response = await fetch(BOT_CONFIG.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BOT_CONFIG.apiKey && { 'Authorization': `Bearer ${BOT_CONFIG.apiKey}` }),
      },
      body: JSON.stringify({
        // Standard-Format – ändere die Felder je nach deiner API:
        system: BOT_CONFIG.systemPrompt,
        messages: formattedHistory,
        userMessage: lastMessage,
        context: {
          botName: botProfile?.name || 'Seite Geld',
          userName: userProfile?.name || 'Nutzer',
        },

        // Alternativer Aufbau für andere APIs:
        // prompt: `${BOT_CONFIG.systemPrompt}\n\nNutzer: ${lastMessage}`,
        // history: formattedHistory,
        // max_tokens: 150,
      }),
      signal: AbortSignal.timeout(10000), // 10s Timeout
    });

    if (!response.ok) {
      throw new Error(`Bot API Fehler: ${response.status}`);
    }

    const data = await response.json();

    // ============================================================
    // 📥 ANTWORT AUSLESEN – passe den Pfad an deine API-Antwort an
    // ============================================================
    const reply =
      data.reply ||           // { reply: "..." }
      data.message ||         // { message: "..." }
      data.text ||            // { text: "..." }
      data.choices?.[0]?.message?.content ||  // OpenAI-Format
      data.content?.[0]?.text ||              // Anthropic-Format
      data.response ||        // { response: "..." }
      null;

    if (!reply) throw new Error('Keine Antwort von Bot API');
    return reply.trim();
    // ============================================================

  } catch (err) {
    console.error('❌ Bot API Fehler:', err.message);
    // Fallback-Antworten wenn Bot nicht erreichbar
    const fallbacks = [
      'Hey, sorry – ich antworte gleich! 😊',
      'Guter Punkt! Was denkst du dazu?',
      'Das klingt interessant! Erzähl mir mehr!',
      'Ich melde mich gleich – kurz beschäftigt 😄',
    ];
    return fallbacks[Math.floor(Math.random() * fallbacks.length)];
  }
}

/**
 * Simuliert "tippt..." Verzögerung für natürlicheres Verhalten
 */
async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Hauptfunktion: Verarbeitet eingehende Nachricht und antwortet via Bot
 * Wird vom Server aufgerufen wenn Empfänger offline ist.
 *
 * @param {Object} params
 * @param {number} params.matchId
 * @param {number} params.senderId - Wer hat geschrieben
 * @param {number} params.botUserId - Bot User ID in der DB
 * @param {string} params.messageText
 * @param {Array}  params.history - Bisherige Nachrichten
 * @param {Object} params.botProfile - Bot-Profil aus DB
 * @param {Object} params.senderProfile - Absender-Profil aus DB
 * @param {Function} params.saveMessage - Funktion um Nachricht zu speichern
 * @param {Function} params.emitMessage - Funktion um via Socket zu senden
 */
async function handleBotReply({ matchId, senderId, botUserId, messageText, history, botProfile, senderProfile, saveMessage, emitMessage }) {
  try {
    // Kurz warten – wirkt natürlicher ("tippt...")
    await delay(BOT_CONFIG.typingDelay);

    const replyText = await getBotReply(history, messageText, botProfile, senderProfile);

    // Nachricht in DB speichern
    const savedMsg = await saveMessage({
      matchId,
      senderId: botUserId,
      text: replyText,
      isBot: true,
    });

    // Via Socket.io live senden
    emitMessage(`match_${matchId}`, savedMsg);

    console.log(`🤖 Bot antwortete in Match ${matchId}: "${replyText.slice(0, 50)}..."`);
    return savedMsg;

  } catch (err) {
    console.error('❌ Bot Reply Fehler:', err);
  }
}

module.exports = { handleBotReply, getBotReply, BOT_CONFIG };
