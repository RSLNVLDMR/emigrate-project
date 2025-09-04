/* Telegram WebApp init + global config */

export const CFG = {
  BOT_USERNAME: window.BOT_USERNAME || 'your_bot_username_here' // <-- Замените на имя бота
};

export function initTelegram(){
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  tg.expand();
  tg.ready();
  // theme sync
  document.documentElement.classList.toggle('tg-dark', tg.colorScheme === 'dark');
  tg.onEvent('themeChanged', ()=>{
    document.documentElement.classList.toggle('tg-dark', tg.colorScheme === 'dark');
  });
  // expose user id (unsafe used only for demo M1)
  const uid = tg.initDataUnsafe?.user?.id || null;
  if (uid) localStorage.setItem('tg_user_id', String(uid));
}
