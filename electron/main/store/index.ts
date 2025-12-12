import { screen } from "electron";
import { storeLog } from "../logger";
import type { LyricConfig } from "../../../src/types/desktop-lyric";
import { defaultAMLLDbServer } from "../utils/config";
import defaultLyricConfig from "../../../src/assets/data/lyricConfig";
import Store from "electron-store";

storeLog.info("🌱 Store init");

export interface StoreType {
  window: {
    width: number;
    height: number;
    x?: number;
    y?: number;
    maximized?: boolean;
  };
  lyric: {
    // 窗口位置
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    // 配置
    config?: LyricConfig;
  };
  proxy: string;
  // amll-db-server
  amllDbServer: string;
}

/**
 * 使用 Store
 * @returns Store<StoreType>
 */
export const useStore = () => {
  // 获取主屏幕
  const screenData = screen.getPrimaryDisplay();
  return new Store<StoreType>({
    defaults: {
      window: {
        width: 1280,
        height: 800,
      },
      lyric: {
        x: screenData.workAreaSize.width / 2 - 400,
        y: screenData.workAreaSize.height - 90,
        width: 800,
        height: 136,
        config: defaultLyricConfig,
      },
      proxy: "",
      amllDbServer: defaultAMLLDbServer,
    },
  });
};
