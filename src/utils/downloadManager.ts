import type { SongType, SongLevelType } from "@/types/main";
import { useDataStore, useSettingStore } from "@/stores";
import { isElectron } from "@/utils/env";
import { saveAs } from "file-saver";
import { cloneDeep } from "lodash-es";
import { songDownloadUrl, songLyric, songUrl } from "@/api/song";
import { songLevelData } from "@/utils/meta";
import songManager from "@/utils/songManager";

interface DownloadTask {
  song: SongType;
  quality: SongLevelType;
}

class DownloadManager {
  private static instance: DownloadManager;
  private queue: DownloadTask[] = [];
  private isProcessing: boolean = false;

  private constructor() {}

  public static getInstance(): DownloadManager {
    if (!DownloadManager.instance) {
      DownloadManager.instance = new DownloadManager();
    }
    return DownloadManager.instance;
  }

  /**
   * 获取已下载歌曲列表
   * @returns 已下载歌曲列表
   */
  public async getDownloadedSongs(): Promise<SongType[]> {
    const settingStore = useSettingStore();
    if (!isElectron) return [];
    const downloadPath = settingStore.downloadPath;
    if (!downloadPath) return [];
    try {
      const songs = await window.electron.ipcRenderer.invoke("get-music-files", downloadPath);
      return songs;
    } catch (error) {
      console.error("Failed to get downloaded songs:", error);
      return [];
    }
  }

  /**
   * 添加下载任务
   * @param song 歌曲信息
   * @param quality 音质
   */
  public async addDownload(song: SongType, quality: SongLevelType) {
    const dataStore = useDataStore();

    // 检查是否已存在
    if (dataStore.downloadingSongs.some((item) => item.song.id === song.id)) {
      return;
    }

    // 添加到正在下载列表 (UI显示)
    dataStore.addDownloadingSong(song, quality);

    // 添加到下载队列
    this.queue.push({ song, quality });

    // 开始处理队列
    this.processQueue();
  }

  /**
   * 处理下载队列
   * 每次处理一个任务，完成后继续处理下一个
   */
  private async processQueue() {
    if (this.isProcessing || this.queue.length === 0) {
      return;
    }

    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        await this.executeDownload(task.song, task.quality);
      }
    }

    this.isProcessing = false;
  }

  /**
   * 执行单个下载任务
   * @param song 歌曲信息
   * @param quality 音质
   */
  private async executeDownload(song: SongType, quality: SongLevelType) {
    const dataStore = useDataStore();
    const settingStore = useSettingStore();

    // 监听下载进度
    let removeListener: (() => void) | null = null;

    if (isElectron) {
      const progressHandler = (
        _event: any,
        progress: {
          percent: number;
          transferredBytes: number;
          totalBytes: number;
          id?: number;
        },
      ) => {
        // 校验 ID
        if (progress.id && progress.id !== song.id) return;

        const { percent, transferredBytes, totalBytes } = progress;
        const transferred = (transferredBytes / 1024 / 1024).toFixed(2) + "MB";
        const total = (totalBytes / 1024 / 1024).toFixed(2) + "MB";
        dataStore.updateDownloadProgress(
          song.id,
          Number((percent * 100).toFixed(1)),
          transferred,
          total,
        );
      };
      removeListener = window.electron.ipcRenderer.on("download-progress", progressHandler);
    }

    // 更新状态为下载中
    dataStore.updateDownloadStatus(song.id, "downloading");

    // 开始下载
    try {
      const result = await this.processDownload({
        song,
        quality,
        downloadPath: settingStore.downloadPath,
        skipIfExist: true,
      });

      if (isElectron && removeListener) {
        removeListener();
      }

      if (result.success) {
        // 下载成功，移除正在下载状态
        dataStore.removeDownloadingSong(song.id);
        window.$message.success(`${song.name} 下载完成`);
      } else {
        // 下载失败，保留在列表中并标记失败
        dataStore.markDownloadFailed(song.id);
        window.$message.error(result.message || "下载失败");
      }
    } catch (error) {
      console.error("Download failed:", error);
      if (isElectron && removeListener) removeListener();
      // 下载出错，保留在列表中并标记失败
      dataStore.markDownloadFailed(song.id);
      window.$message.error("下载出错");
    }
  }

  /**
   * 处理下载逻辑
   * @param song 歌曲信息
   * @param quality 音质
   * @param downloadPath 下载路径
   * @param skipIfExist 是否跳过已存在文件
   * @param mode 下载模式
   */
  private async processDownload({
    song,
    quality,
    downloadPath,
    skipIfExist,
    mode,
  }: {
    song: SongType;
    quality: SongLevelType;
    downloadPath?: string;
    skipIfExist?: boolean;
    mode?: "standard" | "playback";
  }): Promise<{ success: boolean; skipped?: boolean; message?: string }> {
    try {
      const settingStore = useSettingStore();
      let url = "";
      let type = "mp3";

      const usePlayback = mode ? mode === "playback" : settingStore.usePlaybackForDownload;

      // 获取下载链接
      const levelName = songLevelData[quality].level;

      // 如果开启了“使用播放链接下载”且音质支持，则尝试获取播放链接
      if (usePlayback) {
        try {
          const result = await songUrl(song.id, levelName as any);
          if (result.code === 200 && result?.data?.[0]?.url) {
            url = result.data[0].url;
            type = (result.data[0].type || result.data[0].encodeType || "mp3").toLowerCase();
          }
        } catch (e) {
          console.error("Error fetching playback url for download:", e);
        }
      }

      // 如果没有获取到 URL (可能是因为没开启设置，或者音质不支持，或者获取失败)，则使用标准下载接口
      if (!url) {
        const result = await songDownloadUrl(song.id, quality);
        if (result.code !== 200 || !result?.data?.url) {
          return { success: false, message: result.message || "获取下载链接失败" };
        }
        url = result.data.url;
        type = result.data.type?.toLowerCase() || "mp3";
      }

      const infoObj = songManager.getPlayerInfoObj(song) || {
        name: song.name || "未知歌曲",
        artist: "未知歌手",
        album: "未知专辑",
      };

      const baseTitle = infoObj.name || "未知歌曲";
      const rawArtist = infoObj.artist || "未知歌手";
      const rawAlbum = infoObj.album || "未知专辑";

      const safeArtist = rawArtist.replace(/[/:*?"<>|]/g, "&");
      const safeAlbum = rawAlbum.replace(/[/:*?"<>|]/g, "&");

      const finalPath = downloadPath || settingStore.downloadPath;

      // 音乐命名格式与文件夹分类
      const { fileNameFormat, folderStrategy } = settingStore;

      let displayName = baseTitle;
      if (fileNameFormat === "artist-title") {
        displayName = `${safeArtist} - ${baseTitle}`;
      } else if (fileNameFormat === "title-artist") {
        displayName = `${baseTitle} - ${safeArtist}`;
      }

      const safeFileName = displayName.replace(/[/:*?"<>|]/g, "&");

      let targetPath = finalPath;
      if (folderStrategy === "artist") {
        targetPath = `${finalPath}\\${safeArtist}`;
      } else if (folderStrategy === "artist-album") {
        targetPath = `${finalPath}\\${safeArtist}\\${safeAlbum}`;
      }

      // 校验下载路径
      if (finalPath === "" && isElectron) {
        return { success: false, message: "请配置下载目录" };
      }

      if (isElectron) {
        const { downloadMeta, downloadCover, downloadLyric, saveMetaFile } = settingStore;
        let lyric = "";
        if (downloadLyric) {
          const lyricResult = await songLyric(song.id);

          // 排除特定格式的脏数据
          const rawLyric = lyricResult?.lrc?.lyric || "";
          const excludeRegex = /^\{"t":\d+,"c":\[\{"[^"]+":"[^"]*"}(?:,\{"[^"]+":"[^"]*"})*]}$/;
          lyric = rawLyric
            .split("\n")
            .filter((line: string) => !excludeRegex.test(line.trim()))
            .join("\n");

          const lrc = lyricResult?.lrc?.lyric;
          const tlyric = settingStore.downloadLyricTranslation ? lyricResult?.tlyric?.lyric : null;
          const romalrc = settingStore.downloadLyricRomaji ? lyricResult?.romalrc?.lyric : null;

          if (lrc) {
            // 正则：匹配 [mm:ss.xx] 或 [mm:ss.xxx] 形式的时间标签
            const timeTagRe = /\[(\d{2}):(\d{2})(?:\.(\d{1,3}))?\]/g;

            // 把时间字符串转成秒（用于模糊匹配），例如 "00:06.52" -> 6.52
            const timeStrToSeconds = (timeStr: string) => {
              // timeStr 形如 "00:06.52" 或 "00:06"（不带小数）
              const m = timeStr.match(/^(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/);
              if (!m) return 0;
              const minutes = parseInt(m[1], 10);
              const seconds = parseInt(m[2], 10);
              const frac = m[3] ? parseInt((m[3] + "00").slice(0, 3), 10) : 0; // 保证到毫秒位
              return minutes * 60 + seconds + frac / 1000;
            };

            /**
             * 解析歌词字符串为映射表
             * @param lyricStr 歌词字符串
             * @returns 映射表
             */
            const parseToMap = (lyricStr: string) => {
              const map = new Map<string, string>();
              if (!lyricStr) return map;
              const lines = lyricStr.split(/\r?\n/);
              for (const raw of lines) {
                let m: RegExpExecArray | null;
                const timeTags: string[] = [];
                timeTagRe.lastIndex = 0;
                while ((m = timeTagRe.exec(raw)) !== null) {
                  const frac = m[3] ?? "";
                  const tag = `[${m[1]}:${m[2]}${frac ? "." + frac : ""}]`;
                  timeTags.push(tag);
                }
                const text = raw.replace(timeTagRe, "").trim();
                for (const tag of timeTags) {
                  if (text) {
                    const prev = map.get(tag);
                    map.set(tag, prev ? prev + "\n" + text : text);
                  }
                }
              }
              return map;
            };

            /**
             * 查找匹配文本（精确或模糊）
             * @param map 映射表
             * @param currentTag 当前时间标签
             * @returns 匹配文本
             */
            const findMatch = (map: Map<string, string>, currentTag: string) => {
              // 精确匹配
              const exact = map.get(currentTag);
              if (exact) return exact;

              // 模糊匹配
              const tSec = timeStrToSeconds(currentTag.slice(1, -1));
              let bestTag: string | null = null;
              let bestDiff = Infinity;
              for (const key of Array.from(map.keys())) {
                const kSec = timeStrToSeconds(key.slice(1, -1));
                const diff = Math.abs(kSec - tSec);
                if (diff < bestDiff) {
                  bestDiff = diff;
                  bestTag = key;
                }
              }
              if (bestTag && bestDiff < 0.5) {
                return map.get(bestTag);
              }
              return null;
            };

            // 解析翻译和音译歌词
            const tMap = parseToMap(tlyric || "");
            const rMap = parseToMap(romalrc || "");

            const lines: string[] = [];

            // 逐行解析原始 lrc 字符串
            const lrcLinesRaw = lrc.split(/\r?\n/);
            for (const raw of lrcLinesRaw) {
              let m: RegExpExecArray | null;
              const timeTags: string[] = [];
              timeTagRe.lastIndex = 0;
              while ((m = timeTagRe.exec(raw)) !== null) {
                const frac = m[3] ?? "";
                const tag = `[${m[1]}:${m[2]}${frac ? "." + frac : ""}]`;
                timeTags.push(tag);
              }

              if (timeTags.length === 0) continue;

              const text = raw.replace(timeTagRe, "").trim();
              if (!text) continue;

              for (const timeTag of timeTags) {
                lines.push(`${timeTag}${text}`);

                // 添加翻译和音译歌词
                const lyricMaps = [
                  { map: tMap, enabled: tlyric },
                  { map: rMap, enabled: romalrc },
                ];

                for (const { map, enabled } of lyricMaps) {
                  if (enabled) {
                    const matchedText = findMatch(map, timeTag);
                    if (matchedText) {
                      for (const lt of matchedText.split("\n")) {
                        if (lt.trim()) lines.push(`${timeTag}${lt}`);
                      }
                    }
                  }
                }
              }
            }

            lyric = lines.join("\n");
          }
        }

        const config = {
          fileName: safeFileName,
          fileType: type.toLowerCase(),
          path: targetPath,
          downloadMeta,
          downloadCover,
          downloadLyric,
          saveMetaFile,
          songData: cloneDeep(song),
          lyric,
          skipIfExist,
        };

        const result = await window.electron.ipcRenderer.invoke("download-file", url, config);
        if (result.status === "skipped") {
          return { success: true, skipped: true, message: result.message };
        }
        if (result.status === "error") {
          return { success: false, message: result.message || "下载失败" };
        }
      } else {
        saveAs(url, `${safeFileName}.${type}`);
      }

      return { success: true };
    } catch (error) {
      console.error(`Error downloading song ${song.name}:`, error);
      return { success: false, message: "下载过程出错" };
    }
  }

  /**
   * 移除下载任务
   * @param songId 歌曲ID
   */
  public removeDownload(songId: number) {
    const dataStore = useDataStore();
    dataStore.removeDownloadingSong(songId);
    // 移除队列中的任务
    this.queue = this.queue.filter((task) => task.song.id !== songId);
    // TODO: 如果支持取消下载，这里应该调用取消逻辑
  }

  /**
   * 重试下载任务
   * @param songId 歌曲ID
   */
  public retryDownload(songId: number) {
    const dataStore = useDataStore();
    const task = dataStore.downloadingSongs.find((item) => item.song.id === songId);
    if (!task) return;

    // 重置任务状态与进度
    dataStore.updateDownloadStatus(songId, "downloading");
    // 重置进度信息
    dataStore.updateDownloadProgress(songId, 0, "0MB", "0MB");

    // 重新加入队列
    this.queue.push({ song: task.song, quality: task.quality });

    // 继续处理队列
    this.processQueue();
  }

  /**
   * 重试所有下载任务
   */
  public retryAllDownloads() {
    const dataStore = useDataStore();
    const songsToRetry = dataStore.downloadingSongs.map((item) => item.song.id);

    songsToRetry.forEach((id) => {
      this.retryDownload(id);
    });
  }
}

export default DownloadManager.getInstance();
