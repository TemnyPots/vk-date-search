// Клик по значку расширения открывает панель. Вне ВК content-скрипта нет, тогда открываем ВК.
chrome.action.onClicked.addListener((tab) => {
  chrome.tabs.sendMessage(tab.id, { type: 'toggle-panel' }).catch(() => {
    chrome.tabs.create({ url: 'https://vk.com/' });
  });
});
