# Заявки: форма → Worker → CRM (Google Таблица) + Telegram

Worker принимает `POST /request` (без оплаты), считает цену на сервере, отправляет заявку
в CRM-вебхук и владельцу в Telegram. Если оба канала недоступны, Worker отвечает 502, и сайт
предлагает написать в WhatsApp. Никакие токены в репозиторий не попадают.

## 1. Telegram-бот (делает владелец)
1. В Telegram откройте @BotFather → `/newbot` → получите токен.
2. Напишите своему боту любое сообщение, затем откройте
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates` и найдите `chat":{"id":...}` — это chat id.
3. Секреты (вводятся в терминале, значение спросит сам wrangler, нигде не светится):
   ```
   cd worker
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

## 2. CRM — Google Таблица через Apps Script
1. Создайте Google Таблицу, первая строка: `created | id | name | contact | service | hours | start | total AED | add-ons | to confirm | notes | status`.
2. Расширения → Apps Script, вставьте и замените `SECRET` своей случайной строкой:
   ```js
   const SECRET = 'SECRET';
   function doPost(e) {
     const d = JSON.parse(e.postData.contents);
     if (d.secret !== SECRET) return out({ ok: false });
     SpreadsheetApp.getActiveSheet().appendRow([d.createdAt, d.id, d.name, d.contact,
       d.serviceLabel, d.hours, d.start || '', d.totalAed, (d.addons || []).join(', '),
       (d.quoteOnly || []).join(', '), d.notes, d.status]);
     return out({ ok: true });
   }
   const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
   ```
3. Развернуть → Новое развёртывание → Веб-приложение, доступ «Все». Скопируйте URL.
4. Секреты Worker:
   ```
   npx wrangler secret put CRM_WEBHOOK_URL
   npx wrangler secret put CRM_WEBHOOK_SECRET
   ```
   Подойдёт и любой другой вебхук (Zapier, Make, amoCRM/Bitrix24 через них): `CRM_WEBHOOK_SECRET` необязателен.

## 3. Включение
`wrangler deploy` (только по явному решению владельца). Проверка:
```
curl -X POST https://klemmenov-booking.white-term-cd13.workers.dev/request \
  -H 'Content-Type: application/json' \
  -d '{"serviceId":"personal","hours":2,"contact":{"name":"Test","reach":"+971500000001"},"accepted_terms":true}'
```
Ожидаем `{"ok":true,...}`, строку в таблице и сообщение в Telegram.
Лимит: 3 заявки в минуту с одного IP; повтор той же заявки в течение 10 минут игнорируется.

## Что ещё не подключено
Форма на `/book/` пока отправляет только в WhatsApp: её переделывает ветка `booking-redesign`.
Готов клиент `shared/request-client.mjs` (`submitRequest`, не бросает исключений, при сбое
возвращает `fallback: "whatsapp"`); нужно вызвать его из новой формы и поле-ловушку `website`
(скрытое, пустое) добавить в тело запроса.
