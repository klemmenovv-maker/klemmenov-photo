# Заявки: форма → Worker → CRM (Google Таблица) + Telegram

Worker принимает `POST /request` (без оплаты), считает цену на сервере, отправляет заявку
в CRM-вебхук и владельцу в Telegram. Если оба канала недоступны, Worker отвечает 502, и сайт
предлагает написать в WhatsApp. Никакие токены в репозиторий не попадают.

## 1. Telegram-бот (делает владелец)
1. В Telegram откройте @BotFather → `/newbot` → получите токен.
2. Напишите своему боту любое сообщение, затем откройте
   `https://api.telegram.org/bot<ТОКЕН>/getUpdates` и найдите `chat":{"id":...}` — это chat id.
   Токен никому не пересылайте; если он попал в чат или переписку, перевыпустите: @BotFather → `/revoke`.
3. Секреты (вводятся в терминале, значение спросит сам wrangler, нигде не светится):
   ```
   cd worker
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   npx wrangler secret put TELEGRAM_CHAT_ID
   ```

## 2. CRM — Google Таблица через Apps Script
1. Создайте Google Таблицу. В первой строке заголовки (A–J):
   `Дата заявки | Имя | Контакт | Услуга | Дата и время съёмки | Комментарий | Статус | Сумма AED | Допы | ID`
2. Расширения → Apps Script. Удалите всё, вставьте код ниже, замените `ЗАМЕНИТЕ_НА_СЛУЧАЙНУЮ_СТРОКУ` своей длинной случайной строкой (запомните её: это `CRM_WEBHOOK_SECRET`).
   ```js
   const SECRET = 'ЗАМЕНИТЕ_НА_СЛУЧАЙНУЮ_СТРОКУ';
   const TZ = 'Asia/Dubai';
   const fmt = (iso) => iso ? Utilities.formatDate(new Date(iso), TZ, 'dd.MM.yyyy HH:mm') : 'не выбрано';
   function doPost(e) {
     const d = JSON.parse(e.postData.contents);
     if (d.secret !== SECRET) return out({ ok: false });
     SpreadsheetApp.getActiveSheet().appendRow([
       fmt(d.createdAt), d.name, d.contact,
       d.serviceLabel + (d.hours ? ', ' + d.hours + ' ч' : ''),
       fmt(d.start), d.notes || '', 'новая', d.totalAed,
       (d.addons || []).concat(d.quoteOnly || []).join(', '), d.id]);
     return out({ ok: true });
   }
   const out = (o) => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
   ```
3. Развернуть → Новое развёртывание → тип «Веб-приложение»; «Выполнять от имени: я», «Доступ: Все» → Развернуть, разрешите доступ к таблице. Скопируйте URL (оканчивается на `/exec`).
   После любой правки скрипта нужно «Управление развёртываниями → Изменить → Новая версия».
4. Секреты Worker (wrangler сам спросит значение, в чат и в команды ничего вписывать не нужно):
   ```
   cd worker
   npx wrangler secret put CRM_WEBHOOK_URL      # URL из шага 3
   npx wrangler secret put CRM_WEBHOOK_SECRET   # строка SECRET из скрипта
   ```
   Подойдёт и другой вебхук (Zapier, Make и т.д.); `CRM_WEBHOOK_SECRET` необязателен.

## 3. Включение
Выполняет владелец сам, в своём терминале (после `wrangler login`):
```
cd worker
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_CHAT_ID
npx wrangler secret put CRM_WEBHOOK_URL
npx wrangler secret put CRM_WEBHOOK_SECRET
npx wrangler deploy
```
Проверка:
```
curl -X POST https://klemmenov-booking.white-term-cd13.workers.dev/request \
  -H 'Content-Type: application/json' \
  -d '{"serviceId":"personal","hours":2,"contact":{"name":"Test","reach":"+971500000001"},"accepted_terms":true}'
```
Ожидаем `{"ok":true,...}`, строку в таблице и сообщение в Telegram.
Лимит: 3 заявки в минуту с одного IP; повтор той же заявки в течение 10 минут игнорируется.

## Подключение формы /book/ (после merge ветки booking-redesign)
Форма не менялась. Когда новая форма будет в main, подключение такое:
1. В `content.json` уже есть `booking_schedule_api` (адрес Worker); передать его в конфиг формы как `requestApi`.
2. В форму добавить скрытое поле-ловушку `<input name="website" tabindex="-1" autocomplete="off" aria-hidden="true" class="hp">` (прятать через CSS `position:absolute;left:-9999px`, не `display:none`) и чекбокс согласия, если включены условия.
3. По кнопке «Отправить заявку»:
   ```js
   import { submitRequest } from '../../shared/request-client.mjs'; // скопировать в docs/assets при сборке, как book-ui.mjs
   const r = await submitRequest(cfg.requestApi, {
     serviceId, hours, addons,            // как в расчёте цены
     start,                                // ISO вида 2026-11-14T18:00:00+04:00, можно не передавать
     contact: { name, reach },
     notes, accepted_terms: termsChecked,
     website: form.website.value,          // ловушка, у людей пусто
   });
   if (r.ok) показать «Заявка отправлена, свяжусь с вами»;
   else if (r.fallback === 'whatsapp') показать r.message и кнопку WhatsApp (текущая ссылка);
   else показать r.message рядом с формой;
   ```
4. Сборка `tools/build.py` должна копировать `shared/request-client.mjs` в `docs/assets/` и включать его в хэш `ASSET_VERSION`, как остальные модули.
5. Деплой сайта (push в main) только после деплоя Worker и проверки curl выше.
