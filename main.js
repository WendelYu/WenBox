const { app, BrowserWindow, Menu, ipcMain, clipboard, shell } = require('electron');
const path = require('path');
const { pathToFileURL } = require('url');
const indexPath = path.join(__dirname, 'app/src/main/assets/web/index.html');

ipcMain.handle('wenbox:copy-text', (event, text) => {
  if (event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== pathToFileURL(indexPath).href) {
    throw new Error('无效的剪贴板请求来源');
  }
  if (typeof text !== 'string') throw new TypeError('剪贴板内容必须是文本');
  clipboard.writeText(text);
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    title: 'WenBox - 工控现场与工程师百宝箱 (by Wendel)',
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  Menu.setApplicationMenu(null);

  // 外部链接一律交给系统浏览器，窗口本身不再被导航离开本机页面
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== pathToFileURL(indexPath).href) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) {
        void shell.openExternal(url);
      }
    }
  });
  win.webContents.on('will-attach-webview', (event) => event.preventDefault());

  // 载入现有的纯 Web 界面（报销直存、聊天、JSON、进制转换、Cron）
  win.loadFile(indexPath);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
