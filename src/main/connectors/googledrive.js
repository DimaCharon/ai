/* ============================================================
   googledrive.js — коннектор Google Drive
   ------------------------------------------------------------
   Честное состояние: Google не даёт третьим приложениям доступ
   без OAuth-приложения, зарегистрированного САМОМУ пользователю
   (это политика безопасности Google, обойти её нельзя).

   Чтобы подключить:
     1) console.cloud.google.com → создать проект;
     2) API и сервисы → включить «Drive API»;
     3) «Окно согласования OAuth» → добавить свой аккаунт;
     4) Учётные данные → Создать ID клиента OAuth → «Десктоп»;
     5) получить refresh token (один раз, через авторизацию).

   Когда у тебя будут Client ID / Secret / refresh token —
   скажи, допишем полноценный коннектор (файлы, папки, чтение).
   ============================================================ */
"use strict";

class GoogleDriveConnector {
  id = "googledrive";
  name = "Google Drive";
  icon = "📁";
  desc = "Файлы облака Google (нужна регистрация OAuth-приложения)";
  setupNeeded = true;

  async check() {
    return {
      ok: false,
      needsSetup: true,
      error:
        "Google Drive требует OAuth-приложение на твоё имя (политика Google).\n\n" +
        "Как сделать (10 минут):\n" +
        "1. console.cloud.google.com → создать проект;\n" +
        "2. включить «Drive API»;\n" +
        "3. «Окно согласования» → добавить свой аккаунт;\n" +
        "4. Учётные данные → ID клиента OAuth → «Десктоп»;\n" +
        "5. один раз авторизоваться → получить refresh token.\n\n" +
        "Принеси Client ID / Secret / refresh token — подключим полностью.",
    };
  }

  async listFiles() {
    return { ok: false, error: "Google Drive: подключение ещё не настроено." };
  }

  async readFile() {
    return { ok: false, error: "Google Drive: подключение ещё не настроено." };
  }
}

module.exports = GoogleDriveConnector;
