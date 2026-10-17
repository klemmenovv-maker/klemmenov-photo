# Сайт Klemmenov — фотограф в Дубае

Статический сайт (HTML/CSS/JS без сборщиков и зависимостей). Опубликован через GitHub Pages из папки `docs/`.

## Что где лежит

```
klemmenov-site/
├─ docs/                  ← это и есть сайт (его публикует GitHub Pages)
│  ├─ index.html, personal/, events/, commercial/, prices/, reviews/, contact/, 404.html
│  ├─ assets/style.css    ← весь дизайн (цвета глав — в начале файла, :root и .ch-*)
│  ├─ assets/app.js       ← анимации, лайтбокс, калькулятор цены
│  ├─ assets/fonts/       ← шрифты Playfair Display и Onest (свои, без Google, с кириллицей)
│  ├─ assets/img/         ← фото в WebP (полный размер 1200px и превью 560px)
│  └─ data/manifest.json  ← размеры фото (создаётся скриптом)
├─ content.json           ← цифры и цены, отзывы, контакты, выбор фото, адрес сайта
├─ i18n.json              ← все видимые слова (сайт только на английском; русские строки лежат про запас)
├─ tools/optimize.py      ← source-images/ → docs/assets/img/ (WebP) + manifest.json
├─ tools/build.py         ← content.json + manifest → все HTML-страницы в docs/
└─ source-images/         ← оригиналы 1280px с wfolio (НЕ в git, только у вас на Desktop)
```

Страницы в `docs/` генерируются. Цифры, отзывы, контакты и фото правьте в `content.json`, слова в `i18n.json`, внешний вид в `docs/assets/style.css`, потом пересоберите.

## Как поменять

**Цены, отзывы, контакты, подписи:** правим `content.json`, затем

```bash
python3 tools/build.py
```

**Заменить или добавить фото:** кладём JPG в `source-images/personal|events|commercial/` с именами `personal-01.jpg`, `personal-02.jpg` и т. д., затем

```bash
python3 tools/optimize.py    # запускать без -I, иначе не найдётся Pillow
python3 tools/build.py
```

**Скрыть фото из галереи:** номер файла в `content.json`, раздел `exclude` (сейчас ничего не скрыто).

**Какие фото на главной:** `content.json`, разделы `hero` и `collage`.

**Посмотреть локально** (запускать из папки проекта, сайт откроется по адресу `/docs/`, так проверяются относительные пути):

```bash
python3 -m http.server 8801
# http://localhost:8801/docs/
```

## Как выложить изменения

```bash
git add -A && git commit -m "update" && git push
```

GitHub Pages пересоберёт сайт за 1–2 минуты. Настройка: Settings → Pages → Branch `main`, папка `/docs`.

## Свой домен

1. Купить домен.
2. Создать файл `docs/CNAME` с одной строкой: ваш домен (например `klemmenov.com`).
3. В `content.json` поменять `site_url` на `https://ваш-домен`, выполнить `python3 tools/build.py`, закоммитить и запушить.
4. Прописать DNS у регистратора и включить домен в Settings → Pages. Актуальные записи DNS смотрите в официальной инструкции GitHub: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site

## Чего нет и что стоит доделать

- Нет формы заявки: на статическом сайте её некуда отправлять. Вместо неё кнопки WhatsApp (с готовым текстом и выбранной услугой) и Telegram.
- Нет блока «обо мне», логотипов клиентов и цифр: этого не было на wfolio, ничего не придумывалось. Добавить можно в `tools/build.py`.
- Скрытых кадров нет: все 68 личных фото опубликованы. Скрыть кадр можно через `exclude` в `content.json`.
- Старый сайт на wfolio (klemmenov.wfolio.pro) не тронут и остаётся запасным вариантом.

Русская версия убрана по решению владельца. Чтобы вернуть: в `tools/build.py` поставить `LANGS = ['en', 'ru']` и пересобрать.
