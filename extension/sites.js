// Adaptadores por sitio: qué nodos del DOM contienen el TEXTO de un comentario.
// Las redes sociales cambian sus clases seguido; si un sitio deja de funcionar,
// normalmente basta con actualizar `items` aquí.
//
//   host:    regex sobre location.hostname
//   items:   selector CSS de los nodos de texto a puntuar
//   exclude: selector de descendientes que NO forman parte del texto (hora, reacciones…)
//   skip:    selector de ancestros que descartan el nodo (botones, enlaces de usuario…)
//   minLen:  longitud mínima del texto para analizarlo
/* eslint-disable no-unused-vars */
const MOV_SITES = [
  {
    name: "YouTube",
    host: /(^|\.)youtube\.com$/,
    items: [
      "ytd-comment-view-model #content-text",
      "ytd-comment-renderer #content-text",
      "yt-live-chat-text-message-renderer #message", // chat en vivo (iframe)
    ].join(","),
  },
  {
    name: "Instagram",
    host: /(^|\.)instagram\.com$/,
    // Clases ofuscadas: usamos estructura. Texto de comentarios y pies de foto.
    items: [
      'div[role="dialog"] ul span[dir="auto"]',
      'article ul span[dir="auto"]',
      'main ul span[dir="auto"]',
    ].join(","),
    skip: 'a, h1, h2, h3, time, button, [role="button"], [role="link"]',
    minLen: 3,
  },
  {
    name: "Facebook",
    host: /(^|\.)facebook\.com$/,
    items: [
      'div[role="article"] div[dir="auto"][style*="text-align"]',
      'div[data-ad-preview="message"]',
      'div[data-ad-comet-preview="message"]',
    ].join(","),
    skip: 'a[role="link"] , [role="button"], h2, h3, h4',
  },
  {
    name: "Telegram",
    host: /^web\.telegram\.org$/,
    items: [
      ".bubble .translatable-message", // Telegram Web K
      ".bubble .message",
      ".Message .text-content", // Telegram Web A
    ].join(","),
    exclude: ".time, .time-inner, .reactions, .message-time, .MessageMeta, .Reactions, .bubble-name-first",
  },
  {
    name: "X / Twitter",
    host: /(^|\.)(x|twitter)\.com$/,
    items: '[data-testid="tweetText"]',
  },
  {
    name: "Reddit",
    host: /(^|\.)reddit\.com$/,
    items: 'shreddit-comment [slot="comment"], .comment .usertext-body .md',
  },
  {
    name: "Disqus",
    host: /(^|\.)disqus\.com$/,
    items: ".post-message, [data-role='message']",
  },
];

// Modo genérico (periódicos, blogs, foros): bloques de texto dentro de algo que
// "parece" un comentario. Incluye el blog LA PLAZA del proyecto (.comment .body).
const MOV_GENERIC = {
  name: "Genérico (comentarios)",
  items: [
    ".comment .body",
    ".comment-content",
    ".comment-body",
    ".comment-text",
    ".comment__body",
    ".comment__text",
    ".comment__content",
    ".c-comment__text",
    ".comentario-texto",
    ".comentario .texto",
    "[itemprop='comment'] [itemprop='text']",
    "[itemtype*='schema.org/Comment'] [itemprop='text']",
    "[data-testid='comment-text']",
    "[class*='CommentBody']",
    "[class*='comment-body'] p",
    "li.comment p",
    "#comments .comment p",
  ].join(","),
  skip: "button, [role='button'], nav, header, footer",
  minLen: 3,
};

function movSiteFor(hostname) {
  return MOV_SITES.find((s) => s.host.test(hostname)) || null;
}
