import { ipcMain } from "electron";
import { checkUpdate, startDownloadUpdate } from "../update";
import mainWindow from "../windows/main-window";

const initUpdateIpc = () => {
  // 检查更新
  ipcMain.on("check-update", (_event, showTip, channel) => {
    const mainWin = mainWindow.getWin();
    if (!mainWin) return;
    const allowPrerelease = channel === "nightly";
    checkUpdate(mainWin, showTip, allowPrerelease);
  });

  // 开始下载更新
  ipcMain.on("start-download-update", () => startDownloadUpdate());
};

export default initUpdateIpc;
